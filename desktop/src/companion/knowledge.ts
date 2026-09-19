/**
 * companion/knowledge.ts — 本地知识库（文档导入 / 中文 bigram 检索 / 引用上下文 / 全链路删除）。
 *
 * 依据：GAP_AUDIT G-COMP-04（知识库注入陪伴对话 MISSING）；TEACHER_COMPANION §1.1(1)(2)
 * （页/锚点引用、解析文本是不可信数据、注入防护）；规划.txt「知识库」。
 *
 * 设计要点：
 * - 表：`knowledge_docs` / `knowledge_chunks`（页号 + 段落锚点 + untrusted 标记），
 *   表结构由 `schema.ts` 独立版本化。
 * - 分块：分页（`\f`）→ 段落 → 按字符上限打包，长段落切片共享同一段落锚点；
 *   策略与 teacher/study.ts 同思路（行/段落锚点无空洞）但**独立实现**，不共享代码。
 * - 检索：中文 bigram；查询与文本走**同一个** `normalizeForSearch` 管道，
 *   归一化带原文下标映射，snippet 可定位。
 * - 注入防护：命中指令式文本只标记 + 发事件，绝不执行（本模块无工具权限）。
 * - 删除：chunks + doc 全链路；本模块不用 FTS（bigram 在 JS 内打分），故无 FTS 残留。
 */

import { getDb, type DbRow } from '../data/db';
import {
  countOccurrences,
  detectInstructionText,
  makeEvent,
  mapToSource,
  newId,
  normalizeForSearch,
  nowMs,
  sanitizeControlChars,
  searchGrams,
  truncateText,
  type CompanionEvent,
} from './internal';
import { ensureCompanionSchema } from './schema';

export interface KnowledgeLimits {
  /** 单 chunk 最大码点数。 */
  chunkMaxChars: number;
  /** 单文档最大 chunk 数（超出即拒绝导入，不静默丢弃）。 */
  maxChunksPerDoc: number;
  /** 单文档最大码点数。 */
  maxDocChars: number;
  /** 检索返回的 snippet 长度。 */
  snippetChars: number;
  /** 检索默认/最大条数。 */
  defaultSearchLimit: number;
  maxSearchLimit: number;
  /** 检索时最多扫描的 chunk 数（防超大库拖慢热路径）。 */
  maxScanChunks: number;
  /** buildKnowledgeContext 默认字符预算。 */
  defaultContextChars: number;
}

export const KNOWLEDGE_LIMITS: KnowledgeLimits = {
  chunkMaxChars: 600,
  maxChunksPerDoc: 2000,
  maxDocChars: 400000,
  snippetChars: 120,
  defaultSearchLimit: 5,
  maxSearchLimit: 20,
  maxScanChunks: 4000,
  defaultContextChars: 1200,
};

export type KnowledgeSourceKind = 'txt' | 'md';

export interface KnowledgeDoc {
  id: string;
  name: string;
  sourceKind: KnowledgeSourceKind;
  license: string | null;
  charCount: number;
  chunkCount: number;
  importedAt: number;
  untrusted: true;
  injectionHits: number;
}

export interface KnowledgeChunk {
  id: string;
  docId: string;
  index: number;
  /** 1-based 页号（按 \f 分页）；无分页符时为 1。 */
  page: number;
  /** 段落锚点：`{docId}#P{startBlock}[-P{endBlock}]`，可解析、可定位。 */
  anchor: string;
  text: string;
  /** 解析文本一律按不可信数据处理。 */
  untrusted: true;
  injectionDetected: boolean;
}

export interface KnowledgeHit {
  docId: string;
  docName: string;
  anchor: string;
  page: number;
  snippet: string;
  score: number;
  /** 命中片段含疑似指令式文本（只标记，不执行）。 */
  injectionDetected: boolean;
  untrusted: true;
}

export interface KnowledgeImportInput {
  name: string;
  /** 文件字节由调用方给：可直接传 Uint8Array 或已解码文本。 */
  text: string;
  license?: string | null;
  sourceKind?: KnowledgeSourceKind;
  /** 覆盖上限（部分字段）。 */
  limits?: Partial<KnowledgeLimits>;
}

export interface KnowledgeImportResult {
  doc: KnowledgeDoc;
  chunks: KnowledgeChunk[];
  events: CompanionEvent[];
}

export interface KnowledgeDeleteResult {
  docId: string;
  deleted: boolean;
  chunksDeleted: number;
  events: CompanionEvent[];
}

export interface KnowledgeExport {
  docs: KnowledgeDoc[];
  chunks: KnowledgeChunk[];
}

/* ------------------------------------------------------------------ */
/* 分块                                                                */
/* ------------------------------------------------------------------ */

