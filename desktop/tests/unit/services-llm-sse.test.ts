// EXP-003 behavior tests for the OpenAI-compatible streaming chat service.
//
// Covers the SSE line parser (broken lines across chunk boundaries, multi-line
// data events, [DONE], comment/field lines), the data -> ChatChunk decoder and
// streamChat() itself (request shape, delta/done ordering, HTTP failure,
// mid-stream abort). The Tauri HTTP plugin fetch is mocked (no real network).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chatChunksFromData,
  createSseParser,
  streamChat,
} from '../../src/services/llm/openaiCompat';
import type { ChatChunk, ChatMessage } from '../../src/services/llm/openaiCompat';

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

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '你好' },
];

function sseData(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function streamResponse(chunks: string[]): { ok: true; status: 200; body: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

beforeEach(() => {
  harness.calls.length = 0;
  harness.setHandler(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SSE line parser', () => {
  it('dispatches a complete single data event', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"choices":[]}\n\n')).toEqual(['{"choices":[]}']);
    expect(parser.flush()).toEqual([]);
  });

  it('buffers broken lines across pushes until the newline completes them', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    expect(parser.push(':1}\n\n')).toEqual(['{"a":1}']);
  });

  it('joins multi-line data fields of one event with a newline', () => {
    const parser = createSseParser();
    expect(parser.push('data: first\ndata: second\n\n')).toEqual(['first\nsecond']);
  });

  it('ignores comment lines and non-data SSE fields', () => {
    const parser = createSseParser();
    expect(parser.push(': keep-alive\nevent: message\nid: 7\ndata: x\n\n')).toEqual(['x']);
  });

  it('flush dispatches a final event that never saw a blank line', () => {
    const parser = createSseParser();
    expect(parser.push('data: tail\n')).toEqual([]);
    expect(parser.flush()).toEqual(['tail']);
    expect(parser.flush()).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\r\n\r\n')).toEqual(['a']);
  });
});

describe('SSE data payload decoder', () => {
  it('maps [DONE] to a done chunk', () => {
    expect(chatChunksFromData('[DONE]')).toEqual([{ done: { finishReason: null } }]);
    expect(chatChunksFromData(' [DONE] ')).toEqual([{ done: { finishReason: null } }]);
  });

  it('extracts delta content from the first choice', () => {
    expect(chatChunksFromData(JSON.stringify({ choices: [{ delta: { content: '你好' } }] }))).toEqual([
      { delta: '你好' },
    ]);
  });

  it('emits a done chunk when finish_reason arrives, with or without trailing content', () => {
    expect(
      chatChunksFromData(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })),
    ).toEqual([{ done: { finishReason: 'stop' } }]);
    expect(
      chatChunksFromData(
        JSON.stringify({ choices: [{ delta: { content: 'end' }, finish_reason: 'stop' }] }),
      ),
    ).toEqual([{ delta: 'end' }, { done: { finishReason: 'stop' } }]);
  });

  it('carries vendor usage when present (末帧用量用于统计口径)', () => {
    expect(
      chatChunksFromData(
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
        }),
      ),
    ).toEqual([{ done: { finishReason: 'stop', usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } } }]);
    // 只有 usage 没有 finish_reason 的兼容实现：也要作为 done 帧带回来
    expect(
      chatChunksFromData(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } })),
    ).toEqual([{ done: { finishReason: null, usage: { prompt_tokens: 1, completion_tokens: 2 } } }]);
    // 无 usage 时保持原样（统计侧退回估算）
    expect(
      chatChunksFromData(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })),
    ).toEqual([{ done: { finishReason: 'stop' } }]);
  });

  it('ignores malformed and irrelevant payloads without throwing', () => {
    expect(chatChunksFromData('not json')).toEqual([]);
    expect(chatChunksFromData(JSON.stringify({ choices: [] }))).toEqual([]);
    expect(chatChunksFromData('')).toEqual([]);
  });
});

describe('streamChat', () => {
  const ARGS = {
    baseUrl: 'https://llm.test/v1',
    model: 'chat-1',
    apiKey: 'k',
    messages: MESSAGES,
  };

  it('posts a streaming chat/completions request with the abort signal', async () => {
    harness.setHandler(async () => streamResponse([sseData('hi'), 'data: [DONE]\n\n']));
    const controller = new AbortController();
    const chunks = await collect(streamChat({ ...ARGS, signal: controller.signal }));

    expect(chunks).toEqual<ChatChunk[]>([{ delta: 'hi' }, { done: { finishReason: null } }]);
    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0];
    expect(call.url).toBe('https://llm.test/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['Authorization']).toBe('Bearer k');
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: 'chat-1',
      messages: MESSAGES,
      stream: true,
      // 用量统计依赖末帧 usage；不支持的端点会忽略该字段
      stream_options: { include_usage: true },
    });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.signal?.aborted).toBe(false);
  });

  it('reassembles SSE frames split across arbitrary stream chunk boundaries', async () => {
    harness.setHandler(async () =>
      streamResponse([
        `data: {"choices":[{"delta":{"content":"你"}}]}\n\nda`,
        `ta: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n`,
      ]),
    );
    const chunks = await collect(streamChat({ ...ARGS, signal: new AbortController().signal }));
    expect(chunks).toEqual<ChatChunk[]>([{ delta: '你' }, { delta: '好' }, { done: { finishReason: null } }]);
  });

  it('stops at the done chunk even when the server keeps the stream open', async () => {
    harness.setHandler(async () => {
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sseData('a')));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.enqueue(encoder.encode(sseData('never')));
            // no close(): the server would keep the connection open
          },
        }),
      };
    });
    const chunks = await collect(streamChat({ ...ARGS, signal: new AbortController().signal }));
    expect(chunks).toEqual<ChatChunk[]>([{ delta: 'a' }, { done: { finishReason: null } }]);
  });

  it('flushes a trailing unterminated data event at end of stream', async () => {
    harness.setHandler(async () => streamResponse([sseData('only'), 'data: [DONE]\n']));
    const chunks = await collect(streamChat({ ...ARGS, signal: new AbortController().signal }));
    expect(chunks).toEqual<ChatChunk[]>([{ delta: 'only' }, { done: { finishReason: null } }]);
  });

  it('rejects with the HTTP status on non-2xx responses', async () => {
    harness.setHandler(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(
      collect(streamChat({ ...ARGS, signal: new AbortController().signal })),
    ).rejects.toThrow('LLM HTTP 500');
  });

  it('rejects with AbortError when the signal aborts mid-stream', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    harness.setHandler(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      }),
    }));
    const ac = new AbortController();
    const iterator = streamChat({ ...ARGS, signal: ac.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await settle(); // let the generator start the fetch and park on reader.read()
    controller.enqueue(new TextEncoder().encode(sseData('first')));
    const first = await pending;
    expect(first.value).toEqual({ delta: 'first' });

    ac.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
  });
});
