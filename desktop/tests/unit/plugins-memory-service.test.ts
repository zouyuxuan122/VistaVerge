// EXP-006 MemoryView 默认服务（真实数据层）验证。
// 运行环境为 node（默认）：sqlite wasm 在 jsdom 下无法定位，故与 jsdom 的
// 组件挂载测试分开。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/data/db';
import { proposeWrite } from '../../src/data/memory';
import { createMemoryViewService } from '../../src/plugins/views/memoryView';

describe('MemoryView 默认服务（经 data/memory 公开接口）', () => {
  beforeEach(async () => {
    await initDb();
  });
  afterEach(() => {
    closeDb();
  });

  it('list/search/correct/forget/exportJson 全部落到数据层', () => {
    proposeWrite({ kind: 'fact', text: '导出用的记忆条目', tags: ['资料'] });
    const service = createMemoryViewService();

    expect(service.list()).toHaveLength(1);
    expect(service.exportJson()).toContain('导出用的记忆条目');
    expect(service.exportJson()).toContain('资料');
    expect(service.search('导出').length).toBeGreaterThan(0);

    // correctMemory 的语义是「新增版本 + 旧版标 superseded」，不是就地改写。
    const id = service.list()[0]!.id;
    service.correct(id, '更正后的记忆');
    const successor = service.list().find((record) => record.text === '更正后的记忆');
    expect(successor).toBeDefined();
    expect(successor!.supersedes).toBe(id);
    expect(service.list().find((record) => record.id === id)?.status).toBe('superseded');
    expect(service.search('更正').length).toBeGreaterThan(0);

    service.forget(successor!.id);
    expect(service.list().map((record) => record.text)).not.toContain('更正后的记忆');
  });

  it('空库时 list 为空、exportJson 为合法 JSON 数组', () => {
    const service = createMemoryViewService();
    expect(service.list()).toEqual([]);
    expect(JSON.parse(service.exportJson())).toEqual([]);
  });
});
