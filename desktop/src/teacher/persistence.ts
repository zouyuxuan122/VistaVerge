/**
 * teacher/persistence.ts — 教师域状态持久化（B-T-02：默认落 SQLite，不再重启即丢）。
 *
 * 表由本模块自持（CREATE TABLE IF NOT EXISTS，经 data/db 的公开 Db 接口），
 * 不改 data 层内部实现。覆盖：资料、分块、题目、批改、作答记录、诊断画像。
 * 错题/复习计划沿用 review.ts 的 `study_review_items` 表。
 *
 * 版本：`teacher_meta.schema_version` 由本模块维护并断言（单测同步），
 * 与 data 层 `index_meta.schema_version` 相互独立（教师域表可单独演进）。
 *
 * Node（vitest）与浏览器共用同一实现；未初始化 Db 时调用方应回退内存实现
 * （见 `createMemoryTeacherStateStore`），并在 UI 明示「本次会话内有效」。
 */

import { getDb, type Db, type DbRow, type SqlValue } from '../data/db';
import type { Chunk, Grading, Material, QuizQuestion } from './study';

export const TEACHER_SCHEMA_VERSION = 1;
export const TEACHER_SCHEMA_KEY = 'schema_version';

export interface AttemptRecord {
  id: string;
  materialId: string;
  questionId: string;
  point: string;
  verdict: Grading['verdict'];
  cause: Grading['cause'];
  answer: string;
  expected: string;
  at: number;
}

export interface TeacherStateStore {
  /** true = 落 SQLite；false = 内存回退（UI 必须明示）。 */
  readonly persistent: boolean;
  saveMaterial(material: Material, chunks: Chunk[]): void;
  loadMaterial(): { material: Material; chunks: Chunk[] } | null;
  saveQuestions(materialId: string, questions: QuizQuestion[]): void;
  loadQuestions(materialId: string): QuizQuestion[];
  saveGrading(materialId: string, grading: Grading): void;
  loadGradings(materialId: string): Record<string, Grading>;
  appendAttempt(record: AttemptRecord): void;
  loadAttempts(materialId?: string): AttemptRecord[];
  saveDiagnosis(materialId: string, payload: unknown, at: number): void;
  loadDiagnosis(materialId: string): { payload: unknown; updatedAt: number } | null;
  schemaVersion(): number | null;
}

/* ------------------------------------------------------------------ */
/* DB 实现                                                              */
/* ------------------------------------------------------------------ */

