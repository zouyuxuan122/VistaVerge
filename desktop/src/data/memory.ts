/**
 * data/memory.ts — 记忆写入/检索/纠错/遗忘（MEMORY_PERCEPTION.md §2–§5）。
 *
 * 接口（任务书，不得擅改）：
 * - proposeWrite({kind,text,tags?,scope?,ttlSeconds?,source?}): {id, created}|{duplicate:true,id}
 * - searchMemory({query?,tags?,tagMode?:"any"|"all",topK?}): MemoryHit[]
 * - correctMemory(id, newText): void
 * - forgetMemory(id): void
 * - exportMemory(): MemoryRecord[]
 * 另提供 rebuildMemoryIndex()（任务书步骤 4 的 FTS rebuild 验证入口）。
 *
 * 检索语义（任务书步骤 3）：
 * - scope 过滤先行；未传 scope 时不做 scope 过滤（允许范围由调用方决定）。
 * - FTS5 trigram MATCH；<3 码点短查询回退 LIKE '%q%'（trigram 对短词的限制）。
 * - tag any/all；stale（过期或已 superseded）不过滤仅降权（分数×0.5）。
 */

import { getDb, type Db, type DbRow, type SqlParams } from './db';
import { newId, normalizeTags, nowMs } from './util';

export type MemoryKind = 'fact' | 'preference' | 'event' | 'todo';
export type MemoryStatus = 'active' | 'superseded';

/** 来源锚点；字符串是 {kind} 的简写。 */
export type MemorySourceInput = string | { kind: string; id?: string; note?: string; reliability?: number };

export interface ProposeWriteInput {
  kind: MemoryKind | string;
  text: string;
  tags?: string[];
  scope?: string;
  /** 秒；<=0 表示已过期（测试/回填用）。 */
  ttlSeconds?: number;
  source?: MemorySourceInput;
}

export type ProposeWriteResult = { id: string; created: true } | { duplicate: true; id: string };

export interface MemoryHit {
  id: string;
  text: string;
  tags: string[];
  kind: string;
  scope: string;
  createdAt: number;
  /** 越大越相关；stale 结果已乘 0.5。FTS 路径为 -bm25，LIKE 路径恒为 1。 */
  score: number;
  stale: boolean;
  status: MemoryStatus;
  supersedes: string | null;
  expiresAt: number | null;
}

export interface SearchMemoryInput {
  query?: string;
  tags?: string[];
  tagMode?: 'any' | 'all';
  scope?: string | string[];
  topK?: number;
}

export interface MemoryRecord {
  id: string;
  kind: string;
  text: string;
  scope: string;
  status: MemoryStatus;
  supersedes: string | null;
  version: number;
  createdAt: number;
  observedAt: number;
  expiresAt: number | null;
  sensitivity: string;
  tags: string[];
  sourceKind: string | null;
  sourceId: string | null;
  reliability: number;
}

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;
/** 超额召回倍数（MEMORY_PERCEPTION §3：有上限的超额召回避免 topK 后过滤漏光）。 */
const CANDIDATE_MULTIPLIER = 3;
const MAX_CANDIDATES = 60;
const STALE_SCORE_FACTOR = 0.5;

/* ------------------------------------------------------------------ */
/* proposeWrite                                                        */
/* ------------------------------------------------------------------ */

function normalizeSource(source?: MemorySourceInput): { kind: string; id?: string; note?: string; reliability?: number } | null {
  if (source == null) return null;
  if (typeof source === 'string') {
    const kind = source.trim();
    if (!kind) return null;
    return { kind };
  }
  const kind = source.kind.trim();
  if (!kind) return null;
  return source;
}

export function proposeWrite(input: ProposeWriteInput): ProposeWriteResult {
  const text = input.text.trim();
  if (!text) throw new Error('proposeWrite: text 不能为空');
  const kind = String(input.kind).trim();
  if (!kind) throw new Error('proposeWrite: kind 不能为空');
  const scope = input.scope?.trim() || 'personal';
  const tags = normalizeTags(input.tags);
  const source = normalizeSource(input.source);
  const db = getDb();

  // 唯一写入服务的去重（MEMORY_PERCEPTION §4）：同 scope 同文且 active → duplicate
  const duplicate = db.get(
    "SELECT id FROM memories WHERE scope = ? AND status = 'active' AND text = ?",
    [scope, text],
  );
  if (duplicate) {
    return { duplicate: true, id: String(duplicate.id) };
  }

  const id = newId();
  const now = nowMs();
  const expiresAt =
    input.ttlSeconds == null ? null : now + Math.round(input.ttlSeconds * 1000);

  db.transaction(() => {
    db.run(
      `INSERT INTO memories
        (id, kind, text, scope, status, supersedes, version, created_at, observed_at, expires_at, sensitivity, source_kind, source_id, reliability)
       VALUES (?, ?, ?, ?, 'active', NULL, 1, ?, ?, ?, 'normal', ?, ?, ?)`,
      [
        id,
        kind,
        text,
        scope,
        now,
        now,
        expiresAt,
        source?.kind ?? null,
        source?.id ?? null,
        source?.reliability ?? 1.0,
      ],
    );
    for (const tag of tags) {
      db.run('INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)', [id, tag]);
    }
    if (source) {
      db.run(
        'INSERT INTO sources (id, memory_id, kind, reliability, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [newId(), id, source.kind, source.reliability ?? 1.0, source.note ?? null, now],
      );
    }
  });
  db.schedulePersist();
  return { id, created: true };
}

