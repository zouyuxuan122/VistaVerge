// EXP-003 batch TTS client (OpenAI-compatible), reusing the exact HTTP shape
// of the existing batch engine (desktop/src/engine.ts, kept untouched as the
// fallback): POST {baseUrl}/audio/speech with response_format pcm, returning
// PCM16LE decoded into Int16Array (odd trailing bytes dropped).
// createMockTts provides deterministic silence packets marked MOCK for offline
// demos/tests — it never counts as vendor acceptance.
import { fetch } from '@tauri-apps/plugin-http';

interface PluginHttpResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface SynthesizeArgs {
  baseUrl: string;
  model: string;
  apiKey: string;
  text: string;
  voice?: string;
  sampleRate?: number;
  signal: AbortSignal;
}

/** Synthesize one sentence to PCM16LE; resolves empty samples when aborted. */
export async function synthesizeSpeech(args: SynthesizeArgs): Promise<Int16Array> {
  const { baseUrl, model, apiKey, text, signal } = args;
  if (!baseUrl || !model) throw new Error('TTS 未配置：请填写 baseUrl 与 model');
  const payload: Record<string, unknown> = { model, input: text, response_format: 'pcm' };
  if (args.voice) payload.voice = args.voice;
  const response = (await fetch(`${baseUrl.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })) as PluginHttpResponse;
  if (signal.aborted) return new Int16Array(0);
  if (!response.ok) {
    throw new Error(`TTS HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const buffer = await response.arrayBuffer();
  if (signal.aborted) return new Int16Array(0);
  const usable = buffer.byteLength - (buffer.byteLength % 2);
  return new Int16Array(buffer.slice(0, usable));
}

export interface MockTts {
  (text: string, signal: AbortSignal): Promise<Int16Array>;
  readonly mock: true;
}

/**
 * Deterministic silence-per-character TTS (60 ms of zero samples per code
 * point). MOCK: offline demo/test only, no real synthesis.
 */
export function createMockTts(sampleRate = 16000): MockTts {
  const samplesPerChar = Math.max(1, Math.round((sampleRate * 60) / 1000));
  const synth = (text: string, signal: AbortSignal): Promise<Int16Array> => {
    if (signal.aborted) return Promise.resolve(new Int16Array(0));
    const length = Math.max(samplesPerChar, Array.from(text).length * samplesPerChar);
    return Promise.resolve(new Int16Array(length));
  };
  return Object.assign(synth, { mock: true as const });
}
