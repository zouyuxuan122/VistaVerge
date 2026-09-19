// EXP-006 错题表与轻量 SM-2 复习调度测试（TEACHER_COMPANION §3.2 复习调度合同）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDb } from '../../src/data/db';
import {
  DEFAULT_EASE,
  MIN_EASE,
  createDbStudyStore,
  createMemoryStudyStore,
  scheduleReview,
  type ReviewItem,
} from '../../src/teacher/review';
import type { Grading, QuizQuestion } from '../../src/teacher/study';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

function question(id = 'q1'): QuizQuestion {
  return {
    id,
    materialId: 'm1',
    type: 'fill_blank',
    prompt: '光合作用发生在____中。',
    answer: '叶绿体',
    point: '场所',
    difficulty: 1,
    anchor: 'm1#L4-L4',
    explanation: '',
    generatedBy: 'local-fallback',
  };
}

function grading(verdict: Grading['verdict'] = 'incorrect'): Grading {
  return {
    verdict,
    evidence: [{ rule: 'normalized-exact-match', detail: '期望「叶绿体」，实得「线粒体」' }],
    confidence: 0.95,
    validatorId: 'deterministic-exact-v1',
    questionId: 'q1',
    answer: '线粒体',
    expected: '叶绿体',
    cause: verdict === 'incorrect' ? 'concept' : 'none',
  };
}

function newItem(): ReviewItem {
  return {
    id: 'r1',
    questionId: 'q1',
    materialId: 'm1',
    prompt: '光合作用发生在____中。',
    answer: '叶绿体',
    point: '场所',
    anchor: 'm1#L4-L4',
    wrongCount: 1,
    correctStreak: 0,
    easeFactor: DEFAULT_EASE,
    intervalDays: 0,
    repetitions: 0,
    dueAt: T0,
    lastReviewedAt: null,
    lapses: 0,
  };
}

describe('SM-2 轻量调度', () => {
  it('答对：间隔 1 → 6 → 15 天，间隔因子保持 2.5', () => {
    const first = scheduleReview(newItem(), { correct: true }, T0);
    expect(first).toMatchObject({ repetitions: 1, intervalDays: 1, dueAt: T0 + DAY, easeFactor: 2.5 });

    const second = scheduleReview(first, { correct: true }, T0 + DAY);
    expect(second).toMatchObject({ repetitions: 2, intervalDays: 6, dueAt: T0 + DAY + 6 * DAY });

    const third = scheduleReview(second, { correct: true }, T0 + 7 * DAY);
    expect(third).toMatchObject({ repetitions: 3, intervalDays: 15, dueAt: T0 + 7 * DAY + 15 * DAY });
    expect(third.correctStreak).toBe(3);
  });

  it('答错：间隔归零立即重学，lapses 累加，间隔因子下调', () => {
    const reviewed = scheduleReview({ ...newItem(), repetitions: 3, intervalDays: 15, easeFactor: 2.5 }, { correct: false }, T0);
    expect(reviewed).toMatchObject({
      repetitions: 0,
      intervalDays: 0,
      dueAt: T0,
      lapses: 1,
      easeFactor: 1.96,
      correctStreak: 0,
    });
    expect(reviewed.lastReviewedAt).toBe(T0);
  });

  it('间隔因子下限 1.3，不无限下调', () => {
    let item = { ...newItem(), easeFactor: MIN_EASE };
    for (let i = 0; i < 5; i += 1) item = scheduleReview(item, { correct: false }, T0);
    expect(item.easeFactor).toBe(MIN_EASE);
    expect(item.lapses).toBe(5);
  });

  it('支持显式 quality（0–5），并夹取范围', () => {
    const high = scheduleReview(newItem(), { correct: true, quality: 5 }, T0);
    expect(high.easeFactor).toBe(2.6);
    const clamped = scheduleReview(newItem(), { correct: true, quality: 99 }, T0);
    expect(clamped.easeFactor).toBe(2.6);
    const low = scheduleReview(newItem(), { correct: false, quality: -5 }, T0);
    // q 夹取到 0：EF' = 2.5 + (0.1 - 5*(0.08+5*0.02)) = 1.7
    expect(low.easeFactor).toBe(1.7);
  });
});

describe('错题表（内存实现）', () => {
  it('答错入队并立即可复习；答对推进间隔；可移除', () => {
    const store = createMemoryStudyStore();
    const item = store.addWrong(question(), grading('incorrect'), T0);
    expect(item).toMatchObject({ questionId: 'q1', wrongCount: 1, intervalDays: 0, dueAt: T0 });
    expect(store.listAll()).toHaveLength(1);
    expect(store.listDue(T0).map((i) => i.id)).toEqual([item.id]);
    expect(store.listDue(T0 - 1)).toEqual([]);

    const reviewed = store.answer(item.id, true, T0);
    expect(reviewed).toMatchObject({ intervalDays: 1, dueAt: T0 + DAY, wrongCount: 1 });
    expect(store.listDue(T0 + DAY).map((i) => i.id)).toEqual([item.id]);

    expect(store.remove(item.id)).toBe(true);
    expect(store.remove(item.id)).toBe(false);
    expect(store.listAll()).toEqual([]);
    expect(store.answer('missing', true, T0)).toBeNull();
  });

  it('同一题目重复答错只保留一条并累加错误次数', () => {
    const store = createMemoryStudyStore();
    const first = store.addWrong(question(), grading('incorrect'), T0);
    const second = store.addWrong(question(), grading('incorrect'), T0 + 1000);
    expect(store.listAll()).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.wrongCount).toBe(2);
    expect(second.dueAt).toBe(T0 + 1000);
  });

  it('答对后再次答错会重置复习进度', () => {
    const store = createMemoryStudyStore();
    const item = store.addWrong(question(), grading('incorrect'), T0);
    store.answer(item.id, true, T0);
    store.answer(item.id, true, T0 + DAY);
    const afterCorrect = store.listAll()[0]!;
    expect(afterCorrect.repetitions).toBe(2);

    const relapsed = store.addWrong(question(), grading('incorrect'), T0 + 2 * DAY);
    expect(relapsed.repetitions).toBe(0);
    expect(relapsed.intervalDays).toBe(0);
    expect(relapsed.lapses).toBeGreaterThanOrEqual(1);
  });

  it('snapshot 可导出，便于复盘与持久化', () => {
    const store = createMemoryStudyStore();
    store.addWrong(question(), grading('incorrect'), T0);
    const snapshot = store.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ questionId: 'q1', answer: '叶绿体' });
  });
});

describe('错题表（DB 持久化实现）', () => {
  beforeEach(async () => {
    await initDb();
  });
  afterEach(() => {
    closeDb();
  });

  it('跨实例持久化，且表为模块自持（study_review_items）', () => {
    const store = createDbStudyStore(getDb());
    const item = store.addWrong(question(), grading('incorrect'), T0);
    store.answer(item.id, true, T0);

    const reopened = createDbStudyStore(getDb());
    const all = reopened.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: item.id, questionId: 'q1', intervalDays: 1, dueAt: T0 + DAY });

    const tables = getDb()
      .all("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => String(r.name));
    expect(tables).toContain('study_review_items');
  });

  it('DB 实现同样支持去重累加与移除', () => {
    const store = createDbStudyStore(getDb());
    const first = store.addWrong(question(), grading('incorrect'), T0);
    const second = store.addWrong(question(), grading('incorrect'), T0 + 500);
    expect(second.id).toBe(first.id);
    expect(second.wrongCount).toBe(2);
    expect(store.remove(first.id)).toBe(true);
    expect(store.listAll()).toEqual([]);
  });
});
