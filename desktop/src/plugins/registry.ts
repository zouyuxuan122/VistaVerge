/**
 * plugins/registry.ts — 仓库源索引 + 安装事务（PLUGIN_PLATFORM_UPDATES §3）。
 *
 * 安装流程（失败保持旧版本、不留半启用状态）：
 *   resolve → 下载 → 路径白名单 → 体积上限 → sha256 核对 → 包内 manifest 与索引
 *   一致 → 写入本地目录 → 记录为启用。
 *
 * 本期只处理**数据包 JSON**（theme/character）：不执行仓库里的脚本，不做 zip
 * 解压（因此 zip-slip/解压炸弹不适用），路径白名单与体积上限是主要防护。
 * 发行者签名建立信任，哈希只验证一致性——本模块只做哈希，签名验证留待
 * RELEASE-01；UI 必须如实区分二者。
 */

import {
  MANIFEST_LIMITS,
  ManifestError,
  SDK_VERSION,
  SUPPORTED_KINDS,
  isSafeDataPath,
  parseManifest,
  satisfiesSdkRange,
  validatePermissions,
  type ManifestKind,
} from './manifest';
import { type FetchLike } from '../sensors/weather';
import { createPersistence } from '../platform/persistence';

export type { FetchLike };

export const MAX_PACKAGE_BYTES = MANIFEST_LIMITS.maxPackageBytes;
export const MAX_INDEX_BYTES = 1024 * 1024;

export type RegistryErrorCode =
  | 'invalid-json'
  | 'invalid-index'
  | 'http'
  | 'index-too-large'
  | 'not-found'
  | 'path-not-allowed'
  | 'package-too-large'
  | 'size-mismatch'
  | 'sha256-mismatch'
  | 'invalid-package'
  | 'manifest-mismatch'
  | 'store-error';

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

export interface IndexEntry {
  id: string;
  version: string;
  kind: ManifestKind;
  sdkRange: string;
  license: string;
  permissions: string[];
  sha256: string;
  size: number;
  url: string;
  entry: string;
  name?: string;
  publisher?: string;
  description?: string;
  signature?: string;
}

export interface PluginIndex {
  schemaVersion: number;
  updatedAt?: string;
  source?: string;
  plugins: IndexEntry[];
}

export interface InstalledPackage {
  id: string;
  version: string;
  kind: ManifestKind;
  license: string;
  permissions: string[];
  enabled: boolean;
  installedAt: number;
  sha256: string;
  /** 本地相对路径（含 id/version 前缀，天然隔离命名空间）。 */
  path: string;
  source: string;
  /**
   * 升级新增、尚未重新同意的权限（G-PLAT-02/B-P-04）。
   * 非空时插件保持停用，`enable` 会被拒绝，需用户显式同意后才启用。
   */
  pendingPermissions: string[];
}

export interface InstallStore {
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  list(): Promise<InstalledPackage[]>;
  put(record: InstalledPackage): Promise<void>;
  /** 删除该 id 的安装记录**与全部文件字节**（B-P-05：不留残留字节）。 */
  remove(id: string): Promise<void>;
  /** 删除单个文件（升级时清理旧版本字节）。 */
  removePath?(path: string): Promise<void>;
}

export interface PermissionDiff {
  added: string[];
  removed: string[];
  unchanged: string[];
}

export interface Registry {
  /** 用 registry 自身配置的 fetch 拉取并校验索引（市场 UI 复用，避免绕过注入）。 */
  fetchIndex(url: string, signal?: AbortSignal): Promise<PluginIndex>;
  installed(): Promise<InstalledPackage[]>;
  get(id: string): Promise<InstalledPackage | undefined>;
  effectivePermissions(id: string): string[];
  permissionDiff(entry: IndexEntry): Promise<PermissionDiff>;
  install(entry: IndexEntry, context: { indexUrl: string }): Promise<InstalledPackage>;
  installFromIndex(indexUrl: string, id: string): Promise<InstalledPackage>;
  enable(id: string): Promise<boolean>;
  disable(id: string): Promise<boolean>;
  /** 用户重新同意新增权限并启用（G-PLAT-02/B-P-04）。 */
  approvePermissions(id: string): Promise<boolean>;
  uninstall(id: string): Promise<boolean>;
}

export interface RegistryDeps {
  fetch?: FetchLike;
  store?: InstallStore;
  now?: () => number;
  maxPackageBytes?: number;
}

