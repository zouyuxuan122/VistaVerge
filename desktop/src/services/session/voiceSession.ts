// EXP-003 VoiceSession: the streaming voice main chain of VOICE.md §1–3 with
// capability negotiation. The batch engine (desktop/src/engine.ts) stays
// untouched as the explicit fallback; this session reuses its proven parts —
// the mic AudioWorklet capture, the batch STT/TTS HTTP shapes (services/stt,
// services/tts) and the same barge-in feel (连续有声帧去抖 ≈200 ms，
// processing 与 ai-speaking 统一阈值，打断后触发帧回填进新 utterance)。
//
// Chain: VAD turn → batch STT → LlmProvider.streamChat (SSE deltas) →
// takeCompleteSentences → bounded TtsQueue (backpressure pauses the delta
// consumer, never drops audio) → sequential playback → sentence-level
// PlaybackLedger.
//
// Generations (VOICE.md §3.1/§3.2): every new spoken turn advances the
// @contracts GenerationGate; interrupt()/stop() advance it again to invalidate
// the canceled generation. Every delta/sentence/audio callback carries its
// generation and is discarded once it no longer matches the current one.
//
// Events (CustomEvent):
//   state         {state, generation}   six-state machine, always with generation
//   input-level   {rms}                 mic sampling level (noise gate arc)
//   user-turn     {text, generation}
//   reply-delta   {text, generation}    one streaming LLM delta
//   reply         {text, generation}    full assistant text of the turn
//   sentence      {text, index, generation}
//   interrupt     {generation}          a generation was canceled by barge-in
//   error         {message}             non-fatal; turn returns to listening
//   turn-settled  {generation}          the turn coroutine finished (any way)
import { GenerationGate } from '@contracts/generation';
import { createOpenAiCompatProvider } from '../llm/provider';
import type { ChatChunk, ChatMessage, LlmProvider, StreamChatArgs } from '../llm/provider';
import { PlaybackLedger } from '../speech/ledger';
import { takeCompleteSentences } from '../speech/sentences';
import { TtsQueue } from '../speech/ttsQueue';
import type { TtsQueueEventDetail } from '../speech/ttsQueue';
import { transcribeAudio } from '../stt/openaiCompat';
import { synthesizeSpeech } from '../tts/openaiCompat';
import workletUrl from '../../worklets/mic-capture.js?url';

export type VoiceSessionState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'user-speaking'
  | 'processing'
  | 'ai-speaking';

export interface VoiceEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface VoiceSessionSettings {
  stt: VoiceEndpoint;
  llm: VoiceEndpoint;
  tts: VoiceEndpoint;
  ttsVoice: string;
  ttsSampleRate: number;
  instructions: string;
  gateDb: number; // -66 = off (engine-parity default threshold takes over)
  minSilenceMs: number;
  minSpeechMs: number;
  speechPadMs: number;
  audioInputId: string;
  historyTurns: number;
  /** Sentence length bound for TTS chunking (default 64 code points). */
  maxSentenceChars?: number;
  /** Bounded TTS queue capacity, queued + playing (default 4). */
  queueCapacity?: number;
  /**
   * 回应门控（COST-001）：all=每段语音都回；smart=由 respondGate 判定，
   * 判 record 的只录入不回复；name=仅当转写含唤醒名才回。默认 all（旧行为）。
   */
  respondMode?: 'all' | 'smart' | 'name';
  /** respondMode=name 时的唤醒名（不填回退到内置默认名）。 */
  wakeName?: string;
  /** 打断灵敏度：连续有声帧数（≈40ms/帧），processing 与 ai-speaking 统一。默认 5。 */
  bargeInFrames?: number;
}

export interface VoiceSessionDeps {
  /** Defaults to the OpenAI-compatible SSE provider. */
  provider?: LlmProvider;
  /** Defaults to the engine-shape batch STT (settings.stt). */
  transcribe?: (pcm: Int16Array, signal: AbortSignal) => Promise<string>;
  /** Defaults to the engine-shape sentence TTS (settings.tts). */
  synthesize?: (text: string, signal: AbortSignal) => Promise<Int16Array>;
  /** Defaults to AudioContext playback (settings.ttsSampleRate). */
  play?: (pcm: Int16Array, signal: AbortSignal) => Promise<void>;
  /**
   * 统一历史来源（B-C-02）：提供后语音回合从宿主会话读历史，
   * 文本侧编辑/重试/切分支对语音立即生效；不提供则用会话内私有历史（测试/独立使用）。
   */
  getHistory?: () => { role: 'user' | 'assistant'; content: string }[];
  /** 按本轮用户文本组装系统提示（记忆/人设注入）；不提供则用静态 instructions。 */
  systemForTurn?: (userText: string) => string;
  /** smart 门控判定：respond=正常回复；record=只录入；uncertain=拿不准（按 respond 处理，效果优先）。 */
  respondGate?: (transcript: string) => 'respond' | 'record' | 'uncertain';
}

