// teacher-persistence.test.ts — 教师状态落 SQLite（B-T-02/03/05/11/12）+ schema_version 断言。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDb } from '../../src/data/db';
import { createMockProvider } from '../../src/services/llm/provider';
import { createTeacherStore } from '../../src/teacher/teacherStore';
import { createDbStudyStore } from '../../src/teacher/review';
import {
  TEACHER_SCHEMA_KEY,
  TEACHER_SCHEMA_VERSION,
  createDbTeacherStateStore,
} from '../../src/teacher/persistence';
import { gradeAnswer, importMaterial, type QuizQuestion } from '../../src/teacher/study';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const MATERIAL_TEXT = [
  '# 光合作用',
  '',
  '光合作用把光能转化为化学能。',
  '叶绿体是光合作用发生的场所。',
  '',
  '## 呼吸作用',
  '呼吸作用在细胞的线粒体中进行，释放能量。',
].join('\n');

function fill(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: 'q1',
    materialId: 'm1',
    type: 'fill_blank',
    prompt: '光合作用发生在____中。',
    answer: '叶绿体',
    point: '场所',
    difficulty: 1,
    anchor: 'm1#L4-L4',
    explanation: '',
    generatedBy: 'local-fallback',
    ...overrides,
  };
}

function dbStore() {
  return createDbTeacherStateStore(getDb());
}

function setup() {
  return createTeacherStore({
    provider: createMockProvider(),
    stateStore: dbStore(),
    studyStore: createDbStudyStore(getDb()),
    now: () => T0,
  });
}

describe('教师状态持久化（SQLite）', () => {
  beforeEach(async () => {
    await initDb();
  });
  afterEach(() => {
    closeDb();
  });

  it('schema_version 落库且断言同步；教师域表齐备', () => {
    const store = dbStore();
    expect(store.schemaVersion()).toBe(TEACHER_SCHEMA_VERSION);
    expect(getDb().get(`SELECT value FROM teacher_meta WHERE key = '${TEACHER_SCHEMA_KEY}'`)?.value).toBe(
      String(TEACHER_SCHEMA_VERSION),
    );
    const tables = getDb()
      .all("SELECT name FROM sqlite_master WHERE type='table'")
      .map((row) => String(row.name));
    for (const table of [
      'teacher_meta',
      'teacher_materials',
      'teacher_chunks',
      'teacher_questions',
      'teacher_gradings',
      'teacher_attempts',
      'teacher_diagnoses',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('资料/分块/题目/批改/作答/诊断可跨实例读取', () => {
    const store = dbStore();
    const { material, chunks } = importMaterial({ name: '生物.md', text: MATERIAL_TEXT });
    store.saveMaterial(material, chunks);
    store.saveQuestions(material.id, [fill({ id: 'q1', materialId: material.id })]);
    const grading = gradeAnswer(fill({ id: 'q1', materialId: material.id }), '线粒体');
    store.saveGrading(material.id, grading);
    store.appendAttempt({
      id: 'a1',
      materialId: material.id,
      questionId: 'q1',
      point: '场所',
      verdict: grading.verdict,
      cause: grading.cause,
      answer: '线粒体',
      expected: '叶绿体',
      at: T0,
    });
    store.saveDiagnosis(material.id, { overall: 0.5 }, T0);

    const reopened = dbStore();
    const loaded = reopened.loadMaterial();
    expect(loaded?.material.name).toBe('生物.md');
    expect(loaded?.chunks.length).toBe(chunks.length);
    expect(loaded?.chunks[0]?.untrusted).toBe(true);
    expect(reopened.loadQuestions(material.id)).toHaveLength(1);
    expect(reopened.loadGradings(material.id).q1?.verdict).toBe('incorrect');
    expect(reopened.loadAttempts(material.id)).toHaveLength(1);
    expect(reopened.loadDiagnosis(material.id)?.payload).toEqual({ overall: 0.5 });
  });

  it('B-T-02：重启后 teacherStore 复水资料/题目/批改，错题本也持久', async () => {
    const first = setup();
    expect(first.persistenceIsMemory).toBe(false);
    expect(first.importMaterial({ name: '生物.md', text: MATERIAL_TEXT }).ok).toBe(true);
    await first.makeQuiz(3);
    const question = first.quiz()[0]!;
    first.submit(question.id, '完全不相干的答案');
    expect(first.wrongBook()).toHaveLength(1);

    const reopened = setup();
    expect(reopened.material()?.name).toBe('生物.md');
    expect(reopened.quiz().length).toBeGreaterThan(0);
    expect(reopened.gradings()[question.id]?.verdict).toBe('incorrect');
    expect(reopened.wrongBook()).toHaveLength(1);
  });

  it('B-T-03：答错入队→到期→复习→改期闭环', async () => {
    const store = setup();
    store.importMaterial({ name: '生物.md', text: MATERIAL_TEXT });
    await store.makeQuiz(3);
    const question = store.quiz()[0]!;
    store.submit(question.id, '完全不相干的答案');
    const due = store.dueReview();
    expect(due).toHaveLength(1);
    expect(due[0]!.dueAt).toBe(T0);

    store.review(due[0]!.id, true);
    expect(store.dueReview()).toHaveLength(0);
    expect(store.wrongBook()[0]!.dueAt).toBe(T0 + DAY);
    expect(store.wrongBook()[0]!.intervalDays).toBe(1);
  });

  it('B-T-05：导入失败重置 events（不残留上一次资料事件）', () => {
    const store = setup();
    store.importMaterial({ name: '生物.md', text: MATERIAL_TEXT });
    expect(store.events().length).toBeGreaterThan(0);
    const failed = store.importMaterial({ name: '空.txt', text: '   ' });
    expect(failed.ok).toBe(false);
    expect(store.events()).toEqual([]);
    expect(store.material()).toBeNull();
  });

  it('B-T-11：同题同作答重复提交不重复入错题（幂等）', async () => {
    const store = setup();
    store.importMaterial({ name: '生物.md', text: MATERIAL_TEXT });
    await store.makeQuiz(3);
    const question = store.quiz()[0]!;
    const first = store.submit(question.id, '错误答案');
    const second = store.submit(question.id, '错误答案');
    expect(first?.verdict).toBe('incorrect');
    expect(second).toEqual(first);
    expect(store.wrongBook()).toHaveLength(1);
    expect(store.wrongBook()[0]!.wrongCount).toBe(1);
  });

  it('B-T-12：unverified 主观题可手动加入错题本', async () => {
    const shortAnswerProvider = {
      mock: true,
      capabilities: () => ({ streaming: true }),
      async *streamChat() {
        yield {
          delta: JSON.stringify({
            questions: [
              {
                type: 'short_answer',
                prompt: '请简述光合作用的能量转化。',
                answer: '把光能转化为化学能',
                point: '概念',
                difficulty: 1,
                explanation: '资料第 3 行。',
              },
            ],
          }),
        };
        yield { done: { finishReason: 'stop' } };
      },
    };
    const store = createTeacherStore({
      provider: shortAnswerProvider,
      stateStore: dbStore(),
      studyStore: createDbStudyStore(getDb()),
      now: () => T0,
    });
    store.importMaterial({ name: '生物.md', text: MATERIAL_TEXT });
    await store.makeQuiz(1);
    const question = store.quiz()[0]!;
    expect(question.type).toBe('short_answer');
    const grading = store.submit(question.id, '我的理解');
    expect(grading?.verdict).toBe('unverified');
    const item = store.addToWrongBook(question.id);
    expect(item).not.toBeNull();
    expect(store.wrongBook().some((entry) => entry.questionId === question.id)).toBe(true);
  });
});