function sourceKindFromName(name: string): KnowledgeSourceKind {
  return /\.md$/i.test(name) ? 'md' : 'txt';
}

interface Block {
  page: number;
  /** 1-based 段落序号（全文连续，锚点用）。 */
  index: number;
  text: string;
}

/** 分页（\f）→ 段落（空行分隔）；空段落丢弃但**段落序号仍连续**，锚点无空洞。 */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const pages = text.split('\f');
  let paragraphIndex = 0;
  pages.forEach((pageText, pageIdx) => {
    for (const raw of pageText.split(/\n[ \t]*\n/)) {
      const paragraph = raw.replace(/[ \t]+$/gm, '').trim();
      if (paragraph.length === 0) continue;
      paragraphIndex += 1;
      blocks.push({ page: pageIdx + 1, index: paragraphIndex, text: paragraph });
    }
  });
  return blocks;
}

function makeChunk(
  docId: string,
  index: number,
  block: { page: number; startBlock: number; endBlock: number },
  text: string,
): KnowledgeChunk {
  const anchorRange =
    block.startBlock === block.endBlock
      ? `P${block.startBlock}`
      : `P${block.startBlock}-P${block.endBlock}`;
  return {
    id: newId(),
    docId,
    index,
    page: block.page,
    anchor: `${docId}#${anchorRange}`,
    text,
    untrusted: true,
    injectionDetected: detectInstructionText(text).length > 0,
  };
}

/** 按段落打包 chunk：单段落超上限时切片，切片共享段落锚点（锚点仍可定位）。 */
function buildChunks(docId: string, blocks: Block[], limits: KnowledgeLimits): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let buffer: Block[] = [];
  let bufferLength = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    chunks.push(
      makeChunk(
        docId,
        chunks.length,
        { page: first.page, startBlock: first.index, endBlock: last.index },
        buffer.map((entry) => entry.text).join('\n\n'),
      ),
    );
    buffer = [];
    bufferLength = 0;
  };

  for (const block of blocks) {
    if (block.text.length > limits.chunkMaxChars) {
      flush();
      for (let offset = 0; offset < block.text.length; offset += limits.chunkMaxChars) {
        chunks.push(
          makeChunk(
            docId,
            chunks.length,
            { page: block.page, startBlock: block.index, endBlock: block.index },
            block.text.slice(offset, offset + limits.chunkMaxChars),
          ),
        );
      }
      continue;
    }
    const projected = bufferLength === 0 ? block.text.length : bufferLength + 2 + block.text.length;
    // 跨页不合并：chunk 的 page 字段必须与锚点一致，页引用才可定位。
    if (buffer.length > 0 && (projected > limits.chunkMaxChars || buffer[0].page !== block.page)) flush();
    if (buffer.length === 0) bufferLength = block.text.length;
    else bufferLength += 2 + block.text.length;
    buffer.push(block);
  }
  flush();
  return chunks;
}

/* ------------------------------------------------------------------ */
/* 导入 / 删除 / 导出 / 列举                                            */
/* ------------------------------------------------------------------ */

/**
 * 导入纯文本/markdown。文本是数据不是指令：命中注入正则只标记 + 事件。
 * 空资料、超长资料、chunk 数超限都会被拒绝并给出中文可读错误（不静默截断）。
 */
export function importKnowledgeDoc(input: KnowledgeImportInput): KnowledgeImportResult {
  ensureCompanionSchema();
  const limits: KnowledgeLimits = { ...KNOWLEDGE_LIMITS, ...(input.limits ?? {}) };
  const text = sanitizeControlChars(input.text ?? '', { keepFormFeed: true });
  if (text.trim().length === 0) throw new Error('importKnowledgeDoc: 资料内容为空，无法导入');
  if ([...text].length > limits.maxDocChars) {
    throw new Error(
      `importKnowledgeDoc: 资料过长（${[...text].length} 码点，上限 ${limits.maxDocChars}），请拆分后导入`,
    );
  }
  const name = input.name?.trim() || '未命名资料';
  const blocks = splitBlocks(text);
  if (blocks.length === 0) throw new Error('importKnowledgeDoc: 资料没有可索引的段落');
  const docId = newId();
  const chunks = buildChunks(docId, blocks, limits);
  if (chunks.length > limits.maxChunksPerDoc) {
    throw new Error(
      `importKnowledgeDoc: 段落数过多（${chunks.length} 个 chunk，上限 ${limits.maxChunksPerDoc}），请拆分后导入`,
    );
  }

  const injectionHits = chunks.filter((chunk) => chunk.injectionDetected).length;
  const doc: KnowledgeDoc = {
    id: docId,
    name,
    sourceKind: input.sourceKind ?? sourceKindFromName(name),
    license: input.license ?? null,
    charCount: [...text].length,
    chunkCount: chunks.length,
    importedAt: nowMs(),
    untrusted: true,
    injectionHits,
  };

  const db = getDb();
  db.transaction(() => {
    db.run(
      `INSERT INTO knowledge_docs
        (id, name, source_kind, license, char_count, chunk_count, imported_at, untrusted, injection_hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        doc.id,
        doc.name,
        doc.sourceKind,
        doc.license,
        doc.charCount,
        doc.chunkCount,
        doc.importedAt,
        doc.injectionHits,
      ],
    );
    for (const chunk of chunks) {
      db.run(
        `INSERT INTO knowledge_chunks (id, doc_id, idx, page, anchor, text, untrusted, injection_detected)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          chunk.id,
          chunk.docId,
          chunk.index,
          chunk.page,
          chunk.anchor,
          chunk.text,
          chunk.injectionDetected ? 1 : 0,
        ],
      );
    }
  });
  db.schedulePersist();

  const events: CompanionEvent[] = [
    makeEvent('knowledge.imported', {
      docId: doc.id,
      name: doc.name,
      chunks: chunks.length,
      pages: blocks[blocks.length - 1].page,
    }),
  ];
  for (const chunk of chunks) {
    if (chunk.injectionDetected) {
      events.push(
        makeEvent('knowledge.injection.detected', { docId: doc.id, anchor: chunk.anchor }),
      );
    }
  }
  return { doc, chunks, events };
}

