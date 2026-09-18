// EXP-003 behavior tests for the batch STT / TTS OpenAI-compatible clients.
// They reuse the exact HTTP shapes of the existing batch engine (engine.ts
// stays untouched as the fallback): POST {baseUrl}/audio/transcriptions with a
// hand-built multipart WAV body, and POST {baseUrl}/audio/speech returning
// PCM16LE. The Tauri HTTP plugin fetch is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildMultipart, pcmToWav, toBodyInit, transcribeAudio } from '../../src/services/stt/openaiCompat';
import { createMockTts, synthesizeSpeech } from '../../src/services/tts/openaiCompat';

type FetchCall = {
  url: string;
  init: RequestInit & { body?: unknown; signal?: AbortSignal | undefined };
};

const harness = vi.hoisted(() => {
  const calls: FetchCall[] = [];
  let handler: ((url: string, init: FetchCall['init']) => Promise<unknown>) | null = null;
  return {
    calls,
    setHandler(fn: ((url: string, init: FetchCall['init']) => Promise<unknown>) | null) {
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

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function httpError(status: number, body = 'boom') {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

function bytesOf(body: unknown): Uint8Array {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error(`unexpected body type: ${Object.prototype.toString.call(body)}`);
}

const SAMPLE_PCM = Int16Array.from([100, -100, 32767, -32768]);

beforeEach(() => {
  harness.calls.length = 0;
  harness.setHandler(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pcmToWav', () => {
  it('wraps PCM16LE in a canonical 16 kHz mono WAV container', () => {
    const wav = pcmToWav(SAMPLE_PCM, 16000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + SAMPLE_PCM.length * 2);
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
    expect(String.fromCharCode(...wav.subarray(12, 16))).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(String.fromCharCode(...wav.subarray(36, 40))).toBe('data');
    expect(view.getUint32(40, true)).toBe(SAMPLE_PCM.length * 2);
    expect(wav.byteLength).toBe(44 + SAMPLE_PCM.length * 2);
    // sample payload round-trips through the container
    const samples = new Int16Array(wav.buffer, 44);
    expect(Array.from(samples)).toEqual(Array.from(SAMPLE_PCM));
  });
});

describe('buildMultipart / toBodyInit', () => {
  it('builds an exact-length multipart body with fields, file and closing boundary', () => {
    const boundary = '----test';
    const fileBytes = new Uint8Array([1, 2, 3]);
    const body = buildMultipart(boundary, { model: 'whisper-1' }, {
      name: 'file',
      filename: 'utterance.wav',
      mime: 'audio/wav',
      bytes: fileBytes,
    });
    const text = new TextDecoder('latin1').decode(body);
    expect(text).toContain('------test\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n');
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="utterance.wav"\r\nContent-Type: audio/wav\r\n\r\n');
    expect(text.endsWith('\r\n------test--\r\n')).toBe(true);
    // file bytes are embedded verbatim after the file header
    const marker = 'Content-Type: audio/wav\r\n\r\n';
    const fileStart = text.lastIndexOf(marker) + marker.length;
    expect(Array.from(body.subarray(fileStart, fileStart + 3))).toEqual([1, 2, 3]);
    expect(toBodyInit(body)).toBeInstanceOf(ArrayBuffer);
    expect(toBodyInit(body).byteLength).toBe(body.byteLength);
  });
});

describe('transcribeAudio (batch STT, engine shape)', () => {
  const ARGS = {
    baseUrl: 'https://stt.test/v1',
    model: 'whisper-1',
    apiKey: 'k',
    pcm: SAMPLE_PCM,
  };

  it('posts a multipart WAV to /audio/transcriptions with the turn signal and defaults', async () => {
    harness.setHandler(async () => jsonResponse({ text: '你好' }));
    const controller = new AbortController();
    const text = await transcribeAudio({ ...ARGS, signal: controller.signal });

    expect(text).toBe('你好');
    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0];
    expect(call.url).toBe('https://stt.test/v1/audio/transcriptions');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['Authorization']).toBe('Bearer k');
    const contentType = String((call.init.headers as Record<string, string>)['Content-Type']);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=----/);
    expect(call.init.signal).toBe(controller.signal);

    const headerText = new TextDecoder('latin1').decode(bytesOf(call.init.body));
    expect(headerText).toContain('name="model"\r\n\r\nwhisper-1');
    expect(headerText).toContain('name="language"\r\n\r\nzh');
    expect(headerText).toContain('name="response_format"\r\n\r\njson');
    expect(headerText).toContain('filename="utterance.wav"');
    expect(headerText).toContain('RIFF');
  });

  it('honors custom language and sample rate in the WAV header', async () => {
    harness.setHandler(async () => jsonResponse({ text: 'hi' }));
    await transcribeAudio({ ...ARGS, language: 'en', sampleRate: 24000, signal: new AbortController().signal });
    const headerText = new TextDecoder('latin1').decode(bytesOf(harness.calls[0].init.body));
    expect(headerText).toContain('name="language"\r\n\r\nen');
    // the WAV is embedded after the multipart file-part header: locate RIFF first
    const body = bytesOf(harness.calls[0].init.body);
    const riff = new TextDecoder('latin1').decode(body).indexOf('RIFF');
    expect(riff).toBeGreaterThan(0);
    const wavView = new DataView(body.buffer, body.byteOffset + riff, body.byteLength - riff);
    expect(wavView.getUint32(24, true)).toBe(24000);
  });

  it('returns an empty string when the signal aborted after the response', async () => {
    harness.setHandler(async () => jsonResponse({ text: '迟到文本' }));
    const controller = new AbortController();
    const promise = transcribeAudio({ ...ARGS, signal: controller.signal });
    controller.abort();
    await expect(promise).resolves.toBe('');
    await settle();
  });

  it('throws with the HTTP status on failure', async () => {
    harness.setHandler(async () => httpError(503, 'stt down'));
    await expect(
      transcribeAudio({ ...ARGS, signal: new AbortController().signal }),
    ).rejects.toThrow('STT HTTP 503');
  });
});

describe('synthesizeSpeech (batch TTS, engine shape)', () => {
  const ARGS = {
    baseUrl: 'https://tts.test/v1',
    model: 'tts-1',
    apiKey: 'k',
  };

  function pcmResponse(bytes: number[]) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
      json: async () => ({}),
      text: async () => '',
    };
  }

  it('posts JSON to /audio/speech and decodes PCM16LE, dropping odd trailing bytes', async () => {
    harness.setHandler(async () => pcmResponse([1, 0, 2, 0, 3]));
    const controller = new AbortController();
    const pcm = await synthesizeSpeech({ ...ARGS, text: '句子', signal: controller.signal });

    expect(Array.from(pcm)).toEqual([1, 2]);
    const call = harness.calls[0];
    expect(call.url).toBe('https://tts.test/v1/audio/speech');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['Authorization']).toBe('Bearer k');
    expect(call.init.signal).toBe(controller.signal);
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: 'tts-1',
      input: '句子',
      response_format: 'pcm',
    });
  });

  it('includes voice only when configured', async () => {
    harness.setHandler(async () => pcmResponse([0, 0]));
    await synthesizeSpeech({ ...ARGS, text: 'x', voice: 'alloy', signal: new AbortController().signal });
    expect(JSON.parse(String(harness.calls[0].init.body)).voice).toBe('alloy');

    await synthesizeSpeech({ ...ARGS, text: 'x', voice: '', signal: new AbortController().signal });
    const second = JSON.parse(String(harness.calls[1].init.body));
    expect('voice' in second).toBe(false);
  });

  it('returns empty PCM when aborted after the response', async () => {
    harness.setHandler(async () => pcmResponse([1, 0, 2, 0]));
    const controller = new AbortController();
    const promise = synthesizeSpeech({ ...ARGS, text: 'x', signal: controller.signal });
    controller.abort();
    await expect(promise).resolves.toEqual(new Int16Array(0));
    await settle();
  });

  it('throws with the HTTP status on failure', async () => {
    harness.setHandler(async () => httpError(500, 'tts down'));
    await expect(
      synthesizeSpeech({ ...ARGS, text: 'x', signal: new AbortController().signal }),
    ).rejects.toThrow('TTS HTTP 500');
  });
});

describe('createMockTts (MOCK, offline only)', () => {
  it('returns deterministic silence packets scaled to the text and is marked mock', async () => {
    const mock = createMockTts();
    expect(mock.mock).toBe(true);
    const a = await mock('你好', new AbortController().signal);
    const b = await mock('你好', new AbortController().signal);
    expect(a).toEqual(b);
    expect(Array.from(a).every((s) => s === 0)).toBe(true);
    const longer = await mock('你好世界再见', new AbortController().signal);
    expect(longer.length).toBeGreaterThan(a.length);
  });
});
