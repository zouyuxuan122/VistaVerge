import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDb } from '../../src/data/db';
import {
  correctMemory,
  exportMemory,
  forgetMemory,
  proposeWrite,
  rebuildMemoryIndex,
  searchMemory,
  type ProposeWriteResult,
} from '../../src/data/memory';

function mustCreate(r: ProposeWriteResult): string {
  if ('duplicate' in r) throw new Error(`expected created, got duplicate:${r.id}`);
  return r.id;
}

describe('data/memory：写入、检索、纠错、遗忘', () => {
  beforeEach(async () => {
    await initDb();
  });
  afterEach(() => {
    closeDb();
  });

  it('proposeWrite 创建并导出；同 scope 同文判重，不同 scope 不判重', () => {
    const text = '我把签字材料放在书房抽屉里';
    const r1 = proposeWrite({ kind: 'fact', text, tags: ['资料'], scope: 'personal' });
    const id1 = mustCreate(r1);

    const all = exportMemory();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: id1,
      kind: 'fact',
      text,
      scope: 'personal',
      status: 'active',
      tags: ['资料'],
      version: 1,
    });

    const dup = proposeWrite({ kind: 'fact', text, scope: 'personal' });
    expect(dup).toEqual({ duplicate: true, id: id1 });
    expect(exportMemory()).toHaveLength(1);

    const other = proposeWrite({ kind: 'fact', text, scope: 'work' });
    expect(mustCreate(other)).not.toBe(id1);
    expect(exportMemory()).toHaveLength(2);
  });

  it('中文长查询走 FTS5 trigram 命中，不相关查询不误报', () => {
    mustCreate(proposeWrite({ kind: 'fact', text: '我把签字材料放在书房抽屉里' }));
    const hits = searchMemory({ query: '书房抽屉' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe('我把签字材料放在书房抽屉里');
    expect(hits[0]?.score).toBeGreaterThan(0);
    expect(searchMemory({ query: '阳台上晒的被子' })).toHaveLength(0);
  });

  it('短查询（<3 字）回退 LIKE：伞/钥匙/带伞 均命中', () => {
    mustCreate(proposeWrite({ kind: 'todo', text: '出门记得带伞' }));
    mustCreate(proposeWrite({ kind: 'fact', text: '钥匙放在门口的碗里' }));
    expect(searchMemory({ query: '伞' }).map((h) => h.text)).toEqual(['出门记得带伞']);
    expect(searchMemory({ query: '钥匙' }).map((h) => h.text)).toEqual(['钥匙放在门口的碗里']);
    expect(searchMemory({ query: '带伞' }).map((h) => h.text)).toEqual(['出门记得带伞']);
    expect(searchMemory({ query: '雪' })).toHaveLength(0);
  });

  it('tag any：任一标签命中，未打标签的排除', () => {
    const a = mustCreate(
      proposeWrite({ kind: 'event', text: '项目周会纪要已同步', tags: ['工作', '项目'] }),
    );
    const b = mustCreate(proposeWrite({ kind: 'event', text: '读完一节 Rust 教程', tags: ['学习'] }));
    const c = mustCreate(proposeWrite({ kind: 'event', text: '买菜清单更新', tags: ['生活'] }));

    const hits = searchMemory({ tags: ['工作', '学习'], tagMode: 'any' });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(ids).not.toContain(c);
    // 默认 tagMode = any
    expect(searchMemory({ tags: ['学习'] }).map((h) => h.id)).toEqual([b]);
  });

  it('tag all：必须同时具备全部标签', () => {
    const a = mustCreate(
      proposeWrite({ kind: 'event', text: '项目周会纪要已同步', tags: ['工作', '项目'] }),
    );
    mustCreate(proposeWrite({ kind: 'event', text: '读完一节 Rust 教程', tags: ['学习'] }));

    expect(searchMemory({ tags: ['工作', '项目'], tagMode: 'all' }).map((h) => h.id)).toEqual([a]);
    expect(searchMemory({ tags: ['工作', '学习'], tagMode: 'all' })).toHaveLength(0);
  });

  it('scope 过滤先行：跨 scope 不泄漏；数组 scope 取并集；缺省不过滤', () => {
    mustCreate(proposeWrite({ kind: 'fact', text: '工作计划讨论纪要', scope: 'work' }));
    mustCreate(proposeWrite({ kind: 'fact', text: '个人护照办理进度', scope: 'personal' }));

    expect(searchMemory({ query: '办理', scope: 'work' })).toHaveLength(0);
    expect(searchMemory({ query: '办理', scope: 'personal' })).toHaveLength(1);
    expect(searchMemory({ query: '办理', scope: ['work', 'personal'] })).toHaveLength(1);
    // 无 query 时同样按 scope 过滤
    expect(searchMemory({ scope: 'work' })).toHaveLength(1);
    expect(searchMemory({ scope: 'personal' })).toHaveLength(1);
    expect(searchMemory({ scope: ['work', 'personal'] })).toHaveLength(2);
    // 未提供 scope：不过滤（由调用方决定允许范围）
    expect(searchMemory({})).toHaveLength(2);
  });

  it('stale（过期）不过滤仅降权：仍在结果中、stale 标记、分数减半、排在新鲜记录之后', () => {
    mustCreate(proposeWrite({ kind: 'todo', text: '咖啡机需要除垢', ttlSeconds: -10 }));
    const fresh = mustCreate(proposeWrite({ kind: 'preference', text: '咖啡，每天两杯' }));

    const hits = searchMemory({ query: '咖啡' });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.id).toBe(fresh);
    expect(hits[0]?.stale).toBe(false);
    expect(hits[1]?.stale).toBe(true);
    expect(hits[1]?.score).toBeCloseTo(hits[0]?.score * 0.5, 10);
    expect(hits[1]?.expiresAt).not.toBeNull();
  });

  it('correctMemory：旧记 superseded 保留历史，新记 supersedes 且检索优先', () => {
    const oldId = mustCreate(
      proposeWrite({ kind: 'preference', text: '喜欢喝咖啡', tags: ['饮食'] }),
    );
    correctMemory(oldId, '已经戒了咖啡');

    const recs = exportMemory();
    expect(recs).toHaveLength(2);
    const oldRec = recs.find((r) => r.id === oldId);
    expect(oldRec).toMatchObject({ status: 'superseded', text: '喜欢喝咖啡', tags: ['饮食'] });
    const newRec = recs.find((r) => r.supersedes === oldId);
    expect(newRec).toMatchObject({
      status: 'active',
      text: '已经戒了咖啡',
      tags: ['饮食'],
      version: 2,
    });

    // '咖啡' 2 字 → LIKE 路径；新旧都在（历史保留），新记在前、旧记降权
    const hits = searchMemory({ query: '咖啡' });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.id).toBe(newRec?.id);
    expect(hits[0]?.stale).toBe(false);
    expect(hits[1]?.id).toBe(oldId);
    expect(hits[1]?.stale).toBe(true);

    // 同文纠错：无变化不产生新版本
    correctMemory(oldId, '喜欢喝咖啡');
    expect(exportMemory()).toHaveLength(2);
    // 不存在的 id 报错
    expect(() => correctMemory('not-exist', 'x')).toThrow(/not found/);
  });

  it('forgetMemory：主表+FTS+tombstone 同事务删除；MATCH 与 LIKE 均无结果；幂等', () => {
    const id = mustCreate(proposeWrite({ kind: 'fact', text: '旧项目交接文档位置' }));
    forgetMemory(id);

    expect(searchMemory({ query: '交接文档' })).toHaveLength(0); // FTS 路径
    expect(searchMemory({ query: '文档' })).toHaveLength(0); // LIKE 路径
    expect(exportMemory()).toHaveLength(0);

    const tomb = getDb().get('SELECT * FROM tombstones WHERE id = ?', [id]);
    expect(tomb).toBeDefined();
    expect(Number(tomb?.deleted_at)).toBeGreaterThan(0);
    expect(Number(tomb?.version)).toBe(1);

    // 幂等：重复 forget 不抛错
    expect(() => forgetMemory(id)).not.toThrow();
    // 未知 id：抛错
    expect(() => forgetMemory('never-existed')).toThrow(/not found/);
  });

  it('forget 后 FTS rebuild 不复活；tombstone 守护触发器阻止同 id 复活插入', () => {
    const id = mustCreate(proposeWrite({ kind: 'fact', text: '隐私事项备忘录条目' }));
    forgetMemory(id);

    rebuildMemoryIndex();
    expect(searchMemory({ query: '备忘录条目' })).toHaveLength(0);
    expect(searchMemory({ query: '条目' })).toHaveLength(0);

    // 直接 INSERT 同 id（模拟旧备份恢复路径）→ 守护触发器 ABORT
    expect(() =>
      getDb().run(
        "INSERT INTO memories (id, kind, text, scope, status, created_at, observed_at, version) VALUES (?, 'fact', '隐私事项备忘录条目', 'personal', 'active', 1, 1, 1)",
        [id],
      ),
    ).toThrow(/tombstoned/);

    // 存活数据在 rebuild 后仍可检索（FTS 重建只含当前允许记录）
    mustCreate(proposeWrite({ kind: 'fact', text: '仍然存在的记忆条目' }));
    rebuildMemoryIndex();
    expect(searchMemory({ query: '记忆条目' }).map((h) => h.text)).toEqual([
      '仍然存在的记忆条目',
    ]);
  });
});
