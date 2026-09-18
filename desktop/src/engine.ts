// engine.ts — 全云端语音引擎（桌面版核心）
//
// 链路：麦克风 AudioWorklet(16kHz/40ms) → 能量 VAD 断句（手感参数与原 start-voice.sh
// 一致：噪声门/最短语音/停顿断句/前置填充）→ 云 STT → 云 LLM → 云 TTS(PCM) → 播放。
// 所有云调用走 @tauri-apps/plugin-http（Rust reqwest，无 CORS 限制）。
//
// 事件（CustomEvent）：
//   state {state}          状态机变化
//   input-level {rms}      麦克风采样电平（噪声门弧/表）
//   output-level {rms}     回放电平（数字人包络）
//   user-turn {text}       一轮用户语音识别完成
//   reply {text}           助手文本回复
//   error {message}        非致命错误（致命错误也走 error，随后 state=idle）
import { fetch } from "@tauri-apps/plugin-http";
import workletUrl from "./worklets/mic-capture.js?url";

export type EngineState =
  | "idle"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "processing"
  | "ai-speaking";

export interface CloudEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface EngineSettings {
  stt: CloudEndpoint;
  llm: CloudEndpoint;
  tts: CloudEndpoint;
  ttsVoice: string;
  ttsSampleRate: number;
  instructions: string;
  gateDb: number; // -66 = 关
  minSilenceMs: number;
  minSpeechMs: number;
  speechPadMs: number;
  audioInputId: string;
  historyTurns: number;
}

const GATE_OFF_DB = -66;
const CHUNK_MS = 40;
const BARGE_IN_FRAMES = 5; // 连续 200ms 有效语音才触发打断

function dbOf(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

/** Int16 PCM → WAV(容器) bytes。 */
function pcmToWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length * 2, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, "data");
  dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/** 手搓 multipart/form-data（插件 fetch 对 FormData 支持不确定，自建最稳）。 */
function buildMultipart(
  boundary: string,
  fields: Record<string, string>,
  file: { name: string; filename: string; mime: string; bytes: Uint8Array },
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
    ),
    file.bytes,
    enc.encode(`\r\n--${boundary}--\r\n`),
  );
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * multipart bytes → fetch BodyInit。
 * 插件 fetch 的 BodyInit 类型不接受泛型 Uint8Array；这里复制成**长度精确**的
 * ArrayBuffer，既不依赖底层池 buffer 的偏移，也不会有多余尾字节被发出。
 */
