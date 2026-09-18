// FND-002 behavior tests for CloudVoiceEngine signal / stop semantics.
//
// The real engine (desktop/src/engine.ts) is driven through its public
// start()/stop() API and the real AudioWorklet message port. The Tauri HTTP
// plugin fetch is mocked (no real network) and WebAudio / getUserMedia are
// faked (no real microphone, no real playback device). The bundled
// `mic-capture.js?url` import is left to Vite's own asset resolution; the tests
// only assert that whatever Vite resolved is what gets handed to addModule.
//
// These tests were written before the production fix (red first). They assert
// observable behavior, not implementation details: which AbortSignal reaches
// each fetch, whether late provider results can revive an idle engine, whether
// the multipart body is byte-exact, and whether playback is stopped once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudVoiceEngine } from '../../src/engine';
import type { EngineSettings } from '../../src/engine';

type FetchCall = {
  url: string;
  init: RequestInit & { body?: unknown; signal?: AbortSignal | undefined };
};

// vi.mock is hoisted above imports, so the shared state must be hoisted too.
const harness = vi.hoisted(() => {
  const calls: { url: string; init: RequestInit & { body?: unknown; signal?: AbortSignal | undefined } }[] = [];
  let handler: ((url: string, init: unknown) => Promise<unknown>) | null = null;
  return {
    calls,
    setHandler(fn: ((url: string, init: unknown) => Promise<unknown>) | null) {
      handler = fn;
    },
    invoke(url: string, init: FetchCall['init']) {
      calls.push({ url, init });
      if (!handler) return Promise.reject(new Error('no fetch handler installed'));
      return handler(url, init);
    },
  };
});

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: (input: unknown, init: unknown) =>
    harness.invoke(String(input), init as FetchCall['init']),
}));

// ── Fake WebAudio / media environment ────────────────────────────────────────

let sources: FakeBufferSource[] = [];
let workletNodes: FakeAudioWorkletNode[] = [];
let audioContexts: FakeAudioContext[] = [];
let mediaStreams: FakeMediaStream[] = [];
let buffers: { length: number; sampleRate: number; data: Float32Array }[] = [];

class FakeBufferSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  connections: unknown[] = [];
  /** When true, stop() synchronously fires onended (worst-case real behavior). */
  syncEndedOnStop = false;
  start() {
    this.startCalls += 1;
  }
  stop() {
    this.stopCalls += 1;
    if (this.syncEndedOnStop && this.onended) this.onended();
  }
  connect(node: unknown) {
    this.connections.push(node);
  }
}

class FakeAnalyser {
  fftSize = 0;
  getFloatTimeDomainData(_buf: Float32Array) {}
}

class FakeAudioContext {
  state = 'running';
  sampleRate: number;
  destination = {};
  closed = false;
  addedModules: string[] = [];
  audioWorklet: { addModule: (url: string) => Promise<void> };

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 16000;
    this.audioWorklet = {
      addModule: async (url: string) => {
        this.addedModules.push(url);
      },
    };
  }
  createMediaStreamSource(_stream: unknown) {
    return { connect() {} };
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    buffers.push({ length, sampleRate, data });
    return { length, sampleRate, numberOfChannels: 1, getChannelData: () => data };
  }
  createBufferSource() {
    const source = new FakeBufferSource();
    sources.push(source);
    return source;
  }
  async resume() {}
  async close() {
    this.closed = true;
    this.state = 'closed';
  }
}

class FakeAudioWorkletNode {
  ctx: unknown;
  name: string;
  port: {
    onmessage: ((event: { data: { pcm: Float32Array; rms: number } }) => void) | null;
    postMessage: () => void;
  };
  constructor(ctx: unknown, name: string) {
    this.ctx = ctx;
    this.name = name;
    this.port = { onmessage: null, postMessage() {} };
    workletNodes.push(this);
  }
  connect() {}
  disconnect() {}
}

class FakeMediaStream {
  tracks = [
    {
      enabled: true,
      stopCalls: 0,
      stop() {
        this.stopCalls += 1;
      },
    },
  ];
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

// ── HTTP response helpers ────────────────────────────────────────────────────

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function httpError(status: number, body = 'boom') {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  };
}

