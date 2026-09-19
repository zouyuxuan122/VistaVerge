// @vitest-environment jsdom
// EXP-006 UI 组件测试：MarketView（源配置/列表/详情/权限差异/安装停用/可执行插件未开放）、
// MemoryView（查看/搜索/改/删/导出）、ReminderToast（去重/静默/HA BLOCKED 卡）。
// 组件不依赖 App 结构，props 注入依赖，可独立挂载。
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import {
  createMarketStore,
  type MarketEntryView,
  type MarketStore,
} from '../../src/plugins/views/marketStore';
import { MarketView } from '../../src/plugins/views/marketView';
import {
  MemoryView,
  createMemoryViewService,
  type MemoryViewService,
} from '../../src/plugins/views/memoryView';
import { ReminderToast } from '../../src/sensors/views/reminderToast';
import { createRegistry, createMemoryInstallStore, sha256Hex, type IndexEntry, type InstalledPackage } from '../../src/plugins/registry';
import type { MemoryHit, MemoryRecord } from '../../src/data/memory';
import type { Reminder } from '../../src/sensors/reminders';

const NOW = 1_700_000_000_000;

/** 等待异步条件成立（crypto.subtle.digest 在线程池上，可能跨宏任务完成）。 */
async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const PKG_TEXT = JSON.stringify({
  manifest: {
    id: 'com.example.sakura',
    name: '樱花主题',
    version: '1.0.0',
    sdkRange: '>=1.0.0 <2.0.0',
    kind: 'theme',
    permissions: ['memory:read'],
    license: 'MIT',
  },
  data: { accent: '#f7c8d8' },
});

function indexEntry(sha256: string, size: number, overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    id: 'com.example.sakura',
    version: '1.0.0',
    kind: 'theme',
    sdkRange: '>=1.0.0 <2.0.0',
    license: 'MIT',
    permissions: ['memory:read'],
    sha256,
    size,
    url: 'https://cdn.example/sakura.json',
    entry: 'sakura.json',
    ...overrides,
  };
}

async function realStore(): Promise<MarketStore> {
  const bytes = new TextEncoder().encode(PKG_TEXT);
  const sha256 = await sha256Hex(bytes);
  const index = { schemaVersion: 1, plugins: [indexEntry(sha256, bytes.length)] };
  const registry = createRegistry({
    now: () => NOW,
    store: createMemoryInstallStore(),
    fetch: async (url) => ({
      ok: true,
      status: 200,
      text: async () => (url.includes('index') ? JSON.stringify(index) : PKG_TEXT),
    }),
  });
  return createMarketStore({ registry });
}

