// EXP-003 OpenAI-compatible streaming chat over SSE (VOICE.md §1.1 流式 LLM).
//
// Cloud calls go through @tauri-apps/plugin-http (Rust reqwest, no CORS). The
// SSE line parser is a pure state machine: it buffers broken lines across
// chunk boundaries, joins multi-line data fields with a newline, ignores
// comment/field lines, tolerates CRLF, and dispatches on blank lines (or
// flush() at end of stream). `[DONE]` maps to a done chunk; a choice's
// finish_reason ends the stream after its trailing content delta.
import { fetch } from '@tauri-apps/plugin-http';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息携带的工具调用（回传给供应商时必须原样带上）。 */
  tool_calls?: OutgoingToolCall[];
  /** role=tool 时必填：对应哪一次工具调用。 */
  tool_call_id?: string;
  /** role=tool 时的工具名（部分供应商要求）。 */
  name?: string;
}

/** 回传协议用的工具调用形态（OpenAI 兼容 wire format）。 */
export interface OutgoingToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 组装完成的工具调用（arguments 为 JSON 字符串，由调用方解析）。 */
export interface AssembledToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** OpenAI 兼容工具声明。 */
export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatDone {
  finishReason: string | null;
  /** 供应商真实用量（开启 stream_options.include_usage 后由末个 chunk 带回）。 */
  usage?: ChatUsage;
  /** finish_reason=tool_calls 时，流式增量组装完成的工具调用列表。 */
  toolCalls?: AssembledToolCall[];
}

export type ChatChunk = { delta: string } | { done: ChatDone };

export interface StreamChatArgs {
  baseUrl: string;
  model: string;
  apiKey: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  /** 提供即启用工具调用；供应商不支持时应在错误中如实暴露。 */
  tools?: ChatTool[];
  toolChoice?: 'auto' | 'none';
}

interface PluginHttpResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export interface SseParser {
  /** Feed raw text; returns completed event data payloads. */
  push(text: string): string[];
  /** Dispatch a final event that never saw a blank line. */
  flush(): string[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  const dispatch = (block: string): string[] => {
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith('data:')) {
        const value = line.slice(5);
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
      }
      // comment lines (":" prefix) and event/id/retry fields are ignored
    }
    return dataLines.length > 0 ? [dataLines.join('\n')] : [];
  };
  return {
    push(text: string): string[] {
      buffer = (buffer + text).replace(/\r\n?/g, '\n');
      const events: string[] = [];
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        events.push(...dispatch(buffer.slice(0, idx)));
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf('\n\n');
      }
      return events;
    },
    flush(): string[] {
      const block = buffer;
      buffer = '';
      return block.trim().length > 0 ? dispatch(block) : [];
    },
  };
}