/* ------------------------------------------------------------------ */
/* searchMemory                                                        */
/* ------------------------------------------------------------------ */

function clampTopK(topK?: number): number {
  if (topK == null || !Number.isFinite(topK)) return DEFAULT_TOP_K;
  return Math.min(MAX_TOP_K, Math.max(1, Math.round(topK)));
}

function asScopeList(scope?: string | string[]): string[] | null {
  if (scope == null) return null;
  const list = (Array.isArray(scope) ? scope : [scope])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : null;
}

/** trigram 需要 ≥3 码点；更短的查询返回 null（调用方走 LIKE 回退）。 */
function toFtsPhrase(query: string): string | null {
  if ([...query].length < 3) return null;
  return `"${query.replace(/"/g, '""')}"`;
}

/** LIKE 通配符转义（配 ESCAPE '\'）。 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function loadTagsByMemoryId(db: Db, ids: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  for (const row of db.all(
    `SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders})`,
    ids,
  )) {
    const memoryId = String(row.memory_id);
    const tags = map.get(memoryId);
    if (tags) tags.push(String(row.tag));
    else map.set(memoryId, [String(row.tag)]);
  }
  return map;
}

function rowToHit(row: DbRow, tags: string[], baseScore: number, now: number): MemoryHit {
  const expired = row.expires_at != null && Number(row.expires_at) <= now;
  const stale = expired || String(row.status) === 'superseded';
  return {
    id: String(row.id),
    text: String(row.text),
    tags,
    kind: String(row.kind),
    scope: String(row.scope),
    createdAt: Number(row.created_at),
    score: baseScore * (stale ? STALE_SCORE_FACTOR : 1),
    stale,
    status: String(row.status) as MemoryStatus,
    supersedes: row.supersedes == null ? null : String(row.supersedes),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
  };
}

export function searchMemory(input: SearchMemoryInput = {}): MemoryHit[] {
  const db = getDb();
  const topK = clampTopK(input.topK);
  const scopes = asScopeList(input.scope);
  const tags = normalizeTags(input.tags);
  const tagMode: 'any' | 'all' = input.tagMode === 'all' ? 'all' : 'any';
  const query = (input.query ?? '').trim();

  const filters: string[] = [];
  const filterParams: SqlParams = [];
  if (scopes) {
    filters.push(`m.scope IN (${scopes.map(() => '?').join(',')})`);
    filterParams.push(...scopes);
  }
  if (tags.length > 0) {
    if (tagMode === 'all') {
      for (const tag of tags) {
        filters.push(
          'EXISTS (SELECT 1 FROM memory_tags at WHERE at.memory_id = m.id AND at.tag = ?)',
        );
        filterParams.push(tag);
      }
    } else {
      filters.push(
        `EXISTS (SELECT 1 FROM memory_tags at WHERE at.memory_id = m.id AND at.tag IN (${tags
          .map(() => '?')
          .join(',')}))`,
      );
      filterParams.push(...tags);
    }
  }
  const filterSql = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
  const limit = Math.min(MAX_CANDIDATES, topK * CANDIDATE_MULTIPLIER);

  let sql: string;
  let params: SqlParams;
  let useFts: boolean;

  const ftsPhrase = query ? toFtsPhrase(query) : null;
  if (ftsPhrase) {
    // FTS5 trigram 路径：短语引号包裹防 FTS5 语法注入；bm25 越负越相关。
    useFts = true;
    sql =
      'SELECT m.*, bm25(memories_fts) AS bm25_rank ' +
      'FROM memories m JOIN memories_fts ON memories_fts.rowid = m.rowid ' +
      'WHERE memories_fts MATCH ? ' +
      `${filterSql} ` +
      'ORDER BY bm25(memories_fts) LIMIT ?';
    params = [ftsPhrase, ...filterParams, limit];
  } else {
    // 无查询或短查询（<3 码点）：LIKE 回退（trigram 对短词的限制，§2）。
    useFts = false;
    const likeSql = query ? "AND m.text LIKE ? ESCAPE '\\'" : '';
    const likeParams: SqlParams = query ? [`%${escapeLike(query)}%`] : [];
    sql =
      'SELECT m.* FROM memories m WHERE 1=1 ' +
      `${likeSql} ` +
      `${filterSql} ` +
      'ORDER BY m.created_at DESC, m.id LIMIT ?';
    params = [...likeParams, ...filterParams, limit];
  }

  const rows = db.all(sql, params);
  const tagMap = loadTagsByMemoryId(
    db,
    rows.map((r) => String(r.id)),
  );
  const now = nowMs();
  const hits = rows.map((row) =>
    rowToHit(row, tagMap.get(String(row.id)) ?? [], useFts ? -Number(row.bm25_rank) : 1, now),
  );
  hits.sort(
    (a, b) => b.score - a.score || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1),
  );
  return hits.slice(0, topK);
}

/* ------------------------------------------------------------------ */
/* correctMemory / forgetMemory / exportMemory / rebuild               */
/* ------------------------------------------------------------------ */

