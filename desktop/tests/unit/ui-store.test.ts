// EXP-005 store 行为测试（node 环境：真实 SQLite 数据层 + 假供应商，不依赖 DOM）
import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  store,
  configureStore,
  initStore,
  sendUserText,
  editUserMessage,
  retryAssistant,
  copyText,
} from '../../src/app/store';
import type { LlmProvider, StreamChatArgs } from '../../src/services/llm/provider';

const clipboardWrite = vi.fn(async () => {});

function fakeProvider(prefix = '回答'): LlmProvider {
  let n = 0;
  return {
    mock: true,
    capabilities: () => ({ streaming: true }),
    streamChat: async function* (_args: StreamChatArgs) {
      n += 1;
      yield { delta: `${prefix}${n}-第一段。` };
      yield { delta: `${prefix}${n}-第二段。` };
    },
  };
}

beforeAll(async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWrite } });
  configureStore({ provider: fakeProvider() });
  await initStore();
  expect(store.initError).toBe('');
  expect(store.ready).toBe(true);
});

describe('对话持久化与分支', () => {
  it('发送消息后用户与助手两条都写入并回到 store', async () => {
    await sendUserText('你好，介绍一下你自己');
    expect(store.messages.length).toBe(2);
    expect(store.messages[0]).toMatchObject({ role: 'user' });
    expect(store.messages[0].text).toContain('你好');
    expect(store.messages[1]).toMatchObject({ role: 'assistant' });
    expect(store.messages[1].text).toContain('第一段');
  });

  it('编辑用户消息生成新分支，原分支消息保留', () => {
    const originalBranch = store.branchId;
    const userMsg = store.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeTruthy();
    editUserMessage(userMsg!.id, '改一下：请用一句话回答');
    expect(store.branchId).not.toBe(originalBranch);
    expect(store.messages.some((m) => m.text.includes('改一下'))).toBe(true);
    expect(store.branches.length).toBeGreaterThan(1);
  });

  it('重试助手回答生成新分支并重新回答', async () => {
    const before = store.branchId;
    const assistant = store.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeTruthy();
    await retryAssistant(assistant!.id);
    expect(store.branchId).not.toBe(before);
    const last = [...store.messages].reverse().find((m) => m.role === 'assistant');
    expect(last?.text).toContain('第一段');
  });

  it('复制写入剪贴板', async () => {
    await copyText('hello');
    expect(clipboardWrite).toHaveBeenCalledWith('hello');
  });

  it('空消息不产生新回合', async () => {
    const before = store.messages.length;
    await sendUserText('   ');
    expect(store.messages.length).toBe(before);
  });
});
