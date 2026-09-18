// FND-001 behavior tests for the real AudioWorklet at src/worklets/mic-capture.js.
//
// The production worklet is loaded unmodified into an isolated node:vm context
// where AudioWorkletProcessor / registerProcessor are faked. We capture the real
// postMessage payload and its second (transfer list) argument, then assert the
// documented behavior: 640-sample framing, RMS, remainder retention and buffer
// ownership. The capture algorithm itself is never reimplemented here.
//
// AudioWorklet.process receives `inputs` as an array of inputs, each input an
// array of channels, so a single mono channel is passed as [[channel]].
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKLET_PATH = resolve(HERE, '../../src/worklets/mic-capture.js');
const CHUNK = 640;
const TOL = 1e-6;

type Captured = {
  payload: { pcm: Float32Array; rms: number };
  transfer: ArrayBuffer[] | undefined;
  pcmValues: number[];
  pcmBuffer: ArrayBuffer;
  rms: number;
  /** The worklet's internal accumulation buffer at the moment postMessage ran. */
  internalBufferAtSend: ArrayBuffer | undefined;
};

type Processor = { process: (inputs: unknown) => boolean };

type Harness = {
  sent: Captured[];
  registeredName: () => string | null;
  createProcessor: () => Processor;
  source: string;
};

function loadWorklet(): Harness {
  const source = readFileSync(WORKLET_PATH, 'utf8');
  const sent: Captured[] = [];
  let registeredName: string | null = null;
  let Registered: (new () => Processor) | null = null;

  class FakeAudioWorkletProcessor {
    port: { postMessage: (message: { pcm: Float32Array; rms: number }, transfer?: ArrayBuffer[]) => void };

    constructor() {
      const self = this as unknown as { _buf?: Float32Array };
      this.port = {
        postMessage(message, transfer) {
          sent.push({
            payload: message,
            transfer,
            pcmValues: Array.from(message.pcm),
            pcmBuffer: message.pcm.buffer,
            rms: message.rms,
            internalBufferAtSend: self._buf ? self._buf.buffer : undefined,
          });
        },
      };
    }
  }

  const context = vm.createContext({
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor(name: string, processor: unknown) {
      registeredName = name;
      Registered = processor as new () => Processor;
    },
  });
  vm.runInContext(source, context, { filename: WORKLET_PATH });

  return {
    sent,
    registeredName: () => registeredName,
    createProcessor: () => {
      if (!Registered) throw new Error('worklet did not call registerProcessor');
      return new Registered();
    },
    source,
  };
}

function block(value: number, length = 128): Float32Array {
  const out = new Float32Array(length);
  out.fill(value);
  return out;
}

function expectClose(actual: number, expected: number, tol = TOL): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

function expectAllClose(values: number[], expected: number): void {
  expect(values).toHaveLength(CHUNK);
  for (const value of values) expectClose(value, expected);
}

