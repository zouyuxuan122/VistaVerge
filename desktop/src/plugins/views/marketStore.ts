/**
 * plugins/views/marketStore.ts — 市场视图状态（源 URL、列表、详情、权限差异、安装/停用）。
 *
 * 组件只依赖本接口（props 注入），因此可脱离 App 结构独立挂载与测试。
 * 本期只允许**数据包**（theme/character）；`executablePluginsOpen` 恒为 false，
 * UI 必须明示“可执行插件未开放”，不得暗示已支持可执行插件。
 */

import {
  createRegistry,
  type IndexEntry,
  type InstalledPackage,
  type PermissionDiff,
  type Registry,
} from '../registry';

export interface MarketEntryView {
  entry: IndexEntry;
  installed: InstalledPackage | null;
  /** 升级时新增权限必须重新同意，不得自动激活。 */
  permissionDiff: PermissionDiff;
}

export interface MarketRefreshResult {
  ok: boolean;
  error?: string;
  count: number;
}

export interface MarketStore {
  /** 本期不开放可执行插件（硬约束，非开关）。 */
  readonly executablePluginsOpen: false;
  readonly sourceUrl: string | null;
  setSource(url: string): void;
  refresh(): Promise<MarketRefreshResult>;
  list(): MarketEntryView[];
  select(id: string): void;
  selectedId(): string | null;
  selected(): MarketEntryView | null;
  install(id: string): Promise<{ ok: boolean; error?: string }>;
  enable(id: string): Promise<boolean>;
  disable(id: string): Promise<boolean>;
  uninstall(id: string): Promise<boolean>;
  installedCount(): number;
  effectivePermissions(id: string): string[];
  lastError(): string | null;
}

export interface MarketStoreDeps {
  registry?: Registry;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMarketStore(deps: MarketStoreDeps = {}): MarketStore {
  const registry = deps.registry ?? createRegistry();

  let sourceUrl: string | null = null;
  let entries: MarketEntryView[] = [];
  let selectedId: string | null = null;
  let lastError: string | null = null;
  let installed: InstalledPackage[] = [];

  function find(id: string): MarketEntryView | null {
    return entries.find((view) => view.entry.id === id) ?? null;
  }

  return {
    executablePluginsOpen: false,

    get sourceUrl() {
      return sourceUrl;
    },

    setSource(url: string) {
      const trimmed = url.trim();
      sourceUrl = trimmed.length > 0 ? trimmed : null;
    },

    async refresh(): Promise<MarketRefreshResult> {
      if (!sourceUrl) {
        lastError = '请先配置仓库源 URL（HTTPS index.json）';
        entries = [];
        return { ok: false, error: 'no-source', count: 0 };
      }
      try {
        const index = await registry.fetchIndex(sourceUrl);
        installed = await registry.installed();
        const views: MarketEntryView[] = [];
        for (const entry of index.plugins) {
          views.push({
            entry,
            installed: installed.find((record) => record.id === entry.id) ?? null,
            permissionDiff: await registry.permissionDiff(entry),
          });
        }
        entries = views;
        lastError = null;
        if (selectedId && !find(selectedId)) selectedId = null;
        return { ok: true, count: views.length };
      } catch (error) {
        lastError = `索引刷新失败：${messageOf(error)}`;
        entries = [];
        return { ok: false, error: messageOf(error), count: 0 };
      }
    },

    list() {
      return entries;
    },

    select(id: string) {
      selectedId = id;
    },

    selectedId() {
      return selectedId;
    },

    selected() {
      return selectedId ? find(selectedId) : null;
    },

    async install(id: string) {
      if (!sourceUrl) return { ok: false, error: 'no-source' };
      try {
        await registry.installFromIndex(sourceUrl, id);
        installed = await registry.installed();
        const view = find(id);
        if (view) view.installed = installed.find((record) => record.id === id) ?? null;
        lastError = null;
        return { ok: true };
      } catch (error) {
        lastError = `安装失败：${messageOf(error)}`;
        return { ok: false, error: messageOf(error) };
      }
    },

    async enable(id: string) {
      const ok = await registry.enable(id);
      installed = await registry.installed();
      const view = find(id);
      if (view) view.installed = installed.find((record) => record.id === id) ?? null;
      return ok;
    },

    async disable(id: string) {
      const ok = await registry.disable(id);
      installed = await registry.installed();
      const view = find(id);
      if (view) view.installed = installed.find((record) => record.id === id) ?? null;
      return ok;
    },

    async uninstall(id: string) {
      const ok = await registry.uninstall(id);
      installed = await registry.installed();
      const view = find(id);
      if (view) view.installed = null;
      return ok;
    },

    installedCount() {
      return installed.length;
    },

    effectivePermissions(id: string) {
      return registry.effectivePermissions(id);
    },

    lastError() {
      return lastError;
    },
  };
}
