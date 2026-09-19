/**
 * 插件平台新增能力（FEATURE-01 / G-PLAT-01、G-PLAT-02、B-P-04、B-P-05、B-P-06）：
 * - 安装落盘持久化：换一个 store 实例（模拟重启）后已安装插件仍在；
 * - uninstall 清理文件字节，不留残留；
 * - 下载优先用 arrayBuffer，避免 text() 重编码导致 size/sha256 误报；
 * - 升级新增权限后保持停用，用户重新同意后才启用。
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryInstallStore,
  createPersistentInstallStore,
  createRegistry,
  sha256Hex,
  type FetchLike,
  type IndexEntry,
} from '../../src/plugins/registry';

const NOW = 1_700_000_000_000;

function packageFor(version: string, permissions: string[]): string {
  return JSON.stringify({
    manifest: {
      id: 'com.example.sakura',
      name: '樱花主题',
      version,
      sdkRange: '>=1.0.0 <2.0.0',
      kind: 'theme',
      permissions,
      license: 'MIT',
    },
    data: { accent: '#f7c8d8' },
  });
}

function entryFor(
  sha256: string,
  size: number,
  version: string,
  permissions: string[],
  url = 'https://cdn.example/sakura.json',
): IndexEntry {
  return {
    id: 'com.example.sakura',
    version,
    kind: 'theme',
    sdkRange: '>=1.0.0 <2.0.0',
    license: 'MIT',
    permissions,
    sha256,
    size,
    url,
    entry: 'sakura.json',
  };
}

/** 可共享的假持久化后端（模拟 app_data_dir 里的一个文件）。 */
function fakePersistence() {
  let bytes: Uint8Array | null = null;
  return {
    async read() {
      return bytes ? new Uint8Array(bytes) : null;
    },
    async write(next: Uint8Array) {
      bytes = new Uint8Array(next);
    },
    raw: () => bytes,
  };
}

describe('G-PLAT-01 安装落盘持久化', () => {
  it('重启（新 store 实例）后已安装插件与文件字节仍在', async () => {
    const pkg = packageFor('1.0.0', ['memory:read']);
    const bytes = new TextEncoder().encode(pkg);
    const sha = await sha256Hex(bytes);
    const persistence = fakePersistence();
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => pkg,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });

    const store1 = createPersistentInstallStore(persistence);
    const registry1 = createRegistry({ fetch: fetchImpl, store: store1, now: () => NOW });
    const record = await registry1.install(entryFor(sha, bytes.length, '1.0.0', ['memory:read']), {
      indexUrl: 'https://index.example/index.json',
    });
    expect(record.enabled).toBe(true);

    // 模拟重启：同一持久化文件上新建 store/registry。
    const store2 = createPersistentInstallStore(persistence);
    const registry2 = createRegistry({ fetch: fetchImpl, store: store2, now: () => NOW });
    const installed = await registry2.installed();
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({ id: 'com.example.sakura', version: '1.0.0', enabled: true });
    expect(installed[0]?.permissions).toEqual(['memory:read']);
    expect(registry2.effectivePermissions('com.example.sakura')).toEqual(['memory:read']);
    const restored = await store2.read(record.path);
    expect(restored).toBeInstanceOf(Uint8Array);
    expect(restored?.byteLength).toBe(bytes.length);
  });
});

describe('B-P-05 uninstall 清理文件字节', () => {
  it('卸载后记录与文件字节都不残留（内存与落盘两种 store）', async () => {
    const pkg = packageFor('1.0.0', ['memory:read']);
    const bytes = new TextEncoder().encode(pkg);
    const sha = await sha256Hex(bytes);
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => pkg,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });

    for (const store of [createMemoryInstallStore(), createPersistentInstallStore(fakePersistence())]) {
      const registry = createRegistry({ fetch: fetchImpl, store, now: () => NOW });
      const record = await registry.install(entryFor(sha, bytes.length, '1.0.0', ['memory:read']), {
        indexUrl: 'i',
      });
      expect(await store.read(record.path)).toBeInstanceOf(Uint8Array);
      expect(await registry.uninstall('com.example.sakura')).toBe(true);
      expect(await registry.installed()).toEqual([]);
      expect(await store.read(record.path)).toBeNull();
    }
  });
});

