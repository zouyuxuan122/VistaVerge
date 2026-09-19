/**
 * teacher/teacherStore.ts — 教师视图状态（导入 → 提问 → 小测 → 批改 → 错题复习 →
 * 诊断 → 变式 → 复盘）。
 *
 * 编排层：只调用 teacher/study、review、persistence、closure、pptx 的公开接口。
 * LLM 只在步骤边界（提问、出题、诊断、变式、讲课）调用，批改是确定性纯函数。
 *
 * 关键修复：
 * - B-T-01：默认注入 `getAppProvider()`（用户配置真实供应商即走真实供应商，
 *   未配置时回退 mock 并在 UI 明示）；真实供应商的 baseUrl/model/key 从
 *   store.providerSettings 与 OS 凭据仓解析（只读，不修改 store）。
 * - B-T-02：资料/分块/题目/批改/作答/诊断默认落 SQLite（getDb 可用时），
 *   否则内存回退并在 UI 明示。
 * - B-T-03：暴露 dueReview()/review()，UI 有「开始复习」入口，闭环打通。
 * - B-T-05：导入失败重置 events。
 * - B-T-11：submit 加重入保护与幂等（同题同作答不重复入错题）。
 * - B-T-12：unverified 主观题可手动加入错题本。
 */

import { store } from '../app/store';
import { getSecret } from '../platform/credentials';
import { getDb } from '../data/db';
import { newId, nowMs } from '../data/util';
import { getAppProvider } from '../app/providerAccess';
import type { LlmProvider } from '../services/llm/provider';
import {
  DEFAULT_PROVIDER_REQUEST,
  askQuestion,
  generateQuiz,
  gradeAnswer,
  hintFor,
  importMaterial as importStudyMaterial,
  importSlideMaterial,
  type AnswerResult,
  type Chunk,
  type Citation,
  type Grading,
  type Material,
  type ProviderRequest,
  type QuizQuestion,
  type StudyEvent,
} from './study';
import { createDbStudyStore, createMemoryStudyStore, type ReviewItem, type StudyStore } from './review';
import {
  createDbTeacherStateStore,
  createMemoryTeacherStateStore,
  type AttemptRecord,
  type TeacherStateStore,
} from './persistence';
import {
  buildDiagnosisProfile,
  buildRetrospective,
  buildVariants,
  generateDiagnosis,
  retrospectiveToMarkdown,
  type DiagnosisProfile,
  type Retrospective,
} from './closure';
import type { SlideDeck } from './pptx';

export interface TeacherStore {
  /** true 表示当前 provider 是离线 mock（非真实供应商），UI 必须明示。 */
  readonly providerIsMock: boolean;
  /** true 表示状态只存内存（本次会话内有效），UI 必须明示。 */
  readonly persistenceIsMemory: boolean;
  /** 当前 provider（讲课视图等复用）。 */
  provider(): LlmProvider;
  material(): Material | null;
  chunks(): Chunk[];
  events(): StudyEvent[];
  quiz(): QuizQuestion[];
  gradings(): Record<string, Grading>;
  wrongBook(): ReviewItem[];
  /** 到期错题（复习入口）。 */
  dueReview(): ReviewItem[];
  busy(): boolean;
  lastError(): string | null;
  importMaterial(input: { name: string; text: string; license?: string }): { ok: boolean; error?: string };
  importDeck(deck: SlideDeck): { ok: boolean; error?: string };
  ask(question: string): Promise<{ ok: boolean; answer: string; citations: Citation[]; notFound: boolean; error?: string }>;
  makeQuiz(count?: number, difficulty?: 1 | 2 | 3): Promise<{ ok: boolean; generatedBy: string; count: number; error?: string }>;
  submit(questionId: string, answer: string): Grading | null;
  /** B-T-12：把题目（含 unverified 主观题）手动加入错题本。 */
  addToWrongBook(questionId: string): ReviewItem | null;
  review(itemId: string, correct: boolean): void;
  hint(questionId: string, level: number): string | null;
  runDiagnosis(count?: number): Promise<{ ok: boolean; count: number; error?: string }>;
  diagnosis(): DiagnosisProfile | null;
  makeVariants(count?: number): Promise<{ ok: boolean; count: number; error?: string }>;
  retrospective(): Retrospective | null;
  exportRetrospective(): string | null;
  eventsFor(questionId: string): StudyEvent[];
}

