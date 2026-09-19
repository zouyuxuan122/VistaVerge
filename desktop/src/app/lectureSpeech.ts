/**
 * 讲课旁白引擎（TEACHER_COMPANION §1.1A）：把讲稿流式文本分句送 TTS 顺序播报。
 *
 * 与 VoiceSession 的关系：语音会话管「对话回合」，这里管「单向讲课播报」——
 * 没有麦克风、没有打断判定，只有 分句→合成→有界队列→顺序播放→可停止。
 * 口型同样走 RMS 包络（近似口型，非 viseme，与语音链路同一诚实口径）。
 * 未配置 TTS 端点/密钥时静默降级为纯文字字幕（不报错、不伪造语音）。
 */
import { synthesizeSpeech } from '../services/tts/openaiCompat';
import { takeCompleteSentences } from '../services/speech/sentences';
import { getSecret } from '../platform/credentials';
import { avatarMouth } from './avatarBridge';
import { store } from './store';

const MAX_QUEUE = 6; // 有界队列：讲稿生成快于播报时背压截停上游（防讲十页囤十页音频）

interface QueuedSentence {
  text: string;
  generation: number;
}

class LectureSpeaker {
  #queue: QueuedSentence[] = [];
  #buffer = '';
  #generation = 0;
  #pumping = false;
  #abort: AbortController | null = null;
  #ctx: AudioContext | null = null;
  #pendingText = '';

  /** 讲课控制器 speak 注入点：done=false 为流式增量，done=true 为本页收尾。 */
  speak(text: string, meta: { page: number; done: boolean }): void {
    if (!this.#ttsReady()) return; // 无 TTS 配置：字幕兜底
    if (meta.done) {
      // 讲稿全文可能在 done 帧一次性到达（collectProviderText 形态）：
      // 与增量路径统一——全部进 buffer 再切句
      this.#buffer += this.#pendingText === text ? '' : text.slice(this.#pendingText.length);
      this.#pendingText = text;
    } else {
      this.#buffer += text;
      this.#pendingText += text;
    }
    const take = takeCompleteSentences(this.#buffer, { maxChars: 80 });
    this.#buffer = take.rest;
    for (const sentence of take.sentences) this.#enqueue(sentence);
    if (meta.done && this.#buffer.trim().length > 0) {
      this.#enqueue(this.#buffer);
      this.#buffer = '';
    }
    void this.#pump();
  }

  /** 换课/停止讲课/切页时调用：清空队列并中止在播音频。 */
  stop(): void {
    this.#generation += 1;
    this.#queue = [];
    this.#buffer = '';
    this.#pendingText = '';
    this.#abort?.abort();
    this.#abort = null;
    avatarMouth(0);
  }

  get speaking(): boolean {
    return this.#pumping || this.#queue.length > 0;
  }

  #ttsReady(): boolean {
    const s = store.providerSettings;
    return s.kind === 'openai' && !!s.ttsBaseUrl && !!s.ttsModel;
  }

  #enqueue(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (this.#queue.length >= MAX_QUEUE) this.#queue.shift(); // 背压：丢最旧未播（保最新内容）
    this.#queue.push({ text: clean, generation: this.#generation });
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      const s = store.providerSettings;
      const apiKey = (await getSecret('llmApiKey')) ?? '';
      while (this.#queue.length > 0) {
        const item = this.#queue[0]!;
        if (item.generation !== this.#generation) {
          this.#queue.shift();
          continue;
        }
        const controller = new AbortController();
        this.#abort = controller;
        try {
          const pcm = await synthesizeSpeech({
            baseUrl: s.ttsBaseUrl,
            model: s.ttsModel,
            apiKey,
            text: item.text,
            voice: s.ttsVoice,
            sampleRate: 24000,
            signal: controller.signal,
          });
          if (controller.signal.aborted || item.generation !== this.#generation) break;
          await this.#play(pcm, controller.signal);
        } catch (err) {
          if ((err as Error)?.name !== 'AbortError') {
            console.error('[vistaverge] lecture tts failed:', err);
          }
          break;
        } finally {
          this.#queue.shift();
        }
      }
    } finally {
      this.#pumping = false;
      avatarMouth(0);
    }
  }

  /** PCM 播放 + RMS 口型包络（与 VoiceSession 同一形态）。 */
  #play(pcm: Int16Array, signal: AbortSignal): Promise<void> {
    if (signal.aborted || pcm.length === 0) return Promise.resolve();
    this.#ctx ??= new AudioContext({ sampleRate: 24000 });
    const ctx = this.#ctx;
    const audio = ctx.createBuffer(1, pcm.length, 24000);
    const channel = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = audio;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    src.connect(analyser);
    analyser.connect(ctx.destination);

    const buf = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      if (signal.aborted) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      avatarMouth(Math.min(1, Math.sqrt(sum / buf.length) * 3.2));
    }, 40);

    src.start();
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearInterval(timer);
        avatarMouth(0);
        resolve();
      };
      signal.addEventListener(
        'abort',
        () => {
          try {
            src.stop();
          } catch {
            /* 已停 */
          }
          finish();
        },
        { once: true },
      );
      src.onended = finish;
    });
  }
}

/** 全局唯一讲课播报器（一次只讲一门课）。 */
export const lectureSpeaker = new LectureSpeaker();