describe('B-P-06 下载用 arrayBuffer 直接校验字节', () => {
  it('text() 会改变字节时仍以真实字节校验（不误报 size/sha256）', async () => {
    const pkg = packageFor('1.0.0', ['memory:read']);
    const bytes = new TextEncoder().encode(pkg);
    const sha = await sha256Hex(bytes);
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      // 故意让 text() 与真实字节不一致：若实现退回 text() 就会 size-mismatch。
      text: async () => `${pkg}\uFFFD`,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    const registry = createRegistry({ fetch: fetchImpl, store: createMemoryInstallStore(), now: () => NOW });
    const record = await registry.install(entryFor(sha, bytes.length, '1.0.0', ['memory:read']), {
      indexUrl: 'i',
    });
    expect(record.sha256).toBe(sha);
    expect(record.enabled).toBe(true);
  });
});

describe('G-PLAT-02 / B-P-04 升级新增权限阻断启用', () => {
  async function setup() {
    const v1 = packageFor('1.0.0', ['memory:read']);
    const v2 = packageFor('2.0.0', ['memory:read', 'network:weather']);
    const b1 = new TextEncoder().encode(v1);
    const b2 = new TextEncoder().encode(v2);
    const s1 = await sha256Hex(b1);
    const s2 = await sha256Hex(b2);
    const fetchImpl: FetchLike = async (url) => {
      const isV2 = url.includes('v2');
      const text = isV2 ? v2 : v1;
      const raw = isV2 ? b2 : b1;
      return {
        ok: true,
        status: 200,
        text: async () => text,
        arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
      };
    };
    const registry = createRegistry({ fetch: fetchImpl, store: createMemoryInstallStore(), now: () => NOW });
    await registry.install(entryFor(s1, b1.length, '1.0.0', ['memory:read']), { indexUrl: 'i' });
    return { registry, s2, b2 };
  }

  it('升级包新增权限：安装后保持停用，enable 被拒绝，同意后才启用', async () => {
    const { registry, s2, b2 } = await setup();
    const upgraded = await registry.install(
      entryFor(s2, b2.length, '2.0.0', ['memory:read', 'network:weather'], 'https://cdn.example/v2/sakura.json'),
      { indexUrl: 'i' },
    );
    expect(upgraded.enabled).toBe(false);
    expect(upgraded.pendingPermissions).toEqual(['network:weather']);
    // 停用即撤销权限：新增权限未生效。
    expect(registry.effectivePermissions('com.example.sakura')).toEqual([]);
    // 未经同意不能启用。
    expect(await registry.enable('com.example.sakura')).toBe(false);
    expect((await registry.get('com.example.sakura'))?.enabled).toBe(false);

    // 用户重新同意。
    expect(await registry.approvePermissions('com.example.sakura')).toBe(true);
    const after = await registry.get('com.example.sakura');
    expect(after?.enabled).toBe(true);
    expect(after?.pendingPermissions).toEqual([]);
    expect(registry.effectivePermissions('com.example.sakura')).toEqual(['memory:read', 'network:weather']);
  });

  it('首次安装（无旧权限）即使权限较多也直接启用', async () => {
    const pkg = packageFor('1.0.0', ['memory:read', 'network:weather']);
    const bytes = new TextEncoder().encode(pkg);
    const sha = await sha256Hex(bytes);
    const registry = createRegistry({
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => pkg,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }),
      store: createMemoryInstallStore(),
      now: () => NOW,
    });
    const record = await registry.install(
      entryFor(sha, bytes.length, '1.0.0', ['memory:read', 'network:weather']),
      { indexUrl: 'i' },
    );
    expect(record.enabled).toBe(true);
    expect(record.pendingPermissions).toEqual([]);
  });

  it('权限差异接口标出新增权限（供 UI 提示重新同意）', async () => {
    const { registry } = await setup();
    const diff = await registry.permissionDiff({
      ...entryFor('a'.repeat(64), 1, '2.0.0', ['memory:read', 'network:weather']),
    });
    expect(diff.added).toEqual(['network:weather']);
  });
});
