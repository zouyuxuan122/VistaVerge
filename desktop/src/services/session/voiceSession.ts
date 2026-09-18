// EXP-003 VoiceSession: the streaming voice main chain of VOICE.md §1–3 with
// capability negotiation. The batch engine (desktop/src/engine.ts) stays
// untouched as the explicit fallback; this session reuses its proven parts —
// the mic AudioWorklet capture, the batch STT/TTS HTTP shapes (services/stt,
// services/tts) and the same barge-in feel (5 voiced frames ≈ 200 ms during
// ai-speaking; during processing a single mic-open interrupts immediately).
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
}

interface Turn {
  controller: AbortController;
  generation: number;
}

const CHUNK_MS = 40;
const BARGE_IN_FRAMES = 5; // consecutive voiced frames (≈200 ms), engine parity
const GATE_OFF_DB = -66;

function abortError(): Error {
  return new DOMException('This operation was aborted', 'AbortError');
}

export class VoiceSession extends EventTarget {
  #settings: VoiceSessionSettings;
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

    if (this.#state === 'ai-speaking') {
      this.#voiceFrames = open ? this.#voiceFrames + 1 : 0;
      if (this.#voiceFrames >= BARGE_IN_FRAMES) {
        this.interrupt();
      } else {
        return;
      }
    }

    if (this.#state === 'processing') {
      // mic open during processing interrupts the turn immediately (EXP-003)
      if (open) this.interrupt();
      else return;
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
      this.dispatchEvent(
        new CustomEvent('user-turn', { detail: { text: userText, generation } }),
      );

      const messages: ChatMessage[] = [
        { role: 'system', content: this.#settings.instructions },
        // historyTurns=0 必须表示「不带历史」：slice(-0) 等于 slice(0)，会返回整个数组。
        ...(this.#historyTurnsKeep() === 0 ? [] : this.#history.slice(-this.#historyTurnsKeep())),
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
        const keep = this.#historyTurnsKeep();
        if (keep === 0) {
          this.#history = [];
        } else {
          this.#history.push({ role: 'user', content: userText }, { role: 'assistant', content: full });
          if (this.#history.length > keep) this.#history = this.#history.slice(-keep);
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