interface Turn {
  controller: AbortController;
  generation: number;
}

const CHUNK_MS = 40;
const DEFAULT_BARGE_IN_FRAMES = 5; // consecutive voiced frames (≈200 ms), engine parity
const GATE_OFF_DB = -66;
/** smart 门控的内置名字表（用户未配置唤醒名时的回退）。 */
const DEFAULT_WAKE_NAMES = ['vistaverge', '小v', '微微'];

function abortError(): Error {
  return new DOMException('This operation was aborted', 'AbortError');
}

export class VoiceSession extends EventTarget {
  #settings: VoiceSessionSettings;
  #deps: VoiceSessionDeps;
  #provider: LlmProvider;
  #transcribe: NonNullable<VoiceSessionDeps['transcribe']>;
  #synthesize: NonNullable<VoiceSessionDeps['synthesize']>;
  #playFn: NonNullable<VoiceSessionDeps['play']>;
  #gate = new GenerationGate(0);
  #state: VoiceSessionState = 'idle';
  #turn: Turn | null = null;
  #queue: TtsQueue;
  #ledger = new PlaybackLedger();
  #ledgerGeneration = -1;
  #sentenceIndex = 0;
  #pendingIndices: number[] = [];
  #history: { role: 'user' | 'assistant'; content: string }[] = [];
  /** 保留的历史消息条数（0 表示完全不保留）。 */
  #historyTurnsKeep(): number {
    return Math.max(0, Math.floor(this.#settings.historyTurns)) * 2;
  }
  #queuePaused = false;
  #resumeWaiters: (() => void)[] = [];
  // audio graph
  #ctx: AudioContext | null = null;
  #micStream: MediaStream | null = null;
  #node: AudioWorkletNode | null = null;
  // VAD state (engine-parity feel)
  #prepad: Int16Array[] = [];
  #utterance: Int16Array[] = [];
  #utteranceMs = 0;
  #silenceMs = 0;
  #voiceFrames = 0;

  constructor(settings: VoiceSessionSettings, deps: VoiceSessionDeps = {}) {
    super();
    this.#settings = settings;
    this.#deps = deps;
    this.#provider = deps.provider ?? createOpenAiCompatProvider();
    this.#transcribe =
      deps.transcribe ??
      ((pcm, signal) =>
        transcribeAudio({
          ...settings.stt,
          pcm,
          sampleRate: 16000,
          signal,
        }));
    this.#synthesize =
      deps.synthesize ??
      ((text, signal) =>
        synthesizeSpeech({
          ...settings.tts,
          text,
          voice: settings.ttsVoice,
          sampleRate: settings.ttsSampleRate,
          signal,
        }));
    this.#playFn = deps.play ?? ((pcm, signal) => this.#playPcm(pcm, signal));

    this.#queue = new TtsQueue({
      synthesize: (text, signal) => this.#synthesize(text, signal),
      play: (pcm, signal) => this.#playFn(pcm, signal),
      capacity: settings.queueCapacity,
    });
    this.#queue.addEventListener('audio', (event) => {
      const detail = (event as CustomEvent<TtsQueueEventDetail>).detail;
      if (detail.generation === this.#gate.current && this.#state === 'processing') {
        this.#setState('ai-speaking');
      }
    });
    this.#queue.addEventListener('played', (event) => this.#onSentenceSettled(event, 'played'));
    this.#queue.addEventListener('aborted', (event) => this.#onSentenceSettled(event, 'aborted'));
    this.#queue.addEventListener('dropped', (event) => this.#onSentenceSettled(event, 'aborted'));
    this.#queue.addEventListener('error', (event) => {
      const detail = (event as CustomEvent<TtsQueueEventDetail>).detail;
      this.#onSentenceSettled(event, 'aborted');
      this.dispatchEvent(
        new CustomEvent('error', { detail: { message: detail.message ?? 'TTS 句子失败' } }),
      );
    });
    this.#queue.addEventListener('backpressure', (event) => {
      this.#setQueuePaused((event as CustomEvent<{ paused: boolean }>).detail.paused);
    });
  }

  get currentState(): VoiceSessionState {
    return this.#state;
  }

  get generation(): number {
    return this.#gate.current;
  }

  /** Negotiated LLM path: 'streaming' or 'batch' (UI must show 分句/批式). */
  get llmPath(): 'streaming' | 'batch' {
    return this.#provider.capabilities().streaming ? 'streaming' : 'batch';
  }

  /** Playback ledger of the current/last turn (sentence granularity). */
  get ledger(): PlaybackLedger {
    return this.#ledger;
  }

  get history(): { role: 'user' | 'assistant'; content: string }[] {
    return [...this.#history];
  }

  async start(): Promise<void> {
    if (this.#state !== 'idle') return;
    this.#setState('connecting');
    const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    if (ctx.state === 'suspended') {
      // resume() without a user gesture may stay pending forever — race a
      // timeout so startup cannot deadlock (engine-parity behavior).
      await Promise.race([
        ctx.resume().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    this.#ctx = ctx;

    const constraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (this.#settings.audioInputId) constraints.deviceId = { ideal: this.#settings.audioInputId };
    this.#micStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });

    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(this.#micStream);
    const node = new AudioWorkletNode(ctx, 'mic-capture');
    node.port.onmessage = (event) =>
      this.#onChunk(event.data.pcm as Float32Array, event.data.rms as number);
    src.connect(node);
    // keep the mic off the destination: the worklet only taps the stream
    this.#node = node;
    this.#setState('listening');
  }

  async stop(): Promise<void> {
    const turn = this.#turn;
    this.#turn = null;
    turn?.controller.abort();
    this.#queue.cancel(this.#gate.current);
    this.#setQueuePaused(false);
    this.#advanceGate();
    if (this.#node) {
      this.#node.port.onmessage = null;
      this.#node.disconnect();
      this.#node = null;
    }
    if (this.#micStream) {
      for (const track of this.#micStream.getTracks()) track.stop();
      this.#micStream = null;
    }
    if (this.#ctx) {
      await this.#ctx.close().catch(() => {});
      this.#ctx = null;
    }
    this.#resetVad();
    this.#setState('idle');
  }

  /**
   * Cancel the current generation (VOICE.md §3.1): abort the turn's HTTP
   * fetches, stop TTS queue + playback, advance the generation so every late
   * delta/audio of the old generation is discarded. During processing a mic
   * open calls this immediately; during ai-speaking after the engine-parity
   * debounce. A UI control may call it directly in any state.
   */
  interrupt(): void {
    if (this.#turn === null && this.#state !== 'processing' && this.#state !== 'ai-speaking') {
      return;
    }
    const turn = this.#turn;
    this.#turn = null;
    turn?.controller.abort();
    this.#queue.cancel(this.#gate.current);
    this.#setQueuePaused(false); // unblock a backpressure-paused delta consumer
    this.#advanceGate();
    this.#resetVad();
    if (this.#state === 'processing' || this.#state === 'ai-speaking') {
      this.#setState('listening');
    }
    this.dispatchEvent(new CustomEvent('interrupt', { detail: { generation: this.#gate.current } }));
  }

  /**
   * 主动播报（VOICE §1.4 主动插话的出口）：只在 listening 空闲时开口，
   * 其他状态直接放弃（保守默认，不抢用户的话）。文本按句进 TTS 队列，
   * 打断语义与普通回合一致（interrupt 可中止）。
   */
  speak(text: string): void {
    const clean = text.trim();
    if (!clean || this.#state !== 'listening') return;
    const generation = this.#gate.advance();
    const turn: Turn = { controller: new AbortController(), generation };
    this.#turn = turn;
    this.#ledger = new PlaybackLedger();
    this.#ledgerGeneration = generation;
    this.#sentenceIndex = 0;
    this.#pendingIndices = [];
    this.#setState('processing');
    const take = takeCompleteSentences(clean, { maxChars: this.#settings.maxSentenceChars });
    for (const sentence of take.sentences) this.#enqueueSentence(sentence, generation);
    if (take.rest.trim().length > 0) this.#enqueueSentence(take.rest, generation);
    void this.#queue
      .whenDrained()
      .catch(() => {})
      .then(() => {
        if (this.#turn?.generation === generation) this.#turn = null;
        if (
          this.#gate.accepts(generation) &&
          (this.#state === 'processing' || this.#state === 'ai-speaking')
        ) {
          this.#setState('listening');
        }
      });
  }

  // ── mic → noise gate + energy VAD (engine-parity feel) ─────────────────────

  #onChunk(pcm: Float32Array, rms: number): void {
    this.dispatchEvent(new CustomEvent('input-level', { detail: { rms } }));

    const i16 = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    const gateDb = this.#settings.gateDb;
    // gate off (-66) → fixed default threshold (engine parity); no hysteresis band
    const effectiveOpen = gateDb <= GATE_OFF_DB ? -45 : gateDb;
    const open = db > effectiveOpen;
    const closed = !open;

    const padFrames = Math.max(1, Math.round(this.#settings.speechPadMs / CHUNK_MS));
    this.#prepad.push(i16);
    if (this.#prepad.length > padFrames) this.#prepad.shift();

    // 打断判定：processing 与 ai-speaking 用同一连续帧去抖（B-C-03：processing
    // 原先单帧即断，咳嗽/环境声会误杀正在生成的回合）。
    if (this.#state === 'ai-speaking' || this.#state === 'processing') {
      this.#voiceFrames = open ? this.#voiceFrames + 1 : 0;
      if (this.#voiceFrames >= this.#bargeInFrames()) {
        // B-C-01：interrupt() 会 resetVad 清空 prepad，触发打断的这段开头（含当前帧，
        // 已在上方 push 进 prepad）必须在打断后补回，否则新一句话的 onset ~0.5s 被吞掉。
        const seed = [...this.#prepad];
        this.interrupt();
        this.#prepad = seed;
        // 落到下面 listening 分支，用补回的 prepad 开启新 utterance
      } else {
        return;
      }
    }

    if (this.#state === 'user-speaking') {
      this.#appendUtterance(i16, open, closed);
      return;
    }

    if (this.#state === 'listening' && open) {
      // speech onset: enter user-speaking with the prepad ring included
      this.#utterance = [...this.#prepad];
      this.#utteranceMs = this.#utterance.length * CHUNK_MS;
      this.#silenceMs = 0;
      this.#setState('user-speaking');
    }
  }

  #bargeInFrames(): number {
    const frames = this.#settings.bargeInFrames ?? DEFAULT_BARGE_IN_FRAMES;
    return Math.max(1, Math.min(25, Math.floor(frames)));
  }

  /** 回应门控：all 总是回；name 仅含唤醒名；smart 交给 respondGate，缺省/拿不准都回（效果优先）。 */
  #decideRespond(transcript: string): 'respond' | 'record' {
    const mode = this.#settings.respondMode ?? 'all';
    if (mode === 'all') return 'respond';
    if (mode === 'name') {
      const names = this.#settings.wakeName?.trim()
        ? [this.#settings.wakeName.trim().toLowerCase()]
        : DEFAULT_WAKE_NAMES;
      const lower = transcript.toLowerCase();
      return names.some((name) => lower.includes(name)) ? 'respond' : 'record';
    }
    const verdict = this.#deps.respondGate?.(transcript) ?? 'respond';
    return verdict === 'record' ? 'record' : 'respond';
  }

  /**
   * 本轮携带的历史。宿主持史（getHistory）时以宿主为准：
   * store 的 user-turn 监听会先把本轮用户文本写进会话，这里若末尾正是它就去掉，
   * 否则模型会收到 [user X, user X] 重复输入。
   */
  #turnHistory(userText: string): ChatMessage[] {
    const keep = this.#historyTurnsKeep();
    if (keep === 0) return [];
    const external = this.#deps.getHistory?.();
    if (external) {
      let hist = external;
      const last = hist.at(-1);
      if (last && last.role === 'user' && last.content === userText) hist = hist.slice(0, -1);
      return hist.slice(-keep).map((m) => ({ role: m.role, content: m.content }));
    }
    return this.#history.slice(-keep).map((m) => ({ role: m.role, content: m.content }));
  }

  #appendUtterance(i16: Int16Array, open: boolean, closed: boolean): void {
    this.#utterance.push(i16);
    this.#utteranceMs += CHUNK_MS;
    if (open) this.#silenceMs = 0;
    else if (closed) this.#silenceMs += CHUNK_MS;

    // sustained-noise guard: force an end-of-utterance after 60 s
    if (this.#utteranceMs >= 60_000) this.#silenceMs = this.#settings.minSilenceMs;

    if (this.#silenceMs >= this.#settings.minSilenceMs) {
      if (this.#utteranceMs >= this.#settings.minSpeechMs) {
        const pcm = this.#concat(this.#utterance);
        this.#resetVad();
        void this.#runTurn(pcm);
      } else {
        // too short: discard (coughs, bumps)
        this.#resetVad();
        this.#setState('listening');
      }
    }
  }

  #concat(chunks: Int16Array[]): Int16Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  #resetVad(): void {
    this.#prepad = [];
    this.#utterance = [];
    this.#utteranceMs = 0;
    this.#silenceMs = 0;
    this.#voiceFrames = 0;
  }

  // ── one turn: STT → streaming LLM → sentence TTS → playback ────────────────

  async #runTurn(pcm: Int16Array): Promise<void> {
    let generation = -1;
    try {
      // VOICE.md §3.2: a new user utterance opens a new turn (generation++)
      generation = this.#gate.advance();
      this.#setState('processing');
      const turn: Turn = { controller: new AbortController(), generation };
      this.#turn = turn;
      const signal = turn.controller.signal;

      // fresh ledger per turn: sentence indices restart at 0 (§3.3)
      this.#ledger = new PlaybackLedger();
      this.#ledgerGeneration = generation;
      this.#sentenceIndex = 0;
      this.#pendingIndices = [];

      let userText: string;
      try {
        userText = await this.#transcribe(pcm, signal);
      } catch (err) {
        if (signal.aborted || (err as Error)?.name === 'AbortError') return;
        throw err;
      }
      if (signal.aborted || !this.#gate.accepts(generation)) return; // late result dropped
      if (!userText.trim()) {
        this.#setState('listening');
        return;
      }

      // 选择性回应门控（COST-001）：判 record 的语音只录入、不回复，
      // 状态直接回 listening——不发起 LLM/TTS，token 零消耗。
      if (this.#decideRespond(userText) === 'record') {
        this.dispatchEvent(
          new CustomEvent('user-turn-record', { detail: { text: userText, generation } }),
        );
        this.#setState('listening');
        return;
      }

      this.dispatchEvent(
        new CustomEvent('user-turn', { detail: { text: userText, generation } }),
      );

      const messages: ChatMessage[] = [
        { role: 'system', content: this.#deps.systemForTurn?.(userText) ?? this.#settings.instructions },
        // historyTurns=0 必须表示「不带历史」：slice(-0) 等于 slice(0)，会返回整个数组。
        ...this.#turnHistory(userText),
        { role: 'user', content: userText },
      ];
      const args: StreamChatArgs = {
        baseUrl: this.#settings.llm.baseUrl,
        model: this.#settings.llm.model,
        apiKey: this.#settings.llm.apiKey,
        messages,
        signal,
      };

      let full = '';
      let buffer = '';
      let streamError: unknown = null;
      const iterator = this.#provider.streamChat(args)[Symbol.asyncIterator]();
      try {
        for (;;) {
          if (signal.aborted || !this.#gate.accepts(generation)) break;
          // §3.4 backpressure: bounded queue full → stop pulling the upstream
          while (this.#queuePaused && !signal.aborted && this.#gate.accepts(generation)) {
            await new Promise<void>((resolve) => this.#resumeWaiters.push(resolve));
          }
          if (signal.aborted || !this.#gate.accepts(generation)) break;
          const next = await iterator.next();
          if (next.done) break;
          const chunk = next.value as ChatChunk;
          if ('done' in chunk) break;
          if (signal.aborted || !this.#gate.accepts(generation)) break; // stale delta
          this.dispatchEvent(
            new CustomEvent('reply-delta', { detail: { text: chunk.delta, generation } }),
          );
          full += chunk.delta;
          buffer += chunk.delta;
          const take = takeCompleteSentences(buffer, { maxChars: this.#settings.maxSentenceChars });
          for (const sentence of take.sentences) this.#enqueueSentence(sentence, generation);
          buffer = take.rest;
        }
      } catch (err) {
        if (!(signal.aborted || (err as Error)?.name === 'AbortError')) streamError = err;
      } finally {
        void iterator.return?.()?.catch(() => {});
      }
      if (streamError !== null) throw streamError;
      if (signal.aborted || !this.#gate.accepts(generation)) return; // interrupted

      if (buffer.trim().length > 0) this.#enqueueSentence(buffer, generation);
      if (full.trim().length > 0) {
        this.dispatchEvent(new CustomEvent('reply', { detail: { text: full, generation } }));
        // 私有历史只是 fallback：宿主持史（getHistory）时由宿主持久化（B-C-02）
        if (!this.#deps.getHistory) {
          const keep = this.#historyTurnsKeep();
          if (keep === 0) {
            this.#history = [];
          } else {
            this.#history.push({ role: 'user', content: userText }, { role: 'assistant', content: full });
            if (this.#history.length > keep) this.#history = this.#history.slice(-keep);
          }
        }
      }

      await this.#queue.whenDrained();
      if (signal.aborted || !this.#gate.accepts(generation)) return; // interrupted while playing
      if (this.#state === 'processing' || this.#state === 'ai-speaking') {
        this.#setState('listening');
      }
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      if (!aborted) {
        this.dispatchEvent(
          new CustomEvent('error', {
            detail: { message: err instanceof Error ? err.message : String(err) },
          }),
        );
        if (this.#state === 'processing' || this.#state === 'ai-speaking') {
          this.#setState('listening');
        }
      }
    } finally {
      if (this.#turn !== null && this.#turn.generation === generation) this.#turn = null;
      this.dispatchEvent(new CustomEvent('turn-settled', { detail: { generation } }));
    }
  }

  #enqueueSentence(sentence: string, generation: number): void {
    if (sentence.trim().length === 0) return;
    const index = this.#sentenceIndex;
    this.#sentenceIndex += 1;
    this.#ledger.markQueued(index);
    this.#pendingIndices.push(index);
    this.dispatchEvent(
      new CustomEvent('sentence', { detail: { text: sentence, index, generation } }),
    );
    this.#queue.enqueue(sentence, generation);
  }

  #onSentenceSettled(event: Event, kind: 'played' | 'aborted'): void {
    const detail = (event as CustomEvent<TtsQueueEventDetail>).detail;
    if (detail.generation !== this.#ledgerGeneration) return; // stale turn's audio
    const index = this.#pendingIndices.shift();
    if (index === undefined) return;
    if (kind === 'played') this.#ledger.markPlayed(index);
    else this.#ledger.markAborted(index);
  }

  #setQueuePaused(paused: boolean): void {
    this.#queuePaused = paused;
    if (!paused && this.#resumeWaiters.length > 0) {
      const waiters = this.#resumeWaiters;
      this.#resumeWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  #advanceGate(): void {
    try {
      this.#gate.advance();
    } catch {
      // GenerationGate exhausted at Number.MAX_SAFE_INTEGER — observable, not silent
      this.dispatchEvent(
        new CustomEvent('error', { detail: { message: 'GenerationGate 代际耗尽' } }),
      );
    }
  }

  #setState(state: VoiceSessionState): void {
    this.#state = state;
    this.dispatchEvent(
      new CustomEvent('state', { detail: { state, generation: this.#gate.current } }),
    );
  }

  // ── default playback (engine-parity shape, abort stops exactly once) ───────

  #playPcm(pcm: Int16Array, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    const ctx = this.#ctx;
    if (!ctx || pcm.length === 0) return Promise.resolve();
    const audio = ctx.createBuffer(1, pcm.length, this.#settings.ttsSampleRate);
    const channel = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = audio;

    // 回放电平（RMS）→ `output-level` 事件 → 数字人口型包络。
    // 没有这条链路时口型只能是固定振幅正弦，与真实音量无关（此前即是如此）。
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    src.connect(analyser);
    analyser.connect(ctx.destination);

    let levelTimer: ReturnType<typeof setInterval> | null = null;
    const stopLevelTap = () => {
      if (levelTimer === null) return;
      clearInterval(levelTimer);
      levelTimer = null;
      this.dispatchEvent(new CustomEvent('output-level', { detail: { rms: 0 } }));
    };

    src.start();
    const buf = new Float32Array(analyser.fftSize);
    levelTimer = setInterval(() => {
      if (signal.aborted) {
        stopLevelTap();
        return;
      }
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      this.dispatchEvent(new CustomEvent('output-level', { detail: { rms: Math.min(1, rms * 3.2) } }));
    }, 40);

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        stopLevelTap();
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        try {
          src.stop();
        } catch {
          // already stopped
        }
        finish();
      };
      src.onended = () => finish();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