const DDL = [
  `CREATE TABLE IF NOT EXISTS teacher_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS teacher_materials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    license TEXT,
    text TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    line_count INTEGER NOT NULL,
    imported_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS teacher_chunks (
    id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    anchor TEXT NOT NULL,
    page INTEGER,
    text TEXT NOT NULL,
    injection_detected INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS teacher_questions (
    id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL,
    type TEXT NOT NULL,
    prompt TEXT NOT NULL,
    options_json TEXT,
    answer TEXT NOT NULL,
    point TEXT NOT NULL,
    difficulty INTEGER NOT NULL,
    anchor TEXT NOT NULL,
    explanation TEXT NOT NULL,
    generated_by TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS teacher_gradings (
    question_id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL,
    verdict TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    validator_id TEXT NOT NULL,
    answer TEXT NOT NULL,
    expected TEXT NOT NULL,
    cause TEXT NOT NULL DEFAULT 'none',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS teacher_attempts (
    id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    point TEXT NOT NULL,
    verdict TEXT NOT NULL,
    cause TEXT NOT NULL,
    answer TEXT NOT NULL,
    expected TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS teacher_diagnoses (
    material_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

function toBool(value: SqlValue | undefined): boolean {
  return Number(value ?? 0) !== 0;
}

function optionalNumber(value: SqlValue | undefined): number | undefined {
  return value == null ? undefined : Number(value);
}

export function createDbTeacherStateStore(db?: Db): TeacherStateStore {
  const database = (): Db => db ?? getDb();
  for (const statement of DDL) database().run(statement);
  database().run(
    'INSERT INTO teacher_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [TEACHER_SCHEMA_KEY, String(TEACHER_SCHEMA_VERSION)],
  );

  function mapMaterial(row: DbRow): Material {
    return {
      id: String(row.id),
      name: String(row.name),
      sourceKind: String(row.source_kind) as Material['sourceKind'],
      license: row.license == null ? null : String(row.license),
      text: String(row.text),
      charCount: Number(row.char_count),
      lineCount: Number(row.line_count),
      importedAt: Number(row.imported_at),
    };
  }

  function mapChunk(row: DbRow): Chunk {
    const chunk: Chunk = {
      id: String(row.id),
      materialId: String(row.material_id),
      index: Number(row.idx),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      anchor: String(row.anchor),
      text: String(row.text),
      untrusted: true,
      trust: 'untrusted',
      injectionDetected: toBool(row.injection_detected),
    };
    const page = optionalNumber(row.page);
    if (page !== undefined) chunk.page = page;
    return chunk;
  }

  function mapQuestion(row: DbRow): QuizQuestion {
    const question: QuizQuestion = {
      id: String(row.id),
      materialId: String(row.material_id),
      type: String(row.type) as QuizQuestion['type'],
      prompt: String(row.prompt),
      answer: String(row.answer),
      point: String(row.point),
      difficulty: Number(row.difficulty) as QuizQuestion['difficulty'],
      anchor: String(row.anchor),
      explanation: String(row.explanation),
      generatedBy: String(row.generated_by) as QuizQuestion['generatedBy'],
    };
    if (row.options_json != null) {
      try {
        const parsed: unknown = JSON.parse(String(row.options_json));
        if (Array.isArray(parsed)) question.options = parsed.map((item) => String(item));
      } catch {
        /* 选项损坏时按无选项处理，不臆造 */
      }
    }
    return question;
  }

  function mapGrading(row: DbRow): Grading {
    let evidence: Grading['evidence'] = [];
    try {
      const parsed: unknown = JSON.parse(String(row.evidence_json));
      if (Array.isArray(parsed)) evidence = parsed as Grading['evidence'];
    } catch {
      evidence = [];
    }
    return {
      verdict: String(row.verdict) as Grading['verdict'],
      evidence,
      confidence: Number(row.confidence),
      validatorId: String(row.validator_id),
      questionId: String(row.question_id),
      answer: String(row.answer),
      expected: String(row.expected),
      cause: String(row.cause) as Grading['cause'],
    };
  }

  function mapAttempt(row: DbRow): AttemptRecord {
    return {
      id: String(row.id),
      materialId: String(row.material_id),
      questionId: String(row.question_id),
      point: String(row.point),
      verdict: String(row.verdict) as Grading['verdict'],
      cause: String(row.cause) as Grading['cause'],
      answer: String(row.answer),
      expected: String(row.expected),
      at: Number(row.at),
    };
  }

  return {
    persistent: true,

    saveMaterial(material, chunks) {
      database().run('DELETE FROM teacher_materials WHERE id = ?', [material.id]);
      database().run('DELETE FROM teacher_chunks WHERE material_id = ?', [material.id]);
      database().run(
        `INSERT INTO teacher_materials (id, name, source_kind, license, text, char_count, line_count, imported_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          material.id,
          material.name,
          material.sourceKind,
          material.license,
          material.text,
          material.charCount,
          material.lineCount,
          material.importedAt,
        ],
      );
      for (const chunk of chunks) {
        database().run(
          `INSERT INTO teacher_chunks (id, material_id, idx, start_line, end_line, anchor, page, text, injection_detected)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            chunk.id,
            chunk.materialId,
            chunk.index,
            chunk.startLine,
            chunk.endLine,
            chunk.anchor,
            chunk.page ?? null,
            chunk.text,
            chunk.injectionDetected ? 1 : 0,
          ],
        );
      }
    },

    loadMaterial() {
      const row = database().get('SELECT * FROM teacher_materials ORDER BY imported_at DESC, rowid DESC LIMIT 1');
      if (!row) return null;
      const material = mapMaterial(row);
      const chunks = database()
        .all('SELECT * FROM teacher_chunks WHERE material_id = ? ORDER BY idx ASC', [material.id])
        .map(mapChunk);
      return { material, chunks };
    },

    saveQuestions(materialId, questions) {
      database().run('DELETE FROM teacher_questions WHERE material_id = ?', [materialId]);
      for (const question of questions) {
        database().run(
          `INSERT INTO teacher_questions (id, material_id, type, prompt, options_json, answer, point, difficulty, anchor, explanation, generated_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            question.id,
            question.materialId,
            question.type,
            question.prompt,
            question.options ? JSON.stringify(question.options) : null,
            question.answer,
            question.point,
            question.difficulty,
            question.anchor,
            question.explanation,
            question.generatedBy,
          ],
        );
      }
    },

    loadQuestions(materialId) {
      return database()
        .all('SELECT * FROM teacher_questions WHERE material_id = ? ORDER BY rowid ASC', [materialId])
        .map(mapQuestion);
    },

    saveGrading(materialId, grading) {
      database().run(
        `INSERT INTO teacher_gradings (question_id, material_id, verdict, evidence_json, confidence, validator_id, answer, expected, cause, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(question_id) DO UPDATE SET
           material_id = excluded.material_id,
           verdict = excluded.verdict,
           evidence_json = excluded.evidence_json,
           confidence = excluded.confidence,
           validator_id = excluded.validator_id,
           answer = excluded.answer,
           expected = excluded.expected,
           cause = excluded.cause,
           created_at = excluded.created_at`,
        [
          grading.questionId,
          materialId,
          grading.verdict,
          JSON.stringify(grading.evidence),
          grading.confidence,
          grading.validatorId,
          grading.answer,
          grading.expected,
          grading.cause,
          Date.now(),
        ],
      );
    },

    loadGradings(materialId) {
      const out: Record<string, Grading> = {};
      for (const row of database().all('SELECT * FROM teacher_gradings WHERE material_id = ?', [materialId])) {
        const grading = mapGrading(row);
        out[grading.questionId] = grading;
      }
      return out;
    },

    appendAttempt(record) {
      database().run(
        `INSERT INTO teacher_attempts (id, material_id, question_id, point, verdict, cause, answer, expected, at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          record.id,
          record.materialId,
          record.questionId,
          record.point,
          record.verdict,
          record.cause,
          record.answer,
          record.expected,
          record.at,
        ],
      );
    },

    loadAttempts(materialId) {
      const rows = materialId
        ? database().all('SELECT * FROM teacher_attempts WHERE material_id = ? ORDER BY at ASC, rowid ASC', [materialId])
        : database().all('SELECT * FROM teacher_attempts ORDER BY at ASC, rowid ASC');
      return rows.map(mapAttempt);
    },

    saveDiagnosis(materialId, payload, at) {
      database().run(
        `INSERT INTO teacher_diagnoses (material_id, payload_json, updated_at) VALUES (?,?,?)
         ON CONFLICT(material_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
        [materialId, JSON.stringify(payload ?? null), at],
      );
    },

    loadDiagnosis(materialId) {
      const row = database().get('SELECT payload_json, updated_at FROM teacher_diagnoses WHERE material_id = ?', [
        materialId,
      ]);
      if (!row) return null;
      let payload: unknown = null;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        payload = null;
      }
      return { payload, updatedAt: Number(row.updated_at) };
    },

    schemaVersion() {
      const row = database().get('SELECT value FROM teacher_meta WHERE key = ?', [TEACHER_SCHEMA_KEY]);
      return row?.value == null ? null : Number(row.value);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 内存实现（未初始化 Db 时的诚实回退）                                 */
/* ------------------------------------------------------------------ */

export function createMemoryTeacherStateStore(): TeacherStateStore {
  let material: { material: Material; chunks: Chunk[] } | null = null;
  const questions = new Map<string, QuizQuestion[]>();
  const gradings = new Map<string, Record<string, Grading>>();
  const attempts: AttemptRecord[] = [];
  const diagnoses = new Map<string, { payload: unknown; updatedAt: number }>();

  return {
    persistent: false,
    saveMaterial(nextMaterial, chunks) {
      material = { material: { ...nextMaterial }, chunks: chunks.map((chunk) => ({ ...chunk })) };
    },
    loadMaterial() {
      return material ? { material: { ...material.material }, chunks: material.chunks.map((chunk) => ({ ...chunk })) } : null;
    },
    saveQuestions(materialId, next) {
      questions.set(materialId, next.map((question) => ({ ...question })));
    },
    loadQuestions(materialId) {
      return (questions.get(materialId) ?? []).map((question) => ({ ...question }));
    },
    saveGrading(materialId, grading) {
      gradings.set(materialId, { ...(gradings.get(materialId) ?? {}), [grading.questionId]: { ...grading } });
    },
    loadGradings(materialId) {
      return { ...(gradings.get(materialId) ?? {}) };
    },
    appendAttempt(record) {
      attempts.push({ ...record });
    },
    loadAttempts(materialId) {
      return attempts.filter((record) => !materialId || record.materialId === materialId).map((record) => ({ ...record }));
    },
    saveDiagnosis(materialId, payload, at) {
      diagnoses.set(materialId, { payload, updatedAt: at });
    },
    loadDiagnosis(materialId) {
      return diagnoses.get(materialId) ?? null;
    },
    schemaVersion() {
      return TEACHER_SCHEMA_VERSION;
    },
  };
}
