/**
 * platform/credentials.ts — 密钥存取（任务书接口：setSecret/getSecret/deleteSecret）。
 *
 * - Tauri：invoke Rust 命令 set_secret / get_secret / delete_secret
 *   （OS 凭据仓 keyring，service="VistaVerge"，见 src-tauri/src/lib.rs）。
 *   Rust 命令的集成验证归 EXP-007（GUI/构建）；本模块提供可注入 invoke 的
 *   createTauriCredentialBackend，使命令契约在 Node 侧可测。
 * - 浏览器 dev（无 Tauri）：sessionStorage 降级，dev-only 标记 + 一次性告警。
 * - 纯 Node（vitest 等）：内存后端回退，同样标 dev-only。
 */

export type CredentialBackendKind = 'tauri' | 'session-storage' | 'memory';

export interface CredentialBackend {
  readonly kind: CredentialBackendKind;
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  /** 返回是否确实删除了已存在条目。 */
  delete(key: string): Promise<boolean>;
}

export interface CredentialStore {
  readonly backendKind: CredentialBackendKind;
  /** true 表示密钥只存在易失/开发环境位置，不得用于真实密钥。 */
  readonly devOnly: boolean;
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<boolean>;
}

export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/* ------------------------------------------------------------------ */
/* 后端实现                                                             */
/* ------------------------------------------------------------------ */

/** Tauri 后端（命令契约：service=VistaVerge 由 Rust 侧持有，JS 只传 key/value）。 */
export function createTauriCredentialBackend(invoke: InvokeFn): CredentialBackend {
  return {
    kind: 'tauri',
    async set(key: string, value: string): Promise<void> {
      await invoke('set_secret', { key, value });
    },
    async get(key: string): Promise<string | null> {
      const value = await invoke('get_secret', { key });
      return typeof value === 'string' ? value : null;
    },
    async delete(key: string): Promise<boolean> {
      return (await invoke('delete_secret', { key })) === true;
    },
  };
}

const DEV_SECRET_PREFIX = 'vistaverge.dev-secret.';

/** 浏览器 dev 降级：sessionStorage（会话级、非安全存储），标 dev-only。 */
export function createSessionStorageCredentialBackend(storage: Storage): CredentialBackend {
  let warned = false;
  const warnOnce = (): void => {
    if (warned) return;
    warned = true;
    console.warn(
      '[vistaverge] credentials: Tauri 不可用，密钥降级到 sessionStorage（dev-only，仅供开发调试，勿存真实密钥）',
    );
  };
  return {
    kind: 'session-storage',
    async set(key: string, value: string): Promise<void> {
      warnOnce();
      storage.setItem(DEV_SECRET_PREFIX + key, value);
    },
    async get(key: string): Promise<string | null> {
      warnOnce();
      return storage.getItem(DEV_SECRET_PREFIX + key);
    },
    async delete(key: string): Promise<boolean> {
      warnOnce();
      const full = DEV_SECRET_PREFIX + key;
      const existed = storage.getItem(full) !== null;
      storage.removeItem(full);
      return existed;
    },
  };
}

/** 纯 Node/测试回退：进程内 Map，标 dev-only。 */
export function createMemoryCredentialBackend(): CredentialBackend {
  const data = new Map<string, string>();
  return {
    kind: 'memory',
    async set(key: string, value: string): Promise<void> {
      data.set(key, value);
    },
    async get(key: string): Promise<string | null> {
      return data.get(key) ?? null;
    },
    async delete(key: string): Promise<boolean> {
      return data.delete(key);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 默认后端选择与任务书接口                                              */
/* ------------------------------------------------------------------ */

let tauriInvokePromise: Promise<InvokeFn> | null = null;

function getTauriInvoke(): Promise<InvokeFn> {
  // 动态 import：Node 测试不会走到这里；浏览器/Vite 正常打包 @tauri-apps/api。
  tauriInvokePromise ??= import('@tauri-apps/api/core').then(
    (mod) => mod.invoke as unknown as InvokeFn,
  );
  return tauriInvokePromise;
}

function lazyTauriBackend(): CredentialBackend {
  const viaInvoke = async (
    run: (invoke: InvokeFn) => Promise<unknown>,
  ): Promise<unknown> => run(await getTauriInvoke());
  return {
    kind: 'tauri',
    async set(key: string, value: string): Promise<void> {
      await viaInvoke((invoke) => invoke('set_secret', { key, value }));
    },
    async get(key: string): Promise<string | null> {
      const value = (await viaInvoke((invoke) => invoke('get_secret', { key }))) as unknown;
      return typeof value === 'string' ? value : null;
    },
    async delete(key: string): Promise<boolean> {
      return ((await viaInvoke((invoke) => invoke('delete_secret', { key }))) as unknown) === true;
    },
  };
}

function hasTauriIpc(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function hasSessionStorage(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
  } catch {
    // 某些隐私模式访问 sessionStorage 即抛错。
    return false;
  }
}

function getDefaultBackend(): CredentialBackend {
  // 进程内单例：模块级 setSecret/getSecret/deleteSecret 与
  // createCredentialStore()（无参调用）共享同一默认后端。
  defaultBackendInstance ??= detectDefaultBackend();
  return defaultBackendInstance;
}

let defaultBackendInstance: CredentialBackend | null = null;

function detectDefaultBackend(): CredentialBackend {
  if (hasTauriIpc()) return lazyTauriBackend();
  if (hasSessionStorage()) return createSessionStorageCredentialBackend(window.sessionStorage);
  return createMemoryCredentialBackend();
}

/**
 * 创建凭据存取器。传入 backend 用于注入测试；缺省按运行环境自动选择
 * （Tauri → OS 凭据仓；浏览器 dev → sessionStorage；纯 Node → 内存）。
 */
export function createCredentialStore(backend?: CredentialBackend): CredentialStore {
  const resolved = backend ?? getDefaultBackend();
  return {
    backendKind: resolved.kind,
    devOnly: resolved.kind !== 'tauri',
    setSecret: (key, value) => resolved.set(key, value),
    getSecret: (key) => resolved.get(key),
    deleteSecret: (key) => resolved.delete(key),
  };
}

/* 任务书接口的默认单例绑定（Tauri 内为 OS 凭据仓；Node 测试为内存回退）。 */
const defaultStore = createCredentialStore();

export const setSecret = defaultStore.setSecret;
export const getSecret = defaultStore.getSecret;
export const deleteSecret = defaultStore.deleteSecret;