function rowToDoc(row: DbRow): KnowledgeDoc {
  return {
    id: String(row.id),
    name: String(row.name),
    sourceKind: String(row.source_kind) === 'md' ? 'md' : 'txt',
    license: row.license == null ? null : String(row.license),
    charCount: Number(row.char_count),
    chunkCount: Number(row.chunk_count),
    importedAt: Number(row.imported_at),
    untrusted: true,
    injectionHits: Number(row.injection_hits),
  };
}

function rowToChunk(row: DbRow): KnowledgeChunk {
  return {
    id: String(row.id),
    docId: String(row.doc_id),
    index: Number(row.idx),
    page: row.page == null ? 1 : Number(row.page),
    anchor: String(row.anchor),
    text: String(row.text),
    untrusted: true,
    injectionDetected: Number(row.injection_detected) === 1,
  };
}

/** 列出全部文档（新→旧）。 */
export function listKnowledgeDocs(): KnowledgeDoc[] {
  ensureCompanionSchema();
  const db = getDb();
  return db
    .all('SELECT * FROM knowledge_docs ORDER BY imported_at DESC, id')
    .map((row) => rowToDoc(row));
}

/** 读取单个文档的 chunk（按 idx 升序）。 */
export function listKnowledgeChunks(docId: string): KnowledgeChunk[] {
  ensureCompanionSchema();
  const db = getDb();
  return db
    .all('SELECT * FROM knowledge_chunks WHERE doc_id = ? ORDER BY idx ASC', [docId])
    .map((row) => rowToChunk(row));
}

/**
 * 删除文档全链路：chunks → doc。幂等（未知 id 返回 deleted:false，不抛错）。
 * 本模块无 FTS 表，故无索引残留；删除后检索不可能再命中。
 */
export function deleteKnowledgeDoc(docId: string): KnowledgeDeleteResult {
  ensureCompanionSchema();
  const db = getDb();
  const existing = db.get('SELECT id FROM knowledge_docs WHERE id = ?', [docId]);
  if (!existing) return { docId, deleted: false, chunksDeleted: 0, events: [] };
  let chunksDeleted = 0;
  db.transaction(() => {
    chunksDeleted = Number(
      db.get('SELECT COUNT(*) AS c FROM knowledge_chunks WHERE doc_id = ?', [docId])?.c ?? 0,
    );
    db.run('DELETE FROM knowledge_chunks WHERE doc_id = ?', [docId]);
    db.run('DELETE FROM knowledge_docs WHERE id = ?', [docId]);
  });
  db.schedulePersist();
  return {
    docId,
    deleted: true,
    chunksDeleted,
    events: [makeEvent('knowledge.deleted', { docId, chunksDeleted })],
  };
}

/** 导出全库（备份/审计路径）。 */
export function exportKnowledge(): KnowledgeExport {
  ensureCompanionSchema();
  const db = getDb();
  const docs = db.all('SELECT * FROM knowledge_docs ORDER BY imported_at ASC, id').map((row) => rowToDoc(row));
  const chunks = db
    .all('SELECT * FROM knowledge_chunks ORDER BY doc_id ASC, idx ASC')
    .map((row) => rowToChunk(row));
  return { docs, chunks };
}

/* ------------------------------------------------------------------ */
/* 检索                                                                */
/* ------------------------------------------------------------------ */

