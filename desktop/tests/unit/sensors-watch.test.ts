/**
 * 感知域新增能力（FEATURE-01 / G-SENSE-01..04、B-P-03）：
 * - 静默开关真正影响提醒引擎（关=不抑制，开=抑制，运行时立即生效）；
 * - 16℃ 一小时持续判定（区分实测/设定、断线未知、安静时段、每小时额度）；
 * - 照度偏低提醒（额度、安静时段、占用缺失不阻塞）；
 * - HA 控制授权门（默认关 + 每次显式确认；未授权零写操作）；
 * - haClient call_service / readIlluminance 协议帧。
 *
 * 无真实 HA 实例：用注入 fake 验证逻辑，不伪造真实 HA 验收。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createReminderEngine,
  DEFAULT_DEDUPE_WINDOW_MS,
  type ReminderEngineDeps,
} from '../../src/sensors/reminders';
import {
  createTemperatureWatch,
  DEFAULT_LOW_DURATION_MS,
  DEFAULT_TEMP_THRESHOLD_C,
} from '../../src/sensors/temperatureWatch';
import { createLightWatch, DEFAULT_LUX_THRESHOLD } from '../../src/sensors/lightWatch';
import { authorizeHaControl } from '../../src/sensors/haControl';
import { createHaClient, type WebSocketLike } from '../../src/sensors/haClient';
import type { WeatherSnapshot } from '../../src/sensors/weather';

const NOW = new Date('2026-09-19T10:00:00+08:00').getTime();
const HOUR = 3_600_000;

function freshWeather(): WeatherSnapshot {
  return {
    data: { temperatureC: 21.5, apparentC: 20, weatherCode: 3, windKph: 8, isDay: true, description: '阴' },
    observedAt: NOW,
    expiresAt: NOW + 900_000,
    confidence: 'high',
    source: 'open-meteo',
    location: { latitude: 39.9, longitude: 116.4 },
    stale: false,
  };
}

/* ------------------------------------------------------------------ */
/* G-SENSE-04 / B-P-03 静默开关                                          */
/* ------------------------------------------------------------------ */

describe('静默开关真正生效（B-P-03/G-SENSE-04）', () => {
  function engine(overrides: Partial<ReminderEngineDeps> = {}, quietHours: ReminderEngineDeps['quietHours'] = null) {
    let now = NOW;
    const created = createReminderEngine({
      now: () => now,
      quietHours,
      getWeather: async () => freshWeather(),
      searchMemory: () => [],
      ...overrides,
    });
    return { created, advance: (ms: number) => (now += ms) };
  }

  it('关=不抑制；开=抑制；再关恢复（运行时切换立即生效）', async () => {
    const { created, advance } = engine();
    const off = await created.handleMessage('我要出去');
    expect(off.suppressed).toBe(false);
    expect(off.reminder).not.toBeNull();

    // 运行时打开静默：同一引擎下一次触发被抑制。
    created.setQuietEnabled(true);
    expect(created.quietEnabled()).toBe(true);
    advance(DEFAULT_DEDUPE_WINDOW_MS + 1);
    const on = await created.handleMessage('我要出去');
    expect(on.suppressed).toBe(true);
    expect(on.reason).toBe('quiet-mode');
    expect(on.reminder).toBeNull();

    // 再关掉：恢复提醒。
    created.setQuietEnabled(false);
    advance(DEFAULT_DEDUPE_WINDOW_MS + 1);
    const again = await created.handleMessage('我要出去');
    expect(again.suppressed).toBe(false);
    expect(again.reminder).not.toBeNull();
  });

  it('静默开启时用户显式 force 仍可放行', async () => {
    const { created } = engine({ quietEnabled: true });
    const forced = await created.handleMessage('我要出去', { force: true });
    expect(forced.suppressed).toBe(false);
    expect(forced.reminder).not.toBeNull();
  });

  it('安静时段（时间窗）抑制原因仍是 quiet-hours（不误报为静默）', async () => {
    const { created } = engine({}, { start: 0, end: 24 });
    const out = await created.handleMessage('我要出去');
    expect(out.suppressed).toBe(true);
    expect(out.reason).toBe('quiet-hours');
  });
});

