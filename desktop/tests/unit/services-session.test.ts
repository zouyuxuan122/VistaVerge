// EXP-003 behavior tests for VoiceSession: the six-state streaming session
// (idle/connecting/listening/user-speaking/processing/ai-speaking), GenerationGate
// wiring, sentence-level TTS queueing, the playback ledger, bounded-queue
// backpressure against the LLM stream, and barge-in interrupts (mic open during
// processing aborts the turn and advances the generation; ai-speaking uses the
// same 5-frame debounce as the batch engine).
//
// The real worklet port drives VAD (same rig style as engine-abort.test.ts);
// LLM provider, STT, TTS and playback are injected fakes (no network, no audio).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaybackLedger } from '../../src/services/speech/ledger';
import { VoiceSession } from '../../src/services/session/voiceSession';
import type { VoiceSessionSettings } from '../../src/services/session/voiceSession';
import type { ChatChunk, ChatMessage, LlmProvider, StreamChatArgs } from '../../src/services/llm/provider';

// ── fake WebAudio / media environment ────────────────────────────────────────

let workletNodes: FakeAudioWorkletNode[] = [];
let audioContexts: FakeAudioContext[] = [];
let mediaStreams: FakeMediaStream[] = [];

class FakeAudioContext {
  state = 'running';
  sampleRate = 16000;
  destination = {};
  closed = false;
  addedModules: string[] = [];
  audioWorklet = {
    addModule: async (url: string) => {
      this.addedModules.push(url);
    },
  };
  constructor() {
    audioContexts.push(this);
  }
  createMediaStreamSource(_stream: unknown) {
    return { connect() {} };
  }
  async resume() {}
  async close() {
    this.closed = true;
    this.state = 'closed';
  }
}

