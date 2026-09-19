/**
 * data/conversations.ts — 聊天持久化与分支（任务书接口，不得擅改）：
 * - createConversation(): 建会话 + 根分支，返回 { id, branchId, createdAt }
 * - addMessage({conversationId,branchId,role,text,parentId}): 追加消息；
 *   parentId 省略/null 时自动接到分支末尾；提供时必须是末尾（分叉走 editMessage/retryFrom）
 * - editMessage(id, newText): 创建新分支（copy 语义=剪贴板在 UI 层），
 *   新分支 = 到父级为止的前缀副本 + 编辑后的消息；返回 { branchId, messageId }
 * - retryFrom(id): 新分支止于目标消息的父级，供重新生成；返回 { branchId, parentMessageId }
 * - listBranches(convId) / listMessages(branchId)
 */

import { getDb, type Db, type DbRow } from './db';
import { newId, nowMs } from './util';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface MessageRecord {
  id: string;
  conversationId: string;
  branchId: string;
  role: ChatRole | string;
  text: string;
  parentId: string | null;
  /** 本行由哪条原始消息复制/编辑而来；全新消息为 null。 */
  originId: string | null;
  edited: boolean;
  createdAt: number;
}

export interface BranchRecord {
  id: string;
  conversationId: string;
  parentBranchId: string | null;
  /** 分支从原分支哪条消息之后岔出（= 被编辑/重试消息的父）。 */
  forkMessageId: string | null;
  title: string | null;
  createdAt: number;
  messageCount: number;
}

export interface AddMessageInput {
  conversationId: string;
  branchId: string;
  role: ChatRole | string;
  text: string;
  parentId?: string | null;
}

export interface EditMessageResult {
  branchId: string;
  messageId: string;
}

export interface RetryFromResult {
  branchId: string;
  parentMessageId: string | null;
}

/* ------------------------------------------------------------------ */
/* 基础查询                                                             */
/* ------------------------------------------------------------------ */

function requireConversation(db: Db, conversationId: string): void {
  if (!db.get('SELECT id FROM conversations WHERE id = ?', [conversationId])) {
    throw new Error(`conversations: conversation not found: ${conversationId}`);
  }
}

function requireBranch(db: Db, conversationId: string, branchId: string): void {
  const branch = db.get('SELECT conversation_id FROM branches WHERE id = ?', [branchId]);
  if (!branch || String(branch.conversation_id) !== conversationId) {
    throw new Error(`conversations: branch not in conversation: ${branchId}`);
  }
}

/** 分支末尾消息：不被本分支任何消息引用为 parent 的那条。 */
function getTailMessageId(db: Db, branchId: string): string | null {
  const row = db.get(
    'SELECT m.id FROM messages m ' +
      'WHERE m.branch_id = ? AND NOT EXISTS (' +
      'SELECT 1 FROM messages c WHERE c.parent_id = m.id AND c.branch_id = m.branch_id) ' +
      'ORDER BY m.created_at DESC, m.id DESC LIMIT 1',
    [branchId],
  );
  return row ? String(row.id) : null;
}

function rowToMessage(row: DbRow): MessageRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    branchId: String(row.branch_id),
    role: String(row.role),
    text: String(row.text),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    originId: row.origin_id == null ? null : String(row.origin_id),
    edited: Number(row.edited) !== 0,
    createdAt: Number(row.created_at),
  };
}

/**
 * 根 → uptoId 的前缀链（同分支内沿 parent_id 回溯）。
 * 链断裂或跨分支视为数据损坏，抛错。
 */
function prefixChain(db: Db, branchId: string, uptoId: string): DbRow[] {
  const chain: DbRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = uptoId;
  while (cursor !== null) {
    if (seen.has(cursor)) throw new Error(`conversations: cycle detected at message ${cursor}`);
    seen.add(cursor);
    const row = db.get('SELECT * FROM messages WHERE id = ? AND branch_id = ?', [cursor, branchId]);
    if (!row) throw new Error(`conversations: broken branch chain at message ${cursor}`);
    chain.unshift(row);
    cursor = row.parent_id == null ? null : String(row.parent_id);
  }
  return chain;
}

function insertMessageCopy(
  db: Db,
  conversationId: string,
  branchId: string,
  source: DbRow,
  parentId: string | null,
): string {
  const copyId = newId();
  db.run(
    'INSERT INTO messages (id, conversation_id, branch_id, role, text, parent_id, origin_id, edited, created_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?)",
    [
      copyId,
      conversationId,
      branchId,
      String(source.role),
      String(source.text),
      parentId,
      String(source.id),
      Number(source.created_at),
    ],
  );
  return copyId;
}

/* ------------------------------------------------------------------ */
/* 接口实现                                                             */
/* ------------------------------------------------------------------ */

