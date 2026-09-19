import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../src/data/db';
import {
  addMessage,
  createConversation,
  editMessage,
  listBranches,
  listMessages,
  retryFrom,
  rollbackTo,
  type MessageRecord,
} from '../../src/data/conversations';

describe('data/conversations：消息链与分支', () => {
  beforeEach(async () => {
    const { initDb } = await import('../../src/data/db');
    await initDb();
  });
  afterEach(() => {
    closeDb();
  });

  function chain(): { convId: string; rootBranch: string; msgs: MessageRecord[] } {
    const c = createConversation();
    const msgs: MessageRecord[] = [];
    msgs.push(addMessage({ conversationId: c.id, branchId: c.branchId, role: 'user', text: 'A' }));
    msgs.push(
      addMessage({ conversationId: c.id, branchId: c.branchId, role: 'assistant', text: 'B' }),
    );
    msgs.push(addMessage({ conversationId: c.id, branchId: c.branchId, role: 'user', text: 'C' }));
    msgs.push(
      addMessage({ conversationId: c.id, branchId: c.branchId, role: 'assistant', text: 'D' }),
    );
    return { convId: c.id, rootBranch: c.branchId, msgs };
  }

  it('createConversation 建根分支；addMessage 链式追加且省略 parentId 时自动接尾', () => {
    const c = createConversation();
    expect(c.branchId).toBeTruthy();
    const m1 = addMessage({ conversationId: c.id, branchId: c.branchId, role: 'user', text: '帮我查天气' });
    const m2 = addMessage({
      conversationId: c.id,
      branchId: c.branchId,
      role: 'assistant',
      text: '今天晴',
      parentId: m1.id,
    });
    expect(m2.parentId).toBe(m1.id);
    // 省略 parentId → 接到当前末尾
    const m3 = addMessage({ conversationId: c.id, branchId: c.branchId, role: 'user', text: '明天呢' });
    expect(m3.parentId).toBe(m2.id);

    const msgs = listMessages(c.branchId);
    expect(msgs.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs.every((m) => m.edited === false && m.originId === null)).toBe(true);
    // 非末尾 parent：拒绝（分叉必须走 editMessage/retryFrom 产生新分支）
    expect(() =>
      addMessage({ conversationId: c.id, branchId: c.branchId, role: 'user', text: 'x', parentId: m1.id }),
    ).toThrow(/parent/);
  });

  it('editMessage 从首条编辑：新分支止于编辑后的消息（不搬运旧回复），原分支不变', () => {
    const { convId, rootBranch, msgs } = chain();
    const [m1] = msgs;
    const e = editMessage(m1!.id, 'A改');

    const branchMsgs = listMessages(e.branchId);
    expect(branchMsgs).toHaveLength(1);
    expect(branchMsgs[0]).toMatchObject({ id: e.messageId, text: 'A改', edited: true, originId: m1!.id, parentId: null });

    // 原分支完全不变（旧回复留在原分支可回溯）
    expect(listMessages(rootBranch).map((m) => m.text)).toEqual(['A', 'B', 'C', 'D']);
    // 分支记录：父分支指向原分支，fork 点 = 被编辑消息的父（首条 → null）
    const branches = listBranches(convId);
    expect(branches).toHaveLength(2);
    const nb = branches.find((b) => b.id === e.branchId);
    expect(nb).toMatchObject({ parentBranchId: rootBranch, forkMessageId: null, messageCount: 1 });
    // 活动分支切换到新分支
    expect(
      getDb().get('SELECT active_branch_id AS a FROM conversations WHERE id = ?', [convId])?.a,
    ).toBe(e.branchId);
  });

  it('editMessage 从中间编辑：新分支=前缀+编辑消息；forkMessageId 指向断点', () => {
    const { convId, rootBranch, msgs } = chain();
    const [, m2] = msgs;
    const e = editMessage(m2!.id, 'B改');

    const branchMsgs = listMessages(e.branchId);
    expect(branchMsgs).toHaveLength(2);
    expect(branchMsgs[0]).toMatchObject({ text: 'A', edited: false, originId: msgs[0]!.id, parentId: null });
    expect(branchMsgs[1]).toMatchObject({ text: 'B改', edited: true, originId: m2!.id, parentId: branchMsgs[0]!.id });

    const nb = listBranches(convId).find((b) => b.id === e.branchId);
    expect(nb).toMatchObject({ parentBranchId: rootBranch, forkMessageId: msgs[0]!.id, messageCount: 2 });
    expect(listMessages(rootBranch)).toHaveLength(4);
  });

  it('rollbackTo：新分支保留到目标消息为止（含），之后留在原分支', () => {
    const { convId, rootBranch, msgs } = chain();
    const r = rollbackTo(msgs[1]!.id);
    expect(listMessages(r.branchId).map((m) => m.text)).toEqual(['A', 'B']);
    expect(r.parentMessageId).toBe(msgs[0]!.id);
    // 原分支不动；分支记录 fork 点 = 目标消息本身
    expect(listMessages(rootBranch)).toHaveLength(4);
    const nb = listBranches(convId).find((b) => b.id === r.branchId);
    expect(nb).toMatchObject({ parentBranchId: rootBranch, forkMessageId: msgs[1]!.id, messageCount: 2 });
    // 回退到首条：新分支只含首条
    const r2 = rollbackTo(msgs[0]!.id);
    expect(listMessages(r2.branchId).map((m) => m.text)).toEqual(['A']);
    expect(r2.parentMessageId).toBeNull();
  });

  it('retryFrom：新分支止于目标消息的父级，供重新生成', () => {
    const { convId, rootBranch, msgs } = chain();
    const r = retryFrom(msgs[3]!.id);
    const branchMsgs = listMessages(r.branchId);
    expect(branchMsgs.map((m) => m.text)).toEqual(['A', 'B', 'C']);
    expect(r.parentMessageId).toBe(msgs[2]!.id);

    // 从首条重试 → 空分支
    const r2 = retryFrom(msgs[0]!.id);
    expect(listMessages(r2.branchId)).toHaveLength(0);
    expect(r2.parentMessageId).toBeNull();

    expect(listMessages(rootBranch)).toHaveLength(4);
    expect(listBranches(convId)).toHaveLength(3);
  });

  it('分支间消息隔离：新分支消息不出现在原分支，原分支文本不变', () => {
    const { rootBranch, msgs } = chain();
    const e = editMessage(msgs[1]!.id, 'B改');
    expect(listMessages(rootBranch).map((m) => m.text)).toEqual(['A', 'B', 'C', 'D']);
    expect(listMessages(e.branchId).map((m) => m.text)).toEqual(['A', 'B改']);
    // 新分支的消息 id 全新，与原分支零共享
    const rootIds = new Set(listMessages(rootBranch).map((m) => m.id));
    expect(listMessages(e.branchId).every((m) => !rootIds.has(m.id))).toBe(true);
  });

  it('校验：会话/分支/消息不存在时报错', () => {
    const c = createConversation();
    expect(() =>
      addMessage({ conversationId: 'no-such-conv', branchId: c.branchId, role: 'user', text: 'x' }),
    ).toThrow(/conversation/);
    expect(() =>
      addMessage({ conversationId: c.id, branchId: 'no-such-branch', role: 'user', text: 'x' }),
    ).toThrow(/branch/);
    expect(() => addMessage({ conversationId: c.id, branchId: c.branchId, role: 'user', text: '  ' })).toThrow(
      /text/,
    );
    expect(() => editMessage('no-such-message', 'x')).toThrow(/not found/);
    expect(() => retryFrom('no-such-message')).toThrow(/not found/);
  });
});