describe('MarketView', () => {
  it('明示仅数据包、可执行插件未开放', async () => {
    const store = await realStore();
    const wrapper = mount(MarketView, { props: { store } });
    expect(wrapper.find('[data-test="market-notice"]').text()).toContain('可执行插件未开放');
    expect(wrapper.find('[data-test="market-notice"]').text()).toContain('数据包');
  });

  it('配置源 URL → 刷新 → 列表 → 详情 → 安装 → 停用', async () => {
    const store = await realStore();
    const wrapper = mount(MarketView, { props: { store } });

    await wrapper.find('[data-test="market-source-input"]').setValue('https://index.example/index.json');
    await wrapper.find('[data-test="market-refresh"]').trigger('click');
    await flushPromises();

    const items = wrapper.findAll('[data-test="market-item"]');
    expect(items).toHaveLength(1);
    expect(items[0]!.text()).toContain('com.example.sakura');
    expect(items[0]!.text()).toContain('1.0.0');

    await items[0]!.trigger('click');
    const detail = wrapper.find('[data-test="market-detail"]');
    expect(detail.exists()).toBe(true);
    expect(detail.text()).toContain('MIT');
    expect(detail.text()).toContain('memory:read');

    await wrapper.find('[data-test="market-install"]').trigger('click');
    await waitFor(() => store.installedCount() === 1);
    await flushPromises();
    expect(wrapper.find('[data-test="market-disable"]').exists()).toBe(true);

    await wrapper.find('[data-test="market-disable"]').trigger('click');
    await waitFor(() => store.effectivePermissions('com.example.sakura').length === 0);
    await flushPromises();
    expect(wrapper.find('[data-test="market-enable"]').exists()).toBe(true);
  });

  it('权限差异（升级新增权限）在详情中明示', async () => {
    const entry: IndexEntry = indexEntry('a'.repeat(64), 10);
    const view: MarketEntryView = {
      entry,
      installed: null,
      permissionDiff: { added: ['network:weather'], removed: [], unchanged: ['memory:read'] },
    };
    const stub: MarketStore = {
      executablePluginsOpen: false,
      sourceUrl: 'https://index.example/index.json',
      installedCount: () => 0,
      effectivePermissions: () => [],
      setSource: vi.fn(),
      refresh: vi.fn(async () => ({ ok: true, count: 1 })),
      list: () => [view],
      select: vi.fn(),
      selectedId: () => entry.id,
      selected: () => view,
      install: vi.fn(async () => ({ ok: true })),
      enable: vi.fn(async () => true),
      disable: vi.fn(async () => true),
      approvePermissions: vi.fn(async () => true),
      uninstall: vi.fn(async () => true),
      lastError: () => null,
    };
    const wrapper = mount(MarketView, { props: { store: stub } });
    await wrapper.find('[data-test="market-refresh"]').trigger('click');
    await flushPromises();
    const added = wrapper.find('[data-test="market-perm-added"]');
    expect(added.exists()).toBe(true);
    expect(added.text()).toContain('network:weather');
    expect(added.text()).toContain('需重新同意');
  });

  it('升级新增权限：详情显示待重新同意，点「同意并启用」才启用（G-PLAT-02/B-P-04）', async () => {
    const entry: IndexEntry = indexEntry('a'.repeat(64), 10, { version: '2.0.0' });
    const installed: InstalledPackage = {
      id: entry.id,
      version: '2.0.0',
      kind: 'theme',
      license: 'MIT',
      permissions: ['memory:read', 'network:weather'],
      enabled: false,
      installedAt: NOW,
      sha256: 'a'.repeat(64),
      path: `${entry.id}/2.0.0/sakura.json`,
      source: 'https://index.example/index.json',
      pendingPermissions: ['network:weather'],
    };
    const view: MarketEntryView = {
      entry,
      installed,
      permissionDiff: { added: ['network:weather'], removed: [], unchanged: ['memory:read'] },
    };
    const approvePermissions = vi.fn(async () => true);
    const stub: MarketStore = {
      executablePluginsOpen: false,
      sourceUrl: 'https://index.example/index.json',
      installedCount: () => 1,
      effectivePermissions: () => [],
      setSource: vi.fn(),
      refresh: vi.fn(async () => ({ ok: true, count: 1 })),
      list: () => [view],
      select: vi.fn(),
      selectedId: () => entry.id,
      selected: () => view,
      install: vi.fn(async () => ({ ok: true })),
      enable: vi.fn(async () => false),
      disable: vi.fn(async () => true),
      approvePermissions,
      uninstall: vi.fn(async () => true),
      lastError: () => null,
    };
    const wrapper = mount(MarketView, { props: { store: stub } });
    await wrapper.find('[data-test="market-refresh"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="market-pending-perm"]').text()).toContain('待重新同意');
    expect(wrapper.find('[data-test="market-enable"]').exists()).toBe(false);

    await wrapper.find('[data-test="market-approve"]').trigger('click');
    await flushPromises();
    expect(approvePermissions).toHaveBeenCalledWith('com.example.sakura');
  });

  it('刷新失败时显示错误，不谎报成功', async () => {
    const stub: MarketStore = {
      executablePluginsOpen: false,
      sourceUrl: null,
      installedCount: () => 0,
      effectivePermissions: () => [],
      setSource: vi.fn(),
      refresh: vi.fn(async () => ({ ok: false, error: 'http', count: 0 })),
      list: () => [],
      select: vi.fn(),
      selectedId: () => null,
      selected: () => null,
      install: vi.fn(async () => ({ ok: true })),
      enable: vi.fn(async () => true),
      disable: vi.fn(async () => true),
      approvePermissions: vi.fn(async () => true),
      uninstall: vi.fn(async () => true),
      lastError: () => '索引刷新失败：http',
    };
    const wrapper = mount(MarketView, { props: { store: stub } });
    await wrapper.find('[data-test="market-refresh"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="market-error"]').text()).toContain('失败');
    expect(wrapper.findAll('[data-test="market-item"]')).toHaveLength(0);
  });
});