/* ------------------------------------------------------------------ */
/* sha256                                                              */
/* ------------------------------------------------------------------ */

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256（WebCrypto）。哈希只验证一致性；信任来自发行者签名。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new RegistryError('store-error', '当前环境缺少 WebCrypto，无法校验 sha256');
  }
  // Uint8Array<ArrayBufferLike> 与 BufferSource 的泛型不完全兼容，显式收窄到 ArrayBuffer。
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return toHex(await subtle.digest('SHA-256', copy.buffer as ArrayBuffer));
}

/* ------------------------------------------------------------------ */
/* 路径白名单                                                          */
/* ------------------------------------------------------------------ */

/** 安装入口路径白名单（zip-slip / 绝对路径 / 非 JSON 一律拒绝）。 */
export function assertSafeEntryPath(entry: unknown): string {
  if (!isSafeDataPath(entry)) {
    throw new RegistryError('path-not-allowed', `安装路径不在白名单内（必须是相对 .json 路径）：${String(entry)}`);
  }
  return entry as string;
}

/* ------------------------------------------------------------------ */
/* 索引解析                                                            */
/* ------------------------------------------------------------------ */

function asEntry(raw: unknown, index: number): IndexEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RegistryError('invalid-index', `索引第 ${index} 项不是对象`);
  }
  const record = raw as Record<string, unknown>;
  let manifest;
  try {
    manifest = parseManifest(record);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new RegistryError('invalid-index', `索引第 ${index} 项（${String(record.id)}）非法：${error.message}`);
    }
    throw error;
  }
  const sha256 = record.sha256;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new RegistryError('invalid-index', `索引第 ${index} 项 sha256 非法（需 64 位十六进制）`);
  }
  const size = record.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    throw new RegistryError('invalid-index', `索引第 ${index} 项 size 非法`);
  }
  const url = record.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new RegistryError('invalid-index', `索引第 ${index} 项 url 必须是 http(s) 地址`);
  }
  const entry = record.entry;
  assertSafeEntryPath(entry);

  const result: IndexEntry = {
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    sdkRange: manifest.sdkRange,
    license: manifest.license,
    permissions: manifest.permissions,
    sha256: sha256.toLowerCase(),
    size,
    url,
    entry: entry as string,
  };
  if (manifest.name !== undefined) result.name = manifest.name;
  if (manifest.publisher !== undefined) result.publisher = manifest.publisher;
  if (manifest.description !== undefined) result.description = manifest.description;
  if (manifest.signature !== undefined) result.signature = manifest.signature;
  return result;
}

/** 解析并校验静态索引（schemaVersion + plugins[]，逐项校验，id 不得重复）。 */
export function parseIndex(input: string | unknown, options: { source?: string } = {}): PluginIndex {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new RegistryError('invalid-json', '索引不是合法 JSON');
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RegistryError('invalid-index', '索引必须是 JSON 对象');
  }
  const record = raw as Record<string, unknown>;
  const schemaVersion = Number(record.schemaVersion);
  if (!Number.isInteger(schemaVersion)) {
    throw new RegistryError('invalid-index', '索引缺少 schemaVersion');
  }
  if (!Array.isArray(record.plugins)) {
    throw new RegistryError('invalid-index', '索引缺少 plugins 数组');
  }
  const plugins = record.plugins.map((item, index) => asEntry(item, index));
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) {
      throw new RegistryError('invalid-index', `索引中存在重复插件 id：${plugin.id}`);
    }
    seen.add(plugin.id);
  }
  const parsed: PluginIndex = { schemaVersion, plugins };
  if (typeof record.updatedAt === 'string') parsed.updatedAt = record.updatedAt;
  const source = options.source ?? (typeof record.source === 'string' ? record.source : undefined);
  if (source !== undefined) parsed.source = source;
  return parsed;
}

