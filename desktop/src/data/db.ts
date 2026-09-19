/**
 * data/db.ts — 本地 SQLite 真相层初始化（MEMORY_PERCEPTION.md §2）。
 *
 * 引擎裁决（2026-09-18，用户批准）：任务书步骤 2/4 要求 FTS5 trigram
 * external-content，但 sql.js 1.14.2 全部 wasm 构建均未启用 FTS5
 * （ENABLE_FTS5=0，实测 `no such module: fts5`）。经批准将官方
 * @sqlite.org/sqlite-wasm 3.53.4-build1（SQLite 本体公有领域）vendor 到
 * ./vendor/ 并经其 OO1 API 访问。数据层只用这份 vendor 实现；
 * sql.js 已随 2026-09-19 的依赖清理从 package.json 移除（不再被任何代码引用）。
 * 详见 ./vendor/PROVENANCE.md。
 *
 * 双环境装载：
 * - Node（vitest）：动态 import ./vendor/sqlite3-node.mjs（变量 specifier +
 *   @vite-ignore，防止进入浏览器产物）；wasm 按相邻文件定位。
 * - 浏览器 / Tauri webview：import('./vendor/sqlite3-bundler-friendly.mjs')，
 *   其中 `new URL('sqlite3.wasm', import.meta.url)` 由 Vite 改写为构建资产。
 *   webview 需 CSP `wasm-unsafe-eval`（EXP-001 已就位）。
 *
 * 接口（任务书）：initDb(persist?: {read, write}): Promise<Db>
 */

export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlParams = SqlValue[];
export type DbRow = Record<string, SqlValue | undefined>;

/** initDb 的持久化钩子：Tauri/IndexedDB/内存实现见 platform/persistence.ts。 */
export interface DbPersistence {
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
}

export interface Db {
  /** 执行单条写语句（INSERT/UPDATE/DELETE/DDL）。 */
  run(sql: string, params?: SqlParams): void;
  /** 参数化查询，返回行对象数组（列名 -> 值）。 */
  all(sql: string, params?: SqlParams): DbRow[];
  /** 参数化查询，返回首行或 undefined。 */
  get(sql: string, params?: SqlParams): DbRow | undefined;
  /** 事务：fn 正常返回则 COMMIT，抛错则 ROLLBACK 并重抛。fn 必须保持同步。 */
  transaction<T>(fn: () => T): T;
  /** 立即导出字节并写入持久化钩子（未配置时为 no-op）。 */
  persistNow(): Promise<void>;
  /** 变更后调用：调度一次微任务合并写；失败仅记录不抛出。 */
  schedulePersist(): void;
  /** 导出整库字节快照（sqlite3_js_db_export）。 */
  exportBytes(): Uint8Array;
  close(): void;
}

/* ------------------------------------------------------------------ */
/* vendored sqlite3 wasm 的最小类型收窄（完整来源见 vendor/PROVENANCE.md） */
/* ------------------------------------------------------------------ */

interface Oo1DbHandle {
  readonly pointer: number;
  exec(sql: string): void;
  exec(options: { sql: string; bind?: SqlParams }): void;
  selectObjects(sql: string, bind?: SqlParams): DbRow[];
  selectObject(sql: string, bind?: SqlParams): DbRow | undefined;
  transaction<T>(fn: () => T): T;
  close(): void;
}

interface Sqlite3Module {
  oo1: { DB: new (name?: string) => Oo1DbHandle };
  capi: {
    sqlite3_js_db_export(db: Oo1DbHandle): Uint8Array;
    sqlite3_deserialize(
      pDb: number,
      zSchema: string,
      pData: number,
      szDb: number,
      szBuf: number,
      mFlags: number,
    ): number;
  };
  wasm: {
    allocFromTypedArray(data: Uint8Array | ArrayBuffer): number;
    dealloc(pointer: number): void;
  };
}

type Sqlite3Init = (options?: Record<string, unknown>) => Promise<Sqlite3Module>;

const SQLITE_DESERIALIZE_RESIZEABLE = 0x1;
const SQLITE_DESERIALIZE_FREEONCLOSE = 0x2;

/* ------------------------------------------------------------------ */
/* 模块装载                                                             */
/* ------------------------------------------------------------------ */

/** 纯 Node 判定，不依赖 @types/node 全局（自包含结构探测）。 */
function isNodeRuntime(): boolean {
  const g = globalThis as { process?: { versions?: { node?: string } } };
  return typeof g.process?.versions?.node === 'string';
}

let sqlite3Promise: Promise<Sqlite3Module> | null = null;

