/**
 * plugins/taskService.ts — tasks 表 CRUD + 状态机 + 单执行租约。
 *
 * 数据层在 EXP-002 已建好 tasks 结构（status 列默认 'open'，仅结构）。本模块是
 * 唯一写入者，负责：
 * - 状态机 NOT_STARTED / IN_PROGRESS / DONE / BLOCKED（非法迁移抛 TaskError）；
 * - **单执行租约**：同一任务同一时刻只允许一个执行者，租约存于 payload.lease，
 *   到期可被接管，持有者可续租；他人持有租约时不得迁移状态；
 * - 旧值 'open' 读回映射为 NOT_STARTED（兼容数据层默认值，不谎报状态）。
 */

import { getDb, type Db, type DbRow, type SqlParams } from '../data/db';
import { newId, nowMs } from '../data/util';

export const TASK_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'BLOCKED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  NOT_STARTED: ['IN_PROGRESS', 'BLOCKED', 'DONE'],
  IN_PROGRESS: ['DONE', 'BLOCKED', 'NOT_STARTED'],
  BLOCKED: ['IN_PROGRESS', 'NOT_STARTED'],
  DONE: ['IN_PROGRESS'],
};

export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export type TaskErrorCode = 'not-found' | 'illegal-transition' | 'lease-held' | 'invalid';

export class TaskError extends Error {
  readonly code: TaskErrorCode;
  constructor(code: TaskErrorCode, message: string) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
  }
}

export interface TaskLease {
  owner: string;
  expiresAt: number;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  dueAt: number | null;
  memoryId: string | null;
  conversationId: string | null;
  branchId: string | null;
  payload: Record<string, unknown> | null;
}

export interface CreateTaskInput {
  title: string;
  dueAt?: number | null;
  memoryId?: string | null;
  conversationId?: string | null;
  branchId?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface UpdateTaskInput {
  title?: string;
  dueAt?: number | null;
  payload?: Record<string, unknown> | null;
}

export interface LeaseResult {
  ok: boolean;
  lease?: TaskLease;
  error?: TaskErrorCode;
  message?: string;
}

export interface TaskService {
  create(input: CreateTaskInput): Task;
  get(id: string): Task | null;
  list(filter?: { status?: TaskStatus | TaskStatus[] }): Task[];
  update(id: string, patch: UpdateTaskInput): Task;
  transition(id: string, next: TaskStatus, options?: { owner?: string }): Task;
  remove(id: string): boolean;
  acquireLease(id: string, owner: string, ttlMs?: number): LeaseResult;
  releaseLease(id: string, owner: string): boolean;
  leaseOf(id: string): TaskLease | null;
}

export interface TaskServiceDeps {
  db?: Db;
  now?: () => number;
  leaseTtlMs?: number;
}

function normalizeStatus(value: unknown): TaskStatus {
  const raw = String(value ?? '').trim();
  if ((TASK_STATUSES as readonly string[]).includes(raw)) return raw as TaskStatus;
  // 数据层建表默认 'open'（EXP-002 仅建结构）与未知值一律视为未开始。
  return 'NOT_STARTED';
}

function parsePayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function serializePayload(payload: Record<string, unknown> | null): string | null {
  return payload === null ? null : JSON.stringify(payload);
}

function mapRow(row: DbRow): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    status: normalizeStatus(row.status),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    dueAt: row.due_at == null ? null : Number(row.due_at),
    memoryId: row.memory_id == null ? null : String(row.memory_id),
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    branchId: row.branch_id == null ? null : String(row.branch_id),
    payload: parsePayload(row.payload),
  };
}

const SELECT_COLUMNS =
  'id, title, status, created_at, updated_at, due_at, memory_id, conversation_id, branch_id, payload';

