// EXP-006 工具注册表与权限裁决测试。
// 合同（任务书 plugins/tools.ts）：registerTool/runTool；ctx 含权限裁决；
// 未知工具拒绝；内置 memory.search / weather.get / time.now / reminder.create；
// 工具返回带不可信标记（外部/记忆内容不得作为指令）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, initDb } from '../../src/data/db';
import { proposeWrite } from '../../src/data/memory';
import {
  BUILTIN_TOOL_NAMES,
  getTool,
  listTools,
  registerBuiltinTools,
  registerTool,
  resetTools,
  runTool,
  unregisterTool,
  type ToolDefinition,
} from '../../src/plugins/tools';
import { WeatherError, type WeatherSnapshot } from '../../src/sensors/weather';

const NOW = 1_700_000_000_000;

const ctx = (granted: string[] = []) => ({ granted, actor: 'test' });

function demo(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'demo.echo',
    describe: '回显参数',
    schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    permissions: ['demo:run'],
    resultUntrusted: false,
    execute: (args) => ({ echo: args.value }),
    ...overrides,
  };
}

const freshSnapshot = (): WeatherSnapshot => ({
  data: {
    temperatureC: 21.5,
    apparentC: 20,
    weatherCode: 3,
    windKph: 8,
    isDay: true,
    description: '阴',
  },
  observedAt: NOW,
  expiresAt: NOW + 900_000,
  confidence: 'high',
  source: 'open-meteo',
  location: { latitude: 31.23, longitude: 121.47, label: '上海' },
  stale: false,
});

beforeEach(() => {
  resetTools();
});

afterEach(() => {
  closeDb();
});

describe('工具注册表', () => {
  it('注册后可查询与列出，注销生效，重名注册被拒绝', () => {
    registerTool(demo());
    expect(getTool('demo.echo')?.describe).toBe('回显参数');
    expect(listTools().map((t) => t.name)).toEqual(['demo.echo']);
    expect(() => registerTool(demo())).toThrow(/已注册|重复/);
    expect(unregisterTool('demo.echo')).toBe(true);
    expect(unregisterTool('demo.echo')).toBe(false);
    expect(getTool('demo.echo')).toBeUndefined();
  });

  it('非法工具名（缺命名空间/大写）注册被拒绝', () => {
    expect(() => registerTool(demo({ name: 'echo' }))).toThrow();
    expect(() => registerTool(demo({ name: 'Demo.Echo' }))).toThrow();
  });

  it('未知工具调用返回 unknown-tool，且不抛异常', async () => {
    const result = await runTool('nope.nope', {}, ctx([]));
    expect(result).toMatchObject({ ok: false, error: 'unknown-tool', untrusted: false });
  });

  it('未授予权限时拒绝执行，并给出缺失权限列表；execute 从未被调用', async () => {
    const execute = vi.fn(() => ({ echo: 'x' }));
    registerTool(demo({ execute }));
    const result = await runTool('demo.echo', { value: 'x' }, ctx([]));
    expect(result).toMatchObject({
      ok: false,
      error: 'permission-denied',
      missingPermissions: ['demo:run'],
      tool: 'demo.echo',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('授予全部权限后执行成功；不可信结果带 untrusted 标记', async () => {
    registerTool(demo());
    registerTool(demo({ name: 'demo.untrusted', permissions: [], resultUntrusted: true }));
    const ok = await runTool('demo.echo', { value: 'hi' }, ctx(['demo:run']));
    expect(ok).toMatchObject({ ok: true, tool: 'demo.echo', untrusted: false });
    expect(ok.value).toEqual({ echo: 'hi' });

    const untrusted = await runTool('demo.untrusted', {}, ctx([]));
    expect(untrusted).toMatchObject({ ok: true, untrusted: true });
  });

  it('工具内部抛错转为 tool-error 结果，不向调用方抛异常', async () => {
    registerTool(
      demo({
        execute: () => {
          throw new Error('boom');
        },
      }),
    );
    const result = await runTool('demo.echo', {}, ctx(['demo:run']));
    expect(result).toMatchObject({ ok: false, error: 'tool-error', tool: 'demo.echo' });
    expect(result.message).toContain('boom');
  });
});

describe('内置工具', () => {
  it('registerBuiltinTools 注册四件套', () => {
    registerBuiltinTools();
    expect(listTools().map((t) => t.name).sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
    expect(getTool('memory.search')?.permissions).toContain('memory:read');
    expect(getTool('time.now')?.permissions).toEqual([]);
  });

  it('memory.search 经数据层检索，未授权拒绝，命中内容标 untrusted', async () => {
    await initDb();
    proposeWrite({ kind: 'fact', text: '我把签字材料放在书房抽屉里', tags: ['资料'] });
    registerBuiltinTools({ now: () => NOW });

    const denied = await runTool('memory.search', { query: '书房抽屉' }, ctx([]));
    expect(denied.error).toBe('permission-denied');

    const ok = await runTool('memory.search', { query: '书房抽屉' }, ctx(['memory:read']));
    expect(ok.ok).toBe(true);
    expect(ok.untrusted).toBe(true);
    const hits = ok.value as { text: string }[];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toContain('签字材料');
  });

  it('time.now 无需权限，使用注入时钟', async () => {
    registerBuiltinTools({ now: () => NOW });
    const result = await runTool('time.now', {}, ctx([]));
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ nowMs: NOW });
    expect(result.untrusted).toBe(false);
  });

  it('weather.get 离线时返回 tool-error，不伪造天气数据', async () => {
    registerBuiltinTools({
      now: () => NOW,
      getWeather: () => Promise.reject(new WeatherError('offline', '网络不可用')),
    });
    const denied = await runTool('weather.get', {}, ctx([]));
    expect(denied.error).toBe('permission-denied');
    expect(denied.missingPermissions).toEqual(['network:weather']);

    const result = await runTool('weather.get', { latitude: 31.2, longitude: 121.4 }, ctx(['network:weather']));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('tool-error');
    expect(result.value).toBeUndefined();
    expect(result.untrusted).toBe(true);
  });

  it('weather.get 成功返回带 observedAt/expiresAt 的快照', async () => {
    registerBuiltinTools({ now: () => NOW, getWeather: async () => freshSnapshot() });
    const result = await runTool(
      'weather.get',
      { latitude: 31.23, longitude: 121.47 },
      ctx(['network:weather']),
    );
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ observedAt: NOW, expiresAt: NOW + 900_000, source: 'open-meteo' });
  });

  it('reminder.create 需 notify:reminder，写入注入 sink', async () => {
    const createReminder = vi.fn(() => ({ id: 'r1' }));
    registerBuiltinTools({ now: () => NOW, createReminder });
    const denied = await runTool('reminder.create', { text: '出门带伞' }, ctx([]));
    expect(denied.error).toBe('permission-denied');

    const result = await runTool('reminder.create', { text: '出门带伞' }, ctx(['notify:reminder']));
    expect(result.ok).toBe(true);
    expect(createReminder).toHaveBeenCalledWith(expect.objectContaining({ text: '出门带伞' }));
    expect(result.value).toEqual({ id: 'r1' });
  });

  it('reminder.create 参数非法时拒绝（空文本）', async () => {
    registerBuiltinTools({ now: () => NOW, createReminder: () => ({ id: 'r1' }) });
    const result = await runTool('reminder.create', { text: '   ' }, ctx(['notify:reminder']));
    expect(result).toMatchObject({ ok: false, error: 'invalid-args' });
  });
});
