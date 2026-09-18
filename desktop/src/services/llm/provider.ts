// EXP-003 LLM provider layer with capability negotiation (VOICE.md §2 能力协商,
// §3.5). `capabilities().streaming` is the single flag the UI reads to show the
// real path — a non-streaming provider must be displayed as "分句/批式", never
// disguised as streaming. The OpenAI-compatible provider delegates to the SSE
// streamChat; the mock provider is deterministic and explicitly marked MOCK —
// it exists for offline demos and tests only and never counts as vendor
// acceptance (VOICE.md §6: 模拟服务只能证明接线).
import { streamChat } from './openaiCompat';
import type { ChatChunk, ChatDone, ChatMessage, StreamChatArgs } from './openaiCompat';

export type { ChatChunk, ChatDone, ChatMessage, StreamChatArgs };

export interface ProviderCapabilities {
  /** True when the provider streams deltas; false means batch/sentence mode. */
  streaming: boolean;
}

export interface LlmProvider {
  /** True only for offline mock providers (never real vendor acceptance). */
  readonly mock: boolean;
  capabilities(): ProviderCapabilities;
  streamChat(args: StreamChatArgs): AsyncIterable<ChatChunk>;
}

export function createOpenAiCompatProvider(): LlmProvider {
  return {
    mock: false,
    capabilities: () => ({ streaming: true }),
    streamChat: (args) => streamChat(args),
  };
}

/**
 * Deterministic offline provider: echoes the last user message in a reply that
 * is prefixed with [MOCK] and streams it one code point at a time. Reply is
 * byte-identical for identical inputs. NOT a vendor — test/demo only.
 */
export function createMockProvider(): LlmProvider {
  return {
    mock: true,
    capabilities: () => ({ streaming: true }),
    async *streamChat(args: StreamChatArgs): AsyncGenerator<ChatChunk> {
      const lastUser =
        [...args.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const reply = `[MOCK] 已收到「${lastUser}」（离线演示回复，非真实供应商）。`;
      for (const ch of Array.from(reply)) {
        if (args.signal.aborted) {
          throw new DOMException('This operation was aborted', 'AbortError');
        }
        yield { delta: ch };
      }
      yield { done: { finishReason: 'stop' } };
    },
  };
}
