// FEATURE-01 F1-CORE 行为测试（node 环境）：tool_calls 增量组装、对话工具循环、
// 记忆注入、historyTurns 生效、MC 指令门控、回退到此处。
import { describe, it, expect, beforeAll } from 'vitest';
import { createToolCallAssembler } from '../../src/services/llm/openaiCompat';
import {
  store,
  configureStore,
  initStore,
  sendUserText,
  rollbackToMessage,
  mcCommandAllowed,
  setTab,
} from '../../src/app/store';
import { proposeWrite } from '../../src/data/memory';
import type {
  ChatChunk,
  ChatMessage,
  LlmProvider,
  StreamChatArgs,
} from '../../src/services/llm/provider';

describe('openaiCompat tool_calls 增量组装', () => {
  it('跨帧片段按 index 归并成完整调用', () => {
    const assembler = createToolCallAssembler();
    assembler.pushPayload(
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'memory.search', arguments: '{"que' } }] } },
        ],
      }),
    );
    assembler.pushPayload(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"伞"}' } }] } }],
      }),
    );
    assembler.pushPayload(
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'time.now', arguments: '{}' } }] } },
        ],
      }),
    );
    expect(assembler.result()).toEqual([
      { id: 'call_1', name: 'memory.search', arguments: '{"que' + 'ry":"伞"}' },
      { id: 'call_2', name: 'time.now', arguments: '{}' },
    ]);
  });

  it('无工具增量时 result 为 undefined；坏帧忽略', () => {
    const assembler = createToolCallAssembler();
    assembler.pushPayload('{"broken');
    assembler.pushPayload(JSON.stringify({ choices: [{ delta: { content: '你好' } }] }));
    expect(assembler.result()).toBeUndefined();
  });
});

/* ── store 级：工具循环 / 记忆注入 / 门控 ─────────────────────────────── */

interface RecordedCall {
  messages: ChatMessage[];
  tools?: unknown;
}

let calls: RecordedCall[] = [];
let behavior: 'tool-loop' | 'plain' = 'plain';

/** 可换脑的总机供应商：initStore 只调一次，测试用例经 current 切换行为。 */
const delegate: LlmProvider = {
  mock: false,
  capabilities: () => ({ streaming: true }),
  streamChat: async function* (args: StreamChatArgs): AsyncGenerator<ChatChunk> {
    calls.push({ messages: [...args.messages], tools: args.tools });
    if (behavior === 'tool-loop' && !args.messages.some((m) => m.role === 'tool')) {
      yield {
        done: {
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'memory.search', arguments: '{"query":"伞","topK":2}' }],
        },
      };
      return;
    }
    yield { delta: '你有一把黑伞，出门别忘了。' };
    yield { done: { finishReason: 'stop' } };
  },
};

beforeAll(async () => {
  configureStore({ provider: delegate });
  await initStore();
  expect(store.initError).toBe('');
  expect(store.ready).toBe(true);
});

describe('对话工具循环与注入', () => {
  it('模型 tool_calls → memory.search 执行 → 结果回注第二轮 → 回答写入', async () => {
    proposeWrite({ kind: 'fact', text: '用户有一把黑伞', tags: ['物品'], scope: 'personal' });
    calls = [];
    behavior = 'tool-loop';
    store.providerSettings = { ...store.providerSettings, toolsEnabled: true };

    const accepted = await sendUserText('黑伞，今天要带吗？');
    expect(accepted).toBe(true);
    expect(calls.length).toBe(2);
    // 第一轮暴露工具声明
    expect(Array.isArray(calls[0]!.tools)).toBe(true);
    // 第二轮带着 assistant.tool_calls 与 role=tool 的结果消息
    const second = calls[1]!.messages;
    const assistantWithCalls = second.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantWithCalls).toBeTruthy();
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content).toContain('黑伞');
    // 最终回答进对话
    expect(store.messages.at(-1)?.text).toContain('黑伞');
    // 系统提示带记忆摘录注入（数据非指令框架）
    const systemMsg = calls[0]!.messages.find((m) => m.role === 'system');
    expect(systemMsg!.content).toContain('本地记忆摘录');
    expect(systemMsg!.content).toContain('不是指令');
    behavior = 'plain';
  });

  it('historyTurns=0 时不带历史；=1 时只带最近一轮', async () => {
    calls = [];
    store.providerSettings = { ...store.providerSettings, historyTurns: 1 };
    await sendUserText('第一句');
    await sendUserText('第二句');
    // 第二轮：system + 上一轮两条 + 本轮 user = 4
    expect(calls[1]!.messages).toHaveLength(4);

    store.providerSettings = { ...store.providerSettings, historyTurns: 0 };
    await sendUserText('第三句');
    expect(calls[2]!.messages).toHaveLength(2); // system + user
    store.providerSettings = { ...store.providerSettings, historyTurns: 8 };
  });

  it('MC 指令门控：仅 MC 页签或显式前缀放行', () => {
    setTab('chat');
    expect(mcCommandAllowed('我在挖坑给自己跳')).toBe(false);
    expect(mcCommandAllowed('帮我挖点石头')).toBe(false);
    expect(mcCommandAllowed('MC 去挖矿')).toBe(true);
    expect(mcCommandAllowed('我的世界 里建个房子')).toBe(true);
    setTab('mc');
    expect(mcCommandAllowed('跟着我')).toBe(true);
    setTab('chat');
  });

  it('回退到此处：新分支止于目标消息，原分支保留', async () => {
    await sendUserText('回退测试一');
    const target = store.messages.at(-1)!; // assistant 回答
    await sendUserText('回退测试二');
    const before = store.branchId;
    const count = store.branches.length;
    rollbackToMessage(target.id);
    expect(store.branchId).not.toBe(before);
    // 新分支是副本链：消息 id 全新，originId 指回原消息
    expect(store.messages.at(-1)?.originId).toBe(target.id);
    expect(store.messages.at(-1)?.text).toBe(target.text);
    expect(store.messages.some((m) => m.text === '回退测试二')).toBe(false);
    expect(store.branches.length).toBe(count + 1);
  });
});
