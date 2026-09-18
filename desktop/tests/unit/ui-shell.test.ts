// @vitest-environment jsdom
// EXP-005 组件行为测试：导航、主题、IME、演示光标边界（不触数据库）
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import NavPill from '../../src/ui/NavPill.vue';
import ThemeSwitch from '../../src/ui/ThemeSwitch.vue';
import ChatView from '../../src/ui/ChatView.vue';
import WorkspaceView from '../../src/ui/WorkspaceView.vue';
import DeskLaptop from '../../src/ui/DeskLaptop.vue';
import { store, setTheme } from '../../src/app/store';

describe('导航与主题', () => {
  it('胶囊导航渲染五个入口并标记当前项，方向键切换', async () => {
    const wrapper = mount(NavPill, { props: { current: 'chat' } });
    const buttons = wrapper.findAll('button');
    expect(buttons.map((b) => b.text())).toEqual(['💬对话', '📖学习', '🛠任务', '🧩插件', '⚙设置']);
    expect(buttons[0].attributes('aria-current')).toBe('page');
    await wrapper.trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('select')?.[0]).toEqual(['study']);
  });

  it('主题切换写入 html[data-theme] 且会话消息不受影响', async () => {
    const wrapper = mount(ThemeSwitch, { props: { modelValue: 'realistic' } });
    await wrapper.findAll('button')[1].trigger('click');
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['handdrawn']);
    setTheme('handdrawn');
    expect(document.documentElement.dataset.theme).toBe('handdrawn');
    expect(Array.isArray(store.messages)).toBe(true);
    setTheme('realistic');
    expect(document.documentElement.dataset.theme).toBe('realistic');
  });

  it('输入法组合期间 Enter 不发送', async () => {
    const wrapper = mount(ChatView);
    const before = store.messages.length;
    const textarea = wrapper.find('textarea');
    await textarea.setValue('拼音中');
    await textarea.trigger('compositionstart');
    await textarea.trigger('keydown', { key: 'Enter' });
    expect(store.messages.length).toBe(before);
    await textarea.trigger('compositionend');
  });
});

describe('桌面笔记本道具', () => {
  it('无 WebGL 时回退 CSS 版（盖背对我们+Logo 灯），并随场景状态切换，装饰层不抢交互', async () => {
    const wrapper = mount(DeskLaptop);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.css-lid').exists()).toBe(true); // jsdom 无 WebGL → 回退
    expect(wrapper.find('.css-logo').exists()).toBe(true);
    expect(wrapper.find('.laptop-credit').text()).toContain('CC-BY');
    expect(wrapper.attributes('aria-hidden')).toBe('true');
    expect(wrapper.classes()).toContain('is-idle');

    store.sceneState = 'working';
    await wrapper.vm.$nextTick();
    expect(wrapper.classes()).toContain('is-working');
    store.sceneState = 'speaking';
    await wrapper.vm.$nextTick();
    expect(wrapper.classes()).toContain('is-speaking');
    store.sceneState = 'idle';
    await wrapper.vm.$nextTick();
    expect(wrapper.classes()).toContain('is-idle');
  });
});

describe('演示工作区', () => {
  it('虚拟光标始终限制在演示面内且记录 surface/frame 事件', async () => {
    vi.useFakeTimers();
    const wrapper = mount(WorkspaceView);
    await wrapper.find('button').trigger('click');
    await vi.advanceTimersByTimeAsync(4000);
    const style = wrapper.find('.virtual-cursor').attributes('style') ?? '';
    const left = Number(/left:\s*(\d+)px/.exec(style)?.[1] ?? '0');
    const top = Number(/top:\s*(\d+)px/.exec(style)?.[1] ?? '0');
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(800);
    expect(top).toBeLessThanOrEqual(320);
    const log = wrapper.find('.ws-log').text();
    expect(log).toContain('demo-surface-1');
    expect(log).toContain('未触碰本机鼠标');
    vi.useRealTimers();
  });
});