export interface TeacherStoreDeps {
  provider?: LlmProvider;
  studyStore?: StudyStore;
  stateStore?: TeacherStateStore;
  now?: () => number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tryDb() {
  try {
    return getDb();
  } catch {
    return null;
  }
}

export function createTeacherStore(deps: TeacherStoreDeps = {}): TeacherStore {
  const provider = deps.provider ?? getAppProvider();
  const db = deps.stateStore ? null : tryDb();
  const stateStore = deps.stateStore ?? (db ? createDbTeacherStateStore(db) : createMemoryTeacherStateStore());
  const studyStore = deps.studyStore ?? (db ? createDbStudyStore(db) : createMemoryStudyStore());
  const now = deps.now ?? nowMs;
  const persistenceIsMemory = !stateStore.persistent;

  let material: Material | null = null;
  let chunks: Chunk[] = [];
  let events: StudyEvent[] = [];
  let questions: QuizQuestion[] = [];
  let gradings: Record<string, Grading> = {};
  let diagnosisProfile: DiagnosisProfile | null = null;
  let busy = false;
  let submitting = false;
  let lastError: string | null = null;

  // 复水：重启后恢复资料/题目/批改（B-T-02）。
  try {
    const loaded = stateStore.loadMaterial();
    if (loaded) {
      material = loaded.material;
      chunks = loaded.chunks;
      questions = stateStore.loadQuestions(material.id);
      gradings = stateStore.loadGradings(material.id);
      const savedDiagnosis = stateStore.loadDiagnosis(material.id);
      if (savedDiagnosis?.payload) diagnosisProfile = savedDiagnosis.payload as DiagnosisProfile;
    }
  } catch (error) {
    lastError = `恢复教师状态失败：${messageOf(error)}`;
  }

  async function resolveRequest(): Promise<ProviderRequest> {
    if (provider.mock) return DEFAULT_PROVIDER_REQUEST;
    const settings = store.providerSettings;
    let apiKey = '';
    try {
      apiKey = (await getSecret('llmApiKey')) ?? '';
    } catch {
      apiKey = '';
    }
    return { baseUrl: settings.llmBaseUrl, model: settings.llmModel, apiKey };
  }

  function persistMaterialState(): void {
    if (!material) return;
    try {
      stateStore.saveMaterial(material, chunks);
      stateStore.saveQuestions(material.id, questions);
    } catch (error) {
      lastError = `教师状态落库失败：${messageOf(error)}`;
    }
  }

  function appendAttempt(question: QuizQuestion, grading: Grading): void {
    if (!material) return;
    const record: AttemptRecord = {
      id: newId(),
      materialId: material.id,
      questionId: question.id,
      point: question.point,
      verdict: grading.verdict,
      cause: grading.cause,
      answer: grading.answer,
      expected: grading.expected,
      at: now(),
    };
    try {
      stateStore.appendAttempt(record);
    } catch (error) {
      lastError = `作答记录落库失败：${messageOf(error)}`;
    }
  }

  function buildReport(): Retrospective | null {
    if (!material) return null;
    let attempts: AttemptRecord[] = [];
    try {
      attempts = stateStore.loadAttempts(material.id);
    } catch (error) {
      lastError = `读取作答记录失败：${messageOf(error)}`;
    }
    return buildRetrospective({
      materialId: material.id,
      materialName: material.name,
      attempts,
      reviewItems: studyStore.listAll(),
      now: now(),
    });
  }

  return {
    providerIsMock: provider.mock,
    persistenceIsMemory,
    provider: () => provider,

    material: () => material,
    chunks: () => chunks,
    events: () => events,
    quiz: () => questions,
    gradings: () => ({ ...gradings }),
    wrongBook: () => studyStore.listAll(),
    dueReview: () => studyStore.listDue(now()),
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
        diagnosisProfile = null;
        lastError = null;
        persistMaterialState();
        return { ok: true };
      } catch (error) {
        // B-T-05：导入失败必须清空事件，不能残留上一次资料的事件。
        material = null;
        chunks = [];
        events = [];
        questions = [];
        gradings = {};
        diagnosisProfile = null;
        lastError = `导入失败：${messageOf(error)}`;
        return { ok: false, error: messageOf(error) };
      }
    },

