/**
 * teacher/teacherStore.ts — 教师视图状态（导入 → 提问 → 小测 → 批改 → 错题本）。
 *
 * 编排层：只调用 teacher/study 与 teacher/review 的公开接口，不直接触碰数据层
 * 内部实现。LLM 只在步骤边界（提问、出题）调用，批改是确定性纯函数。
 */

import { createMockProvider, type LlmProvider } from '../services/llm/provider';
import { nowMs } from '../data/util';
import {
  askQuestion,
  generateQuiz,
  gradeAnswer,
  importMaterial as importStudyMaterial,
  type AnswerResult,
  type Chunk,
  type Citation,
  type Grading,
  type Material,
  type QuizQuestion,
  type StudyEvent,
} from './study';
import { createMemoryStudyStore, type ReviewItem, type StudyStore } from './review';

export interface TeacherStore {
  /** true 表示当前 provider 是离线 mock（非真实供应商），UI 必须明示。 */
  readonly providerIsMock: boolean;
  material(): Material | null;
  chunks(): Chunk[];
  events(): StudyEvent[];
  quiz(): QuizQuestion[];
  gradings(): Record<string, Grading>;
  wrongBook(): ReviewItem[];
  busy(): boolean;
  lastError(): string | null;
  importMaterial(input: { name: string; text: string; license?: string }): { ok: boolean; error?: string };
  ask(question: string): Promise<{ ok: boolean; answer: string; citations: Citation[]; notFound: boolean; error?: string }>;
  makeQuiz(count?: number): Promise<{ ok: boolean; generatedBy: string; count: number; error?: string }>;
  submit(questionId: string, answer: string): Grading | null;
  review(itemId: string, correct: boolean): void;
  eventsFor(questionId: string): StudyEvent[];
}

export interface TeacherStoreDeps {
  provider?: LlmProvider;
  studyStore?: StudyStore;
  now?: () => number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTeacherStore(deps: TeacherStoreDeps = {}): TeacherStore {
  const provider = deps.provider ?? createMockProvider();
  const studyStore = deps.studyStore ?? createMemoryStudyStore();
  const now = deps.now ?? nowMs;

  let material: Material | null = null;
  let chunks: Chunk[] = [];
  let events: StudyEvent[] = [];
  let questions: QuizQuestion[] = [];
  let gradings: Record<string, Grading> = {};
  let busy = false;
  let lastError: string | null = null;

  return {
    providerIsMock: provider.mock,

    material: () => material,
    chunks: () => chunks,
    events: () => events,
    quiz: () => questions,
    gradings: () => ({ ...gradings }),
    wrongBook: () => studyStore.listAll(),
    busy: () => busy,
    lastError: () => lastError,

    importMaterial(input) {
      try {
        const result = importStudyMaterial(input);
        material = result.material;
        chunks = result.chunks;
        events = [...result.events];
        questions = [];
        gradings = {};
        lastError = null;
        return { ok: true };
      } catch (error) {
        material = null;
        chunks = [];
        questions = [];
        gradings = {};
        lastError = `导入失败：${messageOf(error)}`;
        return { ok: false, error: messageOf(error) };
      }
    },

    async ask(question) {
      if (!material) {
        lastError = '请先导入资料再提问';
        return { ok: false, answer: '', citations: [], notFound: true, error: 'no-material' };
      }
      busy = true;
      try {
        const result: AnswerResult = await askQuestion({ material, chunks, question, provider });
        events = [...events, ...result.events];
        lastError = null;
        return { ok: true, answer: result.answer, citations: result.citations, notFound: result.notFound };
      } catch (error) {
        lastError = `提问失败：${messageOf(error)}`;
        return { ok: false, answer: '', citations: [], notFound: false, error: messageOf(error) };
      } finally {
        busy = false;
      }
    },

    async makeQuiz(count = 3) {
      if (!material) {
        lastError = '请先导入资料再出题';
        return { ok: false, generatedBy: 'none', count: 0, error: 'no-material' };
      }
      busy = true;
      try {
        const result = await generateQuiz({ material, chunks, provider, count });
        questions = result.questions;
        gradings = {};
        events = [...events, ...result.events];
        lastError = null;
        return { ok: true, generatedBy: result.generatedBy, count: result.questions.length };
      } catch (error) {
        lastError = `出题失败：${messageOf(error)}`;
        return { ok: false, generatedBy: 'none', count: 0, error: messageOf(error) };
      } finally {
        busy = false;
      }
    },

    submit(questionId, answer) {
      const question = questions.find((item) => item.id === questionId);
      if (!question) return null;
      const grading = gradeAnswer(question, answer);
      gradings = { ...gradings, [questionId]: grading };
      if (grading.verdict === 'incorrect') {
        const item = studyStore.addWrong(question, grading, now());
        events = [
          ...events,
          { type: 'grading.completed', at: now(), traceId: questionId, detail: { verdict: grading.verdict } },
          { type: 'review.scheduled', at: now(), traceId: item.id, detail: { dueAt: item.dueAt } },
        ];
      } else {
        events = [...events, { type: 'grading.completed', at: now(), traceId: questionId, detail: { verdict: grading.verdict } }];
      }
      return grading;
    },

    review(itemId, correct) {
      const item = studyStore.answer(itemId, correct, now());
      if (item) {
        events = [...events, { type: 'review.scheduled', at: now(), traceId: item.id, detail: { dueAt: item.dueAt } }];
      }
    },

    eventsFor(questionId) {
      return events.filter((event) => event.traceId === questionId);
    },
  };
}