class FakeAudioWorkletNode {
  name: string;
  port: {
    onmessage: ((event: { data: { pcm: Float32Array; rms: number } }) => void) | null;
    postMessage: () => void;
  };
  constructor(_ctx: unknown, name: string) {
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

// ── fake provider ─────────────────────────────────────────────────────────────

class FakeProvider implements LlmProvider {
  readonly mock = false;
  streaming = true;
  streamCalls: { messages: ChatMessage[]; signal: AbortSignal }[] = [];
  pullCount = 0;
  #pending: IteratorResult<ChatChunk>[] = [];
  #waiters: ((result: IteratorResult<ChatChunk>) => void)[] = [];

  capabilities() {
    return { streaming: this.streaming };
  }

  async *streamChat(args: StreamChatArgs): AsyncGenerator<ChatChunk> {
    this.streamCalls.push({ messages: args.messages, signal: args.signal });
    for (;;) {
      this.pullCount += 1;
      const next = await new Promise<IteratorResult<ChatChunk>>((resolve) => {
        if (this.#pending.length > 0) resolve(this.#pending.shift()!);
        else this.#waiters.push(resolve);
      });
      if (args.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (next.done) return;
      yield next.value as ChatChunk;
    }
  }

  push(chunk: ChatChunk) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: chunk });
    else this.#pending.push({ done: false, value: chunk });
  }

  finish() {
    const done: IteratorResult<ChatChunk> = { done: true, value: undefined };
    const waiter = this.#waiters.shift();
    if (waiter) waiter(done);
    else this.#pending.push(done);
  }
}

class FakeBatchProvider extends FakeProvider {
  streaming = false;
}

// ── fake audio deps (STT / TTS / playback gates) ─────────────────────────────

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

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function pcmFor(text: string): Int16Array {
  return Int16Array.from(Array.from(text).map((_, i) => (i + 1) * 7));
}

type AudioRig = {
  deps: Pick<
    import('../../src/services/session/voiceSession').VoiceSessionDeps,
    'transcribe' | 'synthesize' | 'play'
  >;
  transcribeCalls: { pcm: Int16Array; signal: AbortSignal }[];
  sttGates: Deferred<string>[];
  synthesizeCalls: { text: string; signal: AbortSignal }[];
  synGates: Deferred<void>[];
  playCalls: { pcm: Int16Array; signal: AbortSignal }[];
  playGates: Deferred<void>[];
};

function makeAudioRig(): AudioRig {
  const rig: AudioRig = {
    deps: null as unknown as AudioRig['deps'],
    transcribeCalls: [],
    sttGates: [],
    synthesizeCalls: [],
    synGates: [],
    playCalls: [],
    playGates: [],
  };
  rig.deps = {
    transcribe: async (pcm: Int16Array, signal: AbortSignal) => {
      rig.transcribeCalls.push({ pcm, signal });
      const gate = deferred<string>();
      rig.sttGates.push(gate);
      return gate.promise;
    },
    synthesize: async (text: string, signal: AbortSignal) => {
      rig.synthesizeCalls.push({ text, signal });
      const gate = deferred<void>();
      rig.synGates.push(gate);
      await gate.promise;
      if (signal.aborted) throw Object.assign(new Error('syn aborted'), { name: 'AbortError' });
      return pcmFor(text);
    },
    play: async (pcm: Int16Array, signal: AbortSignal) => {
      rig.playCalls.push({ pcm, signal });
      const gate = deferred<void>();
      rig.playGates.push(gate);
      await gate.promise;
    },
  };
  return rig;
}

// ── fixtures & frame helpers ─────────────────────────────────────────────────

const SETTINGS: VoiceSessionSettings = {
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

const FRAME = 640;

function openFrame(): Float32Array {
  const frame = new Float32Array(FRAME);
  frame.fill(0.5);
  return frame;
}

function silentFrame(): Float32Array {
  return new Float32Array(FRAME);
}

function lastNode(): FakeAudioWorkletNode {
  const node = workletNodes[workletNodes.length - 1];
  if (!node) throw new Error('no worklet node created');
  return node;
}

function feed(node: FakeAudioWorkletNode, pcm: Float32Array, rms: number) {
  node.port.onmessage?.({ data: { pcm, rms } });
}

function speakOnce(node: FakeAudioWorkletNode) {
  feed(node, openFrame(), 0.5);
  feed(node, silentFrame(), 0);
}

type EventRecord = { type: string; detail: Record<string, unknown> };

function recorder(session: VoiceSession, types: string[]): EventRecord[] {
  const events: EventRecord[] = [];
  for (const type of types) {
    session.addEventListener(type, (event) => {
      events.push({ type, detail: (event as CustomEvent<Record<string, unknown>>).detail });
    });
  }
  return events;
}

async function startSession(session: VoiceSession) {
  await session.start();
  return lastNode();
}

// ── environment ──────────────────────────────────────────────────────────────

beforeEach(() => {
  workletNodes = [];
  audioContexts = [];
  mediaStreams = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
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

// ── tests ────────────────────────────────────────────────────────────────────

describe('VoiceSession lifecycle and capability surface', () => {
  it('start() drives the worklet port, reports connecting->listening and emits input levels', async () => {
    const session = new VoiceSession(SETTINGS, { provider: new FakeProvider(), ...makeAudioRig().deps });
    const events = recorder(session, ['state', 'input-level']);
    const node = await startSession(session);

    expect(session.currentState).toBe('listening');
    expect(events.filter((e) => e.type === 'state').map((e) => e.detail.state)).toEqual([
      'connecting',
      'listening',
    ]);
    expect(audioContexts[0].addedModules[0]).toContain('mic-capture');
    expect(mediaStreams).toHaveLength(1);
    expect(typeof node.port.onmessage).toBe('function');

    feed(node, openFrame(), 0.5);
    expect(events.filter((e) => e.type === 'input-level').map((e) => e.detail.rms)).toEqual([0.5]);

    await session.stop();
  });

  it('exposes the negotiated llm path: streaming vs batch (VOICE.md §2 能力协商)', async () => {
    const streaming = new VoiceSession(SETTINGS, { provider: new FakeProvider(), ...makeAudioRig().deps });
    const batch = new VoiceSession(SETTINGS, { provider: new FakeBatchProvider(), ...makeAudioRig().deps });
    expect(streaming.llmPath).toBe('streaming');
    expect(batch.llmPath).toBe('batch');
    await streaming.stop();
    await batch.stop();
  });
});

describe('VoiceSession streaming turn', () => {
  it('runs STT -> streaming LLM -> sentence TTS with ledger and history, returning to listening', async () => {
    const rig = makeAudioRig();
    const provider = new FakeProvider();
    const session = new VoiceSession(SETTINGS, { provider, ...rig.deps });
    const events = recorder(session, [
      'state',
      'user-turn',
      'reply-delta',
      'reply',
      'sentence',
      'turn-settled',
    ]);
    const node = await startSession(session);

    speakOnce(node);
    await settle();
    expect(session.currentState).toBe('processing');
    expect(session.generation).toBe(1);

    rig.sttGates[0].resolve('你好');
    await settle();
    expect(events.filter((e) => e.type === 'user-turn')).toEqual([
      { type: 'user-turn', detail: { text: '你好', generation: 1 } },
    ]);
    expect(rig.transcribeCalls[0].pcm.length).toBe(2 * FRAME);
    expect(provider.streamCalls[0].messages).toEqual<ChatMessage[]>([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你好' },
    ]);

    provider.push({ delta: '你好。' });
    await settle();
    provider.push({ delta: '今天天气' });
    await settle();
    provider.push({ delta: '不错。' });
    await settle();
    provider.finish();
    await settle();

    expect(events.filter((e) => e.type === 'reply-delta').map((e) => e.detail.text)).toEqual([
      '你好。',
      '今天天气',
      '不错。',
    ]);
    expect(events.filter((e) => e.type === 'sentence')).toEqual([
      { type: 'sentence', detail: { text: '你好。', index: 0, generation: 1 } },
      { type: 'sentence', detail: { text: '今天天气不错。', index: 1, generation: 1 } },
    ]);
    expect(events.filter((e) => e.type === 'reply')).toEqual([
      { type: 'reply', detail: { text: '你好。今天天气不错。', generation: 1 } },
    ]);
    expect(session.history).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好。今天天气不错。' },
    ]);

    // sentence audio flows through synthesize/play gates in order
    rig.synGates[0].resolve();
    await settle();
    expect(session.currentState).toBe('ai-speaking');
    rig.playGates[0].resolve();
    await settle();
    rig.synGates[1].resolve();
    await settle();
    rig.playGates[1].resolve();
    await settle();

    expect(session.currentState).toBe('listening');
    expect(session.ledger.playedThrough()).toBe(2);
    expect(events.filter((e) => e.type === 'state').map((e) => e.detail.state)).toEqual([
      'connecting',
      'listening',
      'user-speaking',
      'processing',
      'ai-speaking',
      'listening',
    ]);
    expect(events.filter((e) => e.type === 'turn-settled')).toHaveLength(1);

    await session.stop();
  });

  it('a batch provider (capabilities().streaming=false) still completes the turn as one sentence', async () => {
    const rig = makeAudioRig();
    const provider = new FakeBatchProvider();
    const session = new VoiceSession(SETTINGS, { provider, ...rig.deps });
    const events = recorder(session, ['sentence', 'reply']);
    const node = await startSession(session);

    speakOnce(node);
    await settle();
    rig.sttGates[0].resolve('你好');
    await settle();
    provider.push({ delta: '整段回复，一次给完。' });
    await settle();
    provider.finish();
    await settle();

    expect(events.filter((e) => e.type === 'sentence').map((e) => e.detail.text)).toEqual([
      '整段回复，一次给完。',
    ]);
    expect(events.filter((e) => e.type === 'reply').map((e) => e.detail.text)).toEqual([
      '整段回复，一次给完。',
    ]);

    // synthesize's promise must settle before play() is invoked — resolve the
    // play gate only after the queue actually entered playback for that item
    rig.synGates[0].resolve();
    await settle();
    rig.playGates[0].resolve();
    await settle();
    expect(session.currentState).toBe('listening');
    await session.stop();
  });

  it('an empty STT result returns to listening without calling the provider', async () => {
    const rig = makeAudioRig();
    const provider = new FakeProvider();
    const session = new VoiceSession(SETTINGS, { provider, ...rig.deps });
    const node = await startSession(session);

    speakOnce(node);
    await settle();
    rig.sttGates[0].resolve('   ');
    await settle();

    expect(session.currentState).toBe('listening');
    expect(provider.streamCalls).toHaveLength(0);
    await session.stop();
  });

  it('an STT failure emits an error event and returns to listening', async () => {
    const rig = makeAudioRig();
    const provider = new FakeProvider();
    const session = new VoiceSession(SETTINGS, { provider, ...rig.deps });
    const events = recorder(session, ['error', 'user-turn']);
    const node = await startSession(session);

    speakOnce(node);
    await settle();
    rig.sttGates[0].reject(new Error('stt down'));
    await settle();

    expect(events.filter((e) => e.type === 'error').map((e) => e.detail.message)).toEqual(['stt down']);
    expect(events.filter((e) => e.type === 'user-turn')).toEqual([]);
    expect(session.currentState).toBe('listening');
    expect(provider.streamCalls).toHaveLength(0);
    await session.stop();
  });
});

describe('VoiceSession backpressure (bounded queue pauses the upstream)', () => {
  it('stops pulling LLM deltas while the queue is full and resumes after drain', async () => {
    const rig = makeAudioRig();
    const provider = new FakeProvider();
    const session = new VoiceSession(
      { ...SETTINGS, queueCapacity: 1 },
      { provider, ...rig.deps },
    );
    const node = await startSession(session);

    speakOnce(node);
    await settle();
    rig.sttGates[0].resolve('你好');
    await settle();

    provider.push({ delta: '一。' });
    await settle();
    // sentence 0 fills the capacity-1 queue: upstream must be paused before pulling delta 2
    expect(provider.pullCount).toBe(1);
    expect(rig.synthesizeCalls.map((c) => c.text)).toEqual(['一。']);
    expect(rig.playCalls).toHaveLength(0);

    rig.synGates[0].resolve();
    await settle();
    rig.playGates[0].resolve();
    await settle();
    // queue drained below capacity: upstream resumes and delta 2 is pulled
    expect(provider.pullCount).toBe(2);

    provider.push({ delta: '二。' });
    await settle();
    expect(rig.synthesizeCalls.map((c) => c.text)).toEqual(['一。', '二。']);
    expect(session.ledger.playedThrough()).toBe(1);

    provider.finish();
    rig.synGates[1].resolve();
    await settle();
    rig.playGates[1].resolve();
    await settle();
    expect(session.currentState).toBe('listening');
    expect(session.ledger.playedThrough()).toBe(2);
    await session.stop();
  });
});

describe('VoiceSession interrupts (barge-in)', () => {
  it('mic open during processing aborts the turn, advances the generation and discards late STT', async () => {
    const rig = makeAudioRig();
    const provider = new FakeProvider();
    const session = new VoiceSession(SETTINGS, { provider, ...rig.deps });
    const events = recorder(session, ['state', 'user-turn', 'interrupt']);
    const node = await startSession(session);

    speakOnce(node);
    await settle();
    expect(session.generation).toBe(1);

    feed(node, openFrame(), 0.5);
    expect(session.currentState).toBe('user-speaking');
    expect(session.generation).toBe(2);
    expect(events.filter((e) => e.type === 'interrupt')).toEqual([
      { type: 'interrupt', detail: { generation: 2 } },
    ]);
    expect(rig.transcribeCalls[0].signal.aborted).toBe(true);

    // late STT result must not open a provider turn
    rig.sttGates[0].resolve('迟到文本');
    await settle();
    expect(events.filter((e) => e.type === 'user-turn')).toEqual([]);
    expect(provider.streamCalls).toHaveLength(0);

    // the new utterance (prepad kept the interrupting frame) completes into a fresh turn
    feed(node, silentFrame(), 0);
    await settle();
    expect(session.currentState).toBe('processing');
    expect(session.generation).toBe(3);
    rig.sttGates[1].resolve('新话');
    await settle();
    expect(events.filter((e) => e.type === 'user-turn')).toEqual([
      { type: 'user-turn', detail: { text: '新话', generation: 3 } },
    ]);

    await session.stop();
  });

  it('ai-speaking barge-in needs the same 5-frame debounce as the batch engine, then aborts playback and drops late deltas', async () => {
    const rig = makeAudioRig();
    const provider = new FakeProvider();
    const session = new VoiceSession(SETTINGS, { provider, ...rig.deps });
    const events = recorder(session, ['state', 'sentence', 'reply', 'interrupt', 'turn-settled']);
    const node = await startSession(session);

    speakOnce(node);
    await settle();
    rig.sttGates[0].resolve('你好');
    await settle();
    provider.push({ delta: '你好。' });
    await settle();
    rig.synGates[0].resolve();
    await settle();
    expect(session.currentState).toBe('ai-speaking');

    for (let i = 0; i < 4; i += 1) {
      feed(node, openFrame(), 0.5);
    }
    expect(session.currentState).toBe('ai-speaking');
    expect(session.generation).toBe(1);
    expect(rig.playCalls[0].signal.aborted).toBe(false);

    feed(node, openFrame(), 0.5);
    expect(session.currentState).toBe('user-speaking');
    expect(session.generation).toBe(2);
    expect(rig.playCalls[0].signal.aborted).toBe(true);
    expect(session.ledger.playedThrough()).toBe(0);

    // late delta of the old generation is discarded: no reply, no history, no new sentence
    provider.push({ delta: '再见。' });
    await settle();
    expect(events.filter((e) => e.type === 'sentence').map((e) => e.detail.text)).toEqual(['你好。']);
    expect(events.filter((e) => e.type === 'reply')).toEqual([]);
    expect(session.history).toEqual([]);

    provider.finish();
    await settle();

    // silence ends the new utterance -> fresh processing turn
    feed(node, silentFrame(), 0);
    await settle();
    expect(session.currentState).toBe('processing');
    rig.sttGates[1].resolve('新话');
    await settle();
    expect(provider.streamCalls).toHaveLength(2);

    await session.stop();
  });

  it('the ledger watermark survives an abort: playedThrough never regresses', async () => {
    const rig = makeAudioRig();
    const provider = new FakeProvider();
    const session = new VoiceSession(SETTINGS, { provider, ...rig.deps });
    const node = await startSession(session);

    speakOnce(node);
    await settle();
    rig.sttGates[0].resolve('数到三');
    await settle();
    provider.push({ delta: '一。' });
    provider.push({ delta: '二。' });
    provider.push({ delta: '三。' });
    provider.finish();
    await settle();

    rig.synGates[0].resolve();
    await settle();
    rig.playGates[0].resolve();
    await settle();
    rig.synGates[1].resolve();
    await settle();
    rig.playGates[1].resolve();
    await settle();
    rig.synGates[2].resolve();
    await settle(); // sentence 3 playing now

    expect(session.ledger.playedThrough()).toBe(2);
    session.interrupt();
    expect(session.ledger.playedThrough()).toBe(2);
    expect(session.ledger.counts()).toEqual({ queued: 3, played: 2, aborted: 1 });
    expect(session.currentState).toBe('listening');

    await session.stop();
  });

  it('interrupt() is idempotent when there is nothing to cancel', () => {
    const session = new VoiceSession(SETTINGS, { provider: new FakeProvider(), ...makeAudioRig().deps });
    const generation = session.generation;
    expect(() => session.interrupt()).not.toThrow();
    expect(session.generation).toBe(generation);
    expect(session.currentState).toBe('idle');
  });
});

describe('VoiceSession stop semantics', () => {
  it('stop() during processing aborts STT, advances the generation and detaches the mic', async () => {
    const rig = makeAudioRig();
    const provider = new FakeProvider();
    const session = new VoiceSession(SETTINGS, { provider, ...rig.deps });
    const events = recorder(session, ['user-turn', 'state']);
    const node = await startSession(session);

    speakOnce(node);
    await settle();
    const onmessage = node.port.onmessage;

    await session.stop();
    expect(session.currentState).toBe('idle');
    expect(session.generation).toBe(2);
    expect(rig.transcribeCalls[0].signal.aborted).toBe(true);

    rig.sttGates[0].resolve('迟到');
    await settle();
    expect(events.filter((e) => e.type === 'user-turn')).toEqual([]);
    expect(provider.streamCalls).toHaveLength(0);

    // late frames cannot revive anything
    expect(node.port.onmessage).toBeNull();
    onmessage?.({ data: { pcm: openFrame(), rms: 0.5 } });
    await settle();
    expect(session.currentState).toBe('idle');
    expect(node.port.onmessage).toBeNull();
    expect(mediaStreams[0].tracks[0].stopCalls).toBe(1);
    expect(audioContexts[0].closed).toBe(true);
  });

  it('stop() during playback aborts the playing signal exactly once', async () => {
    const rig = makeAudioRig();
    const provider = new FakeProvider();
    const session = new VoiceSession(SETTINGS, { provider, ...rig.deps });
    const node = await startSession(session);

    speakOnce(node);
    await settle();
    rig.sttGates[0].resolve('你好');
    await settle();
    provider.push({ delta: '你好。' });
    provider.finish();
    await settle();
    rig.synGates[0].resolve();
    await settle();
    expect(session.currentState).toBe('ai-speaking');

    await session.stop();
    expect(rig.playCalls[0].signal.aborted).toBe(true);
    expect(session.currentState).toBe('idle');

    rig.playGates[0].resolve();
    await settle();
    expect(session.currentState).toBe('idle');
  });

  it('repeated stop() on an idle session resolves without throwing', async () => {
    const session = new VoiceSession(SETTINGS, { provider: new FakeProvider(), ...makeAudioRig().deps });
    await session.start();
    await expect(session.stop()).resolves.toBeUndefined();
    await expect(session.stop()).resolves.toBeUndefined();
    expect(session.currentState).toBe('idle');
  });
});

describe('VoiceSession ledger exposure', () => {
  it('exposes a fresh PlaybackLedger per turn', async () => {
    const rig = makeAudioRig();
    const provider = new FakeProvider();
    const session = new VoiceSession(SETTINGS, { provider, ...rig.deps });
    const node = await startSession(session);

    const first: PlaybackLedger = session.ledger;
    speakOnce(node);
    await settle();
    expect(session.ledger).not.toBe(first);
    expect(session.ledger.playedThrough()).toBe(0);
    await session.stop();
  });
});