/** Decode one SSE data payload into chat chunks; malformed data is ignored. */
export function chatChunksFromData(data: string): ChatChunk[] {
  const trimmed = data.trim();
  if (trimmed.length === 0) return [];
  if (trimmed === '[DONE]') return [{ done: { finishReason: null } }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const obj = parsed as {
    error?: { message?: string };
    choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
    usage?: ChatUsage;
  };
  if (obj.error) {
    throw new Error(`LLM 流式错误: ${obj.error.message ?? JSON.stringify(obj.error)}`);
  }
  const chunks: ChatChunk[] = [];
  const choice = obj.choices?.[0];
  const content = choice?.delta?.content;
  if (typeof content === 'string' && content.length > 0) chunks.push({ delta: content });
  const finish = choice?.finish_reason;
  if (typeof finish === 'string' && finish.length > 0) {
    // 用量可能和 finish_reason 同帧，也可能单独一帧（OpenAI 兼容实现的两种常见形态）
    chunks.push({ done: { finishReason: finish, usage: obj.usage } });
  } else if (obj.usage && chunks.length === 0) {
    chunks.push({ done: { finishReason: null, usage: obj.usage } });
  }
  return chunks;
}

function abortError(): Error {
  return new DOMException('This operation was aborted', 'AbortError');
}

/* ------------------------------------------------------------------ */
/* tool_calls 流式增量组装                                              */
/* ------------------------------------------------------------------ */

/**
 * 把流式 delta.tool_calls 片段按 index 归并成完整调用。
 * 片段形态：{index, id?, function?: {name?, arguments?}}，arguments 逐帧追加。
 */
export interface ToolCallAssembler {
  pushPayload(data: string): void;
  /** 有已组装调用时返回列表（index 升序），否则 undefined。 */
  result(): AssembledToolCall[] | undefined;
}

export function createToolCallAssembler(): ToolCallAssembler {
  const slots = new Map<number, { id: string; name: string; args: string }>();
  return {
    pushPayload(data: string): void {
      const trimmed = data.trim();
      if (trimmed.length === 0 || trimmed === '[DONE]') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // 与 chatChunksFromData 一致：坏帧忽略
      }
      const deltas = (parsed as { choices?: { delta?: { tool_calls?: unknown } }[] }).choices?.[0]
        ?.delta?.tool_calls;
      if (!Array.isArray(deltas)) return;
      for (const raw of deltas) {
        const frag = raw as {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        const index = typeof frag.index === 'number' ? frag.index : 0;
        const slot = slots.get(index) ?? { id: '', name: '', args: '' };
        if (typeof frag.id === 'string' && frag.id) slot.id = frag.id;
        if (typeof frag.function?.name === 'string' && frag.function.name) {
          slot.name = frag.function.name;
        }
        if (typeof frag.function?.arguments === 'string') slot.args += frag.function.arguments;
        slots.set(index, slot);
      }
    },
    result(): AssembledToolCall[] | undefined {
      if (slots.size === 0) return undefined;
      return [...slots.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, slot], i) => ({
          id: slot.id || `call_${i}`,
          name: slot.name,
          arguments: slot.args,
        }));
    },
  };
}

/**
 * Stream a chat completion as chunks: `{delta}` for content and a final
 * `{done}`. Stops reading at the done chunk even if the server keeps the
 * connection open; aborting the signal rejects the pending next() with an
 * AbortError and cancels the underlying reader.
 */
export async function* streamChat(
  args: StreamChatArgs,
): AsyncGenerator<ChatChunk, void, undefined> {
  const { baseUrl, model, apiKey, messages, signal } = args;
  if (!baseUrl || !model) throw new Error('LLM 未配置：请填写 baseUrl 与 model');
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = (await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      // 让兼容端点在末帧回传真实用量；不支持的端点会忽略该字段，统计自动退回估算
      stream_options: { include_usage: true },
      ...(args.tools && args.tools.length > 0
        ? { tools: args.tools, tool_choice: args.toolChoice ?? 'auto' }
        : {}),
    }),
  })) as PluginHttpResponse;
  if (!response.ok) {
    throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  if (signal.aborted) throw abortError();

  const parser = createSseParser();
  const toolCalls = createToolCallAssembler();
  const emitAll = function* (payloads: string[]): Generator<ChatChunk> {
    for (const payload of payloads) {
      toolCalls.pushPayload(payload);
      for (const chunk of chatChunksFromData(payload)) {
        // 工具调用只在 done 帧上交付：文本增量与调用增量走的是两条独立通道
        if ('done' in chunk) {
          const assembled = toolCalls.result();
          if (assembled) chunk.done.toolCalls = assembled;
        }
        yield chunk;
      }
    }
  };

  const body = response.body;
  if (!body) {
    // no stream body: parse the whole text payload as one SSE buffer
    const text = await response.text();
    if (signal.aborted) throw abortError();
    yield* emitAll(parser.push(text));
    yield* emitAll(parser.flush());
    return;
  }

  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const decoder = new TextDecoder();
    for (;;) {
      if (signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) {
        // abort while parked in read() resolves it as done — still an abort
        if (signal.aborted) throw abortError();
        break;
      }
      for (const chunk of emitAll(parser.push(decoder.decode(value, { stream: true })))) {
        yield chunk;
        if ('done' in chunk) return;
      }
    }
    for (const chunk of emitAll(parser.flush())) {
      yield chunk;
      if ('done' in chunk) return;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
