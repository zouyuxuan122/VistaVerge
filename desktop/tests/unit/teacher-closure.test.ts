// teacher-closure.test.ts — 闭环补全：诊断画像、变式、复盘（T11 数字与记录一致）。
import { describe, expect, it } from 'vitest';
import { createMockProvider } from '../../src/services/llm/provider';
import {
  buildDiagnosisProfile,
  buildRetrospective,
  buildVariants,
  generateDiagnosis,
  retrospectiveToMarkdown,
} from '../../src/teacher/closure';
import { importMaterial, type Grading, type QuizQuestion } from '../../src/teacher/study';
import type { ReviewItem } from '../../src/teacher/review';
import type { AttemptRecord } from '../../src/teacher/persistence';

const T0 = 1_700_000_000_000;
const MATERIAL_TEXT = [
  '# 光合作用',
  '',
  '光合作用把光能转化为化学能。',
  '叶绿体是光合作用发生的场所。',
  '呼吸作用在细胞的线粒体中进行，释放能量。',
].join('\n');

function question(id: string, point: string): QuizQuestion {
  return {
    id,
    materialId: 'm1',
    type: 'fill_blank',
    prompt: `${point}____`,
    answer: '叶绿体',
    point,
    difficulty: 1,
    anchor: 'm1#L4-L4',
    explanation: '',
    generatedBy: 'local-fallback',
  };
}

function grading(verdict: Grading['verdict'], cause: Grading['cause']): Grading {
  return {
    verdict,
    evidence: [{ rule: 'r', detail: 'd' }],
    confidence: 1,
    validatorId: 'deterministic-exact-v1',
    questionId: 'q',
    answer: 'a',
    expected: 'e',
    cause,
  };
}

function wrongItem(id: string, point: string): ReviewItem {
  return {
    id,
    questionId: `q-${id}`,
    materialId: 'm1',
    prompt: `${point}____`,
    answer: '叶绿体',
    point,
    anchor: 'm1#L4-L4',
    wrongCount: 1,
    correctStreak: 0,
    easeFactor: 2.5,
    intervalDays: 0,
    repetitions: 0,
    dueAt: T0,
    lastReviewedAt: null,
    lapses: 0,
  };
}

describe('诊断', () => {
  it('前测题量夹取在 3–5', async () => {
    const { material, chunks } = importMaterial({ name: 'x.md', text: MATERIAL_TEXT });
    const result = await generateDiagnosis({ material, chunks, provider: createMockProvider(), count: 1 });
    expect(result.questions.length).toBeGreaterThanOrEqual(3);
    expect(result.questions.length).toBeLessThanOrEqual(5);
  });

  it('画像按知识点统计，unverified 不计入分母', () => {
    const profile = buildDiagnosisProfile({
      materialId: 'm1',
      questions: [question('q1', '场所'), question('q2', '场所'), question('q3', '能量'), question('q4', '能量')],
      gradings: {
        q1: grading('correct', 'none'),
        q2: grading('incorrect', 'concept'),
        q3: grading('correct', 'none'),
        q4: grading('unverified', 'none'),
      },
      at: T0,
    });
    const place = profile.points.find((point) => point.point === '场所')!;
    expect(place).toMatchObject({ asked: 2, correct: 1, mastery: 0.5 });
    const energy = profile.points.find((point) => point.point === '能量')!;
    expect(energy).toMatchObject({ asked: 1, correct: 1, mastery: 1 });
    expect(profile.overall).toBe(0.67);
    expect(profile.at).toBe(T0);
  });
});

describe('变式', () => {
  it('基于错题知识点生成 1–2 道变式；无错题返回空', async () => {
    const { material, chunks } = importMaterial({ name: 'x.md', text: MATERIAL_TEXT });
    const variants = await buildVariants({
      material,
      chunks,
      wrongItems: [wrongItem('r1', '场所')],
      provider: createMockProvider(),
    });
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.length).toBeLessThanOrEqual(2);
    expect(variants.every((variant) => variant.difficulty === 2)).toBe(true);

    const none = await buildVariants({ material, chunks, wrongItems: [], provider: createMockProvider() });
    expect(none).toEqual([]);
  });
});

describe('复盘（T11 真实性）', () => {
  const attempts: AttemptRecord[] = [
    { id: 'a1', materialId: 'm1', questionId: 'q1', point: '场所', verdict: 'correct', cause: 'none', answer: '叶绿体', expected: '叶绿体', at: T0 },
    { id: 'a2', materialId: 'm1', questionId: 'q2', point: '场所', verdict: 'incorrect', cause: 'concept', answer: '线粒体', expected: '叶绿体', at: T0 + 1 },
    { id: 'a3', materialId: 'm1', questionId: 'q3', point: '能量', verdict: 'incorrect', cause: 'calculation', answer: '41', expected: '42', at: T0 + 2 },
    { id: 'a4', materialId: 'm1', questionId: 'q4', point: '能量', verdict: 'unverified', cause: 'none', answer: '主观', expected: '标准', at: T0 + 3 },
  ];

  it('观测数字与记录一致，错因分布正确', () => {
    const report = buildRetrospective({
      materialId: 'm1',
      materialName: 'x.md',
      attempts,
      reviewItems: [wrongItem('r1', '场所')],
      now: T0 + 10,
    });
    expect(report.observed.attempts).toBe(4);
    expect(report.observed.correct).toBe(1);
    expect(report.observed.incorrect).toBe(2);
    expect(report.observed.unverified).toBe(1);
    expect(report.observed.accuracy).toBe(0.33);
    expect(report.observed.causes).toEqual([
      { cause: 'concept', label: '概念不清', count: 1 },
      { cause: 'calculation', label: '计算错误', count: 1 },
    ]);
    const place = report.observed.points.find((point) => point.point === '场所')!;
    expect(place).toMatchObject({ asked: 2, correct: 1, mastery: 0.5 });
    expect(report.observed.dueReviewCount).toBe(1);
    expect(report.observed.wrongBookCount).toBe(1);
  });

  it('观测事实与推测建议分离，markdown 分节且数字一致', () => {
    const report = buildRetrospective({
      materialId: 'm1',
      materialName: 'x.md',
      attempts,
      reviewItems: [wrongItem('r1', '场所')],
      now: T0 + 10,
    });
    expect(report.suggestions.length).toBeGreaterThan(0);
    const markdown = retrospectiveToMarkdown(report);
    expect(markdown).toContain('## 观测事实');
    expect(markdown).toContain('## 推测建议');
    expect(markdown).toContain('作答次数：4');
    expect(markdown).toContain('正确率：33%');
    expect(markdown).toContain('概念不清 1');
    expect(markdown).toContain('计算错误 1');
  });

  it('无作答记录时 accuracy 为 null，并给出首次诊断建议', () => {
    const report = buildRetrospective({ materialId: 'm1', materialName: 'x.md', attempts: [], reviewItems: [], now: T0 });
    expect(report.observed.attempts).toBe(0);
    expect(report.observed.accuracy).toBeNull();
    expect(report.suggestions.join('')).toContain('诊断');
  });
});
