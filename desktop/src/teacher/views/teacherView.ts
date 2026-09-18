/**
 * teacher/views/teacherView.ts — 教师面板（可挂载组件实现）。
 *
 * 需求（EXP-006 步骤 4）：导入 → 提问（回答带锚点）→ 小测 → 批改证据 → 错题本。
 * 依赖经 props 注入，可独立挂载测试；`src/ui/TeacherView.vue` 为同名 SFC 薄包装。
 */

import { computed, defineComponent, h, reactive, ref, type PropType } from 'vue';
import { createTeacherStore, type TeacherStore } from '../teacherStore';

export const TeacherView = defineComponent({
  name: 'TeacherView',
  props: {
    store: { type: Object as PropType<TeacherStore>, default: undefined },
  },
  setup(props) {
    const store = props.store ?? createTeacherStore();

    const name = ref('');
    const text = ref('');
    const error = ref<string | null>(null);
    const info = ref<{ name: string; chunks: number; lines: number } | null>(null);
    const question = ref('');
    const answer = ref('');
    const citations = ref<{ anchor: string; quote: string }[]>([]);
    const questions = ref(store.quiz());
    const gradings = ref(store.gradings());
    const wrongItems = ref(store.wrongBook());
    const drafts = reactive<Record<string, string>>({});

    function sync(): void {
      const material = store.material();
      info.value = material
        ? { name: material.name, chunks: store.chunks().length, lines: material.lineCount }
        : null;
      error.value = store.lastError();
      questions.value = store.quiz();
      gradings.value = store.gradings();
      wrongItems.value = store.wrongBook();
    }

    function doImport(): void {
      store.importMaterial({ name: name.value, text: text.value });
      answer.value = '';
      citations.value = [];
      sync();
    }

    async function doAsk(): Promise<void> {
      const result = await store.ask(question.value);
      answer.value = result.ok ? result.answer : `（提问失败：${result.error ?? '未知错误'}）`;
      citations.value = result.citations.map((citation) => ({ anchor: citation.anchor, quote: citation.quote }));
      sync();
    }

    async function doQuiz(): Promise<void> {
      await store.makeQuiz(3);
      sync();
    }

    function doSubmit(questionId: string): void {
      store.submit(questionId, drafts[questionId] ?? '');
      sync();
    }

    const verdictLabel: Record<string, string> = { correct: '正确', incorrect: '错误', unverified: '待验证' };

    const providerBadge = computed(() =>
      store.providerIsMock ? '离线 mock 供应商（非真实供应商，仅演示接线）' : '已配置供应商',
    );

    return () =>
      h('section', { 'data-test': 'teacher-view', class: 'teacher-view' }, [
        h('p', { 'data-test': 'teacher-provider-badge', class: 'teacher-provider-badge' }, providerBadge.value),

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
            placeholder: '粘贴 txt / md 资料内容',
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
                  h('li', { 'data-test': 'teacher-citation', class: 'teacher-citation' }, `[${citation.anchor}] ${citation.quote}`),
                ),
              ),
            ])
          : null,

        h('div', { class: 'teacher-quiz-bar' }, [
          h('button', { 'data-test': 'teacher-make-quiz', onClick: doQuiz }, '生成小测'),
        ]),
        h(
          'ol',
          { class: 'teacher-questions' },
          questions.value.map((item) => {
            const grading = gradings.value[item.id];
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
              grading
                ? h('div', { 'data-test': 'teacher-grading', class: 'teacher-grading' }, [
                    h('span', { 'data-test': 'teacher-verdict' }, verdictLabel[grading.verdict] ?? grading.verdict),
                    h(
                      'span',
                      { 'data-test': 'teacher-evidence', class: 'teacher-evidence' },
                      `依据：${grading.evidence.map((evidence) => `${evidence.rule}｜${evidence.detail}`).join('；')}`,
                    ),
                    h('span', { class: 'teacher-validator' }, `（验证器 ${grading.validatorId}）`),
                  ])
                : null,
            ]);
          }),
        ),

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
      ]);
  },
});

export default TeacherView;
