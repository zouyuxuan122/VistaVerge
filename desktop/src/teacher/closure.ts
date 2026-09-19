/**
 * teacher/closure.ts — 闭环补全（P1）：诊断、变式、学习复盘。
 *
 * 依据 TEACHER_COMPANION §1.1(6)(7)、§1.4、T11：
 * - 诊断：前测 3–5 题 → 各知识点掌握画像（落库由 persistence 层负责）。
 * - 变式：基于错题知识点生成 1–2 道变式（走 provider，失败降级本地确定性出题）。
 * - 复盘：统计**全部来自真实 Attempt/Grading 记录**，明确区分「观测事实」与
 *   「推测建议」，可导出 markdown；不出现模型自述生成的虚构数字。
 */

import type { LlmProvider } from '../services/llm/provider';
import { newId } from '../data/util';
import {
  GRADING_CAUSE_LABELS,
  generateQuiz,
  type Chunk,
  type Grading,
  type GradingCause,
  type Material,
  type ProviderRequest,
  type QuizQuestion,
} from './study';
import type { ReviewItem } from './review';
import type { AttemptRecord } from './persistence';

export const DIAGNOSIS_MIN_QUESTIONS = 3;
export const DIAGNOSIS_MAX_QUESTIONS = 5;

export interface DiagnosisPoint {
  point: string;
  asked: number;
  correct: number;
  /** 正确率 0–1（unverified 不计入分母）。 */
  mastery: number;
}

export interface DiagnosisProfile {
  materialId: string;
  at: number;
  points: DiagnosisPoint[];
  /** 全部知识点合并正确率（无有效判定时为 0）。 */
  overall: number;
}

/** 前测：复用出题器，题量限制在 3–5，难度偏基础。 */
export async function generateDiagnosis(input: {
  material: Material;
  chunks: Chunk[];
  provider: LlmProvider;
  count?: number;
  providerRequest?: ProviderRequest;
  signal?: AbortSignal;
}) {
  const count = Math.min(
    Math.max(input.count ?? DIAGNOSIS_MIN_QUESTIONS, DIAGNOSIS_MIN_QUESTIONS),
    DIAGNOSIS_MAX_QUESTIONS,
  );
  return generateQuiz({
    material: input.material,
    chunks: input.chunks,
    provider: input.provider,
    count,
    difficulty: 1,
    providerRequest: input.providerRequest,
    signal: input.signal,
  });
}

/** 由真实题目+批改记录构建知识点掌握画像（只统计有确定判定的题）。 */
export function buildDiagnosisProfile(input: {
  materialId: string;
  questions: QuizQuestion[];
  gradings: Record<string, Grading>;
  at: number;
}): DiagnosisProfile {
  const byPoint = new Map<string, { asked: number; correct: number }>();
  for (const question of input.questions) {
    const grading = input.gradings[question.id];
    if (!grading || grading.verdict === 'unverified') continue;
    const point = question.point || '未标注知识点';
    const entry = byPoint.get(point) ?? { asked: 0, correct: 0 };
    entry.asked += 1;
    if (grading.verdict === 'correct') entry.correct += 1;
    byPoint.set(point, entry);
  }
  const points: DiagnosisPoint[] = [...byPoint.entries()].map(([point, entry]) => ({
    point,
    asked: entry.asked,
    correct: entry.correct,
    mastery: entry.asked === 0 ? 0 : Math.round((entry.correct / entry.asked) * 100) / 100,
  }));
  const asked = points.reduce((sum, point) => sum + point.asked, 0);
  const correct = points.reduce((sum, point) => sum + point.correct, 0);
  return {
    materialId: input.materialId,
    at: input.at,
    points,
    overall: asked === 0 ? 0 : Math.round((correct / asked) * 100) / 100,
  };
}

