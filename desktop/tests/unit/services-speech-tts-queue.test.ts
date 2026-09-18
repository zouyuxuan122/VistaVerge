// EXP-003 behavior tests for the bounded TTS queue (VOICE.md §3.4: bounded
// audio channel with backpressure — pause the upstream producer when full,
// never drop speech frames; §3.1: cancellation invalidates a whole generation).
//
// Capacity counts queued + in-flight sentences. Crossing it emits
// backpressure {paused:true}; dropping below it emits {paused:false}.
// cancel(generation) aborts in-flight playback and drops everything with
// generation <= the canceled one; later enqueues with a stale generation are
// dropped as well.
import { describe, expect, it } from 'vitest';

import { TtsQueue } from '../../src/services/speech/ttsQueue';
import type { TtsQueueDeps } from '../../src/services/speech/ttsQueue';

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
  return Int16Array.from(Array.from(text).map((_, i) => (i + 1) * 11));
}

type Rig = {
  deps: TtsQueueDeps;
  synthesizeCalls: { text: string; signal: AbortSignal }[];
  playCalls: { pcm: Int16Array; signal: AbortSignal }[];
  synGates: Deferred<void>[];
  playGates: Deferred<void>[];
  failNextSynthesizeWith: Error | null;
};

function makeRig(): Rig {
  const rig: Rig = {
    deps: null as unknown as TtsQueueDeps,
    synthesizeCalls: [],
    playCalls: [],
    synGates: [],
    playGates: [],
    failNextSynthesizeWith: null,
  };
  rig.deps = {
    synthesize: async (text: string, signal: AbortSignal) => {
      rig.synthesizeCalls.push({ text, signal });
      const failure = rig.failNextSynthesizeWith;
      rig.failNextSynthesizeWith = null;
      if (failure) throw failure;
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

type EventRecord = { type: string; detail: Record<string, unknown> };

function recordEvents(queue: TtsQueue, types: string[]): EventRecord[] {
  const events: EventRecord[] = [];
  for (const type of types) {
    queue.addEventListener(type, (event) => {
      events.push({ type, detail: (event as CustomEvent<Record<string, unknown>>).detail });
    });
  }
  return events;
}

describe('TtsQueue sequential playback', () => {
  it('synthesizes and plays strictly one sentence at a time, in enqueue order', async () => {
    const rig = makeRig();
    const queue = new TtsQueue({ ...rig.deps });
    const drained = queue.whenDrained();

    queue.enqueue('甲。', 1);
    queue.enqueue('乙。', 1);
    queue.enqueue('丙。', 1);
    await settle();

    expect(rig.synthesizeCalls.map((c) => c.text)).toEqual(['甲。']);
    expect(rig.playCalls).toHaveLength(0);
    expect(queue.stats()).toMatchObject({ queued: 2, playing: true, played: 0, dropped: 0 });

    rig.synGates[0].resolve();
    await settle();
    expect(rig.playCalls.map((c) => c.pcm)).toEqual([pcmFor('甲。')]);
    expect(rig.synthesizeCalls.map((c) => c.text)).toEqual(['甲。']);

    rig.playGates[0].resolve();
    await settle();
    expect(rig.synthesizeCalls.map((c) => c.text)).toEqual(['甲。', '乙。']);

    rig.synGates[1].resolve();
    await settle();
    rig.playGates[1].resolve();
    await settle();
    rig.synGates[2].resolve();
    await settle();
    rig.playGates[2].resolve();
    await settle();
    await expect(drained).resolves.toBeUndefined();

    expect(rig.playCalls.map((c) => c.pcm)).toEqual([pcmFor('甲。'), pcmFor('乙。'), pcmFor('丙。')]);
    expect(queue.stats()).toMatchObject({ queued: 0, playing: false, played: 3, dropped: 0, errors: 0 });
  });

  it('fires the audio event with sentence/generation before each playback and supports onAudio unsubscribe', async () => {
    const rig = makeRig();
    const queue = new TtsQueue({ ...rig.deps });
    const audio: { sentence: string; generation: number; seq: number }[] = [];
    const off = queue.onAudio((detail) => audio.push({ ...detail }));

    queue.enqueue('一。', 5);
    queue.enqueue('二。', 6);
    rig.synGates[0].resolve();
    await settle();
    expect(audio).toEqual([{ sentence: '一。', generation: 5, seq: 0 }]);

    off();
    rig.playGates[0].resolve();
    await settle();
    rig.synGates[1].resolve();
    await settle();
    expect(audio).toHaveLength(1);
    // playback still proceeded normally after unsubscribing
    rig.playGates[1].resolve();
    await settle();
    expect(queue.stats().played).toBe(2);
  });

  it('ignores empty or whitespace-only sentences', async () => {
    const rig = makeRig();
    const queue = new TtsQueue({ ...rig.deps });
    queue.enqueue('   ', 1);
    await settle();
    expect(queue.stats()).toMatchObject({ queued: 0, playing: false });
    expect(rig.synthesizeCalls).toHaveLength(0);
  });
});

describe('TtsQueue backpressure', () => {
  it('pauses the upstream when full and resumes below capacity, without dropping frames', async () => {
    const rig = makeRig();
    const queue = new TtsQueue({ ...rig.deps, capacity: 2 });
    const backpressure: boolean[] = [];
    queue.addEventListener('backpressure', (event) => {
      backpressure.push((event as CustomEvent<{ paused: boolean }>).detail.paused);
    });

    queue.enqueue('一。', 1);
    queue.enqueue('二。', 1);
    expect(backpressure).toEqual([true]);
    expect(queue.stats().paused).toBe(true);

    queue.enqueue('三。', 1);
    queue.enqueue('四。', 1);
    expect(backpressure).toEqual([true]); // no duplicate pause events while saturated

    rig.synGates[0].resolve();
    await settle();
    rig.playGates[0].resolve();
    await settle();
    expect(backpressure).toEqual([true]); // 3 sentences still in system: stay paused
    expect(queue.stats().paused).toBe(true);

    rig.synGates[1].resolve();
    await settle();
    rig.playGates[1].resolve();
    await settle();
    expect(backpressure).toEqual([true]); // 2 in system: still at capacity

    rig.synGates[2].resolve();
    await settle();
    rig.playGates[2].resolve();
    await settle();
    expect(backpressure).toEqual([true, false]); // 1 in system: upstream may resume
    expect(queue.stats().paused).toBe(false);

    rig.synGates[3].resolve();
    await settle();
    rig.playGates[3].resolve();
    await settle();
    expect(queue.stats()).toMatchObject({ played: 4, dropped: 0 });
  });
});

describe('TtsQueue cancel and generations', () => {
  it('cancel aborts in-flight synthesis, aborts current playback and drops queued old-generation items', async () => {
    const rig = makeRig();
    const queue = new TtsQueue({ ...rig.deps });
    const events = recordEvents(queue, ['aborted', 'dropped', 'played', 'audio']);

    queue.enqueue('甲。', 7);
    queue.enqueue('乙。', 7);
    await settle();
    expect(rig.synthesizeCalls[0].signal.aborted).toBe(false);

    queue.cancel(7);
    expect(events).toEqual([
      { type: 'aborted', detail: expect.objectContaining({ sentence: '甲。', generation: 7 }) },
      { type: 'dropped', detail: expect.objectContaining({ sentence: '乙。', generation: 7, reason: 'canceled' }) },
    ]);
    expect(rig.synthesizeCalls[0].signal.aborted).toBe(true);
    expect(queue.stats()).toMatchObject({ queued: 0, playing: false, played: 0, dropped: 2 });

    rig.synGates[0].resolve();
    await settle();
    expect(rig.playCalls).toHaveLength(0);
    await expect(queue.whenDrained()).resolves.toBeUndefined();

    // a newer generation still plays after the cancel
    queue.enqueue('丙。', 8);
    rig.synGates[1].resolve();
    await settle();
    rig.playGates[0].resolve();
    await settle();
    expect(queue.stats()).toMatchObject({ played: 1, dropped: 2 });
  });

  it('cancel during playback aborts the playing signal exactly once', async () => {
    const rig = makeRig();
    const queue = new TtsQueue({ ...rig.deps });
    const events = recordEvents(queue, ['aborted', 'dropped', 'played']);

    queue.enqueue('甲。', 1);
    rig.synGates[0].resolve();
    await settle();
    expect(events).toEqual([]);

    queue.cancel(1);
    expect(events).toEqual([
      { type: 'aborted', detail: expect.objectContaining({ sentence: '甲。' }) },
    ]);
    expect(rig.playCalls[0].signal.aborted).toBe(true);

    rig.playGates[0].resolve();
    await settle();
    expect(events).toHaveLength(1); // no duplicate aborted event when play settles late
    expect(queue.stats()).toMatchObject({ played: 0, dropped: 1 });
    await expect(queue.whenDrained()).resolves.toBeUndefined();
  });

  it('drops enqueues with a stale generation after cancel (no stale audio can enter)', async () => {
    const rig = makeRig();
    const queue = new TtsQueue({ ...rig.deps });
    const events = recordEvents(queue, ['dropped']);

    queue.cancel(3);
    queue.enqueue('旧代际。', 2);
    expect(events).toEqual([
      { type: 'dropped', detail: expect.objectContaining({ sentence: '旧代际。', reason: 'stale-generation' }) },
    ]);
    expect(queue.stats().dropped).toBe(1);
    await settle();
    expect(rig.synthesizeCalls).toHaveLength(0);
    await expect(queue.whenDrained()).resolves.toBeUndefined();
  });

  it('keeps sentences of a generation newer than the canceled one', async () => {
    const rig = makeRig();
    const queue = new TtsQueue({ ...rig.deps });
    queue.enqueue('新代际。', 4);
    queue.cancel(3);
    rig.synGates[0].resolve();
    await settle();
    rig.playGates[0].resolve();
    await settle();
    expect(queue.stats()).toMatchObject({ played: 1, dropped: 0 });
  });
});

describe('TtsQueue failure path', () => {
  it('emits an error for a failed sentence and continues with the next one', async () => {
    const rig = makeRig();
    const queue = new TtsQueue({ ...rig.deps });
    const errors: string[] = [];
    queue.addEventListener('error', (event) => {
      errors.push((event as CustomEvent<{ message: string }>).detail.message);
    });

    rig.failNextSynthesizeWith = new Error('tts down');
    queue.enqueue('坏的。', 1);
    queue.enqueue('好的。', 1);
    await settle();
    rig.synGates[0].resolve();
    await settle();
    rig.playGates[0].resolve();
    await settle();

    expect(errors).toEqual(['tts down']);
    expect(queue.stats()).toMatchObject({ errors: 1, played: 1 });
    expect(rig.synthesizeCalls.map((c) => c.text)).toEqual(['坏的。', '好的。']);
  });
});
