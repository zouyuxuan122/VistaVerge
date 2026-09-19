/**
 * teacher/views/teacherView.ts — 教师面板（分区布局，P2 步骤 9）。
 *
 * 分区：资料库（txt/md/pptx 导入 + 粘贴）/ 讲课（LectureView）/ 问答 / 小测 /
 * 错题复习（开始复习入口）/ 诊断 / 复盘。引用锚点可点击定位（问答引用跳到资料
 * 原文位置；PPT 引用跳对应页）。口语评分无评测器时诚实显示「未评测」。
 *
 * 依赖经 props 注入，可独立挂载测试；`src/ui/TeacherView.vue` 为同名 SFC 薄包装。
 * 既有 data-test 选择器保持不变（teacher-ui.test.ts 回归门）。
 */

import { computed, defineComponent, h, onBeforeUnmount, reactive, ref, type PropType, type VNodeChild } from 'vue';
import { createTeacherStore, type TeacherStore } from '../teacherStore';
import { GRADING_CAUSE_LABELS } from '../study';
import { createLectureController } from '../lecture';
import type { SlideDeck } from '../pptx';
import LectureView from '../../ui/teacher/LectureView.vue';
import { lectureSpeaker } from '../../app/lectureSpeech';

export const TeacherView = defineComponent({
  name: 'TeacherView',
  props: {
    store: { type: Object as PropType<TeacherStore>, default: undefined },
  },
  setup(props) {
    const store = props.store ?? createTeacherStore();
    // 讲稿旁白：lectureSpeech 把流式讲稿分句送 TTS 播报（无 TTS 配置时字幕兜底）
    const lecture = createLectureController({
      provider: store.provider(),
      speak: (text, meta) => lectureSpeaker.speak(text, meta),
    });
    // 暂停/关闭时同步停掉旁白队列，不让旧音频追着新状态跑
    //（finished 不停：最后一页讲稿刚收尾，让播报队列自然播完）
    lecture.subscribe(() => {
      const s = lecture.state();
      if (s === 'paused' || s === 'idle') lectureSpeaker.stop();
    });
    onBeforeUnmount(() => lectureSpeaker.stop());

    const name = ref('');
    const text = ref('');
    const error = ref<string | null>(null);
    const info = ref<{ name: string; chunks: number; lines: number } | null>(null);
    const question = ref('');
    const answer = ref('');
    const citations = ref<{ anchor: string; quote: string; page?: number }[]>([]);
    const jumpInfo = ref<string | null>(null);
    const questions = ref(store.quiz());
    const gradings = ref(store.gradings());
    const wrongItems = ref(store.wrongBook());
    const dueItems = ref(store.dueReview());
    const drafts = reactive<Record<string, string>>({});
    const hints = reactive<Record<string, { level: number; text: string }>>({});
    const diagnosisText = ref<string | null>(null);
    const retrospectiveText = ref<string | null>(null);
    const busy = ref(false);

    function sync(): void {
      const material = store.material();
      info.value = material
        ? { name: material.name, chunks: store.chunks().length, lines: material.lineCount }
        : null;
      error.value = store.lastError();
      questions.value = store.quiz();
      gradings.value = store.gradings();
      wrongItems.value = store.wrongBook();
      dueItems.value = store.dueReview();
    }

    function doImport(): void {
      store.importMaterial({ name: name.value, text: text.value });
      answer.value = '';
      citations.value = [];
      sync();
    }

    function onDeckOpened(deck: SlideDeck): void {
      lectureSpeaker.stop(); // 换课件立即停掉上一门课的旁白
      store.importDeck(deck);
      answer.value = '';
      citations.value = [];
      sync();
    }

    async function doAsk(): Promise<void> {
      const result = await store.ask(question.value);
      answer.value = result.ok ? result.answer : `（提问失败：${result.error ?? '未知错误'}）`;
      citations.value = result.citations.map((citation) => ({
        anchor: citation.anchor,
        quote: citation.quote,
        page: citation.page,
      }));
      jumpInfo.value = null;
      sync();
    }

    /** 引用点击定位：PPT 跳对应页；文本资料显示对应行区间原文。 */
    function jumpToCitation(citation: { anchor: string; page?: number }): void {
      if (citation.page !== undefined) {
        lecture.goto(citation.page);
        jumpInfo.value = `已跳到幻灯片 第${citation.page}页`;
        return;
      }
      const material = store.material();
      if (!material) return;
      const chunk = store.chunks().find((item) => item.anchor === citation.anchor);
      if (!chunk) {
        jumpInfo.value = `未找到锚点 ${citation.anchor}`;
        return;
      }
      const lines = material.text.split('\n');
      const excerpt = lines.slice(chunk.startLine - 1, chunk.endLine).join('\n');
      jumpInfo.value = `${citation.anchor}：${excerpt.slice(0, 160)}`;
    }

    async function doQuiz(): Promise<void> {
      busy.value = true;
      try {
        await store.makeQuiz(3);
      } finally {
        busy.value = false;
        sync();
      }
    }

    function doSubmit(questionId: string): void {
      store.submit(questionId, drafts[questionId] ?? '');
      sync();
    }

    function showHint(questionId: string): void {
      const current = hints[questionId]?.level ?? 0;
      const next = Math.min(current + 1, 3);
      const hint = store.hint(questionId, next);
      if (hint) hints[questionId] = { level: next, text: hint };
    }

    function addUnverifiedToWrongBook(questionId: string): void {
      store.addToWrongBook(questionId);
      sync();
    }

    function doReview(itemId: string, correct: boolean): void {
      store.review(itemId, correct);
      sync();
    }

    async function doDiagnosis(): Promise<void> {
      busy.value = true;
      try {
        const result = await store.runDiagnosis(3);
        if (result.ok) {
          const profile = store.diagnosis();
          diagnosisText.value = profile
            ? `总体掌握度 ${Math.round(profile.overall * 100)}%；` +
              (profile.points.length === 0
                ? '暂无有效判定（先作答诊断题）'
                : profile.points.map((point) => `${point.point} ${Math.round(point.mastery * 100)}%`).join('；'))
            : null;
        }
      } finally {
        busy.value = false;
        sync();
      }
    }

    async function doVariants(): Promise<void> {
      busy.value = true;
      try {
        await store.makeVariants(2);
      } finally {
        busy.value = false;
        sync();
      }
    }

    function doRetrospective(): void {
      const report = store.retrospective();
      if (!report) {
        retrospectiveText.value = null;
        return;
      }
      const observed = report.observed;
      retrospectiveText.value =
        `观测事实：作答 ${observed.attempts} 次（正确 ${observed.correct} / 错误 ${observed.incorrect} / 待验证 ${observed.unverified}）` +
        `，正确率 ${observed.accuracy === null ? '无有效判定' : `${Math.round(observed.accuracy * 100)}%`}` +
        `；到期错题 ${observed.dueReviewCount}；错因分布 ${observed.causes.map((cause) => `${cause.label} ${cause.count}`).join('、') || '无'}。` +
        `\n推测建议：${report.suggestions.join(' ') || '无'}`;
    }

    function exportReport(): void {
      const markdown = store.exportRetrospective();
      if (!markdown) return;
      retrospectiveText.value = markdown;
      try {
        const blob = new Blob([markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `学习复盘-${store.material()?.name ?? '资料'}.md`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch {
        /* 无下载能力时仅展示 markdown 文本 */
      }
    }

    const verdictLabel: Record<string, string> = { correct: '正确', incorrect: '错误', unverified: '待验证' };

    const providerBadge = computed(() =>
      store.providerIsMock ? '离线 mock 供应商（非真实供应商，仅演示接线）' : '已配置供应商',
    );
    const persistenceBadge = computed(() =>
      store.persistenceIsMemory ? '状态仅本次会话（内存）' : '状态已落本地数据库',
    );

    function section(title: string, children: VNodeChild[]): VNodeChild {
      return h('section', { class: 'teacher-section' }, [
        h('h3', { class: 'teacher-section-title' }, title),
        ...children,
      ]);
    }

    return () =>
      h('section', { 'data-test': 'teacher-view', class: 'teacher-view' }, [
        h('div', { class: 'teacher-badges' }, [
          h('p', { 'data-test': 'teacher-provider-badge', class: 'teacher-provider-badge' }, providerBadge.value),
          h('p', { 'data-test': 'teacher-persistence-badge', class: 'teacher-persistence-badge' }, persistenceBadge.value),
        ]),

        section('资料库', [
          h('div', { class: 'teacher-import' }, [
            h('input', {
              'data-test': 'teacher-material-name',
              class: 'teacher-material-name',
              value: name.value,
              placeholder: '资料名（如 生物笔记.md）',
              onInput: (event: Event) => {
                name.value = (event.target as HTMLInputElement).value;
              },
            }),
            h('textarea', {
              'data-test': 'teacher-material-text',
              class: 'teacher-material-text',
              value: text.value,
              rows: 4,
              placeholder: '粘贴 txt / md 资料内容，或在下方「讲课」打开 .pptx',
              onInput: (event: Event) => {
                text.value = (event.target as HTMLTextAreaElement).value;
              },
            }),
            h('button', { 'data-test': 'teacher-import', onClick: doImport }, '导入资料'),
          ]),
          error.value ? h('p', { 'data-test': 'teacher-error', class: 'teacher-error' }, error.value) : null,
          info.value
            ? h(
                'p',
                { 'data-test': 'teacher-material-info', class: 'teacher-material-info' },
                `${info.value.name} · ${info.value.chunks} 个片段 · ${info.value.lines} 行（解析文本按不可信数据处理）`,
              )
            : null,
        ]),

        section('讲课（PPT）', [
          h(LectureView, { controller: lecture, onDeckOpened }),
        ]),

        section('问答', [
          h('div', { class: 'teacher-ask' }, [
            h('input', {
              'data-test': 'teacher-question-input',
              class: 'teacher-question-input',
              value: question.value,
              placeholder: '就资料提问（回答会带行锚点）',
              onInput: (event: Event) => {
                question.value = (event.target as HTMLInputElement).value;
              },
            }),
            h('button', { 'data-test': 'teacher-ask', onClick: doAsk }, '提问'),
          ]),
          answer.value
            ? h('div', { class: 'teacher-answer-block' }, [
                h('p', { 'data-test': 'teacher-answer', class: 'teacher-answer' }, answer.value),
                h(
                  'ul',
                  { class: 'teacher-citations' },
                  citations.value.map((citation) =>
                    h(
                      'li',
                      {
                        'data-test': 'teacher-citation',
                        class: 'teacher-citation',
                        onClick: () => jumpToCitation(citation),
                      },
                      `[${citation.anchor}] ${citation.quote}`,
                    ),
                  ),
                ),
              ])
            : null,
          jumpInfo.value ? h('p', { class: 'teacher-jump', 'data-test': 'teacher-jump' }, jumpInfo.value) : null,
        ]),

        section('小测', [
          h('div', { class: 'teacher-quiz-bar' }, [
            h('button', { 'data-test': 'teacher-make-quiz', onClick: doQuiz, disabled: busy.value }, '生成小测'),
            h('button', { 'data-test': 'teacher-diagnosis', onClick: doDiagnosis, disabled: busy.value }, '开始诊断'),
            h('button', { 'data-test': 'teacher-variants', onClick: doVariants, disabled: busy.value }, '生成变式'),
          ]),
          h(
            'ol',
            { class: 'teacher-questions' },
            questions.value.map((item) => {
              const grading = gradings.value[item.id];
              const hint = hints[item.id];
              return h('li', { 'data-test': 'teacher-question', class: 'teacher-question' }, [
                h('p', { 'data-test': 'teacher-question-prompt' }, `${item.prompt}（${item.point} · 难度${item.difficulty} · ${item.anchor}）`),
                h('input', {
                  'data-test': 'teacher-answer-input',
                  class: 'teacher-answer-input',
                  value: drafts[item.id] ?? '',
                  placeholder: item.type === 'single_choice' ? '填写选项字母或原文' : '填写答案',
                  onInput: (event: Event) => {
                    drafts[item.id] = (event.target as HTMLInputElement).value;
                  },
                }),
                h('button', { 'data-test': 'teacher-submit', onClick: () => doSubmit(item.id) }, '提交批改'),
                h('button', { 'data-test': 'teacher-hint', class: 'teacher-hint-btn', onClick: () => showHint(item.id) }, '提示'),
                grading && grading.verdict === 'unverified'
                  ? h(
                      'button',
                      {
                        'data-test': 'teacher-add-wrong',
                        class: 'teacher-add-wrong',
                        onClick: () => addUnverifiedToWrongBook(item.id),
                      },
                      '加入错题',
                    )
                  : null,
                hint ? h('p', { 'data-test': 'teacher-hint-text', class: 'teacher-hint-text' }, hint.text) : null,
                grading
                  ? h('div', { 'data-test': 'teacher-grading', class: 'teacher-grading' }, [
                      h('span', { 'data-test': 'teacher-verdict' }, verdictLabel[grading.verdict] ?? grading.verdict),
                      h(
                        'span',
                        { 'data-test': 'teacher-evidence', class: 'teacher-evidence' },
                        `依据：${grading.evidence.map((evidence) => `${evidence.rule}｜${evidence.detail}`).join('；')}`,
                      ),
                      h('span', { 'data-test': 'teacher-cause', class: 'teacher-cause' }, `错因：${GRADING_CAUSE_LABELS[grading.cause]}`),
                      h('span', { class: 'teacher-validator' }, `（验证器 ${grading.validatorId}）`),
                    ])
                  : null,
              ]);
            }),
          ),
        ]),

        section('错题复习', [
          dueItems.value.length > 0
            ? h('div', { class: 'teacher-review-due', 'data-test': 'teacher-review-due' }, [
                h('p', { class: 'teacher-review-title' }, `到期错题 ${dueItems.value.length} 道`),
                ...dueItems.value.map((item) =>
                  h('div', { class: 'teacher-review-row', 'data-test': 'teacher-review-row' }, [
                    h('span', {}, `${item.prompt}（错 ${item.wrongCount} 次）`),
                    h('button', { 'data-test': 'teacher-review-remember', onClick: () => doReview(item.id, true) }, '记得'),
                    h('button', { 'data-test': 'teacher-review-forget', onClick: () => doReview(item.id, false) }, '忘了'),
                  ]),
                ),
              ])
            : h('p', { class: 'teacher-review-empty', 'data-test': 'teacher-review-empty' }, '暂无到期错题'),
          h(
            'ul',
            { class: 'teacher-wrongbook' },
            wrongItems.value.map((item) =>
              h('li', { 'data-test': 'teacher-wrongbook-item', class: 'teacher-wrongbook-item' }, [
                h('span', {}, `${item.prompt}（错 ${item.wrongCount} 次）`),
                h('span', { class: 'teacher-wrongbook-due' }, ` 下次复习：${new Date(item.dueAt).toISOString()}（间隔 ${item.intervalDays} 天）`),
              ]),
            ),
          ),
        ]),

        section('诊断与复盘', [
          h('div', { class: 'teacher-report-bar' }, [
            h('button', { 'data-test': 'teacher-report', onClick: doRetrospective }, '生成复盘'),
            h('button', { 'data-test': 'teacher-report-export', onClick: exportReport }, '导出 markdown'),
          ]),
          diagnosisText.value ? h('p', { 'data-test': 'teacher-diagnosis-text', class: 'teacher-diagnosis-text' }, diagnosisText.value) : null,
          retrospectiveText.value
            ? h('pre', { 'data-test': 'teacher-retrospective', class: 'teacher-retrospective' }, retrospectiveText.value)
            : null,
        ]),

        section('口语评分', [
          h(
            'p',
            { 'data-test': 'teacher-speaking', class: 'teacher-speaking' },
            '口语评分：未评测（本版本未接入评测器，不伪造分数）',
          ),
        ]),
      ]);
  },
});

export default TeacherView;