/* ------------------------------------------------------------------ */
/* G-SENSE-01 16℃ 一小时                                                */
/* ------------------------------------------------------------------ */

describe('16℃ 一小时持续判定（G-SENSE-01）', () => {
  it('阈值/时长默认值符合设计（16℃、1 小时）', () => {
    expect(DEFAULT_TEMP_THRESHOLD_C).toBe(16);
    expect(DEFAULT_LOW_DURATION_MS).toBe(HOUR);
  });

  it('只有设定值：持续到 1 小时才提醒，且文案标注「设定值，不是实测」', () => {
    let t = NOW;
    const emit = vi.fn();
    const watch = createTemperatureWatch({ now: () => t, quietHours: null, emit });
    const early = watch.sample({ setpointC: 15, measuredC: null, available: true });
    expect(early.status).toBe('accumulating');
    expect(early.heldMs).toBe(0);

    t = NOW + HOUR - 1000;
    expect(watch.sample({ setpointC: 15, measuredC: null, available: true }).status).toBe('accumulating');

    t = NOW + HOUR;
    const hit = watch.sample({ setpointC: 15, measuredC: null, available: true });
    expect(hit.status).toBe('triggered');
    expect(hit.source).toBe('setpoint');
    expect(hit.text).toContain('设定值');
    expect(hit.text).toContain('不是实测');
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('有实测值：用实测并区分表述；不出现医学结论', () => {
    let t = NOW;
    const watch = createTemperatureWatch({ now: () => t, quietHours: null });
    watch.sample({ setpointC: 24, measuredC: 15, available: true });
    t = NOW + HOUR;
    const hit = watch.sample({ setpointC: 24, measuredC: 15, available: true });
    expect(hit.status).toBe('triggered');
    expect(hit.source).toBe('measured');
    expect(hit.text).toContain('实测');
    expect(hit.text).not.toMatch(/感冒|健康|诊断|疾病|生病/);
  });

  it('温度回到阈值以上会重置持续计时', () => {
    let t = NOW;
    const watch = createTemperatureWatch({ now: () => t, quietHours: null });
    watch.sample({ setpointC: 15, measuredC: null, available: true });
    t = NOW + 30 * 60_000;
    watch.sample({ setpointC: 20, measuredC: null, available: true }); // 回升
    t = NOW + 40 * 60_000;
    const again = watch.sample({ setpointC: 15, measuredC: null, available: true });
    expect(again.status).toBe('accumulating');
    expect(again.heldMs).toBe(0);
  });

  it('断线/不可用：状态未知，不生成确定性陈述', () => {
    const watch = createTemperatureWatch({ now: () => NOW, quietHours: null });
    const out = watch.sample({ setpointC: null, measuredC: null, available: false });
    expect(out.status).toBe('unknown');
    expect(out.text).toBeNull();
    expect(out.heldMs).toBe(0);
  });

  it('安静时段抑制不丢状态，解除后仍可基于同一段偏低提醒', () => {
    let t = NOW;
    const watch = createTemperatureWatch({ now: () => t, quietHours: null, quietEnabled: true });
    watch.sample({ setpointC: 15, measuredC: null, available: true });
    t = NOW + HOUR;
    expect(watch.sample({ setpointC: 15, measuredC: null, available: true }).status).toBe('suppressed');
    watch.setQuietEnabled(false);
    const hit = watch.sample({ setpointC: 15, measuredC: null, available: true });
    expect(hit.status).toBe('triggered');
  });

  it('每小时额度（默认 2）用完后不再提醒', () => {
    let t = NOW;
    const watch = createTemperatureWatch({ now: () => t, quietHours: null, durationMs: 0, hourlyQuota: 2 });
    expect(watch.sample({ setpointC: 15, measuredC: null, available: true }).status).toBe('triggered');
    t += 1000;
    expect(watch.sample({ setpointC: 15, measuredC: null, available: true }).status).toBe('triggered');
    t += 1000;
    expect(watch.sample({ setpointC: 15, measuredC: null, available: true }).status).toBe('quota-exceeded');
  });
});

/* ------------------------------------------------------------------ */
/* G-SENSE-02 照度                                                      */
/* ------------------------------------------------------------------ */

describe('照度偏低提醒（G-SENSE-02）', () => {
  it('默认阈值可配；低于阈值触发「有点暗」提醒且无医学结论', () => {
    expect(DEFAULT_LUX_THRESHOLD).toBeGreaterThan(0);
    const watch = createLightWatch({ now: () => NOW, quietHours: null });
    const out = watch.sample({ lux: 20, available: true });
    expect(out.status).toBe('triggered');
    expect(out.text).toMatch(/暗|开灯/);
    expect(out.text).not.toMatch(/感冒|健康|诊断|疾病/);
  });

  it('照度充足 / 实体不可用 / 明确无人时都不提醒', () => {
    const watch = createLightWatch({ now: () => NOW, quietHours: null });
    expect(watch.sample({ lux: 300, available: true }).status).toBe('normal');
    expect(watch.sample({ lux: null, available: false }).status).toBe('unknown');
    expect(watch.sample({ lux: 10, available: true, occupied: false }).status).toBe('normal');
    // 占用未知不阻塞保守提醒
    expect(watch.sample({ lux: 10, available: true, occupied: null }).status).toBe('triggered');
  });

  it('静默开启时抑制；额度用完后不再提醒', () => {
    let t = NOW;
    const watch = createLightWatch({ now: () => t, quietHours: null, quietEnabled: true, hourlyQuota: 1 });
    expect(watch.sample({ lux: 10, available: true }).status).toBe('suppressed');
    watch.setQuietEnabled(false);
    expect(watch.sample({ lux: 10, available: true }).status).toBe('triggered');
    t += 600_001;
    expect(watch.sample({ lux: 10, available: true }).status).toBe('quota-exceeded');
  });
});

/* ------------------------------------------------------------------ */
/* G-SENSE-03 HA 控制授权门                                             */
/* ------------------------------------------------------------------ */

describe('HA 控制授权门（G-SENSE-03）', () => {
  const request = { entityId: 'climate.living_room', action: 'turn_on' as const, label: '开空调' };

  it('授权门默认关：直接拒绝且零写操作', async () => {
    const callService = vi.fn(async () => ({ ok: true }));
    const result = await authorizeHaControl(request, {
      controlEnabled: false,
      connected: true,
      confirm: () => true,
      callService,
    });
    expect(result).toMatchObject({ ok: false, error: 'control-disabled' });
    expect(callService).not.toHaveBeenCalled();
  });

  it('未连接：拒绝且零写操作', async () => {
    const callService = vi.fn(async () => ({ ok: true }));
    const result = await authorizeHaControl(request, {
      controlEnabled: true,
      connected: false,
      confirm: () => true,
      callService,
    });
    expect(result).toMatchObject({ ok: false, error: 'not-connected' });
    expect(callService).not.toHaveBeenCalled();
  });

  it('缺少每次确认回调：拒绝（confirmation-required）', async () => {
    const callService = vi.fn(async () => ({ ok: true }));
    const result = await authorizeHaControl(request, {
      controlEnabled: true,
      connected: true,
      confirm: null,
      callService,
    });
    expect(result).toMatchObject({ ok: false, error: 'confirmation-required' });
    expect(callService).not.toHaveBeenCalled();
  });

  it('用户未确认：拒绝且零写操作', async () => {
    const callService = vi.fn(async () => ({ ok: true }));
    const result = await authorizeHaControl(request, {
      controlEnabled: true,
      connected: true,
      confirm: () => false,
      callService,
    });
    expect(result).toMatchObject({ ok: false, error: 'not-confirmed' });
    expect(callService).not.toHaveBeenCalled();
  });

  it('授权门开 + 已连接 + 用户确认：才下发 call_service', async () => {
    const callService = vi.fn(async () => ({ ok: true }));
    const result = await authorizeHaControl(request, {
      controlEnabled: true,
      connected: true,
      confirm: () => true,
      callService,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: true, executedAt: NOW });
    expect(callService).toHaveBeenCalledWith('climate', 'turn_on', { entity_id: 'climate.living_room' });
  });

  it('服务端拒绝：如实返回失败，不谎报成功', async () => {
    const result = await authorizeHaControl(request, {
      controlEnabled: true,
      connected: true,
      confirm: () => true,
      callService: async () => ({ ok: false, error: '服务不可用' }),
    });
    expect(result).toMatchObject({ ok: false, error: 'service-error' });
    expect(result.reason).toContain('服务不可用');
  });
});

/* ------------------------------------------------------------------ */
/* haClient 协议帧                                                      */
/* ------------------------------------------------------------------ */

class FakeHaSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();

  constructor(public url: string) {
    queueMicrotask(() => this.emit('message', { type: 'auth_required' }));
  }

  send(data: string): void {
    this.sent.push(data);
    const parsed = JSON.parse(data) as { type?: string; id?: number; domain?: string; service?: string };
    if (parsed.type === 'auth') this.emit('message', { type: 'auth_ok' });
    if (parsed.type === 'get_states') {
      this.emit('message', {
        id: parsed.id,
        type: 'result',
        success: true,
        result: [
          {
            entity_id: 'sensor.living_lux',
            state: '35',
            attributes: { device_class: 'illuminance', unit_of_measurement: 'lx' },
            last_updated: new Date(NOW).toISOString(),
          },
          {
            entity_id: 'sensor.dark_lux',
            state: 'unavailable',
            attributes: { device_class: 'illuminance' },
            last_updated: new Date(NOW).toISOString(),
          },
        ],
      });
    }
    if (parsed.type === 'call_service') {
      this.emit('message', { id: parsed.id, type: 'result', success: true, result: [] });
    }
  }

  close(): void {
    this.emit('close', {});
  }

  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((l) => l !== listener));
  }

  emit(type: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(payload) });
  }
}

