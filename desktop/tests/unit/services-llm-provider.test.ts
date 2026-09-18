// EXP-003 behavior tests for the LLM provider layer: the capability
// negotiation surface, the OpenAI-compatible provider wrapper and the
// deterministic offline mock provider (marked MOCK, never part of real
// vendor acceptance). The Tauri HTTP plugin fetch is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProvider, createOpenAiCompatProvider } from '../../src/services/llm/provider';
import type { ChatChunk, ChatMessage, LlmProvider, StreamChatArgs } from '../../src/services/llm/provider';

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
  { role: 'user', content: '今天天气怎么样' },
];

function argsOf(signal: AbortSignal, providerMessages: ChatMessage[] = MESSAGES): StreamChatArgs {
  return { baseUrl: 'https://llm.test/v1', model: 'chat-1', apiKey: 'k', messages: providerMessages, signal };
}

async function drainText(provider: LlmProvider, args: StreamChatArgs): Promise<string> {
  let text = '';
  let finish: string | null | undefined;
  for await (const chunk of provider.streamChat(args)) {
    if ('delta' in chunk) text += chunk.delta;
    else finish = chunk.done.finishReason;
  }
  expect(finish).toBe('stop');
  return text;
}

beforeEach(() => {
  harness.calls.length = 0;
  harness.setHandler(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAI-compatible provider', () => {
  it('reports real streaming capability and is not a mock', () => {
    const provider = createOpenAiCompatProvider();
    expect(provider.capabilities()).toEqual({ streaming: true });
    expect(provider.mock).toBe(false);
  });

  it('delegates streamChat with stream:true in the request body', async () => {
    harness.setHandler(async () => {
      const body = `data: ${JSON.stringify({ choices: [{ delta: { content: ' hi ' } }] })}\n\ndata: [DONE]\n\n`;
      return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(body));
          c.close();
        },
      }) };
    });
    const provider = createOpenAiCompatProvider();
    const chunks: ChatChunk[] = [];
    for await (const chunk of provider.streamChat(argsOf(new AbortController().signal))) chunks.push(chunk);

    expect(chunks).toEqual<ChatChunk[]>([{ delta: ' hi ' }, { done: { finishReason: null } }]);
    expect(JSON.parse(String(harness.calls[0].init.body)).stream).toBe(true);
  });
});

describe('mock provider (MOCK, offline only)', () => {
  it('is explicitly marked as a mock with streaming capability', () => {
    const provider = createMockProvider();
    expect(provider.mock).toBe(true);
    expect(provider.capabilities().streaming).toBe(true);
  });

  it('streams a deterministic reply character by character and ends with done', async () => {
    const provider = createMockProvider();
    const deltas: string[] = [];
    let done: string | null | undefined;
    for await (const chunk of provider.streamChat(argsOf(new AbortController().signal))) {
      if ('delta' in chunk) deltas.push(chunk.delta);
      else done = chunk.done.finishReason;
    }
    const text = deltas.join('');
    expect(deltas.every((d) => Array.from(d).length === 1)).toBe(true);
    expect(text.startsWith('[MOCK]')).toBe(true);
    expect(text).toContain('今天天气怎么样');
    expect(done).toBe('stop');

    // determinism: same input -> byte-identical reply
    const second = await drainText(provider, argsOf(new AbortController().signal));
    expect(second).toBe(text);
    expect(text).toBe(await drainText(provider, argsOf(new AbortController().signal)));
  });

  it('falls back to a deterministic reply when no user message exists', async () => {
    const provider = createMockProvider();
    const text = await drainText(provider, argsOf(new AbortController().signal, [{ role: 'system', content: 's' }]));
    expect(text.startsWith('[MOCK]')).toBe(true);
  });

  it('rejects with AbortError when aborted mid-stream', async () => {
    const provider = createMockProvider();
    const ac = new AbortController();
    const iterator = provider.streamChat(argsOf(ac.signal))[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect('delta' in first.value && first.value.delta.length).toBe(1);
    ac.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
  });
});
