import { describe, expect, it } from 'vitest';
import {
  createCredentialStore,
  createMemoryCredentialBackend,
  createTauriCredentialBackend,
  deleteSecret,
  getSecret,
  setSecret,
  type CredentialBackend,
} from '../../src/platform/credentials';
import { createPersistence, createTauriPersistence } from '../../src/platform/persistence';

describe('platform/credentials：可注入后端与 Tauri 命令契约', () => {
  function makeFakeBackend(): CredentialBackend & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      kind: 'memory',
      data,
      async set(key, value) {
        data.set(key, value);
      },
      async get(key) {
        return data.get(key) ?? null;
      },
      async delete(key) {
        return data.delete(key);
      },
    };
  }

  it('注入后端：set/get 往返、覆盖写、删除后为 null、删除缺失返回 false', async () => {
    const backend = makeFakeBackend();
    const store = createCredentialStore(backend);
    expect(store.backendKind).toBe('memory');
    expect(store.devOnly).toBe(true);

    await store.setSecret('api-key', 'v1');
    expect(await store.getSecret('api-key')).toBe('v1');
    await store.setSecret('api-key', 'v2');
    expect(await store.getSecret('api-key')).toBe('v2');
    expect(await store.getSecret('missing')).toBeNull();

    expect(await store.deleteSecret('api-key')).toBe(true);
    expect(await store.getSecret('api-key')).toBeNull();
    expect(await store.deleteSecret('api-key')).toBe(false);
    expect(await store.getSecret('')).toBeNull();
  });

  it('Tauri 后端命令契约：invoke("set_secret"/"get_secret"/"delete_secret") 参数名与返回值', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const data = new Map<string, string>();
    const fakeInvoke = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'set_secret') {
        data.set(String(args?.key), String(args?.value));
        return null;
      }
      if (cmd === 'get_secret') return data.get(String(args?.key)) ?? null;
      if (cmd === 'delete_secret') return data.delete(String(args?.key));
      throw new Error(`unexpected command: ${cmd}`);
    };
    const backend = createTauriCredentialBackend(fakeInvoke);
    expect(backend.kind).toBe('tauri');
    await backend.set('llm-api-key', 'sk-test');
    expect(await backend.get('llm-api-key')).toBe('sk-test');
    expect(await backend.get('not-set')).toBeNull();
    expect(await backend.delete('llm-api-key')).toBe(true);
    expect(await backend.delete('llm-api-key')).toBe(false);

    expect(calls.map((c) => c.cmd)).toEqual([
      'set_secret',
      'get_secret',
      'get_secret',
      'delete_secret',
      'delete_secret',
    ]);
    expect(calls[0]?.args).toEqual({ key: 'llm-api-key', value: 'sk-test' });
    expect(calls[1]?.args).toEqual({ key: 'llm-api-key' });
    // Tauri 侧 Rust 命令名固定为 set/get/delete_secret（service=VistaVerge 由 Rust 侧持有）
  });

  it('纯 Node 默认后端：memory 回退并标 dev-only；模块级 setSecret/getSecret/deleteSecret 可用', async () => {
    const store = createCredentialStore();
    expect(store.backendKind).toBe('memory');
    expect(store.devOnly).toBe(true);

    await setSecret('gk', 'gv');
    expect(await getSecret('gk')).toBe('gv');
    expect(await deleteSecret('gk')).toBe(true);
    expect(await getSecret('gk')).toBeNull();
    // store 与模块级函数共享默认后端
    await store.setSecret('k2', 'v2');
    expect(await getSecret('k2')).toBe('v2');
    expect(await deleteSecret('k2')).toBe(true);
  });

  it('createMemoryCredentialBackend 可重复独立创建', async () => {
    const a = createMemoryCredentialBackend();
    const b = createMemoryCredentialBackend();
    await a.set('k', 'a');
    expect(await b.get('k')).toBeNull();
  });
});

describe('platform/persistence：Node 侧回退与 Tauri 命令契约', () => {
  it('纯 Node：内存回退标 dev-only，write→read 往返', async () => {
    const p = createPersistence('vistaverge.sqlite3');
    expect(p.kind).toBe('memory');
    expect(p.devOnly).toBe(true);
    expect(await p.read()).toBeNull();

    const bytes = new Uint8Array([1, 2, 3, 250]);
    await p.write(bytes);
    expect(await p.read()).toEqual(bytes);
  });

  it('Tauri 持久化命令契约：invoke("db_read_file"/"db_write_file") 参数与返回', async () => {
    const store = new Map<string, Uint8Array>();
    const fakeInvoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'db_read_file') {
        const v = store.get(String(args?.name));
        return v ? Array.from(v) : null;
      }
      if (cmd === 'db_write_file') {
        const arr = args?.data;
        if (!Array.isArray(arr)) throw new Error('db_write_file: data 必须是字节数组');
        store.set(String(args?.name), new Uint8Array(arr));
        return null;
      }
      throw new Error(`unexpected command: ${cmd}`);
    };
    const p = createTauriPersistence(fakeInvoke, 'vistaverge.sqlite3');
    expect(await p.read()).toBeNull();
    await p.write(new Uint8Array([9, 8, 7]));
    expect(await p.read()).toEqual(new Uint8Array([9, 8, 7]));
  });
});
