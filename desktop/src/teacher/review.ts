/**
 * teacher/review.ts — 错题表 + 轻量 SM-2 复习调度（TEACHER_COMPANION §3.2(8)）。
 *
 * 调度为**可校准策略**：间隔因子 EF 默认 2.5、下限 1.3；答对间隔 1 → 6 → 上次×EF
 * 天；答错（q<3）间隔归零、立即重学并累加 lapses。所有参数与 nextDue 可导出，
 * 用户可手动改期（`answer` 可由 UI 直接调用）。
 *
 * 存储：默认内存实现；`createDbStudyStore` 用模块自持表 `study_review_items`
 * （经 data/db 的公开 Db 接口创建，不修改 data 层内部实现）。
 */

import { getDb, type Db, type DbRow } from '../data/db';
import { newId } from '../data/util';
import type { Grading, QuizQuestion } from './study';

export const DEFAULT_EASE = 2.5;
export const MIN_EASE = 1.3;
export const REVIEW_DAY_MS = 86_400_000;
/** 答错（q<3）阈值：低于此质量视为未掌握，重新学习。 */
export const RELEARN_QUALITY_THRESHOLD = 3;

export interface ReviewItem {
  id: string;
  questionId: string;
  materialId: string;
  prompt: string;
  answer: string;
  point: string;
  anchor: string;
  wrongCount: number;
  correctStreak: number;
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  dueAt: number;
  lastReviewedAt: number | null;
  lapses: number;
}

export interface ReviewOutcome {
  correct: boolean;
  /** 0–5，显式覆盖；缺省时 correct ? 4 : 1。 */
  quality?: number;
}

export interface StudyStore {
  addWrong(question: QuizQuestion, grading: Grading, now: number): ReviewItem;
  answer(itemId: string, correct: boolean, now: number): ReviewItem | null;
  listDue(now: number): ReviewItem[];
  listAll(): ReviewItem[];
  remove(itemId: string): boolean;
  snapshot(): ReviewItem[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * SM-2 单步调度。纯函数：返回新 item，不修改入参。
 */
export function scheduleReview(item: ReviewItem, outcome: ReviewOutcome, now: number): ReviewItem {
  const quality = clamp(Math.round(outcome.quality ?? (outcome.correct ? 4 : 1)), 0, 5);
  const easeFactor = Math.max(
    MIN_EASE,
    round2(item.easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))),
  );

  if (quality < RELEARN_QUALITY_THRESHOLD) {
    return {
      ...item,
      easeFactor,
      repetitions: 0,
      intervalDays: 0,
      lapses: item.lapses + 1,
      correctStreak: 0,
      dueAt: now,
      lastReviewedAt: now,
    };
  }

  const repetitions = item.repetitions + 1;
  const intervalDays =
    repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.max(1, Math.round(item.intervalDays * easeFactor));
  return {
    ...item,
    easeFactor,
    repetitions,
    intervalDays,
    correctStreak: item.correctStreak + 1,
    dueAt: now + intervalDays * REVIEW_DAY_MS,
    lastReviewedAt: now,
  };
}

function newItem(question: QuizQuestion, now: number): ReviewItem {
  return {
    id: newId(),
    questionId: question.id,
    materialId: question.materialId,
    prompt: question.prompt,
    answer: question.answer,
    point: question.point,
    anchor: question.anchor,
    wrongCount: 0,
    correctStreak: 0,
    easeFactor: DEFAULT_EASE,
    intervalDays: 0,
    repetitions: 0,
    dueAt: now,
    lastReviewedAt: null,
    lapses: 0,
  };
}

