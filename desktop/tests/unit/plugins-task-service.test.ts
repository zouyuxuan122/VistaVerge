// EXP-006 任务服务测试：tasks 表 CRUD + 状态机 + 单执行租约。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/data/db';
import {
  DEFAULT_LEASE_TTL_MS,
  TASK_STATUSES,
  TaskError,
  createTaskService,
  type TaskStatus,
} from '../../src/plugins/taskService';

const T0 = 1_700_000_000_000;

describe('taskService：CRUD 与状态机', () => {
  beforeEach(async () => {
    await initDb();
  });
  afterEach(() => {
    closeDb();
  });

  function svc(startAt = T0) {
    let now = startAt;
    const service = createTaskService({ now: () => now });
    return { service, advance: (ms: number) => (now += ms) };
  }

  it('创建任务默认 NOT_STARTED，时间戳来自注入时钟', () => {
    const { service } = svc();
    const task = service.create({ title: '整理错题' });
    expect(task).toMatchObject({ title: '整理错题', status: 'NOT_STARTED', createdAt: T0, updatedAt: T0 });
    expect(task.id).toMatch(/[0-9a-f-]{8,}/);
    expect(service.get(task.id)).toEqual(task);
    expect(service.get('missing')).toBeNull();
    expect(TASK_STATUSES).toEqual(['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'BLOCKED']);
  });

  it('创建校验：空标题拒绝', () => {
    const { service } = svc();
    expect(() => service.create({ title: '  ' })).toThrow(TaskError);
  });

  it('update 修改标题/截止/负载并推进 updatedAt', () => {
    const { service, advance } = svc();
    const task = service.create({ title: 'A' });
    advance(1000);
    const updated = service.update(task.id, { title: 'B', dueAt: T0 + 86_400_000, payload: { note: 'x' } });
    expect(updated).toMatchObject({ title: 'B', dueAt: T0 + 86_400_000, payload: { note: 'x' }, updatedAt: T0 + 1000 });
    expect(() => service.update('missing', { title: 'C' })).toThrow(TaskError);
  });

  it('list 支持按状态过滤', () => {
    const { service } = svc();
    const a = service.create({ title: 'A' });
    service.create({ title: 'B' });
    service.transition(a.id, 'IN_PROGRESS');
    expect(service.list().map((t) => t.title).sort()).toEqual(['A', 'B']);
    expect(service.list({ status: 'IN_PROGRESS' }).map((t) => t.title)).toEqual(['A']);
    expect(service.list({ status: ['NOT_STARTED', 'BLOCKED'] }).map((t) => t.title)).toEqual(['B']);
  });

  it('状态机：合法迁移成功，非法迁移抛 illegal-transition，同态幂等', () => {
    const { service } = svc();
    const task = service.create({ title: 'A' });
    expect(service.transition(task.id, 'NOT_STARTED').status).toBe('NOT_STARTED');
    expect(service.transition(task.id, 'IN_PROGRESS').status).toBe('IN_PROGRESS');
    expect(service.transition(task.id, 'DONE').status).toBe('DONE');
    expect(service.transition(task.id, 'IN_PROGRESS').status).toBe('IN_PROGRESS');

    const blocked = service.create({ title: 'B' });
    expect(service.transition(blocked.id, 'BLOCKED').status).toBe('BLOCKED');
    expect(service.transition(blocked.id, 'IN_PROGRESS').status).toBe('IN_PROGRESS');

    const done = service.create({ title: 'C' });
    service.transition(done.id, 'DONE');
    let caught: unknown;
    try {
      service.transition(done.id, 'BLOCKED');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TaskError);
    expect((caught as TaskError).code).toBe('illegal-transition');
    expect(() => service.transition(done.id, 'WHATEVER' as TaskStatus)).toThrow(TaskError);
  });

  it('remove 删除任务，再次 get 为 null', () => {
    const { service } = svc();
    const task = service.create({ title: 'A' });
    expect(service.remove(task.id)).toBe(true);
    expect(service.remove(task.id)).toBe(false);
    expect(service.get(task.id)).toBeNull();
  });

  it('任务跨服务实例持久化（同一 DB）', () => {
    const first = createTaskService({ now: () => T0 });
    const task = first.create({ title: '持久化任务' });
    const second = createTaskService({ now: () => T0 + 5 });
    expect(second.get(task.id)).toMatchObject({ title: '持久化任务', status: 'NOT_STARTED' });
  });

  it('legacy 状态值 open 读回映射为 NOT_STARTED', async () => {
    const { getDb } = await import('../../src/data/db');
    getDb().run('INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?,?,?,?,?)', [
      'legacy-1',
      '旧任务',
      'open',
      T0,
      T0,
    ]);
    const service = createTaskService({ now: () => T0 });
    expect(service.get('legacy-1')?.status).toBe('NOT_STARTED');
  });
});

describe('taskService：单执行租约', () => {
  beforeEach(async () => {
    await initDb();
  });
  afterEach(() => {
    closeDb();
  });

  function svc(startAt = T0) {
    let now = startAt;
    const service = createTaskService({ now: () => now });
    return { service, advance: (ms: number) => (now += ms) };
  }

  it('同一时刻仅一个持有者可获租约，他人 acquire 被拒', () => {
    const { service } = svc();
    const task = service.create({ title: 'A' });
    const first = service.acquireLease(task.id, 'agent-A');
    expect(first.ok).toBe(true);
    expect(first.lease).toMatchObject({ owner: 'agent-A', expiresAt: T0 + DEFAULT_LEASE_TTL_MS });

    const second = service.acquireLease(task.id, 'agent-B');
    expect(second.ok).toBe(false);
    expect(second.error).toBe('lease-held');
    expect(service.leaseOf(task.id)?.owner).toBe('agent-A');
  });

  it('他人持有租约时不得迁移状态；持有者可以', () => {
    const { service } = svc();
    const task = service.create({ title: 'A' });
    service.acquireLease(task.id, 'agent-A');

    let caught: unknown;
    try {
      service.transition(task.id, 'IN_PROGRESS', { owner: 'agent-B' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TaskError);
    expect((caught as TaskError).code).toBe('lease-held');

    expect(service.transition(task.id, 'IN_PROGRESS', { owner: 'agent-A' }).status).toBe('IN_PROGRESS');
  });

  it('租约到期后可被他人接管；持有者可续租', () => {
    const { service, advance } = svc();
    const task = service.create({ title: 'A' });
    service.acquireLease(task.id, 'agent-A', 1000);
    advance(500);
    expect(service.acquireLease(task.id, 'agent-A', 1000).ok).toBe(true);
    advance(600);
    expect(service.acquireLease(task.id, 'agent-A').ok).toBe(true);
    advance(DEFAULT_LEASE_TTL_MS + 1);
    const takeover = service.acquireLease(task.id, 'agent-B');
    expect(takeover.ok).toBe(true);
    expect(service.leaseOf(task.id)?.owner).toBe('agent-B');
  });

  it('释放租约后他人可获取；非持有者释放无效', () => {
    const { service } = svc();
    const task = service.create({ title: 'A' });
    service.acquireLease(task.id, 'agent-A');
    expect(service.releaseLease(task.id, 'agent-B')).toBe(false);
    expect(service.releaseLease(task.id, 'agent-A')).toBe(true);
    expect(service.leaseOf(task.id)).toBeNull();
    expect(service.acquireLease(task.id, 'agent-B').ok).toBe(true);
  });

  it('对不存在任务获取租约报 not-found', () => {
    const { service } = svc();
    expect(service.acquireLease('missing', 'agent-A')).toMatchObject({ ok: false, error: 'not-found' });
  });
});
