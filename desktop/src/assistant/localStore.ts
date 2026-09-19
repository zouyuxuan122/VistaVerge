/**
 * assistant/localStore.ts — 助手域的本地键值存储小工具。
 *
 * 巡检快照与社媒草稿都是「本地持久化」的非机密数据（token 绝不落这里，只走
 * platform/credentials 的 OS 凭据仓）。浏览器/Vite 下用 localStorage；纯 Node
 * 测试注入 StorageLike；无存储权限时降级为仅会话内生效（不抛错、不伪造持久化）。
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 默认存储：无 localStorage（纯 Node / 隐私模式）时返回 null，调用方降级为内存。 */
export function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // 某些隐私模式访问 localStorage 即抛错。
    return null;
  }
}

/** 读取并解析 JSON；缺失/损坏一律返回 null（不猜内容）。 */
export function readJson<T>(storage: StorageLike | null, key: string): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw === '') return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 写入 JSON；无存储权限时静默降级（仅会话内生效）。 */
export function writeJson(storage: StorageLike | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额/权限问题：不阻断主流程，数据只在内存里 */
  }
}

export function removeKey(storage: StorageLike | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* 同上 */
  }
}