/** 内存错题表（默认；测试与会话内使用）。 */
export function createMemoryStudyStore(): StudyStore {
  const items = new Map<string, ReviewItem>();

  function addWrong(question: QuizQuestion, grading: Grading, now: number): ReviewItem {
    const existing = [...items.values()].find((item) => item.questionId === question.id);
    const base = existing ?? newItem(question, now);
    const scheduled = scheduleReview(
      {
        ...base,
        prompt: question.prompt,
        answer: question.answer,
        point: question.point,
        anchor: question.anchor,
        materialId: question.materialId,
        wrongCount: base.wrongCount + 1,
      },
      { correct: grading.verdict === 'correct' },
      now,
    );
    items.set(scheduled.id, scheduled);
    return scheduled;
  }

  return {
    addWrong,
    answer(itemId: string, correct: boolean, now: number) {
      const item = items.get(itemId);
      if (!item) return null;
      const scheduled = scheduleReview(item, { correct }, now);
      items.set(itemId, scheduled);
      return scheduled;
    },
    listDue(now: number) {
      return [...items.values()]
        .filter((item) => item.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
    },
    listAll() {
      return [...items.values()];
    },
    remove(itemId: string) {
      return items.delete(itemId);
    },
    snapshot() {
      return [...items.values()].map((item) => ({ ...item }));
    },
  };
}

/* ------------------------------------------------------------------ */
/* DB 实现（模块自持表 study_review_items）                             */
/* ------------------------------------------------------------------ */

const SELECT_COLUMNS =
  'id, question_id, material_id, prompt, answer, point, anchor, wrong_count, correct_streak, ease_factor, interval_days, repetitions, due_at, last_reviewed_at, lapses';

function mapRow(row: DbRow): ReviewItem {
  return {
    id: String(row.id),
    questionId: String(row.question_id),
    materialId: String(row.material_id),
    prompt: String(row.prompt),
    answer: String(row.answer),
    point: String(row.point),
    anchor: String(row.anchor),
    wrongCount: Number(row.wrong_count),
    correctStreak: Number(row.correct_streak),
    easeFactor: Number(row.ease_factor),
    intervalDays: Number(row.interval_days),
    repetitions: Number(row.repetitions),
    dueAt: Number(row.due_at),
    lastReviewedAt: row.last_reviewed_at == null ? null : Number(row.last_reviewed_at),
    lapses: Number(row.lapses),
  };
}

/** 错题表的 DB 实现；表由本模块创建（CREATE TABLE IF NOT EXISTS）。 */
export function createDbStudyStore(db?: Db): StudyStore {
  const database = () => db ?? getDb();
  database().run(`CREATE TABLE IF NOT EXISTS study_review_items (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    material_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    answer TEXT NOT NULL,
    point TEXT NOT NULL,
    anchor TEXT NOT NULL,
    wrong_count INTEGER NOT NULL DEFAULT 0,
    correct_streak INTEGER NOT NULL DEFAULT 0,
    ease_factor REAL NOT NULL DEFAULT 2.5,
    interval_days INTEGER NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL,
    last_reviewed_at INTEGER,
    lapses INTEGER NOT NULL DEFAULT 0
  )`);
  database().run('CREATE INDEX IF NOT EXISTS idx_study_review_due ON study_review_items (due_at)');
  database().run('CREATE UNIQUE INDEX IF NOT EXISTS idx_study_review_question ON study_review_items (question_id)');

  function persist(item: ReviewItem): void {
    database().run(
      `INSERT INTO study_review_items (${SELECT_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         question_id = excluded.question_id,
         material_id = excluded.material_id,
         prompt = excluded.prompt,
         answer = excluded.answer,
         point = excluded.point,
         anchor = excluded.anchor,
         wrong_count = excluded.wrong_count,
         correct_streak = excluded.correct_streak,
         ease_factor = excluded.ease_factor,
         interval_days = excluded.interval_days,
         repetitions = excluded.repetitions,
         due_at = excluded.due_at,
         last_reviewed_at = excluded.last_reviewed_at,
         lapses = excluded.lapses`,
      [
        item.id,
        item.questionId,
        item.materialId,
        item.prompt,
        item.answer,
        item.point,
        item.anchor,
        item.wrongCount,
        item.correctStreak,
        item.easeFactor,
        item.intervalDays,
        item.repetitions,
        item.dueAt,
        item.lastReviewedAt,
        item.lapses,
      ],
    );
  }

  function findById(itemId: string): ReviewItem | null {
    const row = database().get(`SELECT ${SELECT_COLUMNS} FROM study_review_items WHERE id = ?`, [itemId]);
    return row ? mapRow(row) : null;
  }

  return {
    addWrong(question: QuizQuestion, grading: Grading, now: number) {
      const row = database().get(`SELECT ${SELECT_COLUMNS} FROM study_review_items WHERE question_id = ?`, [
        question.id,
      ]);
      const base = row ? mapRow(row) : newItem(question, now);
      const scheduled = scheduleReview(
        {
          ...base,
          prompt: question.prompt,
          answer: question.answer,
          point: question.point,
          anchor: question.anchor,
          materialId: question.materialId,
          wrongCount: base.wrongCount + 1,
        },
        { correct: grading.verdict === 'correct' },
        now,
      );
      persist(scheduled);
      return scheduled;
    },
    answer(itemId: string, correct: boolean, now: number) {
      const item = findById(itemId);
      if (!item) return null;
      const scheduled = scheduleReview(item, { correct }, now);
      persist(scheduled);
      return scheduled;
    },
    listDue(now: number) {
      return database()
        .all(`SELECT ${SELECT_COLUMNS} FROM study_review_items WHERE due_at <= ? ORDER BY due_at ASC, id ASC`, [now])
        .map(mapRow);
    },
    listAll() {
      return database()
        .all(`SELECT ${SELECT_COLUMNS} FROM study_review_items ORDER BY due_at ASC, id ASC`)
        .map(mapRow);
    },
    remove(itemId: string) {
      if (!findById(itemId)) return false;
      database().run('DELETE FROM study_review_items WHERE id = ?', [itemId]);
      return true;
    },
    snapshot() {
      return database()
        .all(`SELECT ${SELECT_COLUMNS} FROM study_review_items ORDER BY due_at ASC, id ASC`)
        .map(mapRow);
    },
  };
}

/** 复习事件（复盘/审计用）。 */
export function reviewEvent(item: ReviewItem, now: number): { type: 'review.scheduled'; at: number; itemId: string; dueAt: number } {
  return { type: 'review.scheduled', at: now, itemId: item.id, dueAt: item.dueAt };
}
