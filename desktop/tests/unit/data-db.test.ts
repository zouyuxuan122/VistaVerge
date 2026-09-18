import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDb, type DbPersistence } from '../../src/data/db';
import { proposeWrite, searchMemory } from '../../src/data/memory';

function mustCreate(r: { id: string } & ({ created: true } | { duplicate: true })): string {
  if ('duplicate' in r) throw new Error(`expected created, got duplicate:${r.id}`);
  return r.id;
}

describe('data/db：initDb 与 schema_version 迁移', () => {
  beforeEach(async () => {
    await initDb();
  });
  afterEach(() => {
    closeDb();
  });

  it('初始化创建全部表、FTS5 trigram external-content 与守护触发器', () => {
    const db = getDb();
    const tables = db
      .all("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => String(r.name));
    expect(tables).toEqual(
      expect.arrayContaining([
        'memories',
        'memory_tags',
        'sources',
        'tombstones',
        'index_meta',
        'conversations',
        'branches',
        'messages',
        'tasks',
        'memories_fts',
      ]),
    );
    // task 表仅建结构（EXP-006 用）
    expect(db.get('SELECT COUNT(*) AS c FROM tasks')?.c).toBe(0);
    // FTS5 trigram external-content
    const fts = db.get("SELECT sql FROM sqlite_master WHERE name='memories_fts'");
    expect(String(fts?.sql)).toContain("content='memories'");
    expect(String(fts?.sql)).toContain("content_rowid='rowid'");
    expect(String(fts?.sql)).toContain("tokenize='trigram'");
    // 同步触发器（INSERT/UPDATE）+ 墓碑守护触发器；刻意无 AFTER DELETE（forget 显式 FTS delete）
    const triggers = db
      .all("SELECT name FROM sqlite_master WHERE type='trigger'")
      .map((r) => String(r.name));
    expect(triggers).toEqual(
      expect.arrayContaining(['memories_fts_ai', 'memories_fts_au', 'memories_tombstone_guard']),
    );
    expect(triggers.filter((n) => n === 'memories_fts_ad')).toHaveLength(0);
  });

  it('schema_version 迁移幂等：同库重开版本不变、表不重复、数据保留', async () => {
    const id = mustCreate(proposeWrite({ kind: 'fact', text: '迁移前已存在的记忆条目' }));
    const bytes = getDb().exportBytes();
    const store = new Map<string, Uint8Array>([['db', bytes]]);
    await initDb({
      read: async () => store.get('db') ?? null,
      write: async (b) => {
        store.set('db', b);
      },
    });
    try {
      expect(getDb().get("SELECT value FROM index_meta WHERE key='schema_version'")?.value).toBe(
        '2',
      );
      // 表/触发器不因重复迁移而翻倍
      expect(
        getDb().all("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"),
      ).toHaveLength(1);
      expect(
        getDb().all(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memories_%'",
        ),
      ).toHaveLength(3);
      // 数据跨重开保留（FTS 索引同样持久化可用）
      const hits = searchMemory({ query: '记忆条目' });
      expect(hits.map((h) => h.id)).toContain(id);
    } finally {
      closeDb();
    }
  });

  it('persist 注入：变更后写钩子收到字节；从读钩子重开可恢复数据', async () => {
    const chunks: Uint8Array[] = [];
    const persist: DbPersistence = {
      read: async () => (chunks.length ? chunks[chunks.length - 1] : null),
      write: async (b) => {
        chunks.push(b);
      },
    };
    await initDb(persist);
    proposeWrite({ kind: 'fact', text: '持久化验证记忆条目' });
    await getDb().persistNow();
    expect(chunks.length).toBeGreaterThan(0);
    const saved = chunks[chunks.length - 1];
    expect(saved.byteLength).toBeGreaterThan(0);

    await initDb(persist);
    try {
      const hits = searchMemory({ query: '持久化验证' });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.text).toBe('持久化验证记忆条目');
    } finally {
      closeDb();
    }
  });
});
