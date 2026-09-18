// EXP-006 插件仓库源 / 安装事务测试（PLUGIN_PLATFORM_UPDATES §3）。
// fetchIndex → 校验 → install(数据包 JSON) → 本地目录；sha256 核对、大小上限、
// 路径白名单；失败不留半启用状态。
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PACKAGE_BYTES,
  RegistryError,
  assertSafeEntryPath,
  createMemoryInstallStore,
  createRegistry,
  fetchIndex,
  parseIndex,
  sha256Hex,
  type FetchLike,
  type IndexEntry,
  type RegistryErrorCode,
} from '../../src/plugins/registry';

const NOW = 1_700_000_000_000;

const PKG = JSON.stringify({
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

const PKG_BYTES = new TextEncoder().encode(PKG);

async function packageBytes(text = PKG): Promise<{ bytes: Uint8Array; sha256: string }> {
  const bytes = new TextEncoder().encode(text);
  return { bytes, sha256: await sha256Hex(bytes) };
}

function entry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    id: 'com.example.sakura',
    version: '1.0.0',
    kind: 'theme',
    sdkRange: '>=1.0.0 <2.0.0',
    license: 'MIT',
    permissions: ['memory:read'],
    sha256: 'a'.repeat(64),
    size: 10,
    url: 'https://cdn.example/packs/sakura.json',
    entry: 'sakura.json',
    ...overrides,
  };
}

function expectRegistryError(fn: () => unknown | Promise<unknown>, code: RegistryErrorCode): Promise<RegistryError> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        throw new Error(`expected RegistryError(${code})`);
      },
      (err: unknown) => {
        expect(err, `expected RegistryError(${code})`).toBeInstanceOf(RegistryError);
        const error = err as RegistryError;
        expect(error.code).toBe(code);
        return error;
      },
    );
}

describe('sha256 与路径白名单', () => {
  it('sha256Hex 与已知向量一致', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('路径白名单：允许相对 .json，拒绝穿越/绝对路径/非 JSON', () => {
    expect(() => assertSafeEntryPath('sakura.json')).not.toThrow();
    expect(() => assertSafeEntryPath('theme/sakura.v2.json')).not.toThrow();

    for (const bad of [
      '../evil.json',
      'a/../../evil.json',
      '/etc/passwd.json',
      'C:/abs.json',
      'C:\\abs.json',
      'a\\b.json',
      'sakura.js',
      'sakura.json.exe',
      '',
      'a//b.json',
      '%2e%2e/evil.json',
      'https://evil.example/x.json',
    ]) {
      expect(() => assertSafeEntryPath(bad), `should reject ${bad}`).toThrow(RegistryError);
    }
    expect(() => assertSafeEntryPath('../evil.json')).toThrow(/路径|path/i);
  });
});

describe('parseIndex / fetchIndex', () => {
  const index = {
    schemaVersion: 1,
    updatedAt: '2026-09-19T00:00:00Z',
    plugins: [entry()],
  };

  it('合法索引解析成功并标注来源', () => {
    const parsed = parseIndex(index, { source: 'https://index.example/index.json' });
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.source).toBe('https://index.example/index.json');
  });

  it('非法索引：结构错误 / sha256 非 64 位 / 重复 id / 未知 kind', () => {
    expect(() => parseIndex('nope')).toThrow(RegistryError);
    expect(() => parseIndex({ plugins: [] })).toThrow(RegistryError);
    expect(() => parseIndex({ schemaVersion: 1, plugins: [{ ...entry(), sha256: 'zz' }] })).toThrow(/sha256/i);
    expect(() => parseIndex({ schemaVersion: 1, plugins: [entry(), entry()] })).toThrow(/重复/);
    expect(() => parseIndex({ schemaVersion: 1, plugins: [entry({ kind: 'executable' as never })] })).toThrow(
      /kind|可执行|种类/,
    );
    expect(() => parseIndex({ schemaVersion: 1, plugins: [entry({ entry: '../x.json' })] })).toThrow(/路径/);
  });

  it('fetchIndex 使用注入 fetch，HTTP 错误与超大索引被拒绝', async () => {
    const okFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(index),
    });
    const parsed = await fetchIndex('https://index.example/index.json', { fetch: okFetch });
    expect(parsed.plugins).toHaveLength(1);

    const badFetch: FetchLike = async () => ({ ok: false, status: 503, text: async () => 'down' });
    await expectRegistryError(() => fetchIndex('https://index.example/i.json', { fetch: badFetch }), 'http');

    const hugeFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => 'x'.repeat(2 * 1024 * 1024),
    });
    await expectRegistryError(() => fetchIndex('https://index.example/i.json', { fetch: hugeFetch }), 'index-too-large');
  });
});