export function createConversation(): { id: string; branchId: string; createdAt: number } {
  const db = getDb();
  const id = newId();
  const branchId = newId();
  const now = nowMs();
  db.transaction(() => {
    db.run(
      'INSERT INTO conversations (id, created_at, updated_at, active_branch_id) VALUES (?, ?, ?, ?)',
      [id, now, now, branchId],
    );
    db.run(
      'INSERT INTO branches (id, conversation_id, parent_branch_id, fork_message_id, title, created_at) ' +
        'VALUES (?, ?, NULL, NULL, NULL, ?)',
      [branchId, id, now],
    );
  });
  db.schedulePersist();
  return { id, branchId, createdAt: now };
}

export function addMessage(input: AddMessageInput): MessageRecord {
  if (!input.text.trim()) throw new Error('addMessage: text 不能为空');
  if (!String(input.role).trim()) throw new Error('addMessage: role 不能为空');
  const db = getDb();
  requireConversation(db, input.conversationId);
  requireBranch(db, input.conversationId, input.branchId);

  const tailId = getTailMessageId(db, input.branchId);
  const parentId = input.parentId == null ? tailId : input.parentId;
  if (parentId !== null && parentId !== tailId) {
    throw new Error(
      'addMessage: parentId 必须是当前分支末尾消息；中途分叉请使用 editMessage / retryFrom',
    );
  }

  const id = newId();
  const now = nowMs();
  db.transaction(() => {
    db.run(
      'INSERT INTO messages (id, conversation_id, branch_id, role, text, parent_id, origin_id, edited, created_at) ' +
        "VALUES (?, ?, ?, ?, ?, ?, NULL, '0', ?)",
      [id, input.conversationId, input.branchId, String(input.role), input.text, parentId, now],
    );
    db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now, input.conversationId]);
  });
  db.schedulePersist();
  return {
    id,
    conversationId: input.conversationId,
    branchId: input.branchId,
    role: String(input.role),
    text: input.text,
    parentId,
    originId: null,
    edited: false,
    createdAt: now,
  };
}

/**
 * 编辑消息 → 新分支（UI 合同 §1.4.1）：新分支 = 该消息之前的前缀副本 + 编辑后的消息，
 * **不搬运旧回复后缀**——编辑的语义是「从这里重新来过」，旧回答留在原分支可回溯。
 * 原分支原消息不动（保留完整历史），活动分支切到新分支。
 * copy 语义=剪贴板在 UI 层（数据层只负责分支与副本记录）。
 * fork_message_id = 被编辑消息的父（与父分支最后一个共享原消息）。
 */
export function editMessage(id: string, newText: string): EditMessageResult {
  const text = newText.trim();
  if (!text) throw new Error('editMessage: newText 不能为空');
  const db = getDb();
  const message = db.get('SELECT * FROM messages WHERE id = ?', [id]);
  if (!message) throw new Error(`editMessage: message not found: ${id}`);

  const oldBranchId = String(message.branch_id);
  const conversationId = String(message.conversation_id);
  const parentId = message.parent_id == null ? null : String(message.parent_id);
  const chain = messagesOfBranch(db, oldBranchId);
  const index = chain.findIndex((row) => String(row.id) === id);
  if (index < 0) throw new Error(`editMessage: branch chain lost message ${id}`);
  const prefix = chain.slice(0, index);

  const newBranchId = newId();
  const editedId = newId();
  const now = nowMs();
  db.transaction(() => {
    db.run(
      'INSERT INTO branches (id, conversation_id, parent_branch_id, fork_message_id, title, created_at) ' +
        'VALUES (?, ?, ?, ?, NULL, ?)',
      [newBranchId, conversationId, oldBranchId, parentId, now],
    );
    let lastId: string | null = null;
    for (const source of prefix) {
      lastId = insertMessageCopy(db, conversationId, newBranchId, source, lastId);
    }
    db.run(
      'INSERT INTO messages (id, conversation_id, branch_id, role, text, parent_id, origin_id, edited, created_at) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, '1', ?)",
      [editedId, conversationId, newBranchId, String(message.role), text, lastId, String(message.id), now],
    );
    db.run('UPDATE conversations SET active_branch_id = ?, updated_at = ? WHERE id = ?', [
      newBranchId,
      now,
      conversationId,
    ]);
  });
  db.schedulePersist();
  return { branchId: newBranchId, messageId: editedId };
}

/**
 * 回退到指定消息：新分支 = 到该消息为止（含）的前缀副本，之后的内容留在原分支。
 * 与 retryFrom 的差别：rollbackTo 保留目标消息本身（用户想「回到这一点」，
 * 而不是「删掉这一条重生成」）。外部动作（发送/购买等）不因回退而撤销（UI §1.4.4）。
 */