describe('mic-capture worklet (real source, isolated vm)', () => {
  it('registers "mic-capture" and returns true without posting when there is no input', () => {
    const harness = loadWorklet();
    expect(harness.registeredName()).toBe('mic-capture');
    const processor = harness.createProcessor();

    expect(processor.process([])).toBe(true);
    expect(processor.process([[]])).toBe(true);
    expect(harness.sent).toHaveLength(0);
  });

  it('emits exactly one 640-sample frame with RMS 0.5 only after five 128-sample blocks', () => {
    const harness = loadWorklet();
    const processor = harness.createProcessor();

    for (let i = 0; i < 4; i++) {
      expect(processor.process([[block(0.5)]])).toBe(true);
      expect(harness.sent).toHaveLength(0);
    }

    expect(processor.process([[block(0.5)]])).toBe(true);
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    expectAllClose(frame.pcmValues, 0.5);
    expectClose(frame.rms, 0.5);
  });

  it('retains a remainder when input is not a multiple of 640 and stitches across process calls', () => {
    const harness = loadWorklet();
    const processor = harness.createProcessor();

    expect(processor.process([[block(0.25, 300)]])).toBe(true);
    expect(harness.sent).toHaveLength(0);

    expect(processor.process([[block(0.75, 340)]])).toBe(true);
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    expect(frame.pcmValues).toHaveLength(CHUNK);
    expectClose(frame.pcmValues[0], 0.25);
    expectClose(frame.pcmValues[299], 0.25);
    expectClose(frame.pcmValues[300], 0.75);
    expectClose(frame.pcmValues[639], 0.75);
    expectClose(frame.rms, Math.sqrt((300 * 0.25 * 0.25 + 340 * 0.75 * 0.75) / CHUNK));

    // The remainder (100 samples) is held; no second frame may be emitted yet.
    expect(processor.process([[block(0.1, 100)]])).toBe(true);
    expect(harness.sent).toHaveLength(1);
  });

  it('reports per-frame RMS for 0.25 and 0.75 frames and leaves the first payload untouched', () => {
    const harness = loadWorklet();
    const processor = harness.createProcessor();

    processor.process([[block(0.25, CHUNK)]]);
    expect(harness.sent).toHaveLength(1);
    const first = harness.sent[0];
    expectAllClose(first.pcmValues, 0.25);
    expectClose(first.rms, 0.25);

    processor.process([[block(0.75, CHUNK)]]);
    expect(harness.sent).toHaveLength(2);
    const second = harness.sent[1];
    expectAllClose(second.pcmValues, 0.75);
    expectClose(second.rms, 0.75);

    // Writing the second frame must not mutate the first frame's captured payload.
    expectAllClose(first.pcmValues, 0.25);
    expectClose(first.rms, 0.25);
    expect(first.pcmBuffer).not.toBe(second.pcmBuffer);
  });

  it('transfers the first buffer of this output and never the internal reused buffer', () => {
    const harness = loadWorklet();
    const processor = harness.createProcessor();

    processor.process([[block(0.5, CHUNK)]]);
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];

    expect(Array.isArray(frame.transfer)).toBe(true);
    expect(frame.transfer).toHaveLength(1);
    expect(frame.transfer?.[0]).toBe(frame.pcmBuffer);
    expect(frame.pcmBuffer.byteLength).toBe(CHUNK * Float32Array.BYTES_PER_ELEMENT);

    // The internal accumulation buffer is reused across frames, so it must not be
    // the transferred buffer. This is the direct regression guard.
    expect(frame.internalBufferAtSend).toBeDefined();
    expect(frame.transfer?.[0]).not.toBe(frame.internalBufferAtSend);

    // The processor must keep producing correct frames after the transfer.
    processor.process([[block(0.5, CHUNK)]]);
    expect(harness.sent).toHaveLength(2);
    expectAllClose(harness.sent[1].pcmValues, 0.5);
    expectClose(harness.sent[1].rms, 0.5);
  });

  it('reports RMS 0 with no NaN for a full silent frame', () => {
    const harness = loadWorklet();
    const processor = harness.createProcessor();

    processor.process([[new Float32Array(CHUNK)]]);
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];

    expect(frame.rms).toBe(0);
    expect(Number.isNaN(frame.rms)).toBe(false);
    expect(frame.pcmValues).toHaveLength(CHUNK);
    expect(frame.pcmValues.every((value) => value === 0)).toBe(true);
    expect(frame.pcmValues.some((value) => Number.isNaN(value))).toBe(false);
  });

  it('keeps the exact remainder boundary: 100 samples of 1.0 then 540 of 0.0 form one frame', () => {
    const harness = loadWorklet();
    const processor = harness.createProcessor();

    processor.process([[block(1, 100)]]);
    expect(harness.sent).toHaveLength(0);
    processor.process([[new Float32Array(540)]]);
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    expect(frame.pcmValues).toHaveLength(CHUNK);
    for (let i = 0; i < 100; i++) expectClose(frame.pcmValues[i], 1);
    for (let i = 100; i < CHUNK; i++) expectClose(frame.pcmValues[i], 0);
    expectClose(frame.rms, Math.sqrt(100 / CHUNK));
  });
});
