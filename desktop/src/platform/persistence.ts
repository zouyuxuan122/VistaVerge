/**
 * platform/persistence.ts — 数据库文件持久化（initDb 的 DbPersistence 提供者）。
 *
 * - Tauri：invoke db_read_file / db_write_file（Rust 侧写 app_data_dir，文件名
 *   白名单 + 临时文件 rename 原子替换，见 src-tauri/src/lib.rs）。集成验证归 EXP-007。
 * - 浏览器 dev（无 Tauri）：IndexedDB 降级（dev-only，仅供开发调试）。
 * - 纯 Node（vitest）：内存回退（dev-only），保证平台层在 Node 侧可测。
 *
 * 说明：v1 经 JSON IPC 传字节数组（Vec<u8> ↔ number[]），百 KB 量级足够；
 * 更大吞吐时 EXP-007 可切 tauri::ipc::Response 原始通道（接口不变）。
 */

import type { DbPersistence } from '../data/db';

export type PersistenceKind = 'tauri' | 'indexeddb' | 'memory';

export interface PersistenceHandle extends DbPersistence {
  readonly kind: PersistenceKind;
  /** true 表示数据只存在易失/开发环境位置，不落真实文件。 */
  readonly devOnly: boolean;
}

export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/* ------------------------------------------------------------------ */
/* 后端实现                                                             */
/* ------------------------------------------------------------------ */

/** Tauri 后端（命令契约可注入 invoke 在 Node 侧测试）。 */
export function createTauriPersistence(invoke: InvokeFn, fileName: string): DbPersistence {
  return {
    async read(): Promise<Uint8Array | null> {
      const value = (await invoke('db_read_file', { name: fileName })) as unknown;
      if (value == null) return null;
      if (value instanceof Uint8Array) return value;
      if (Array.isArray(value)) return new Uint8Array(value);
      throw new Error('persistence: db_read_file 返回类型异常（期望字节数组或 null）');
    },
    async write(bytes: Uint8Array): Promise<void> {
      // JSON IPC：Uint8Array → number[]（Vec<u8>）。
      await invoke('db_write_file', { name: fileName, data: Array.from(bytes) });
    },
  };
}

/* 浏览器 dev 降级：IndexedDB（库 vistaverge-dev，store kv，键=文件名）。 */
function createIndexedDbPersistence(fileName: string): DbPersistence {
  const DB_NAME = 'vistaverge-dev';
  const STORE = 'kv';

  const idbRequest = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexeddb request failed'));
    });

  const openDb = (): Promise<IDBDatabase> =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) {
          open.result.createObjectStore(STORE);
        }
      };
      open.onerror = () => reject(open.error ?? new Error('indexeddb open failed'));
      open.onsuccess = () => resolve(open.result);
    });

  return {
    async read(): Promise<Uint8Array | null> {
      const idb = await openDb();
      try {
        const tx = idb.transaction(STORE, 'readonly');
        const value = await idbRequest(tx.objectStore(STORE).get(fileName) as IDBRequest<unknown>);
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        return null;
      } finally {
        idb.close();
      }
    },
    async write(bytes: Uint8Array): Promise<void> {
      const idb = await openDb();
      try {
        const tx = idb.transaction(STORE, 'readwrite');
        await idbRequest(tx.objectStore(STORE).put(new Uint8Array(bytes), fileName));
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('indexeddb commit failed'));
          tx.onabort = () => reject(tx.error ?? new Error('indexeddb aborted'));
        });
      } finally {
        idb.close();
      }
    },
  };
}

/* 纯 Node/测试回退：进程内 Map，标 dev-only。 */
function createMemoryPersistence(): DbPersistence {
  const data = new Map<string, Uint8Array>();
  return {
    async read(): Promise<Uint8Array | null> {
      return data.get('default') ?? null;
    },
    async write(bytes: Uint8Array): Promise<void> {
      data.set('default', new Uint8Array(bytes));
    },
  };
}

/* ------------------------------------------------------------------ */
/* 默认选择                                                             */
/* ------------------------------------------------------------------ */

function hasTauriIpc(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

let tauriInvokePromise: Promise<InvokeFn> | null = null;
function getTauriInvoke(): Promise<InvokeFn> {
  tauriInvokePromise ??= import('@tauri-apps/api/core').then(
    (mod) => mod.invoke as unknown as InvokeFn,
  );
  return tauriInvokePromise;
}

/**
 * 创建默认持久化句柄：Tauri → app_data_dir 文件（Rust 命令）；
 * 浏览器 dev → IndexedDB；纯 Node → 内存。缺省文件名 vistaverge.sqlite3。
 */
export function createPersistence(fileName = 'vistaverge.sqlite3'): PersistenceHandle {
  if (hasTauriIpc()) {
    const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> =>
      (await getTauriInvoke())(cmd, args);
    return { kind: 'tauri', devOnly: false, ...createTauriPersistence(invoke, fileName) };
  }
  if (hasIndexedDb()) {
    return { kind: 'indexeddb', devOnly: true, ...createIndexedDbPersistence(fileName) };
  }
  return { kind: 'memory', devOnly: true, ...createMemoryPersistence() };
}