function loadSqlite3(): Promise<Sqlite3Module> {
  sqlite3Promise ??= (async (): Promise<Sqlite3Module> => {
    if (isNodeRuntime()) {
      // join('') 阻止打包器把 Node 专用 glue 常量折叠后当作浏览器资产分析。
      const nodeGlue = ['./vendor/sqlite3-', 'node.mjs'].join('');
      const href = new URL(nodeGlue, import.meta.url).href;
      const mod = (await import(/* @vite-ignore */ href)) as {
        default?: unknown;
      };
      const init = (mod.default ?? mod) as Sqlite3Init;
      return await init();
    }
    const mod = await import('./vendor/sqlite3-bundler-friendly.mjs');
    const init = (mod.default ?? mod) as Sqlite3Init;
    return await init();
  })();
  return sqlite3Promise;
}

/* ------------------------------------------------------------------ */
/* Db 实现                                                              */
/* ------------------------------------------------------------------ */

class VistavergeDb implements Db {
  #persistScheduled = false;

  constructor(
    private readonly handle: Oo1DbHandle,
    private readonly sqlite3: Sqlite3Module,
    private readonly persist?: DbPersistence,
  ) {}

  run(sql: string, params: SqlParams = []): void {
    // OO1 层对"无可绑定参数的语句"传入空 bind 数组会抛错，故空参时不带 bind。
    if (params.length === 0) {
      this.handle.exec({ sql });
    } else {
      this.handle.exec({ sql, bind: params });
    }
  }

  all(sql: string, params: SqlParams = []): DbRow[] {
    return params.length === 0
      ? this.handle.selectObjects(sql)
      : this.handle.selectObjects(sql, params);
  }

  get(sql: string, params: SqlParams = []): DbRow | undefined {
    return params.length === 0
      ? this.handle.selectObject(sql)
      : this.handle.selectObject(sql, params);
  }

  transaction<T>(fn: () => T): T {
    return this.handle.transaction(fn);
  }

  exportBytes(): Uint8Array {
    return this.sqlite3.capi.sqlite3_js_db_export(this.handle);
  }

  async persistNow(): Promise<void> {
    if (!this.persist) return;
    const bytes = this.exportBytes();
    await this.persist.write(bytes);
  }