    importDeck(deck) {
      try {
        const result = importSlideMaterial({ name: deck.name, slides: deck.slides });
        material = result.material;
        chunks = result.chunks;
        events = [...deck.events, ...result.events];
        questions = [];
        gradings = {};
        diagnosisProfile = null;
        lastError = null;
        persistMaterialState();
        return { ok: true };
      } catch (error) {
        material = null;
        chunks = [];
        events = [];
        questions = [];
        gradings = {};
        diagnosisProfile = null;
        lastError = `PPT 导入失败：${messageOf(error)}`;
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
        const providerRequest = await resolveRequest();
        const result: AnswerResult = await askQuestion({
          material,
          chunks,
          question,
          provider,
          providerRequest,
        });
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

    async makeQuiz(count = 3, difficulty) {
      if (!material) {
        lastError = '请先导入资料再出题';
        return { ok: false, generatedBy: 'none', count: 0, error: 'no-material' };
      }
      busy = true;
      try {
        const providerRequest = await resolveRequest();
        const result = await generateQuiz({ material, chunks, provider, count, difficulty, providerRequest });
        questions = result.questions;
        gradings = {};
        diagnosisProfile = null;
        events = [...events, ...result.events];
        lastError = null;
        if (material) stateStore.saveQuestions(material.id, questions);
        return { ok: true, generatedBy: result.generatedBy, count: result.questions.length };
      } catch (error) {
        lastError = `出题失败：${messageOf(error)}`;
        return { ok: false, generatedBy: 'none', count: 0, error: messageOf(error) };
      } finally {
        busy = false;
      }
    },

    submit(questionId, answer) {
      if (submitting) return gradings[questionId] ?? null; // B-T-11 重入保护
      const question = questions.find((item) => item.id === questionId);
      if (!question) return null;
      // B-T-11 幂等：同题同作答不重复批改/重复入错题（双击提交只记一次）。
      const existing = gradings[questionId];
      if (existing && existing.answer === answer) return existing;
      submitting = true;
      try {
        const grading = gradeAnswer(question, answer);
        gradings = { ...gradings, [questionId]: grading };
        if (material) stateStore.saveGrading(material.id, grading);
        appendAttempt(question, grading);
        if (grading.verdict === 'incorrect') {
          const item = studyStore.addWrong(question, grading, now());
          events = [
            ...events,
            { type: 'grading.completed', at: now(), traceId: questionId, detail: { verdict: grading.verdict, cause: grading.cause } },
            { type: 'review.scheduled', at: now(), traceId: item.id, detail: { dueAt: item.dueAt } },
          ];
        } else {
          events = [
            ...events,
            { type: 'grading.completed', at: now(), traceId: questionId, detail: { verdict: grading.verdict, cause: grading.cause } },
          ];
        }
        return grading;
      } finally {
        submitting = false;
      }
    },

    addToWrongBook(questionId) {
      const question = questions.find((item) => item.id === questionId);
      if (!question) return null;
      const grading =
        gradings[questionId] ??
        gradeAnswer(question, question.answer); // 兜底：按正确答案批改（correct），仅作占位证据
      const item = studyStore.addWrong(question, grading, now());
      events = [
        ...events,
        {
          type: 'review.scheduled',
          at: now(),
          traceId: item.id,
          detail: { dueAt: item.dueAt, manual: true, verdict: grading.verdict },
        },
      ];
      return item;
    },

    review(itemId, correct) {
      const item = studyStore.answer(itemId, correct, now());
      if (item) {
        events = [...events, { type: 'review.scheduled', at: now(), traceId: item.id, detail: { dueAt: item.dueAt } }];
      }
    },

    hint(questionId, level) {
      const question = questions.find((item) => item.id === questionId);
      return question ? hintFor(question, level) : null;
    },

    async runDiagnosis(count) {
      if (!material) {
        lastError = '请先导入资料再做诊断';
        return { ok: false, count: 0, error: 'no-material' };
      }
      busy = true;
      try {
        const providerRequest = await resolveRequest();
        const result = await generateDiagnosis({ material, chunks, provider, count, providerRequest });
        questions = result.questions;
        gradings = {};
        diagnosisProfile = null;
        events = [...events, ...result.events];
        lastError = null;
        stateStore.saveQuestions(material.id, questions);
        return { ok: true, count: result.questions.length };
      } catch (error) {
        lastError = `诊断出题失败：${messageOf(error)}`;
        return { ok: false, count: 0, error: messageOf(error) };
      } finally {
        busy = false;
      }
    },

    diagnosis() {
      if (!material) return null;
      const profile = buildDiagnosisProfile({
        materialId: material.id,
        questions,
        gradings,
        at: now(),
      });
      diagnosisProfile = profile;
      try {
        stateStore.saveDiagnosis(material.id, profile, profile.at);
      } catch (error) {
        lastError = `诊断画像落库失败：${messageOf(error)}`;
      }
      return profile;
    },

    async makeVariants(count) {
      if (!material) {
        lastError = '请先导入资料再生成变式';
        return { ok: false, count: 0, error: 'no-material' };
      }
      busy = true;
      try {
        const providerRequest = await resolveRequest();
        const variants = await buildVariants({
          material,
          chunks,
          wrongItems: studyStore.listAll(),
          provider,
          count,
          providerRequest,
        });
        if (variants.length === 0) {
          lastError = '暂无错题，无法生成变式';
          return { ok: false, count: 0, error: 'no-wrong-items' };
        }
        questions = [...questions, ...variants];
        lastError = null;
        stateStore.saveQuestions(material.id, questions);
        return { ok: true, count: variants.length };
      } catch (error) {
        lastError = `变式生成失败：${messageOf(error)}`;
        return { ok: false, count: 0, error: messageOf(error) };
      } finally {
        busy = false;
      }
    },

    retrospective() {
      return buildReport();
    },

    exportRetrospective() {
      const report = buildReport();
      return report ? retrospectiveToMarkdown(report) : null;
    },

    eventsFor(questionId) {
      return events.filter((event) => event.traceId === questionId);
    },
  };
}