export function createTaskService(deps: TaskServiceDeps = {}): TaskService {
  const db = () => deps.db ?? getDb();
  const now = deps.now ?? nowMs;
  const defaultLeaseTtl = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  function get(id: string): Task | null {
    const row = db().get(`SELECT ${SELECT_COLUMNS} FROM tasks WHERE id = ?`, [id]);
    return row ? mapRow(row) : null;
  }

  function persist(task: Task): void {
    db().run(
      'UPDATE tasks SET title = ?, status = ?, updated_at = ?, due_at = ?, memory_id = ?, conversation_id = ?, branch_id = ?, payload = ? WHERE id = ?',
      [
        task.title,
        task.status,
        task.updatedAt,
        task.dueAt,
        task.memoryId,
        task.conversationId,
        task.branchId,
        serializePayload(task.payload),
        task.id,
      ],
    );
  }

  function requireTask(id: string): Task {
    const task = get(id);
    if (!task) throw new TaskError('not-found', `任务不存在：${id}`);
    return task;
  }

  function leaseOf(id: string): TaskLease | null {
    const task = get(id);
    const lease = task?.payload?.lease as unknown;
    if (typeof lease !== 'object' || lease === null) return null;
    const { owner, expiresAt } = lease as { owner?: unknown; expiresAt?: unknown };
    if (typeof owner !== 'string' || typeof expiresAt !== 'number') return null;
    return { owner, expiresAt };
  }

  return {
    create(input: CreateTaskInput): Task {
      const title = input.title?.trim() ?? '';
      if (!title) throw new TaskError('invalid', '任务标题不能为空');
      const timestamp = now();
      const task: Task = {
        id: newId(),
        title,
        status: 'NOT_STARTED',
        createdAt: timestamp,
        updatedAt: timestamp,
        dueAt: input.dueAt ?? null,
        memoryId: input.memoryId ?? null,
        conversationId: input.conversationId ?? null,
        branchId: input.branchId ?? null,
        payload: input.payload ?? null,
      };
      db().run(
        'INSERT INTO tasks (id, title, status, created_at, updated_at, due_at, memory_id, conversation_id, branch_id, payload) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [
          task.id,
          task.title,
          task.status,
          task.createdAt,
          task.updatedAt,
          task.dueAt,
          task.memoryId,
          task.conversationId,
          task.branchId,
          serializePayload(task.payload),
        ],
      );
      return task;
    },

    get,

    list(filter: { status?: TaskStatus | TaskStatus[] } = {}): Task[] {
      const statuses =
        filter.status === undefined
          ? undefined
          : Array.isArray(filter.status)
            ? filter.status
            : [filter.status];
      const sql =
        statuses && statuses.length > 0
          ? `SELECT ${SELECT_COLUMNS} FROM tasks WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at ASC, id ASC`
          : `SELECT ${SELECT_COLUMNS} FROM tasks ORDER BY created_at ASC, id ASC`;
      const rows = statuses && statuses.length > 0 ? db().all(sql, statuses) : db().all(sql);
      return rows.map(mapRow);
    },

    update(id: string, patch: UpdateTaskInput): Task {
      const task = requireTask(id);
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!title) throw new TaskError('invalid', '任务标题不能为空');
        task.title = title;
      }
      if (patch.dueAt !== undefined) task.dueAt = patch.dueAt;
      if (patch.payload !== undefined) {
        // 合并而非整体替换：payload.lease 属于任务服务内部状态。
        task.payload = { ...(task.payload ?? {}), ...(patch.payload ?? {}) };
      }
      task.updatedAt = now();
      persist(task);
      return task;
    },

    transition(id: string, next: TaskStatus, options: { owner?: string } = {}): Task {
      if (!(TASK_STATUSES as readonly string[]).includes(next)) {
        throw new TaskError('invalid', `未知任务状态：${String(next)}`);
      }
      const task = requireTask(id);
      if (task.status === next) return task;
      if (!ALLOWED_TRANSITIONS[task.status].includes(next)) {
        throw new TaskError(
          'illegal-transition',
          `非法状态迁移：${task.status} → ${next}（允许：${ALLOWED_TRANSITIONS[task.status].join(', ') || '无'}）`,
        );
      }
      const lease = leaseOf(id);
      if (lease && lease.expiresAt > now() && lease.owner !== options.owner) {
        throw new TaskError('lease-held', `任务 ${id} 的执行租约由 ${lease.owner} 持有，禁止他人迁移状态`);
      }
      task.status = next;
      task.updatedAt = now();
      persist(task);
      return task;
    },

    remove(id: string): boolean {
      if (!get(id)) return false;
      db().run('DELETE FROM tasks WHERE id = ?', [id]);
      return true;
    },

    acquireLease(id: string, owner: string, ttlMs: number = defaultLeaseTtl): LeaseResult {
      const task = get(id);
      if (!task) return { ok: false, error: 'not-found', message: `任务不存在：${id}` };
      const timestamp = now();
      const current = leaseOf(id);
      if (current && current.owner !== owner && current.expiresAt > timestamp) {
        return {
          ok: false,
          error: 'lease-held',
          message: `任务 ${id} 的租约由 ${current.owner} 持有至 ${current.expiresAt}`,
        };
      }
      const lease: TaskLease = { owner, expiresAt: timestamp + ttlMs };
      task.payload = { ...(task.payload ?? {}), lease };
      task.updatedAt = timestamp;
      persist(task);
      return { ok: true, lease };
    },

    releaseLease(id: string, owner: string): boolean {
      const task = get(id);
      if (!task) return false;
      const current = leaseOf(id);
      if (!current || current.owner !== owner) return false;
      const nextPayload = { ...(task.payload ?? {}) };
      delete nextPayload.lease;
      task.payload = Object.keys(nextPayload).length > 0 ? nextPayload : null;
      task.updatedAt = now();
      persist(task);
      return true;
    },

    leaseOf,
  };
}