/** 拉取并校验索引。索引体积超限、HTTP 失败、格式非法都拒绝。 */
export async function fetchIndex(
  url: string,
  deps: { fetch?: FetchLike; signal?: AbortSignal; now?: () => number } = {},
): Promise<PluginIndex> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') {
    throw new RegistryError('http', '当前环境没有可用的 fetch，无法刷新索引');
  }
  let response;
  try {
    response = await fetchImpl(url, deps.signal ? { signal: deps.signal } : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RegistryError('http', `索引请求失败：${message}`);
  }
  if (!response.ok) {
    throw new RegistryError('http', `索引请求返回 HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length > MAX_INDEX_BYTES) {
    throw new RegistryError('index-too-large', `索引体积超出上限 ${MAX_INDEX_BYTES} 字节`);
  }
  return parseIndex(text, { source: url });
}

/* ------------------------------------------------------------------ */
/* 安装存储：内存（测试）与落盘（G-PLAT-01）                            */
/* ------------------------------------------------------------------ */

/** 兼容旧记录：缺失 pendingPermissions 时补空数组。 */
function normalizeRecord(record: InstalledPackage): InstalledPackage {
  return {
    ...record,
    permissions: [...(record.permissions ?? [])],
    pendingPermissions: [...(record.pendingPermissions ?? [])],
  };
}

export function createMemoryInstallStore(): InstallStore {
  const files = new Map<string, Uint8Array>();
  const records = new Map<string, InstalledPackage>();
  return {
    async write(path: string, bytes: Uint8Array): Promise<void> {
      files.set(path, new Uint8Array(bytes));
    },
    async read(path: string): Promise<Uint8Array | null> {
      const value = files.get(path);
      return value ? new Uint8Array(value) : null;
    },
    async list(): Promise<InstalledPackage[]> {
      return [...records.values()].map((record) => ({ ...normalizeRecord(record) }));
    },
    async put(record: InstalledPackage): Promise<void> {
      records.set(record.id, normalizeRecord(record));
    },
    async remove(id: string): Promise<void> {
      records.delete(id);
      // B-P-05：卸载必须连文件字节一起清掉，否则本地目录永久残留。
      const prefix = `${id}/`;
      for (const key of [...files.keys()]) {
        if (key.startsWith(prefix)) files.delete(key);
      }
    },
    async removePath(path: string): Promise<void> {
      files.delete(path);
    },
  };
}

/** 落盘格式（单文件 JSON，字节以 base64 保存）。 */
interface PersistedStoreFile {
  version: 1;
  files: Record<string, string>;
  records: InstalledPackage[];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 文件落盘安装存储（G-PLAT-01）：重启后已安装插件仍在。
 * 通过 platform/persistence 的 db_read_file/db_write_file 通道写 app_data_dir，
 * 与记忆库分文件（`vistaverge-plugins.json`），避免与 data/db 的迁移耦合。
 */
export function createPersistentInstallStore(
  persistence: { read(): Promise<Uint8Array | null>; write(bytes: Uint8Array): Promise<void> },
): InstallStore {
  const files = new Map<string, Uint8Array>();
  const records = new Map<string, InstalledPackage>();
  let loaded = false;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await persistence.read();
      if (!raw || raw.byteLength === 0) return;
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as Partial<PersistedStoreFile>;
      if (parsed && typeof parsed === 'object') {
        for (const [path, base64] of Object.entries(parsed.files ?? {})) {
          if (typeof base64 === 'string') files.set(path, base64ToBytes(base64));
        }
        for (const record of parsed.records ?? []) {
          if (record && typeof record.id === 'string') records.set(record.id, normalizeRecord(record));
        }
      }
    } catch (error) {
      // 文件损坏：以空状态启动并留下痕迹，不静默假装已安装。
      console.error('[vistaverge] plugin store read failed:', error);
    }
  }

  async function persist(): Promise<void> {
    const payload: PersistedStoreFile = {
      version: 1,
      files: Object.fromEntries([...files.entries()].map(([path, bytes]) => [path, bytesToBase64(bytes)])),
      records: [...records.values()],
    };
    await persistence.write(new TextEncoder().encode(JSON.stringify(payload)));
  }

  return {
    async write(path: string, bytes: Uint8Array): Promise<void> {
      await ensureLoaded();
      files.set(path, new Uint8Array(bytes));
      await persist();
    },
    async read(path: string): Promise<Uint8Array | null> {
      await ensureLoaded();
      const value = files.get(path);
      return value ? new Uint8Array(value) : null;
    },
    async list(): Promise<InstalledPackage[]> {
      await ensureLoaded();
      return [...records.values()].map((record) => ({ ...normalizeRecord(record) }));
    },
    async put(record: InstalledPackage): Promise<void> {
      await ensureLoaded();
      records.set(record.id, normalizeRecord(record));
      await persist();
    },
    async remove(id: string): Promise<void> {
      await ensureLoaded();
      records.delete(id);
      const prefix = `${id}/`;
      for (const key of [...files.keys()]) {
        if (key.startsWith(prefix)) files.delete(key);
      }
      await persist();
    },
    async removePath(path: string): Promise<void> {
      await ensureLoaded();
      files.delete(path);
      await persist();
    },
  };
}

/**
 * 默认落盘存储：Tauri → app_data_dir 文件；浏览器 dev → IndexedDB；纯 Node → 内存。
 * 与记忆库分文件，避免与 data/db 的迁移版本耦合。
 */
function createDefaultInstallStore(): InstallStore {
  try {
    return createPersistentInstallStore(createPersistence('vistaverge-plugins.json'));
  } catch (error) {
    console.error('[vistaverge] plugin persistence unavailable, falling back to memory:', error);
    return createMemoryInstallStore();
  }
}

/* ------------------------------------------------------------------ */
/* 安装事务                                                            */
/* ------------------------------------------------------------------ */

function packagePath(entry: IndexEntry): string {
  return `${entry.id}/${entry.version}/${entry.entry}`;
}

export function createRegistry(deps: RegistryDeps = {}): Registry {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  const store = deps.store ?? createDefaultInstallStore();
  const now = deps.now ?? (() => Date.now());
  const maxPackageBytes = deps.maxPackageBytes ?? MAX_PACKAGE_BYTES;

  /**
   * 已安装记录的进程内镜像：`effectivePermissions` 是同步接口（UI 直接读取），
   * 因此维护快照；所有写操作后更新，读操作前先与 store 对齐。
   */
  const cache = new Map<string, InstalledPackage>();
  async function syncCache(): Promise<void> {
    cache.clear();
    for (const record of await store.list()) cache.set(record.id, record);
  }

  async function download(url: string): Promise<Uint8Array> {
    if (typeof fetchImpl !== 'function') {
      throw new RegistryError('http', '当前环境没有可用的 fetch，无法下载数据包');
    }
    let response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RegistryError('http', `数据包下载失败：${message}`);
    }
    if (!response.ok) {
      throw new RegistryError('http', `数据包下载返回 HTTP ${response.status}`);
    }
    // B-P-06：优先用 arrayBuffer 直接取字节。text() 会把字节按 UTF-8 解码再重编码，
    // 非 UTF-8/含多字节内容时字节数会变，导致 size/sha256 误报不一致。
    if (typeof response.arrayBuffer === 'function') {
      try {
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RegistryError('http', `数据包读取失败：${message}`);
      }
    }
    return new TextEncoder().encode(await response.text());
  }

  async function install(entry: IndexEntry, context: { indexUrl: string }): Promise<InstalledPackage> {
    // 1) 路径白名单（在下载之前就拒绝，避免把不可信路径带入本地目录）
    const entryPath = assertSafeEntryPath(entry.entry);
    // 2) 声明体积上限
    if (entry.size > maxPackageBytes) {
      throw new RegistryError('package-too-large', `数据包声明体积 ${entry.size} 超出上限 ${maxPackageBytes}`);
    }
    // 3) 下载 + 实际体积
    const bytes = await download(entry.url);
    if (bytes.byteLength > maxPackageBytes) {
      throw new RegistryError('package-too-large', `数据包体积 ${bytes.byteLength} 超出上限 ${maxPackageBytes}`);
    }
    if (bytes.byteLength !== entry.size) {
      throw new RegistryError(
        'size-mismatch',
        `数据包体积与索引不符：索引 ${entry.size}，实际 ${bytes.byteLength}`,
      );
    }
    // 4) sha256 一致性
    const actualSha256 = await sha256Hex(bytes);
    if (actualSha256 !== entry.sha256.toLowerCase()) {
      throw new RegistryError('sha256-mismatch', `数据包 sha256 不符：期望 ${entry.sha256}，实际 ${actualSha256}`);
    }
    // 5) 包内 manifest 与索引一致（防止索引与内容错配）
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new RegistryError('invalid-package', '数据包不是合法 JSON');
    }
    const manifestRaw = (payload as { manifest?: unknown } | null)?.manifest;
    let manifest;
    try {
      manifest = parseManifest(manifestRaw);
    } catch (error) {
      if (error instanceof ManifestError) {
        throw new RegistryError('invalid-package', `数据包 manifest 非法：${error.message}`);
      }
      throw error;
    }
    if (manifest.id !== entry.id || manifest.version !== entry.version || manifest.kind !== entry.kind) {
      throw new RegistryError(
        'manifest-mismatch',
        `数据包 manifest 与索引不一致：索引 ${entry.id}@${entry.version}(${entry.kind})，包内 ${manifest.id}@${manifest.version}(${manifest.kind})`,
      );
    }

    // 6) 升级时的权限差异：新增权限必须重新同意（G-PLAT-02/B-P-04）。
    await syncCache();
    const existing = cache.get(entry.id);
    const before = new Set(existing?.permissions ?? []);
    const added = entry.permissions.filter((permission) => !before.has(permission));
    const needsReconsent = existing !== undefined && added.length > 0;

    // 7) 写入本地目录 + 记录（同 id 覆盖 = 升级）
    const path = packagePath(entry);
    await store.write(path, bytes);
    // 升级换路径：清掉旧版本字节，避免残留（B-P-05 同类问题）。
    if (existing && existing.path !== path && store.removePath) {
      await store.removePath(existing.path);
    }
    const record: InstalledPackage = {
      id: entry.id,
      version: entry.version,
      kind: entry.kind,
      license: entry.license,
      permissions: [...entry.permissions],
      // 有新增权限的升级包安装后保持停用，等待用户重新同意。
      enabled: !needsReconsent,
      installedAt: now(),
      sha256: actualSha256,
      path,
      source: context.indexUrl,
      pendingPermissions: needsReconsent ? added : [],
    };
    await store.put(record);
    cache.set(record.id, record);
    return record;
  }

  async function installFromIndex(indexUrl: string, id: string): Promise<InstalledPackage> {
    const index = await fetchIndex(indexUrl, fetchImpl ? { fetch: fetchImpl, now } : { now });
    const entry = index.plugins.find((plugin) => plugin.id === id);
    if (!entry) {
      throw new RegistryError('not-found', `索引中未找到插件：${id}`);
    }
    const record = await install(entry, { indexUrl });
    cache.set(record.id, record);
    return record;
  }

  return {
    fetchIndex: (indexUrl: string, signal?: AbortSignal) =>
      fetchIndex(indexUrl, { ...(fetchImpl ? { fetch: fetchImpl } : {}), now, ...(signal ? { signal } : {}) }),
    async installed() {
      await syncCache();
      return [...cache.values()];
    },
    async get(id: string) {
      await syncCache();
      return cache.get(id);
    },
    effectivePermissions(id: string) {
      // 停用即撤销权限（PLUGIN_PLATFORM_UPDATES §3「权限随停用撤销」）。
      const record = cache.get(id);
      if (!record || !record.enabled) return [];
      return [...record.permissions];
    },
    async permissionDiff(entry: IndexEntry) {
      await syncCache();
      const current = cache.get(entry.id);
      const before = new Set(current?.permissions ?? []);
      const after = new Set(entry.permissions);
      return {
        added: entry.permissions.filter((permission) => !before.has(permission)),
        removed: [...before].filter((permission) => !after.has(permission)),
        unchanged: entry.permissions.filter((permission) => before.has(permission)),
      };
    },
    async install(entry: IndexEntry, context: { indexUrl: string }) {
      const record = await install(entry, context);
      cache.set(record.id, record);
      return record;
    },
    installFromIndex,
    async enable(id: string) {
      await syncCache();
      const record = cache.get(id);
      if (!record) return false;
      // G-PLAT-02/B-P-04：有未重新同意的新增权限时拒绝启用。
      if (record.pendingPermissions.length > 0) return false;
      const next = { ...record, enabled: true };
      await store.put(next);
      cache.set(id, next);
      return true;
    },
    async disable(id: string) {
      await syncCache();
      const record = cache.get(id);
      if (!record) return false;
      const next = { ...record, enabled: false };
      await store.put(next);
      cache.set(id, next);
      return true;
    },
    async approvePermissions(id: string) {
      await syncCache();
      const record = cache.get(id);
      if (!record) return false;
      // 用户已重新同意：清空待同意权限并启用。
      const next = { ...record, pendingPermissions: [], enabled: true };
      await store.put(next);
      cache.set(id, next);
      return true;
    },
    async uninstall(id: string) {
      await syncCache();
      if (!cache.has(id)) return false;
      // store.remove 同时清理记录与文件字节（B-P-05）。
      await store.remove(id);
      cache.delete(id);
      return true;
    },
  };
}

// SDK_VERSION / SUPPORTED_KINDS / satisfiesSdkRange / validatePermissions 由 manifest
// 统一提供；此处 re-export 便于市场与测试从 registry 单点取用。
export { SDK_VERSION, SUPPORTED_KINDS, satisfiesSdkRange, validatePermissions };
export type { ManifestKind };