/**
 * 纠错（MEMORY_PERCEPTION §4）：旧记转 superseded（正文原样保留，历史可查），
 * 新记 supersedes 链到旧记并继承 kind/scope/tags；同文纠错视为无变化。
 */
export function correctMemory(id: string, newText: string): void {
  const text = newText.trim();
  if (!text) throw new Error('correctMemory: newText 不能为空');
  const db = getDb();
  const old = db.get('SELECT * FROM memories WHERE id = ?', [id]);
  if (!old) throw new Error(`correctMemory: memory not found: ${id}`);
  if (String(old.text) === text) return;

  const successorId = newId();
  const now = nowMs();
  db.transaction(() => {
    // 正文未变 → FTS 无需操作；仅状态迁移。
    db.run("UPDATE memories SET status = 'superseded' WHERE id = ?", [id]);
    db.run(
      `INSERT INTO memories
        (id, kind, text, scope, status, supersedes, version, created_at, observed_at, expires_at, sensitivity, source_kind, source_id, reliability)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?, 'correction', ?, 1.0)`,
      [
        successorId,
        String(old.kind),
        text,
        String(old.scope),
        id,
        Number(old.version) + 1,
        now,
        now,
        String(old.sensitivity),
        id,
      ],
    );
    for (const row of db.all('SELECT tag FROM memory_tags WHERE memory_id = ?', [id])) {
      db.run('INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)', [successorId, String(row.tag)]);
    }
    db.run(
      'INSERT INTO sources (id, memory_id, kind, reliability, note, created_at) VALUES (?, ?, ?, 1.0, ?, ?)',
      [newId(), successorId, 'correction', `corrects ${id}`, now],
    );
  });
  db.schedulePersist();
}

/**
 * 遗忘（任务书步骤 4，MEMORY_PERCEPTION §5）：同一事务内
 * 1) FTS5 'delete' 命令以旧值精确删除索引项；2) 删标签/来源/主表行；
 * 3) 写 tombstone（仅 opaque id + version + 时间，不留内容）。
 * 幂等：已遗忘的 id 直接返回；未知 id 抛错。
 */
export function forgetMemory(id: string): void {
  const db = getDb();
  const row = db.get('SELECT rowid, text, version FROM memories WHERE id = ?', [id]);
  if (!row) {
    if (db.get('SELECT id FROM tombstones WHERE id = ?', [id])) return;
    throw new Error(`forgetMemory: memory not found: ${id}`);
  }
  const rowid = Number(row.rowid);
  const oldText = String(row.text);
  const version = Number(row.version);

  db.transaction(() => {
    db.run("INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', ?, ?)", [
      rowid,
      oldText,
    ]);
    db.run('DELETE FROM memory_tags WHERE memory_id = ?', [id]);
    db.run('DELETE FROM sources WHERE memory_id = ?', [id]);
    db.run('DELETE FROM memories WHERE id = ?', [id]);
    db.run('INSERT INTO tombstones (id, version, deleted_at) VALUES (?, ?, ?)', [
      id,
      version,
      nowMs(),
    ]);
  });
  db.schedulePersist();
}

/** 全量导出（备份/审计路径）；包含 superseded 历史与标签，不含已遗忘内容。 */
export function exportMemory(): MemoryRecord[] {
  const db = getDb();
  const rows = db.all('SELECT * FROM memories ORDER BY created_at ASC, id');
  const tagMap = loadTagsByMemoryId(
    db,
    rows.map((r) => String(r.id)),
  );
  return rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    text: String(row.text),
    scope: String(row.scope),
    status: String(row.status) as MemoryStatus,
    supersedes: row.supersedes == null ? null : String(row.supersedes),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    observedAt: Number(row.observed_at),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    sensitivity: String(row.sensitivity),
    tags: tagMap.get(String(row.id)) ?? [],
    sourceKind: row.source_kind == null ? null : String(row.source_kind),
    sourceId: row.source_id == null ? null : String(row.source_id),
    reliability: Number(row.reliability),
  }));
}

/**
 * FTS 全量重建（'rebuild'）。遗忘语义的前提：forgetMemory 硬删主表行，
 * 因此 rebuild 只包含当前允许记录，不会复活已遗忘内容（§5）。
 */
export function rebuildMemoryIndex(): void {
  const db = getDb();
  db.run("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
  db.schedulePersist();
}