function pcmResponse(pcm: Int16Array) {
  const bytes = new Uint8Array(pcm.length * 2);
  new Int16Array(bytes.buffer).set(pcm);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(0),
    json: async () => ({}),
    text: async () => '',
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type RouteOverrides = {
  stt?: () => Promise<unknown>;
  llm?: () => Promise<unknown>;
  tts?: () => Promise<unknown>;
};

function router(overrides: RouteOverrides = {}) {
  return (url: string): Promise<unknown> => {
    if (url.includes('/audio/transcriptions')) {
      return (overrides.stt ?? (() => Promise.resolve(jsonResponse({ text: '你好' }))))();
    }
    if (url.includes('/chat/completions')) {
      return (
        overrides.llm ??
        (() => Promise.resolve(jsonResponse({ choices: [{ message: { content: '回复' } }] })))
      )();
    }
    if (url.includes('/audio/speech')) {
      return (overrides.tts ?? (() => Promise.resolve(pcmResponse(KNOWN_TTS_PCM))))();
    }
    return Promise.reject(new Error(`unexpected url: ${url}`));
  };
}

// ── Engine fixtures ──────────────────────────────────────────────────────────

const BASE_SETTINGS: EngineSettings = {
  stt: { baseUrl: 'https://stt.test/v1', model: 'whisper-1', apiKey: 'k' },
  llm: { baseUrl: 'https://llm.test/v1', model: 'chat-1', apiKey: 'k' },
  tts: { baseUrl: 'https://tts.test/v1', model: 'tts-1', apiKey: 'k' },
  ttsVoice: 'voice-a',
  ttsSampleRate: 16000,
  instructions: 'sys',
  gateDb: -66,
  minSilenceMs: 40,
  minSpeechMs: 0,
  speechPadMs: 0,
  audioInputId: '',
  historyTurns: 4,
};

const KNOWN_TTS_PCM = Int16Array.from([100, -100, 32767, -32768]);
const FRAME = 640;
const OPEN_SAMPLE = 0.5;
// 0.5 * 0x7fff truncated toward zero, exactly as the engine's Int16 conversion.
const OPEN_I16 = Math.trunc(OPEN_SAMPLE * 0x7fff);

const EXPECTED_UTTERANCE = (() => {
  const pcm = new Int16Array(FRAME * 2);
  for (let i = 0; i < FRAME; i++) pcm[i] = OPEN_I16;
  return pcm;
})();

function openFrame(): Float32Array {
  const frame = new Float32Array(FRAME);
  frame.fill(OPEN_SAMPLE);
  return frame;
}

function silentFrame(): Float32Array {
  return new Float32Array(FRAME);
}

/** Feed the real worklet port: one voiced frame then one silent frame. */
function speak(node: FakeAudioWorkletNode) {
  node.port.onmessage?.({ data: { pcm: openFrame(), rms: 0.5 } });
  node.port.onmessage?.({ data: { pcm: silentFrame(), rms: 0 } });
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

type Rig = {
  engine: CloudVoiceEngine;
  stateEvents: string[];
  events: { type: string; detail: unknown }[];
};

function makeRig(overrides: Partial<EngineSettings> = {}): Rig {
  const engine = new CloudVoiceEngine({ ...BASE_SETTINGS, ...overrides });
  const stateEvents: string[] = [];
  const events: { type: string; detail: unknown }[] = [];
  engine.addEventListener('state', (event) => {
    stateEvents.push((event as CustomEvent<{ state: string }>).detail.state);
  });
  for (const type of ['user-turn', 'reply', 'error']) {
    engine.addEventListener(type, (event) => {
      events.push({ type, detail: (event as CustomEvent<unknown>).detail });
    });
  }
  return { engine, stateEvents, events };
}

async function startRig(overrides: Partial<EngineSettings> = {}) {
  const rig = makeRig(overrides);
  await rig.engine.start();
  const node = workletNodes[workletNodes.length - 1];
  return { ...rig, node };
}

function textOf(events: Rig['events'], type: string): string[] {
  return events
    .filter((event) => event.type === type)
    .map((event) => (event.detail as { text?: string; message?: string }).text ?? '');
}

// ── Byte helpers for the multipart / WAV assertions ──────────────────────────

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function expectedWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

function bytesOf(body: unknown): Uint8Array {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error(`unexpected body type: ${Object.prototype.toString.call(body)}`);
}

// ── Environment ──────────────────────────────────────────────────────────────

beforeEach(() => {
  harness.calls.length = 0;
  harness.setHandler(router());
  sources = [];
  workletNodes = [];
  audioContexts = [];
  mediaStreams = [];
  buffers = [];

  class TrackedAudioContext extends FakeAudioContext {
    constructor(options?: { sampleRate?: number }) {
      super(options);
      audioContexts.push(this);
    }
  }
  vi.stubGlobal('AudioContext', TrackedAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        const stream = new FakeMediaStream();
        mediaStreams.push(stream);
        return stream;
      }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CloudVoiceEngine signal propagation and stop semantics', () => {
  it('start() drives the real worklet port and resolves the bundled worklet URL', async () => {
    const { engine, stateEvents, node } = await startRig();

    expect(engine.currentState).toBe('listening');
    expect(stateEvents).toEqual(['connecting', 'listening']);

    const ctx = audioContexts[0];
    expect(ctx.addedModules).toHaveLength(1);
    expect(typeof ctx.addedModules[0]).toBe('string');
    expect(ctx.addedModules[0]).toContain('mic-capture');

    expect(node.name).toBe('mic-capture');
    expect(typeof node.port.onmessage).toBe('function');

    const getUserMedia = navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>;
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  });

  it('sends STT, LLM and TTS with the same AbortSignal instance of the turn', async () => {
    const { engine, node, events } = await startRig();
    speak(node);
    await settle();

    expect(harness.calls.map((call) => call.url)).toEqual([
      'https://stt.test/v1/audio/transcriptions',
      'https://llm.test/v1/chat/completions',
      'https://tts.test/v1/audio/speech',
    ]);

    const signals = harness.calls.map((call) => call.init.signal);
    for (const signal of signals) {
      expect(signal).toBeDefined();
      expect(signal).toBeInstanceOf(AbortSignal);
      expect((signal as unknown as { abort?: unknown }).abort).toBeUndefined();
      expect(signal?.aborted).toBe(false);
    }
    expect(signals[0]).toBe(signals[1]);
    expect(signals[1]).toBe(signals[2]);

    expect(textOf(events, 'user-turn')).toEqual(['你好']);
    expect(textOf(events, 'reply')).toEqual(['回复']);

    const ttsBody = JSON.parse(String(harness.calls[2].init.body)) as Record<string, unknown>;
    expect(ttsBody).toMatchObject({ model: 'tts-1', input: '回复', response_format: 'pcm' });

    expect(engine.currentState).toBe('ai-speaking');
    const source = sources[sources.length - 1];
    expect(source.startCalls).toBe(1);
    expect(buffers[buffers.length - 1].length).toBe(KNOWN_TTS_PCM.length);
    expect(buffers[buffers.length - 1].data[0]).toBeCloseTo(100 / 32768, 6);
    expect(buffers[buffers.length - 1].data[3]).toBeCloseTo(-32768 / 32768, 6);

    source.onended?.();
    await settle();
    expect(engine.currentState).toBe('listening');
    expect(source.stopCalls).toBe(0);
  });

  it('STT multipart body is an exact-length WAV payload with no pool over-read', async () => {
    const { node } = await startRig();
    speak(node);
    await settle();

    const sttCall = harness.calls[0];
    expect(sttCall.url).toBe('https://stt.test/v1/audio/transcriptions');
    expect(sttCall.init.body).toBeInstanceOf(ArrayBuffer);

    const contentType = String(
      (sttCall.init.headers as Record<string, string>)['Content-Type'],
    );
    expect(contentType).toMatch(/^multipart\/form-data; boundary=----cybergirl[0-9a-f]+$/);
    const boundary = contentType.split('boundary=')[1];

    const body = bytesOf(sttCall.init.body);
    expect(body.byteLength).toBe((sttCall.init.body as ArrayBuffer).byteLength);

    const wav = expectedWav(EXPECTED_UTTERANCE, 16000);
    const fileMarker = new TextEncoder().encode('Content-Type: audio/wav\r\n\r\n');
    const markerIndex = indexOfBytes(body, fileMarker);
    expect(markerIndex).toBeGreaterThan(0);

    const headerText = new TextDecoder('latin1').decode(body.subarray(0, markerIndex));
    expect(headerText).toContain('name="model"\r\n\r\nwhisper-1');
    expect(headerText).toContain('name="language"\r\n\r\nzh');
    expect(headerText).toContain('name="response_format"\r\n\r\njson');
    expect(headerText).toContain('name="file"; filename="utterance.wav"');

    const payloadStart = markerIndex + fileMarker.length;
    const payload = body.subarray(payloadStart, payloadStart + wav.length);
    expect(Array.from(payload)).toEqual(Array.from(wav));

    // WAV container header fields.
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    expect(String.fromCharCode(...payload.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...payload.subarray(8, 12))).toBe('WAVE');
    expect(String.fromCharCode(...payload.subarray(12, 16))).toBe('fmt ');
    expect(String.fromCharCode(...payload.subarray(36, 40))).toBe('data');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(EXPECTED_UTTERANCE.length * 2);

    // Payload bytes exactly equal the utterance PCM, and the closing boundary is
    // the final bytes of the body: no trailing bytes from a reused pool buffer.
    const closing = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const closingIndex = indexOfBytes(body, closing);
    expect(closingIndex).toBe(payloadStart + wav.length);
    expect(body.byteLength).toBe(closingIndex + closing.length);
  });

  it('stop() during STT aborts the turn signal and suppresses late text, reply and follow-up requests', async () => {
    const stt = deferred<unknown>();
    harness.setHandler(router({ stt: () => stt.promise }));
    const { engine, node, events } = await startRig();

    speak(node);
    await settle();
    expect(harness.calls).toHaveLength(1);

    const signal = harness.calls[0].init.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await engine.stop();
    expect(signal?.aborted).toBe(true);
    expect(engine.currentState).toBe('idle');

    stt.resolve(jsonResponse({ text: '你好' }));
    await settle();

    expect(harness.calls).toHaveLength(1);
    expect(textOf(events, 'user-turn')).toEqual([]);
    expect(textOf(events, 'reply')).toEqual([]);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(engine.currentState).toBe('idle');
    expect(engine.currentState).toBe('idle');
  });

  it('late empty STT result after stop() does not revive idle state', async () => {
    const stt = deferred<unknown>();
    harness.setHandler(router({ stt: () => stt.promise }));
    const { engine, node, stateEvents } = await startRig();

    speak(node);
    await settle();
    await engine.stop();
    const eventsAfterStop = stateEvents.length;

    stt.resolve(jsonResponse({ text: '' }));
    await settle();

    expect(harness.calls).toHaveLength(1);
    expect(stateEvents.length).toBe(eventsAfterStop);
    expect(engine.currentState).toBe('idle');
  });

  it('stop() during LLM aborts the signal and never sends TTS or a late reply', async () => {
    const llm = deferred<unknown>();
    harness.setHandler(router({ llm: () => llm.promise }));
    const { engine, node, events } = await startRig();

    speak(node);
    await settle();
    expect(harness.calls).toHaveLength(2);

    const signal = harness.calls[1].init.signal;
    await engine.stop();
    expect(signal?.aborted).toBe(true);

    llm.resolve(jsonResponse({ choices: [{ message: { content: '回复' } }] }));
    await settle();

    expect(harness.calls).toHaveLength(2);
    expect(textOf(events, 'reply')).toEqual([]);
    expect(engine.currentState).toBe('idle');
  });

  it('late LLM result after stop() does not pollute history', async () => {
    const llm = deferred<unknown>();
    harness.setHandler(router({ llm: () => llm.promise }));
    const { engine, node } = await startRig();

    speak(node);
    await settle();
    await engine.stop();

    llm.resolve(jsonResponse({ choices: [{ message: { content: '迟到回复' } }] }));
    await settle();

    const history = Reflect.get(engine, 'history') as unknown[];
    expect(history).toEqual([]);
  });

  it('late LLM rejection after stop() does not emit error or revive state', async () => {
    const llm = deferred<unknown>();
    harness.setHandler(router({ llm: () => llm.promise }));
    const { engine, node, events } = await startRig();

    speak(node);
    await settle();
    await engine.stop();

    llm.reject(new Error('llm down'));
    await settle();

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(engine.currentState).toBe('idle');
  });

  it('stop() during TTS aborts the signal and never starts playback', async () => {
    const tts = deferred<unknown>();
    harness.setHandler(router({ tts: () => tts.promise }));
    const { engine, node, events } = await startRig();

    speak(node);
    await settle();
    expect(harness.calls).toHaveLength(3);

    const signal = harness.calls[2].init.signal;
    await engine.stop();
    expect(signal?.aborted).toBe(true);

    tts.resolve(pcmResponse(KNOWN_TTS_PCM));
    await settle();

    expect(harness.calls).toHaveLength(3);
    expect(sources).toHaveLength(0);
    expect(engine.currentState).toBe('idle');
    expect(events.some((event) => event.type === 'reply')).toBe(true);
  });

  it('late TTS rejection after stop() does not emit error or revive state', async () => {
    const tts = deferred<unknown>();
    harness.setHandler(router({ tts: () => tts.promise }));
    const { engine, node, events } = await startRig();

    speak(node);
    await settle();
    await engine.stop();

    tts.reject(new Error('tts down'));
    await settle();

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(engine.currentState).toBe('idle');
  });

  it('an STT HTTP error while not aborted still surfaces an error and returns to listening', async () => {
    harness.setHandler(router({ stt: () => Promise.resolve(httpError(500, 'stt boom')) }));
    const { engine, node, events } = await startRig();

    speak(node);
    await settle();

    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(engine.currentState).toBe('listening');
  });

  it('playback abort stops the source exactly once and settles its promise', async () => {
    const { engine } = await startRig();
    const play = Reflect.get(engine, '_play') as (
      pcm: Int16Array,
      sampleRate: number,
      signal: AbortSignal,
    ) => Promise<void>;

    const controller = new AbortController();
    const promise = play.call(engine, Int16Array.from([1, 2, 3, 4]), 16000, controller.signal);

    expect(engine.currentState).toBe('ai-speaking');
    const source = sources[sources.length - 1];
    expect(source.startCalls).toBe(1);

    controller.abort();
    await expect(promise).resolves.toBeUndefined();
    expect(source.stopCalls).toBe(1);

    await engine.stop();
    expect(source.stopCalls).toBe(1);
    expect(engine.currentState).toBe('idle');
  });

  it('engine.stop() during playback stops once even when stop() fires onended synchronously, and repeated stop is safe', async () => {
    const { engine, node } = await startRig();
    speak(node);
    await settle();

    expect(engine.currentState).toBe('ai-speaking');
    const source = sources[sources.length - 1];
    source.syncEndedOnStop = true;

    await engine.stop();
    expect(source.stopCalls).toBe(1);
    expect(engine.currentState).toBe('idle');

    await expect(engine.stop()).resolves.toBeUndefined();
    await expect(engine.stop()).resolves.toBeUndefined();
    expect(source.stopCalls).toBe(1);
    expect(engine.currentState).toBe('idle');
  });

  it('stop() detaches the worklet so late frames cannot request or revive state', async () => {
    const { engine, node, stateEvents } = await startRig();
    const lateHandler = node.port.onmessage;

    await engine.stop();
    expect(node.port.onmessage).toBeNull();
    const eventsAfterStop = stateEvents.length;

    lateHandler?.({ data: { pcm: openFrame(), rms: 0.5 } });
    lateHandler?.({ data: { pcm: silentFrame(), rms: 0 } });
    await settle();

    expect(harness.calls).toHaveLength(0);
    expect(stateEvents.length).toBe(eventsAfterStop);
    expect(engine.currentState).toBe('idle');
  });

  it('repeated stop() on an idle engine resolves without throwing', async () => {
    const { engine } = await startRig();

    await expect(engine.stop()).resolves.toBeUndefined();
    await expect(engine.stop()).resolves.toBeUndefined();
    await expect(engine.stop()).resolves.toBeUndefined();
    expect(engine.currentState).toBe('idle');
  });
});
