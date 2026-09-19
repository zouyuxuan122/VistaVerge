// @vitest-environment jsdom
// F1-ASSIST 组件测试：AssistantView（GitHub 巡检卡 + 社媒草稿卡）。
// 依赖经 props 注入真实服务 + 假 fetch/内存存储，组件可独立挂载（不依赖 App 结构）。
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AssistantView from '../../src/ui/AssistantView.vue';
import {
  createGhPatrolService,
  type HttpResponseLike,
  type PatrolFetchLike,
} from '../../src/assistant/ghPatrol';
import { createSocialDraftService } from '../../src/assistant/socialDraft';
import type { StorageLike } from '../../src/assistant/localStore';

const NOW = 1_756_000_000_000;
const REPO = 'octocat/Hello-World';

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function res(status: number, body: unknown): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const okFetch: PatrolFetchLike = async (url) =>
  url.includes('/pulls')
    ? res(200, [
        { number: 1, title: '修一个 bug', user: { login: 'octocat' }, updated_at: '2026-09-19T00:00:00Z', draft: false, labels: [{ name: 'bug' }], html_url: 'u1' },
        { number: 2, title: '草稿 PR', user: { login: 'hubber' }, updated_at: '2026-09-19T01:00:00Z', draft: true, labels: [], html_url: 'u2' },
      ])
    : res(200, [
        { number: 7, title: '有个问题', user: { login: 'octocat' }, updated_at: '2026-09-19T02:00:00Z', labels: [], html_url: 'u3' },
      ]);

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makePatrol(options: { token?: string | null; fetch?: PatrolFetchLike } = {}) {
  return createGhPatrolService({
    fetch: options.fetch ?? okFetch,
    getToken: async () => (options.token === undefined ? 'ghp_secret' : options.token),
    now: () => NOW,
    storage: memStorage(),
  });
}

describe('AssistantView · GitHub 巡检卡', () => {
  it('只显示凭据「已配置/未配置」，不回显 token 明文', async () => {
    const wrapper = mount(AssistantView, {
      props: { patrol: makePatrol(), drafts: createSocialDraftService({ storage: memStorage() }) },
    });
    await waitFor(() => wrapper.get('[data-testid="gh-token-state"]').text().includes('已配置'));
    expect(wrapper.get('[data-testid="gh-token-state"]').text()).toContain('不回显');
    expect(wrapper.text()).not.toContain('ghp_secret');
    expect(wrapper.find('[data-testid="gh-empty"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('未配置 token 时如实显示「未配置」', async () => {
    const wrapper = mount(AssistantView, {
      props: { patrol: makePatrol({ token: null }), drafts: createSocialDraftService({ storage: memStorage() }) },
    });
    await waitFor(() => wrapper.get('[data-testid="gh-token-state"]').text().includes('未配置'));
    wrapper.unmount();
  });

  it('保存仓库 → 立即巡检 → 摘要与条目列表渲染；定时默认未运行', async () => {
    const patrol = makePatrol();
    const wrapper = mount(AssistantView, {
      props: { patrol, drafts: createSocialDraftService({ storage: memStorage() }) },
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="gh-schedule-state"]').text()).toContain('定时未运行');

    await wrapper.get('[data-testid="gh-repos-input"]').setValue(REPO);
    await wrapper.get('[data-testid="gh-save-repos"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="gh-config-note"]').text()).toContain('已保存 1 个仓库');
    expect(wrapper.get('[data-testid="gh-repo-count"]').text()).toContain('1 个仓库');

    await wrapper.get('[data-testid="gh-run"]').trigger('click');
    await waitFor(() => wrapper.find('[data-testid="gh-summary"]').exists());
    expect(wrapper.get('[data-testid="gh-summary"]').text()).toContain('GitHub 巡检');
    expect(wrapper.get('[data-testid="gh-summary"]').text()).toContain('待评审 1');
    expect(wrapper.get('[data-testid="gh-repo-status"]').text()).toContain('正常');
    expect(wrapper.findAll('[data-testid="gh-item"]')).toHaveLength(3);
    expect(wrapper.text()).toContain('修一个 bug');
    expect(wrapper.text()).toContain('草稿');
    expect(wrapper.get('[data-testid="gh-repo-count"]').text()).toContain('1 个仓库');
    wrapper.unmount();
  });

  it('非法仓库输入被如实提示且被忽略', async () => {
    const wrapper = mount(AssistantView, {
      props: { patrol: makePatrol(), drafts: createSocialDraftService({ storage: memStorage() }) },
    });
    await wrapper.get('[data-testid="gh-repos-input"]').setValue('octocat/Hello-World\nnot-a-repo');
    await wrapper.get('[data-testid="gh-save-repos"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="gh-config-note"]').text()).toContain('not-a-repo');
    expect(wrapper.get('[data-testid="gh-repo-count"]').text()).toContain('1 个仓库');
    wrapper.unmount();
  });

  it('定时开关：无仓库时不创建定时器（如实显示未运行），配置仓库后开启才运行', async () => {
    const patrol = makePatrol();
    const wrapper = mount(AssistantView, {
      props: { patrol, drafts: createSocialDraftService({ storage: memStorage() }) },
    });
    const toggle = wrapper.get('[data-testid="gh-schedule-toggle"]');
    await toggle.setValue(true);
    await flushPromises();
    expect(wrapper.get('[data-testid="gh-schedule-state"]').text()).toContain('定时未运行');

    await wrapper.get('[data-testid="gh-repos-input"]').setValue(REPO);
    await wrapper.get('[data-testid="gh-save-repos"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="gh-schedule-state"]').text()).toContain('定时运行中');
    wrapper.unmount();
    // 注入的服务归调用方管理：测试自行收尾定时器
    patrol.dispose();
    expect(patrol.scheduledActive()).toBe(false);
  });

  it('离线时摘要如实报「离线/未取得数据」，不显示编造条目', async () => {
    const failing: PatrolFetchLike = async () => {
      throw new Error('network down');
    };
    const patrol = createGhPatrolService({
      fetch: failing,
      getToken: async () => 't',
      now: () => NOW,
      storage: memStorage(),
      sleep: async () => {},
    });
    const wrapper = mount(AssistantView, {
      props: { patrol, drafts: createSocialDraftService({ storage: memStorage() }) },
    });
    await wrapper.get('[data-testid="gh-repos-input"]').setValue(REPO);
    await wrapper.get('[data-testid="gh-save-repos"]').trigger('click');
    await wrapper.get('[data-testid="gh-run"]').trigger('click');
    await waitFor(() => wrapper.find('[data-testid="gh-summary"]').exists());
    expect(wrapper.get('[data-testid="gh-summary"]').text()).toContain('离线');
    expect(wrapper.get('[data-testid="gh-repo-status"]').text()).toContain('离线');
    expect(wrapper.get('[data-testid="gh-repo-message"]').text()).toContain('不编造列表');
    expect(wrapper.findAll('[data-testid="gh-item"]')).toHaveLength(0);
    wrapper.unmount();
  });
});