describe('haClient call_service / readIlluminance', () => {
  it('call_service 发出真实写命令并返回结果；readIlluminance 区分可用性', async () => {
    const sockets: FakeHaSocket[] = [];
    class TrackingSocket extends FakeHaSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const client = createHaClient(
      { url: 'http://ha.local:8123', token: 't' },
      { WebSocket: TrackingSocket as unknown as new (url: string) => WebSocketLike },
    );
    expect((await client.connect()).ok).toBe(true);
    await client.getStates();

    expect((await client.readIlluminance('sensor.living_lux'))?.lux).toBe(35);
    expect((await client.readIlluminance('sensor.dark_lux'))?.available).toBe(false);

    const result = await client.callService('climate', 'turn_on', { entity_id: 'climate.living_room' });
    expect(result.ok).toBe(true);
    const frame = sockets[0]?.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'call_service');
    expect(frame).toMatchObject({
      type: 'call_service',
      domain: 'climate',
      service: 'turn_on',
      service_data: { entity_id: 'climate.living_room' },
    });
  });

  it('未配置/未连接时 call_service 如实拒绝，不伪造成功', async () => {
    const blocked = createHaClient({});
    expect((await blocked.callService('climate', 'turn_on')).ok).toBe(false);
    const offline = createHaClient({ url: 'http://ha.local:8123', token: 't' }, {
      WebSocket: FakeHaSocket as unknown as new (url: string) => WebSocketLike,
    });
    const notConnected = await offline.callService('climate', 'turn_on');
    expect(notConnected.ok).toBe(false);
    expect(notConnected.error).toMatch(/未连接/);
  });
});

/* ------------------------------------------------------------------ */
/* perceptionStore 接线                                                 */
/* ------------------------------------------------------------------ */

describe('perceptionStore 静默开关接线', () => {
  it('setQuietEnabled 影响引擎：开启后出门提醒被抑制（不发网络请求即返回）', async () => {
    const mod = await import('../../src/sensors/perceptionStore');
    mod.resetPerception();
    mod.setQuietEnabled(true);
    expect(mod.perception.quietEnabled).toBe(true);
    await mod.maybeHandleOuting('我要出去');
    expect(mod.perception.reminders).toHaveLength(0);
    expect(mod.perception.lastReminderNote).toMatch(/不主动打扰/);

    mod.setQuietEnabled(false);
    expect(mod.perception.quietEnabled).toBe(false);
    mod.resetPerception();
  });
});