/** 变式：基于错题知识点生成 1–2 道新题（同知识点、同难度区间）。 */
export async function buildVariants(input: {
  material: Material;
  chunks: Chunk[];
  wrongItems: ReviewItem[];
  provider: LlmProvider;
  count?: number;
  providerRequest?: ProviderRequest;
  signal?: AbortSignal;
}): Promise<QuizQuestion[]> {
  const count = Math.min(Math.max(input.count ?? 2, 1), 2);
  if (input.wrongItems.length === 0) return [];
  const points = new Set(input.wrongItems.map((item) => item.point).filter(Boolean));
  const relevantChunks = input.chunks.filter((chunk) => {
    for (const point of points) {
      if (chunk.text.includes(point)) return true;
    }
    return false;
  });
  const sourceChunks = relevantChunks.length > 0 ? relevantChunks : input.chunks;
  const result = await generateQuiz({
    material: input.material,
    chunks: sourceChunks,
    provider: input.provider,
    count: Math.max(count * 2, 2),
    difficulty: 2,
    providerRequest: input.providerRequest,
    signal: input.signal,
  });
  const wrongQuestionIds = new Set(input.wrongItems.map((item) => item.questionId));
  const preferred = result.questions.filter((question) => !wrongQuestionIds.has(question.id));
  return (preferred.length > 0 ? preferred : result.questions).slice(0, count);
}

/* ------------------------------------------------------------------ */
/* 学习复盘（T11：观测事实与推测建议分离）                              */
/* ------------------------------------------------------------------ */

export interface CauseDistribution {
  cause: GradingCause;
  label: string;
  count: number;
}

export interface RetrospectivePoint {
  point: string;
  asked: number;
  correct: number;
  mastery: number;
}

export interface Retrospective {
  materialId: string;
  materialName: string;
  generatedAt: number;
  /** 观测事实：全部来自 Attempt/Grading 记录。 */
  observed: {
    attempts: number;
    correct: number;
    incorrect: number;
    unverified: number;
    /** correct / (correct + incorrect)，无有效判定时为 null。 */
    accuracy: number | null;
    causes: CauseDistribution[];
    points: RetrospectivePoint[];
    dueReviewCount: number;
    nextDueAt: number | null;
    wrongBookCount: number;
  };
  /** 推测建议：明确标注为启发式建议，不是观测事实。 */
  suggestions: string[];
}

const CAUSE_ORDER: GradingCause[] = ['concept', 'calculation', 'misread', 'incomplete', 'unanswered'];

