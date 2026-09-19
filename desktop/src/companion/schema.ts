/**
 * companion/schema.ts — 陪伴域本地表结构与版本化迁移。
 *
 * 为什么不写进 data/db.ts 的 MIGRATIONS：本模块文件域被限定在
 * `desktop/src/companion/**`，不允许改既有文件；因此陪伴域表结构用**独立的
 * 版本键**（index_meta.companion_schema_version）与独立的迁移列表管理，
 * 与数据层 schema_version 互不影响、可各自推进。
 *
 * 前台接线：应用启动时在 `initDb()` 之后调用一次 `ensureCompanionSchema()` 即可；
 * 各业务函数内部也会惰性调用（幂等，代价是一次 SELECT）。
 */

import { getDb, type Db } from '../data/db';

/** 陪伴域表结构版本（每次新增表/列时 +1 并追加迁移）。 */
export const COMPANION_SCHEMA_VERSION = 1;

/** 与数据层共用的元数据表，但用独立 key，避免与 schema_version 冲突。 */
export const COMPANION_SCHEMA_VERSION_KEY = 'companion_schema_version';

type Migration = { version: number; up: (db: Db) => void };

function createCompanionSchemaV1(db: Db): void {
  // ---- 说话风格档案（口癖学习）：payload 存 JSON，manual 条目由用户手动增删 ----
  db.run(`CREATE TABLE IF NOT EXISTS companion_style_profiles (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    window_size INTEGER NOT NULL DEFAULT 200,
    sample_count INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL
  )`);

  // ---- 本地知识库：文档 + 段落锚点 chunk（解析文本一律 untrusted）----
  db.run(`CREATE TABLE IF NOT EXISTS knowledge_docs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'txt',
    license TEXT,
    char_count INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    imported_at INTEGER NOT NULL,
    untrusted INTEGER NOT NULL DEFAULT 1,
    injection_hits INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    page INTEGER,
    anchor TEXT NOT NULL,
    text TEXT NOT NULL,
    untrusted INTEGER NOT NULL DEFAULT 1,
    injection_detected INTEGER NOT NULL DEFAULT 0
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks (doc_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_knowledge_docs_imported ON knowledge_docs (imported_at)');
}

const MIGRATIONS: Migration[] = [{ version: 1, up: createCompanionSchemaV1 }];

/**
 * 幂等迁移：读 index_meta.companion_schema_version 按版本号推进，每步一个事务。
 * 未调用 `initDb()` 时 `getDb()` 会抛错（与数据层一致，不做静默兜底）。
 */
export function ensureCompanionSchema(): void {
  const db = getDb();
  db.run('CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.get('SELECT value FROM index_meta WHERE key = ?', [COMPANION_SCHEMA_VERSION_KEY]);
  const current = row?.value == null ? 0 : Number(row.value);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      migration.up(db);
      db.run(
        'INSERT INTO index_meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [COMPANION_SCHEMA_VERSION_KEY, String(migration.version)],
      );
    });
  }
}

/** 当前库里的陪伴域 schema 版本（未初始化时为 0；供测试与诊断使用）。 */
export function companionSchemaVersion(): number {
  const db = getDb();
  db.run('CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.get('SELECT value FROM index_meta WHERE key = ?', [COMPANION_SCHEMA_VERSION_KEY]);
  return row?.value == null ? 0 : Number(row.value);
}

/** 陪伴域建的全部表名（供测试/诊断断言）。 */
export const COMPANION_TABLES = [
  'companion_style_profiles',
  'knowledge_docs',
  'knowledge_chunks',
] as const;