describe('AssistantView · 社媒草稿卡', () => {
  it('平台切换、实时告警与预览气泡、空内容不能存草稿', async () => {
    const wrapper = mount(AssistantView, {
      props: { patrol: makePatrol(), drafts: createSocialDraftService({ storage: memStorage() }) },
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="social-channel-note"]').text()).toContain('发送通道未就绪');
    expect(wrapper.get('[data-testid="social-limit"]').text()).toContain('1000');
    expect(wrapper.get('[data-testid="social-save"]').attributes('disabled')).toBeDefined();

    await wrapper.get('[data-testid="social-text"]').setValue('@全体成员 看这个 https://example.com');
    await flushPromises();
    const warnings = wrapper.get('[data-testid="social-warnings"]').text();
    expect(warnings).toContain('@全体成员');
    expect(warnings).toContain('含链接');
    expect(wrapper.get('[data-testid="social-preview"]').text()).toContain('@全体成员');
    expect(wrapper.get('[data-testid="social-preview-bubble"]').text()).toContain('链接');

    await wrapper.get('[data-testid="social-platform-weibo"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="social-limit"]').text()).toContain('2000');
    expect(wrapper.find('[data-testid="social-to"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="social-weibo-note"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="social-preview"]').text()).toContain('公开发布');
    wrapper.unmount();
  });

  it('存草稿 → 列表出现；发送先弹确认层 → 确认后如实报未就绪；publish 桩禁用', async () => {
    const wrapper = mount(AssistantView, {
      props: { patrol: makePatrol(), drafts: createSocialDraftService({ storage: memStorage() }) },
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="social-empty"]').exists()).toBe(true);

    await wrapper.get('[data-testid="social-to"]').setValue('小美');
    await wrapper.get('[data-testid="social-text"]').setValue('晚上一起吃饭吗');
    await wrapper.get('[data-testid="social-save"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="social-draft"]')).toHaveLength(1);
    expect(wrapper.text()).toContain('小美');

    await wrapper.get('[data-testid="social-select"]').trigger('click');
    await flushPromises();

    // 发送按钮存在但永远先确认
    expect(wrapper.find('[data-testid="social-confirm"]').exists()).toBe(false);
    await wrapper.get('[data-testid="social-send"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="social-confirm"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="social-decision"]').text()).toContain('确认');

    await wrapper.get('[data-testid="social-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="social-confirm"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="social-decision"]').text()).toContain('发送通道未就绪');

    await wrapper.get('[data-testid="social-publish"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="social-decision"]').text()).toContain('social.publish 默认禁用');

    await wrapper.get('[data-testid="social-delete"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="social-draft"]')).toHaveLength(0);
    expect(wrapper.find('[data-testid="social-empty"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('取消确认不会产生任何发送结论', async () => {
    const wrapper = mount(AssistantView, {
      props: { patrol: makePatrol(), drafts: createSocialDraftService({ storage: memStorage() }) },
    });
    await flushPromises();
    await wrapper.get('[data-testid="social-text"]').setValue('草稿内容');
    await wrapper.get('[data-testid="social-save"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="social-select"]').trigger('click');
    await wrapper.get('[data-testid="social-send"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="social-confirm-no"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="social-confirm"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="social-decision"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('超长草稿的发送按钮被禁用（阻塞级告警）', async () => {
    const wrapper = mount(AssistantView, {
      props: { patrol: makePatrol(), drafts: createSocialDraftService({ storage: memStorage() }) },
    });
    await flushPromises();
    await wrapper.get('[data-testid="social-text"]').setValue('x'.repeat(1001));
    await flushPromises();
    expect(wrapper.get('[data-testid="social-warnings"]').text()).toContain('超过');
    expect(wrapper.get('[data-testid="social-save"]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});
