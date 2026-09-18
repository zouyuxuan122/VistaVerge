// @vitest-environment jsdom
// EXP-006 TeacherView 测试：导入 → 提问（带锚点）→ 小测 → 批改证据 → 错题本。
// 组件 props 注入 store，不假定 App 结构，可独立挂载。
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMockProvider } from '../../src/services/llm/provider';
import { TeacherView } from '../../src/teacher/views/teacherView';
import { createTeacherStore } from '../../src/teacher/teacherStore';
import { createMemoryStudyStore } from '../../src/teacher/review';

const MATERIAL_TEXT = [
  '# 光合作用',
  '',
  '光合作用把光能转化为化学能。',
  '叶绿体是光合作用发生的场所。',
  '',
  '## 呼吸作用',
  '呼吸作用在细胞的线粒体中进行，释放能量。',
  '有机物在氧气参与下被分解。',
].join('\n');

function setup() {
  const store = createTeacherStore({
    provider: createMockProvider(),
    studyStore: createMemoryStudyStore(),
    now: () => 1_700_000_000_000,
  });
  const wrapper = mount(TeacherView, { props: { store } });
  return { store, wrapper };
}

async function importMaterial(wrapper: ReturnType<typeof setup>['wrapper']): Promise<void> {
  await wrapper.find('[data-test="teacher-material-name"]').setValue('生物笔记.md');
  await wrapper.find('[data-test="teacher-material-text"]').setValue(MATERIAL_TEXT);
  await wrapper.find('[data-test="teacher-import"]').trigger('click');
  await flushPromises();
}

describe('TeacherView 学习闭环', () => {
  it('导入资料后显示片段数，mock 供应商明示为离线演示', async () => {
    const { wrapper } = setup();
    expect(wrapper.find('[data-test="teacher-provider-badge"]').text()).toMatch(/MOCK|离线/);
    await importMaterial(wrapper);
    const info = wrapper.find('[data-test="teacher-material-info"]');
    expect(info.text()).toContain('生物笔记.md');
    expect(info.text()).toMatch(/\d+\s*个片段/);
  });

  it('空资料导入显示错误，不产生片段', async () => {
    const { wrapper } = setup();
    await wrapper.find('[data-test="teacher-import"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="teacher-error"]').text().length).toBeGreaterThan(0);
    expect(wrapper.find('[data-test="teacher-material-info"]').exists()).toBe(false);
  });

  it('提问命中资料给出带锚点回答；无依据时明确未找到', async () => {
    const { wrapper } = setup();
    await importMaterial(wrapper);

    await wrapper.find('[data-test="teacher-question-input"]').setValue('叶绿体是做什么的');
    await wrapper.find('[data-test="teacher-ask"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="teacher-answer"]').text()).toContain('[MOCK]');
    const citations = wrapper.findAll('[data-test="teacher-citation"]');
    expect(citations.length).toBeGreaterThan(0);
    expect(citations[0]!.text()).toMatch(/#L\d+-L\d+/);

    await wrapper.find('[data-test="teacher-question-input"]').setValue('量子纠缠是什么');
    await wrapper.find('[data-test="teacher-ask"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="teacher-answer"]').text()).toContain('资料中未找到');
    expect(wrapper.findAll('[data-test="teacher-citation"]')).toHaveLength(0);
  });

  it('小测 → 批改给证据 → 错题入本；答对不入错题本', async () => {
    const { store, wrapper } = setup();
    await importMaterial(wrapper);

    await wrapper.find('[data-test="teacher-make-quiz"]').trigger('click');
    await flushPromises();
    const rows = wrapper.findAll('[data-test="teacher-question"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(store.quiz().length).toBe(rows.length);

    const questions = store.quiz();
    const inputs = wrapper.findAll('[data-test="teacher-answer-input"]');
    const submits = wrapper.findAll('[data-test="teacher-submit"]');

    // 第 1 题故意答错
    await inputs[0]!.setValue('完全不相干的答案');
    await submits[0]!.trigger('click');
    await flushPromises();
    const grading = wrapper.findAll('[data-test="teacher-grading"]')[0]!;
    expect(grading.text()).toContain('错误');
    expect(grading.find('[data-test="teacher-evidence"]').text().length).toBeGreaterThan(0);
    expect(wrapper.findAll('[data-test="teacher-wrongbook-item"]')).toHaveLength(1);

    // 第 2 题答对（若只有一题则跳过）
    if (questions.length > 1) {
      await inputs[1]!.setValue(questions[1]!.answer);
      await submits[1]!.trigger('click');
      await flushPromises();
      const second = wrapper.findAll('[data-test="teacher-grading"]')[1]!;
      expect(second.text()).toContain('正确');
      expect(wrapper.findAll('[data-test="teacher-wrongbook-item"]')).toHaveLength(1);
    }

    // 错题本显示下次复习时间
    const wrong = wrapper.find('[data-test="teacher-wrongbook-item"]');
    expect(wrong.text()).toMatch(/复习|due|间隔/);
  });
});