describe('registry 安装事务', () => {
  async function setup() {
    const { bytes, sha256 } = await packageBytes();
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => PKG,
    });
    const store = createMemoryInstallStore();
    const registry = createRegistry({ fetch: fetchImpl, store, now: () => NOW });
    return { bytes, sha256, store, registry, fetchImpl };
  }

  it('正常安装：哈希核对通过，写入本地目录并标记启用', async () => {
    const { sha256, store, registry } = await setup();
    const installed = await registry.install(entry({ sha256, size: PKG_BYTES.byteLength }), {
      indexUrl: 'https://index.example/index.json',
    });
    expect(installed).toMatchObject({
      id: 'com.example.sakura',
      version: '1.0.0',
      enabled: true,
      sha256,
      installedAt: NOW,
      source: 'https://index.example/index.json',
    });
    expect(installed.path).toBe('com.example.sakura/1.0.0/sakura.json');
    expect(await store.read(installed.path)).toBeInstanceOf(Uint8Array);
    expect((await registry.installed()).map((p) => p.id)).toEqual(['com.example.sakura']);
    expect(registry.effectivePermissions('com.example.sakura')).toEqual(['memory:read']);
  });

  it('sha256 不符拒装，且不写入任何文件、不产生安装记录', async () => {
    const { store, registry } = await setup();
    await expectRegistryError(
      () => registry.install(entry({ sha256: 'b'.repeat(64), size: PKG_BYTES.byteLength }), { indexUrl: 'i' }),
      'sha256-mismatch',
    );
    expect(await store.list()).toEqual([]);
    expect(await registry.installed()).toEqual([]);
  });

  it('声明大小不符 / 超出体积上限拒装', async () => {
    const { sha256, registry } = await setup();
    await expectRegistryError(
      () => registry.install(entry({ sha256, size: 999 }), { indexUrl: 'i' }),
      'size-mismatch',
    );
    await expectRegistryError(
      () => registry.install(entry({ sha256, size: MAX_PACKAGE_BYTES + 1 }), { indexUrl: 'i' }),
      'package-too-large',
    );
  });

  it('路径白名单在安装路径上生效（路径穿越拒装）', async () => {
    const { sha256, registry } = await setup();
    await expectRegistryError(
      () => registry.install(entry({ sha256, entry: '../evil.json' }), { indexUrl: 'i' }),
      'path-not-allowed',
    );
  });

  it('包内 manifest 与索引不一致拒装（id/version/kind）', async () => {
    const mismatch = JSON.stringify({
      manifest: {
        id: 'com.example.other',
        version: '1.0.0',
        sdkRange: '>=1.0.0 <2.0.0',
        kind: 'theme',
        permissions: [],
        license: 'MIT',
      },
      data: {},
    });
    const bytes = new TextEncoder().encode(mismatch);
    const sha256 = await sha256Hex(bytes);
    const registry = createRegistry({
      fetch: async () => ({ ok: true, status: 200, text: async () => mismatch }),
      store: createMemoryInstallStore(),
      now: () => NOW,
    });
    await expectRegistryError(
      () => registry.install(entry({ sha256, size: bytes.length }), { indexUrl: 'i' }),
      'manifest-mismatch',
    );
  });

  it('下载失败 / 非法 JSON 包被拒绝', async () => {
    const failing = createRegistry({
      fetch: async () => ({ ok: false, status: 404, text: async () => 'missing' }),
      store: createMemoryInstallStore(),
      now: () => NOW,
    });
    await expectRegistryError(() => failing.install(entry(), { indexUrl: 'i' }), 'http');

    const notJson = 'not json at all';
    const bytes = new TextEncoder().encode(notJson);
    const sha256 = await sha256Hex(bytes);
    const registry = createRegistry({
      fetch: async () => ({ ok: true, status: 200, text: async () => notJson }),
      store: createMemoryInstallStore(),
      now: () => NOW,
    });
    await expectRegistryError(
      () => registry.install(entry({ sha256, size: bytes.length }), { indexUrl: 'i' }),
      'invalid-package',
    );
  });

  it('停用撤销权限、重新启用恢复；卸载移除记录', async () => {
    const { sha256, registry } = await setup();
    await registry.install(entry({ sha256, size: PKG_BYTES.byteLength }), { indexUrl: 'i' });
    expect(await registry.disable('com.example.sakura')).toBe(true);
    expect(registry.effectivePermissions('com.example.sakura')).toEqual([]);
    expect((await registry.get('com.example.sakura'))?.enabled).toBe(false);
    expect(await registry.enable('com.example.sakura')).toBe(true);
    expect(registry.effectivePermissions('com.example.sakura')).toEqual(['memory:read']);
    expect(await registry.uninstall('com.example.sakura')).toBe(true);
    expect(await registry.installed()).toEqual([]);
  });

  it('权限差异：升级新增权限被标出（新增权限不得自动激活）', async () => {
    const { sha256, registry } = await setup();
    await registry.install(entry({ sha256, size: PKG_BYTES.byteLength }), { indexUrl: 'i' });
    const diff = await registry.permissionDiff(
      entry({ version: '1.1.0', permissions: ['memory:read', 'network:weather'] }),
    );
    expect(diff.added).toEqual(['network:weather']);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual(['memory:read']);
  });

  it('installFromIndex 组合 fetchIndex + install', async () => {
    const { sha256 } = await packageBytes();
    const index = { schemaVersion: 1, plugins: [entry({ sha256, size: PKG_BYTES.byteLength })] };
    const registry = createRegistry({
      store: createMemoryInstallStore(),
      now: () => NOW,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        text: async () => (url.includes('index') ? JSON.stringify(index) : PKG),
      }),
    });
    const installed = await registry.installFromIndex('https://index.example/index.json', 'com.example.sakura');
    expect(installed.version).toBe('1.0.0');
  });

  it('未知插件 id 从索引安装时报 not-found', async () => {
    const registry = createRegistry({
      store: createMemoryInstallStore(),
      now: () => NOW,
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ schemaVersion: 1, plugins: [] }) }),
    });
    await expectRegistryError(
      () => registry.installFromIndex('https://index.example/index.json', 'com.example.missing'),
      'not-found',
    );
  });
});