function makeSnippet(
  source: string,
  normalizedMap: number[],
  matchIndex: number,
  snippetChars: number,
): string {
  const sourceLength = source.length;
  const start = mapToSource(normalizedMap, Math.max(0, matchIndex - 20), sourceLength);
  const end = Math.min(sourceLength, start + snippetChars);
  const raw = source.slice(start, end).replace(/\s+/g, ' ').trim();
  return raw;
}

/**
 * 中文 bigram 检索。查询与文本共用 `normalizeForSearch` 管道；
 * 打分 = 命中的 bigram 出现次数之和 + 整句短语命中加成；同分按文档/段落顺序稳定。
 */
export function searchKnowledge(query: string, limit = KNOWLEDGE_LIMITS.defaultSearchLimit): KnowledgeHit[] {
  ensureCompanionSchema();
  const topK = Math.min(
    KNOWLEDGE_LIMITS.maxSearchLimit,
    Math.max(1, Math.round(Number.isFinite(limit) ? limit : KNOWLEDGE_LIMITS.defaultSearchLimit)),
  );
  const normalizedQuery = normalizeForSearch(query ?? '').normalized;
  const grams = searchGrams(normalizedQuery);
  if (grams.length === 0) return [];

  const db = getDb();
  const rows = db.all(
    `SELECT c.*, d.name AS doc_name FROM knowledge_chunks c
       JOIN knowledge_docs d ON d.id = c.doc_id
      ORDER BY c.doc_id ASC, c.idx ASC
      LIMIT ?`,
    [KNOWLEDGE_LIMITS.maxScanChunks],
  );

  const scored: { hit: KnowledgeHit; order: number }[] = [];
  rows.forEach((row, order) => {
    const text = String(row.text);
    const { normalized, map } = normalizeForSearch(text);
    if (normalized.length === 0) return;
    let score = 0;
    let firstMatch = -1;
    for (const gram of grams) {
      const occurrences = countOccurrences(normalized, gram);
      if (occurrences === 0) continue;
      score += occurrences;
      const index = normalized.indexOf(gram);
      if (firstMatch < 0 || index < firstMatch) firstMatch = index;
    }
    if (score <= 0) return;
    if (normalizedQuery.length > 1) {
      const phraseHits = countOccurrences(normalized, normalizedQuery);
      if (phraseHits > 0) {
        score += phraseHits * 3;
        const index = normalized.indexOf(normalizedQuery);
        if (firstMatch < 0 || index < firstMatch) firstMatch = index;
      }
    }
    scored.push({
      order,
      hit: {
        docId: String(row.doc_id),
        docName: String(row.doc_name),
        anchor: String(row.anchor),
        page: row.page == null ? 1 : Number(row.page),
        snippet: makeSnippet(text, map, Math.max(0, firstMatch), KNOWLEDGE_LIMITS.snippetChars),
        score,
        injectionDetected: Number(row.injection_detected) === 1,
        untrusted: true,
      },
    });
  });

  scored.sort((a, b) => b.hit.score - a.hit.score || a.order - b.order);
  return scored.slice(0, topK).map((entry) => entry.hit);
}

/**
 * 紧凑引用格式：`[库:文档名#锚点] 片段`，按 maxChars 预算截断。
 * 输出属于低优先级上下文通道；片段是数据不是指令。
 */
export function buildKnowledgeContext(
  results: readonly KnowledgeHit[],
  maxChars = KNOWLEDGE_LIMITS.defaultContextChars,
): string {
  if (results.length === 0) return '';
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  if (budget === 0) return '';
  const lines: string[] = [];
  let used = 0;
  for (const hit of results) {
    const prefix = `[库:${hit.docName}#${hit.anchor}] `;
    const remaining = budget - used;
    if (remaining <= prefix.length) break;
    const { text: body, truncated } = truncateText(hit.snippet, remaining - prefix.length);
    if (body.trim().length === 0) continue;
    lines.push(`${prefix}${body}${truncated ? '…' : ''}`);
    used += prefix.length + [...body].length + (truncated ? 1 : 0);
  }
  return lines.join('\n');
}

/** 便捷组合：检索 + 组装上下文（前台一次调用即可注入）。 */
export function knowledgeContextFor(
  query: string,
  options: { limit?: number; maxChars?: number } = {},
): { context: string; hits: KnowledgeHit[] } {
  const hits = searchKnowledge(query, options.limit);
  return { context: buildKnowledgeContext(hits, options.maxChars), hits };
}

/** 从字节导入（调用方给文件字节；UTF-8 解码，拒绝空文件）。 */
export function importKnowledgeDocFromBytes(
  input: Omit<KnowledgeImportInput, 'text'> & { bytes: Uint8Array },
): KnowledgeImportResult {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new Error('importKnowledgeDocFromBytes: 文件字节为空');
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes);
  return importKnowledgeDoc({ ...input, text });
}