function toBodyInit(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export class CloudVoiceEngine extends EventTarget {
  private settings: EngineSettings;
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private playSource: AudioBufferSourceNode | null = null;
  private muted = false;

  private state: EngineState = "idle";
  // VAD 断句状态
  private prepad: Int16Array[] = [];
  private utterance: Int16Array[] = [];
  private utteranceMs = 0;
  private silenceMs = 0;
  private voiceFrames = 0; // 连续有效语音帧（打断判定）
  private inFlight: AbortController | null = null;
  private playStop: (() => void) | null = null;
  private history: { role: "user" | "assistant"; content: string }[] = [];
  private pollTimer = 0;

  constructor(settings: EngineSettings) {
    super();
    this.settings = settings;
  }

  /** @param {EngineState} s */
  private setState(s: EngineState) {
    this.state = s;
    this.dispatchEvent(new CustomEvent("state", { detail: { state: s } }));
  }

  updateSettings(patch: Partial<EngineSettings>) {
    this.settings = { ...this.settings, ...patch };
  }

  setMuted(m: boolean) {
    this.muted = m;
    for (const t of this.micStream?.getAudioTracks() ?? []) t.enabled = !m;
  }

  get currentState() {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    this.setState("connecting");
    const ctx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
    if (ctx.state === "suspended") {
      // resume() 在无用户手势时可能永远 pending——竞速超时，不让启动卡死。
      // 真实用户点击（可信手势）时它会立即 resolve。
      await Promise.race([
        ctx.resume().catch(() => {}),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    }
    this.ctx = ctx;

    const constraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (this.settings.audioInputId) constraints.deviceId = { ideal: this.settings.audioInputId };
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });

    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(this.micStream);
    const node = new AudioWorkletNode(ctx, "mic-capture");
    node.port.onmessage = (e) => this._onChunk(e.data.pcm as Float32Array, e.data.rms as number);
    src.connect(node);
    // 不把麦克风连到 destination（避免回授）；worklet 只做旁路
    this.node = node;

    // 输出电平轮询（数字人包络）
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.pollTimer = window.setInterval(() => this._pollOutputLevel(), 50);

    this.resetTurn();
    this.setState("listening");
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = 0;
    }
    // 先 abort 本回合：_play 的 abort 监听会同步停播（且只停一次）。
    const inFlight = this.inFlight;
    this.inFlight = null;
    inFlight?.abort();
    this._stopPlayback();
    this.playSource = null;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) t.stop();
      this.micStream = null;
    }
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.analyser = null;
    this.resetTurn();
    this.setState("idle");
  }

  clearHistory() {
    this.history = [];
  }

  private resetTurn() {
    this.prepad = [];
    this.utterance = [];
    this.utteranceMs = 0;
    this.silenceMs = 0;
    this.voiceFrames = 0;
  }

  /** 幂等停播：真正的 src.stop() 由 _play 注册的 stopOnce 执行，最多一次。 */
  private _stopPlayback() {
    const stop = this.playStop;
    this.playStop = null;
    if (stop) stop();
  }

  // ── 麦克风 → 噪声门 + 能量 VAD ────────────────────────────────────────────

  private _onChunk(pcm: Float32Array, rms: number) {
    this.dispatchEvent(new CustomEvent("input-level", { detail: { rms } }));

    // Int16 化一次，两种用途共用
    const i16 = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    const db = dbOf(rms);
    const gate = this.settings.gateDb;
    // 门关（-66）= 不静音，但 VAD 用固定默认阈值断句（对应原方案里 silero VAD 的角色）；
    // 门开 = 低于门限按静音处理（环境吵时调高门限 → 只有大音量才触发）。
    // 能量 VAD 不做滞回带：房间底噪落在带内会把回合永远冻结在 user-speaking。
    const effectiveOpen = gate <= GATE_OFF_DB ? -45 : gate;
    const open = db > effectiveOpen;
    const closed = !open;

    // 待机时也维持前置填充环
    const padFrames = Math.max(1, Math.round(this.settings.speechPadMs / CHUNK_MS));
    this.prepad.push(i16);
    if (this.prepad.length > padFrames) this.prepad.shift();

    if (this.state === "ai-speaking") {
      // 打断判定
      this.voiceFrames = open ? this.voiceFrames + 1 : 0;
      if (this.voiceFrames >= BARGE_IN_FRAMES) {
        this._stopPlayback();
        this.playSource = null;
        this.inFlight?.abort();
        this.inFlight = null;
        this.resetTurn();
        this.setState("user-speaking");
        this._appendUtterance(i16, open, closed);
      }
      return;
    }

    if (this.state === "user-speaking") {
      this._appendUtterance(i16, open, closed);
      return;
    }

    if (this.state === "listening" && open) {
      // 语音起点：带着前置填充进入 user-speaking
      this.utterance = [...this.prepad];
      this.utteranceMs = this.utterance.length * CHUNK_MS;
      this.silenceMs = 0;
      this.setState("user-speaking");
    }
  }

  private _appendUtterance(i16: Int16Array, open: boolean, closed: boolean) {
    this.utterance.push(i16);
    this.utteranceMs += CHUNK_MS;
    if (open) this.silenceMs = 0;
    else if (closed) this.silenceMs += CHUNK_MS;

    // 最长发言保护：能量 VAD 在持续噪声里可能一直"开口"，60s 强制断句
    if (this.utteranceMs >= 60_000) this.silenceMs = this.settings.minSilenceMs;

    if (this.silenceMs >= this.settings.minSilenceMs) {
      if (this.utteranceMs >= this.settings.minSpeechMs) {
        const pcm = this._concat(this.utterance);
        this.resetTurn();
        this.setState("processing");
        void this._processTurn(pcm);
      } else {
        // 太短：丢弃（咳嗽/碰撞）
        this.resetTurn();
        this.setState("listening");
      }
    }
  }

  private _concat(chunks: Int16Array[]): Int16Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  // ── 一轮对话：STT → LLM → TTS → 播放 ─────────────────────────────────────

  private async _processTurn(pcm: Int16Array) {
    // 控制器只属于本回合：迟到检查一律用本地 signal，不读 this.inFlight 的当前值。
    const controller = new AbortController();
    this.inFlight = controller;
    const signal = controller.signal;
    try {
      const userText = await this._stt(pcm, signal);
      if (signal.aborted) return;
      if (!userText.trim()) {
        this.setState("listening");
        return;
      }
      this.dispatchEvent(new CustomEvent("user-turn", { detail: { text: userText } }));

      const reply = await this._llm(userText, signal);
      if (signal.aborted) return;
      this.dispatchEvent(new CustomEvent("reply", { detail: { text: reply } }));

      const pcm24k = await this._tts(reply, signal);
      if (signal.aborted) return;
      await this._play(pcm24k, this.settings.ttsSampleRate, signal);
    } catch (err) {
      if (signal.aborted || (err as Error)?.name === "AbortError") return; // 被打断/停止
      const msg = err instanceof Error ? err.message : String(err);
      this.dispatchEvent(new CustomEvent("error", { detail: { message: msg } }));
      this.setState("listening");
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  private async _stt(pcm: Int16Array, signal: AbortSignal): Promise<string> {
    const { baseUrl, model, apiKey } = this.settings.stt;
    if (!baseUrl || !model) throw new Error("STT 未配置：请在设置 → ☁ 云服务 填写");
    const boundary = "----cybergirl" + Math.random().toString(16).slice(2);
    const body = toBodyInit(
      buildMultipart(boundary, { model, language: "zh", response_format: "json" }, {
        name: "file",
        filename: "utterance.wav",
        mime: "audio/wav",
        bytes: pcmToWav(pcm, 16000),
      }),
    );
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    if (signal.aborted) return "";
    if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { text?: string };
    if (signal.aborted) return "";
    return j.text ?? "";
  }

  private async _llm(userText: string, signal: AbortSignal): Promise<string> {
    const { baseUrl, model, apiKey } = this.settings.llm;
    if (!baseUrl || !model) throw new Error("LLM 未配置：请在设置 → ☁ 云服务 填写");
    const messages = [
      { role: "system", content: this.settings.instructions },
      ...this.history.slice(-this.settings.historyTurns * 2),
      { role: "user", content: userText },
    ];
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, stream: false }),
    });
    if (signal.aborted) return "";
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    if (signal.aborted) return ""; // 迟到的 json 不得污染 history
    const reply = j.choices?.[0]?.message?.content ?? "";
    this.history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
    if (this.history.length > this.settings.historyTurns * 2) {
      this.history = this.history.slice(-this.settings.historyTurns * 2);
    }
    return reply;
  }

  private async _tts(text: string, signal: AbortSignal): Promise<Int16Array> {
    const { baseUrl, model, apiKey } = this.settings.tts;
    if (!baseUrl || !model) throw new Error("TTS 未配置：请在设置 → ☁ 云服务 填写");
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/audio/speech`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice: this.settings.ttsVoice || undefined,
        response_format: "pcm",
      }),
    });
    if (signal.aborted) return new Int16Array(0);
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (signal.aborted) return new Int16Array(0);
    // PCM16 LE → Int16Array（丢弃奇数字节尾部）
    const usable = buf.length - (buf.length % 2);
    return new Int16Array(buf.buffer, 0, usable / 2);
  }

  private _play(pcm: Int16Array, sampleRate: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    const ctx = this.ctx;
    if (!ctx || pcm.length === 0) {
      if (!signal.aborted && this.state !== "idle") this.setState("listening");
      return Promise.resolve();
    }
    const audio = ctx.createBuffer(1, pcm.length, sampleRate);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = audio;
    this.analyser && src.connect(this.analyser);
    src.connect(ctx.destination);
    this.playSource = src;
    this.setState("ai-speaking");
    return new Promise((resolve) => {
      let stopped = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (this.playSource === src) this.playSource = null;
        if (this.playStop === stopOnce) this.playStop = null;
        resolve();
      };
      // 取消/停止时只真正调用一次 src.stop()；同步触发的 onended 不会二次 stop。
      const stopOnce = () => {
        if (stopped) return;
        stopped = true;
        try {
          src.stop();
        } catch {}
        finish();
      };
      const onAbort = () => stopOnce();
      src.onended = () => {
        if (!signal.aborted && this.state === "ai-speaking") this.setState("listening");
        finish();
      };
      this.playStop = stopOnce;
      signal.addEventListener("abort", onAbort, { once: true });
      src.start();
    });
  }

  private _pollOutputLevel() {
    if (!this.analyser || this.state !== "ai-speaking") return;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    this.dispatchEvent(new CustomEvent("output-level", { detail: { rms } }));
  }
}