describe('MemoryView', () => {
  function record(id: string, text: string): MemoryRecord {
    return {
      id,
      kind: 'fact',
      text,
      scope: 'personal',
      status: 'active',
      supersedes: null,
      version: 1,
      createdAt: NOW,
      observedAt: NOW,
      expiresAt: null,
      sensitivity: 'normal',
      tags: ['资料'],
      sourceKind: 'user',
      sourceId: null,
      reliability: 1,
    };
  }

  function hit(id: string, text: string): MemoryHit {
    return {
      id,
      text,
      tags: ['资料'],
      kind: 'fact',
      scope: 'personal',
      createdAt: NOW,
      score: 1,
      stale: false,
      status: 'active',
      supersedes: null,
      expiresAt: null,
    };
  }

  function fakeService(): MemoryViewService & { calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = { correct: [], forget: [], exportJson: [] };
    return {
      calls,
      list: () => [record('m1', '我把签字材料放在书房抽屉里'), record('m2', '出门记得带伞')],
      search: (query) => (query.includes('伞') ? [hit('m2', '出门记得带伞')] : []),
      correct: (id, text) => {
        calls.correct!.push([id, text]);
      },
      forget: (id) => {
        calls.forget!.push([id]);
      },
      exportJson: () => {
        calls.exportJson!.push([]);
        return JSON.stringify([{ id: 'm1' }]);
      },
    };
  }

  it('列出记忆、搜索、修改、删除、导出', async () => {
    const service = fakeService();
    const wrapper = mount(MemoryView, { props: { service } });
    await flushPromises();
    expect(wrapper.findAll('[data-test="memory-item"]')).toHaveLength(2);

    await wrapper.find('[data-test="memory-search-input"]').setValue('伞');
    await wrapper.find('[data-test="memory-search"]').trigger('click');
    const filtered = wrapper.findAll('[data-test="memory-item"]');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.text()).toContain('带伞');

    await filtered[0]!.trigger('click');
    await wrapper.find('[data-test="memory-edit-input"]').setValue('出门一定记得带伞');
    await wrapper.find('[data-test="memory-save"]').trigger('click');
    expect(service.calls.correct).toEqual([['m2', '出门一定记得带伞']]);

    await wrapper.find('[data-test="memory-delete"]').trigger('click');
    expect(service.calls.forget).toEqual([['m2']]);

    await wrapper.find('[data-test="memory-export"]').trigger('click');
    expect(service.calls.exportJson).toHaveLength(1);
    expect(wrapper.find('[data-test="memory-export-output"]').text()).toContain('m1');
  });

  it('搜索无命中时明确空态，不显示旧结果', async () => {
    const service = fakeService();
    const wrapper = mount(MemoryView, { props: { service } });
    await flushPromises();
    await wrapper.find('[data-test="memory-search-input"]').setValue('量子');
    await wrapper.find('[data-test="memory-search"]').trigger('click');
    expect(wrapper.findAll('[data-test="memory-item"]')).toHaveLength(0);
    expect(wrapper.find('[data-test="memory-empty"]').text()).toContain('未找到');
  });

  it('createMemoryViewService 包装数据层公开接口（默认实现委托）', () => {
    const service = createMemoryViewService({
      list: () => [],
      search: () => [],
      correct: vi.fn(),
      forget: vi.fn(),
      exportJson: () => '[]',
    });
    expect(service.list()).toEqual([]);
    expect(service.exportJson()).toBe('[]');
  });
});

describe('ReminderToast', () => {
  function reminder(id: string, text: string): Reminder {
    return {
      id,
      kind: 'outing',
      text,
      parts: { weather: '外面小雨，约 21.5℃' },
      createdAt: NOW,
      expiresAt: null,
      source: 'sensors/reminders',
      untrusted: true,
    };
  }

  it('渲染提醒并支持关闭；相同文本只显示一条（去重）', async () => {
    const onDismiss = vi.fn();
    const wrapper = mount(ReminderToast, {
      props: {
        reminders: [reminder('r1', '出门提醒：外面小雨'), reminder('r2', '出门提醒：外面小雨')],
        haStatus: 'connected',
        onDismiss,
      },
    });
    expect(wrapper.findAll('[data-test="reminder-toast"]')).toHaveLength(1);
    await wrapper.find('[data-test="reminder-dismiss"]').trigger('click');
    expect(onDismiss).toHaveBeenCalledWith('r1');
  });

  it('静默开启时不显示提醒，显示静默指示；可切换', async () => {
    const onToggleQuiet = vi.fn();
    const wrapper = mount(ReminderToast, {
      props: { reminders: [reminder('r1', '出门提醒')], haStatus: 'connected', quietEnabled: true, onToggleQuiet },
    });
    expect(wrapper.findAll('[data-test="reminder-toast"]')).toHaveLength(0);
    expect(wrapper.find('[data-test="reminder-quiet-indicator"]').exists()).toBe(true);
    await wrapper.find('[data-test="reminder-quiet-toggle"]').setValue(false);
    expect(onToggleQuiet).toHaveBeenCalledWith(false);
  });

  it('HA 未配置时显示 BLOCKED 卡，不伪装已连接', () => {
    const wrapper = mount(ReminderToast, {
      props: { reminders: [], haStatus: 'blocked', blockedReason: 'HA 未配置（缺少 url/token），状态 BLOCKED' },
    });
    const card = wrapper.find('[data-test="ha-blocked-card"]');
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain('BLOCKED');
    expect(card.text()).toContain('未配置');
  });

  it('HA 已连接时不显示 BLOCKED 卡', () => {
    const wrapper = mount(ReminderToast, { props: { reminders: [], haStatus: 'connected' } });
    expect(wrapper.find('[data-test="ha-blocked-card"]').exists()).toBe(false);
  });
});