export function buildRetrospective(input: {
  materialId: string;
  materialName: string;
  attempts: AttemptRecord[];
  reviewItems: ReviewItem[];
  now: number;
}): Retrospective {
  const attempts = input.attempts.filter((record) => record.materialId === input.materialId);
  const correct = attempts.filter((record) => record.verdict === 'correct').length;
  const incorrect = attempts.filter((record) => record.verdict === 'incorrect').length;
  const unverified = attempts.filter((record) => record.verdict === 'unverified').length;

  const causeCounts = new Map<GradingCause, number>();
  for (const record of attempts) {
    if (record.verdict !== 'incorrect') continue;
    causeCounts.set(record.cause, (causeCounts.get(record.cause) ?? 0) + 1);
  }
  const causes: CauseDistribution[] = CAUSE_ORDER.filter((cause) => (causeCounts.get(cause) ?? 0) > 0).map((cause) => ({
    cause,
    label: GRADING_CAUSE_LABELS[cause],
    count: causeCounts.get(cause) ?? 0,
  }));

  const byPoint = new Map<string, { asked: number; correct: number }>();
  for (const record of attempts) {
    if (record.verdict === 'unverified') continue;
    const point = record.point || '未标注知识点';
    const entry = byPoint.get(point) ?? { asked: 0, correct: 0 };
    entry.asked += 1;
    if (record.verdict === 'correct') entry.correct += 1;
    byPoint.set(point, entry);
  }
  const points: RetrospectivePoint[] = [...byPoint.entries()].map(([point, entry]) => ({
    point,
    asked: entry.asked,
    correct: entry.correct,
    mastery: entry.asked === 0 ? 0 : Math.round((entry.correct / entry.asked) * 100) / 100,
  }));

  const dueItems = input.reviewItems.filter((item) => item.materialId === input.materialId && item.dueAt <= input.now);
  const upcoming = input.reviewItems
    .filter((item) => item.materialId === input.materialId)
    .map((item) => item.dueAt)
    .sort((a, b) => a - b);

  const observed: Retrospective['observed'] = {
    attempts: attempts.length,
    correct,
    incorrect,
    unverified,
    accuracy: correct + incorrect === 0 ? null : Math.round((correct / (correct + incorrect)) * 100) / 100,
    causes,
    points,
    dueReviewCount: dueItems.length,
    nextDueAt: upcoming.length > 0 ? upcoming[0]! : null,
    wrongBookCount: input.reviewItems.filter((item) => item.materialId === input.materialId).length,
  };

  // 推测建议：仅由观测事实触发的启发式规则，明确不是观测结论。
  const suggestions: string[] = [];
  if (observed.attempts === 0) {
    suggestions.push('尚无作答记录：建议先做一轮诊断题以获得掌握画像。');
  } else {
    const weak = [...points].filter((point) => point.asked >= 1 && point.mastery < 0.6).sort((a, b) => a.mastery - b.mastery);
    if (weak.length > 0) {
      suggestions.push(`建议优先复习掌握度较低的知识点：${weak.slice(0, 3).map((point) => point.point).join('、')}。`);
    }
    const topCause = [...causes].sort((a, b) => b.count - a.count)[0];
    if (topCause) {
      const advice: Record<GradingCause, string> = {
        concept: '建议先回到资料原文重建概念，再做同类题。',
        calculation: '建议放慢计算步骤并逐步验算。',
        misread: '建议作答前先圈出题干限定词。',
        incomplete: '建议按要点分条作答，补全缺失要点。',
        unanswered: '建议不要留空，先写出已知部分。',
        none: '',
      };
      suggestions.push(`主要错因是「${topCause.label}」：${advice[topCause.cause]}`);
    }
    if (observed.dueReviewCount > 0) {
      suggestions.push(`当前有 ${observed.dueReviewCount} 道到期错题：建议立即进入复习队列。`);
    }
  }

  return {
    materialId: input.materialId,
    materialName: input.materialName,
    generatedAt: input.now,
    observed,
    suggestions,
  };
}

/** 导出 markdown：观测事实与推测建议分节，避免混写（§1.4(4)）。 */
export function retrospectiveToMarkdown(report: Retrospective): string {
  const lines: string[] = [];
  lines.push(`# 学习复盘：${report.materialName}`);
  lines.push('');
  lines.push(`生成时间：${new Date(report.generatedAt).toISOString()}`);
  lines.push('');
  lines.push('## 观测事实（来自 Attempt/Grading 记录）');
  lines.push('');
  lines.push(`- 作答次数：${report.observed.attempts}`);
  lines.push(`- 正确：${report.observed.correct}`);
  lines.push(`- 错误：${report.observed.incorrect}`);
  lines.push(`- 待验证：${report.observed.unverified}`);
  lines.push(
    `- 正确率：${report.observed.accuracy === null ? '无有效判定' : `${Math.round(report.observed.accuracy * 100)}%`}`,
  );
  lines.push(`- 错题本：${report.observed.wrongBookCount} 题，其中到期 ${report.observed.dueReviewCount} 题`);
  if (report.observed.points.length > 0) {
    lines.push('');
    lines.push('| 知识点 | 作答 | 正确 | 掌握度 |');
    lines.push('| --- | --- | --- | --- |');
    for (const point of report.observed.points) {
      lines.push(`| ${point.point} | ${point.asked} | ${point.correct} | ${Math.round(point.mastery * 100)}% |`);
    }
  }
  if (report.observed.causes.length > 0) {
    lines.push('');
    lines.push('错因分布：' + report.observed.causes.map((cause) => `${cause.label} ${cause.count}`).join('；'));
  }
  lines.push('');
  lines.push('## 推测建议（启发式，不是观测结论）');
  lines.push('');
  if (report.suggestions.length === 0) lines.push('- 无');
  else for (const suggestion of report.suggestions) lines.push(`- ${suggestion}`);
  lines.push('');
  return lines.join('\n');
}

/** 供 UI 直接取用：稳定 id（诊断记录/变式导出用）。 */
export function newClosureId(): string {
  return newId();
}