export function rollbackTo(id: string): RetryFromResult {
  const db = getDb();
  const message = db.get('SELECT * FROM messages WHERE id = ?', [id]);
  if (!message) throw new Error(`rollbackTo: message not found: ${id}`);

  const oldBranchId = String(message.branch_id);
  const conversationId = String(message.conversation_id);
  const prefix = prefixChain(db, oldBranchId, id);

  const newBranchId = newId();
  const now = nowMs();
  db.transaction(() => {
    db.run(
      'INSERT INTO branches (id, conversation_id, parent_branch_id, fork_message_id, title, created_at) ' +
        'VALUES (?, ?, ?, ?, NULL, ?)',
      [newBranchId, conversationId, oldBranchId, id, now],
    );
    let lastId: string | null = null;
    for (const source of prefix) {
      lastId = insertMessageCopy(db, conversationId, newBranchId, source, lastId);
    }
    db.run('UPDATE conversations SET active_branch_id = ?, updated_at = ? WHERE id = ?', [
      newBranchId,
      now,
      conversationId,
    ]);
  });
  db.schedulePersist();
  const parentId = message.parent_id == null ? null : String(message.parent_id);
  return { branchId: newBranchId, parentMessageId: parentId };
}

/**
 * 从指定消息重试：新分支只复制到其父级为止（不含该消息及之后），供引擎
 * 重新生成一条 assistant 回复追加到新分支末尾；活动分支切到新分支。
 */
export function retryFrom(id: string): RetryFromResult {
  const db = getDb();
  const message = db.get('SELECT * FROM messages WHERE id = ?', [id]);
  if (!message) throw new Error(`retryFrom: message not found: ${id}`);

  const oldBranchId = String(message.branch_id);
  const conversationId = String(message.conversation_id);
  const parentId = message.parent_id == null ? null : String(message.parent_id);
  const prefix = parentId === null ? [] : prefixChain(db, oldBranchId, parentId);

  const newBranchId = newId();
  const now = nowMs();
  db.transaction(() => {
    db.run(
      'INSERT INTO branches (id, conversation_id, parent_branch_id, fork_message_id, title, created_at) ' +
        'VALUES (?, ?, ?, ?, NULL, ?)',
      [newBranchId, conversationId, oldBranchId, parentId, now],
    );
    let lastId: string | null = null;
    for (const source of prefix) {
      lastId = insertMessageCopy(db, conversationId, newBranchId, source, lastId);
    }
    db.run('UPDATE conversations SET active_branch_id = ?, updated_at = ? WHERE id = ?', [
      newBranchId,
      now,
      conversationId,
    ]);
  });
  db.schedulePersist();
  return { branchId: newBranchId, parentMessageId: parentId };
}

export function listBranches(conversationId: string): BranchRecord[] {
  const db = getDb();
  requireConversation(db, conversationId);
  const rows = db.all(
    'SELECT * FROM branches WHERE conversation_id = ? ORDER BY created_at ASC, id',
    [conversationId],
  );
  return rows.map((row) => {
    const branchId = String(row.id);
    const count = db.get('SELECT COUNT(*) AS c FROM messages WHERE branch_id = ?', [branchId]);
    return {
      id: branchId,
      conversationId,
      parentBranchId: row.parent_branch_id == null ? null : String(row.parent_branch_id),
      forkMessageId: row.fork_message_id == null ? null : String(row.fork_message_id),
      title: row.title == null ? null : String(row.title),
      createdAt: Number(row.created_at),
      messageCount: count ? Number(count.c) : 0,
    };
  });
}

export function listMessages(branchId: string): MessageRecord[] {
  const db = getDb();
  if (!db.get('SELECT id FROM branches WHERE id = ?', [branchId])) {
    throw new Error(`listMessages: branch not found: ${branchId}`);
  }
  return messagesOfBranch(db, branchId).map(rowToMessage);
}

/** 分支内消息按链序（根→尾）排列；created_at 相同的兄弟按 id 定序，visited 防环。 */
function messagesOfBranch(db: Db, branchId: string): DbRow[] {
  const rows = db.all('SELECT * FROM messages WHERE branch_id = ?', [branchId]);
  const childrenByParent = new Map<string | null, DbRow[]>();
  for (const row of rows) {
    const parent = row.parent_id == null ? null : String(row.parent_id);
    const bucket = childrenByParent.get(parent);
    if (bucket) bucket.push(row);
    else childrenByParent.set(parent, [row]);
  }
  const byCreated = (a: DbRow, b: DbRow): number => {
    const delta = Number(a.created_at) - Number(b.created_at);
    return delta !== 0 ? delta : String(a.id) < String(b.id) ? -1 : 1;
  };
  const ordered: DbRow[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null): void => {
    const children = (childrenByParent.get(parent) ?? []).slice().sort(byCreated);
    for (const child of children) {
      const childId = String(child.id);
      if (visited.has(childId)) continue;
      visited.add(childId);
      ordered.push(child);
      walk(childId);
    }
  };
  walk(null);
  return ordered;
}