  schedulePersist(): void {
    if (!this.persist || this.#persistScheduled) return;
    this.#persistScheduled = true;
    queueMicrotask(() => {
      this.#persistScheduled = false;
      this.persistNow().catch((err: unknown) => {
        // 持久化失败不能让同步数据操作半途抛错，但必须留下可见痕迹。
        console.error('[vistaverge] db persist write failed:', err);
      });
    });
  }

  close(): void {
    this.handle.close();
  }
}

/* ------------------------------------------------------------------ */
/* schema 迁移                                                          */
/* ------------------------------------------------------------------ */

const SCHEMA_VERSION_KEY = 'schema_version';

type Migration = { version: number; up: (db: Db) => void };

function createSchemaV1(db: Db): void {
  // ---- 记忆（MEMORY_PERCEPTION §2：Memory/Source/Tag/Tombstone/IndexMeta）----
  db.run(`CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'personal',
    status TEXT NOT NULL DEFAULT 'active',
    supersedes TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    expires_at INTEGER,
    sensitivity TEXT NOT NULL DEFAULT 'normal',
    source_kind TEXT,
    source_id TEXT,
    reliability REAL NOT NULL DEFAULT 1.0
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_memories_scope_status ON memories (scope, status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories (supersedes)');

  db.run(`CREATE TABLE IF NOT EXISTS memory_tags (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags (tag)');

  db.run(`CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    reliability REAL NOT NULL DEFAULT 1.0,
    note TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_sources_memory ON sources (memory_id)');

  // 墓碑：只留 opaque id + 版本 + 删除时间，不留正文/标签（§2）。
  db.run(`CREATE TABLE IF NOT EXISTS tombstones (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL
  )`);

  // ---- 会话 ----
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    active_branch_id TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    parent_branch_id TEXT,
    fork_message_id TEXT,
    title TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_branches_conversation ON branches (conversation_id)');

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    parent_id TEXT,
    origin_id TEXT,
    edited INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_messages_branch ON messages (branch_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages (parent_id)');

  // ---- 任务：仅建结构，EXP-006 使用 ----
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    due_at INTEGER,
    memory_id TEXT,
    conversation_id TEXT,
    branch_id TEXT,
    payload TEXT
  )`);

  // ---- FTS5 trigram external-content（§2 中文方案，实施前已实测复核）----
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    text,
    content='memories',
    content_rowid='rowid',
    tokenize='trigram'
  )`);

  // FTS 同步触发器：INSERT / UPDATE OF text。
  // 刻意不建 AFTER DELETE 触发器：forgetMemory() 在同事务内用 FTS5 'delete'
  // 命令以旧值精确删除（任务书步骤 4）；AFTER DELETE 触发器会造成二次 delete，
  // 破坏 external-content 索引一致性。
  db.run(`CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF text ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
  END`);

  // 墓碑守护触发器：被遗忘的 id 不允许复活（备份恢复等旁路），
  // 对应 MEMORY_PERCEPTION §5「恢复必须应用最新可用 tombstone，验证删除不复活」。
  db.run(`CREATE TRIGGER IF NOT EXISTS memories_tombstone_guard BEFORE INSERT ON memories BEGIN
    SELECT RAISE(ABORT, 'memory id is tombstoned: forgotten content must not be resurrected')
    WHERE EXISTS (SELECT 1 FROM tombstones WHERE id = new.id);
  END`);
}

const MIGRATIONS: Migration[] = [
  { version: 1, up: createSchemaV1 },
  { version: 2, up: createSchemaV2 },
];

/**
 * v2：用量台账（花费统计 / token 曲线 / 热力图的唯一数据源）。
 * 只记计量数字，不存对话正文；成本在写入时按当时单价折算，改单价不追溯历史。
 */
function createSchemaV2(db: Db): void {
  db.run(`CREATE TABLE IF NOT EXISTS usage_ledger (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    units REAL NOT NULL DEFAULT 0,
    cost_micros INTEGER NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0,
    conversation_id TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_ledger (ts)');
  db.run('CREATE INDEX IF NOT EXISTS idx_usage_kind ON usage_ledger (kind)');
}

/** 幂等迁移：读 index_meta.schema_version，按版本号推进；每步一个事务。 */
function migrate(db: Db): void {
  db.run('CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.get('SELECT value FROM index_meta WHERE key = ?', [SCHEMA_VERSION_KEY]);
  const current = row?.value == null ? 0 : Number(row.value);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      migration.up(db);
      db.run(
        'INSERT INTO index_meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [SCHEMA_VERSION_KEY, String(migration.version)],
      );
    });
  }
}

/* ------------------------------------------------------------------ */
/* initDb / getDb / closeDb                                             */
/* ------------------------------------------------------------------ */

let currentDb: VistavergeDb | null = null;

/**
 * 初始化（或重开）数据层。任务书接口：
 * `initDb(persist?: {read(): Promise<Uint8Array|null>, write(b: Uint8Array): Promise<void>}): Promise<Db>`
 *
 * - 提供 persist 时：先 read() 取字节，经 sqlite3_deserialize 载入；此后变更由
 *   数据层 schedulePersist() 合并写回。
 * - 不提供时：纯内存库（vitest / 无盘场景）。
 * - 重复调用：关闭并替换上一个句柄（测试/重开语义）。
 */
export async function initDb(persist?: DbPersistence): Promise<Db> {
  const sqlite3 = await loadSqlite3();
  if (currentDb) {
    try {
      currentDb.close();
    } catch {
      // 上一个句柄可能已被关闭；忽略。
    }
    currentDb = null;
  }

  const handle = new sqlite3.oo1.DB(); // ':memory:'
  if (persist) {
    // read() 可能抛（Tauri 命令失败/IO 错误）：句柄此时已经建出来了，
    // 直接往上抛会让这个 wasm 实例永久泄漏，必须先关掉再抛。
    let bytes: Uint8Array | null = null;
    try {
      bytes = await persist.read();
    } catch (error) {
      handle.close();
      throw error;
    }
    if (bytes && bytes.byteLength > 0) {
      const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
      const rc = sqlite3.capi.sqlite3_deserialize(
        handle.pointer,
        'main',
        pointer,
        bytes.byteLength,
        bytes.byteLength,
        SQLITE_DESERIALIZE_RESIZEABLE | SQLITE_DESERIALIZE_FREEONCLOSE,
      );
      if (rc !== 0) {
        sqlite3.wasm.dealloc(pointer);
        handle.close();
        throw new Error(`initDb: sqlite3_deserialize failed (sqlite rc ${rc})`);
      }
    }
  }

  const db = new VistavergeDb(handle, sqlite3, persist);
  try {
    db.run('PRAGMA foreign_keys = ON');
    migrate(db);
  } catch (err) {
    handle.close();
    throw err;
  }
  currentDb = db;
  return db;
}

/** 取当前已初始化的 Db；未初始化时抛错。 */
export function getDb(): Db {
  if (!currentDb) {
    throw new Error('data/db: initDb() 必须先于其他数据层调用');
  }
  return currentDb;
}

/** 关闭并丢弃当前句柄（测试与关机路径；未初始化时为 no-op）。 */
export function closeDb(): void {
  if (currentDb) {
    currentDb.close();
    currentDb = null;
  }
}
