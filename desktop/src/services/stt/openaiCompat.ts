// EXP-003 batch STT client (OpenAI-compatible), reusing the exact HTTP shape
// of the existing batch engine (desktop/src/engine.ts, kept untouched as the
// fallback): POST {baseUrl}/audio/transcriptions with a hand-built multipart
// WAV body (16 kHz mono PCM16 by default), language zh, response_format json.
// pcmToWav/buildMultipart are extracted as pure functions so the request
// construction is testable without network.
import { fetch } from '@tauri-apps/plugin-http';

interface PluginHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Int16 PCM → WAV (container) bytes. */
export function pcmToWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) dv.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length * 2, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, 'data');
  dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/**
 * Hand-built multipart/form-data (the plugin fetch's FormData support is
 * uncertain; building bytes directly is the engine's proven shape).
 */
export function buildMultipart(
  boundary: string,
  fields: Record<string, string>,
  file: { name: string; filename: string; mime: string; bytes: Uint8Array },
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
    ),
    file.bytes,
    enc.encode(`\r\n--${boundary}--\r\n`),
  );
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * multipart bytes → fetch BodyInit: copy into an exactly-sized ArrayBuffer so
 * no pool over-read sends stray tail bytes (same rationale as engine.ts).
 */
export function toBodyInit(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export interface TranscribeArgs {
  baseUrl: string;
  model: string;
  apiKey: string;
  pcm: Int16Array;
  sampleRate?: number;
  language?: string;
  signal: AbortSignal;
}

/** Batch transcription of one utterance; resolves '' when aborted late. */
export async function transcribeAudio(args: TranscribeArgs): Promise<string> {
  const { baseUrl, model, apiKey, pcm, signal } = args;
  if (!baseUrl || !model) throw new Error('STT 未配置：请填写 baseUrl 与 model');
  const sampleRate = args.sampleRate ?? 16000;
  const language = args.language ?? 'zh';
  const boundary = '----vistaverge' + Math.random().toString(16).slice(2);
  const body = toBodyInit(
    buildMultipart(
      boundary,
      { model, language, response_format: 'json' },
      {
        name: 'file',
        filename: 'utterance.wav',
        mime: 'audio/wav',
        bytes: pcmToWav(pcm, sampleRate),
      },
    ),
  );
  const response = (await fetch(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  })) as PluginHttpResponse;
  if (signal.aborted) return '';
  if (!response.ok) {
    throw new Error(`STT HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const payload = (await response.json()) as { text?: string };
  if (signal.aborted) return '';
  return payload.text ?? '';
}
