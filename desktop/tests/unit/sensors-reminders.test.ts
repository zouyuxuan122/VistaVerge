// EXP-006 出门提醒规则测试（DOMAIN_PLUGINS §1.3、§2 天气行）：
// 触发词 → 新鲜天气 + tag:出行 记忆 → 合并为一条；安静时段抑制；
// 会话内去重；反证取消；天气过期必须说明不确定、不胡编。
import { describe, expect, it, vi } from 'vitest';
import type { MemoryHit } from '../../src/data/memory';
import {
  DEFAULT_DEDUPE_WINDOW_MS,
  DEFAULT_QUIET_HOURS,
  OUTING_TRIGGERS,
  createReminderEngine,
  detectCounterEvidence,
  detectOutingTrigger,
  isQuietNow,
  type ReminderEngineDeps,
} from '../../src/sensors/reminders';
import type { WeatherSnapshot } from '../../src/sensors/weather';

const NOW = new Date('2026-09-19T10:00:00+08:00').getTime();
const HOUR = 3_600_000;

function hit(id: string, text: string, tags: string[] = ['出行']): MemoryHit {
  return {
    id,
    text,
    tags,
    kind: 'todo',
    scope: 'personal',
    createdAt: NOW,
    score: 1,
    stale: false,
    status: 'active',
    supersedes: null,
    expiresAt: null,
  };
}

function freshWeather(): WeatherSnapshot {
  return {
    data: { temperatureC: 21.5, apparentC: 20.1, weatherCode: 61, windKph: 8, isDay: true, description: '小雨' },
    observedAt: NOW,
    expiresAt: NOW + 15 * 60_000,
    confidence: 'high',
    source: 'open-meteo',
    location: { latitude: 31.23, longitude: 121.47 },
    stale: false,
  };
}

function staleWeather(): WeatherSnapshot {
  return { ...freshWeather(), observedAt: NOW - HOUR, expiresAt: NOW - HOUR + 60_000, stale: true };
}

function engine(deps: Partial<ReminderEngineDeps> = {}, quietHours: ReminderEngineDeps['quietHours'] = null) {
  let now = NOW;
  const emit = vi.fn();
  const created = createReminderEngine({
    now: () => now,
    quietHours,
    getWeather: async () => freshWeather(),
    searchMemory: () => [hit('m1', '今天要带资料去学校'), hit('m2', '下午三点开会')],
    emit,
    ...deps,
  });
  return { created, emit, advance: (ms: number) => (now += ms) };
}

describe('触发词与安静时段判定', () => {
  it('识别出门触发词，普通语句不触发', () => {
    for (const trigger of OUTING_TRIGGERS) {
      expect(detectOutingTrigger(`好的，${trigger}`), trigger).toBe(trigger);
    }
    expect(detectOutingTrigger('我要出去了，再见')).toBe('我要出去');
    expect(detectOutingTrigger('今天天气怎么样')).toBeNull();
    expect(detectOutingTrigger('')).toBeNull();
  });

  it('识别反证语句（已带伞 / 不出门）', () => {
    expect(detectCounterEvidence('我已经带伞了')).not.toBeNull();
    expect(detectCounterEvidence('今天不出门了')).not.toBeNull();
    expect(detectCounterEvidence('我出门了')).toBeNull();
  });

  it('isQuietNow 覆盖跨午夜与同日区间，边界为左闭右开', () => {
    const night = { start: 22, end: 7 };
    expect(isQuietNow(new Date('2026-09-19T23:30:00'), night)).toBe(true);
    expect(isQuietNow(new Date('2026-09-19T03:00:00'), night)).toBe(true);
    expect(isQuietNow(new Date('2026-09-19T07:00:00'), night)).toBe(false);
    expect(isQuietNow(new Date('2026-09-19T21:59:00'), night)).toBe(false);
    expect(isQuietNow(new Date('2026-09-19T12:00:00'), night)).toBe(false);

    const afternoon = { start: 13, end: 15 };
    expect(isQuietNow(new Date('2026-09-19T13:00:00'), afternoon)).toBe(true);
    expect(isQuietNow(new Date('2026-09-19T14:59:00'), afternoon)).toBe(true);
    expect(isQuietNow(new Date('2026-09-19T15:00:00'), afternoon)).toBe(false);
    expect(isQuietNow(new Date('2026-09-19T12:00:00'), afternoon)).toBe(false);
    expect(DEFAULT_QUIET_HOURS).toEqual({ start: 22, end: 7 });
  });
});

describe('出门提醒：天气 + 记忆合并为一条', () => {
  it('触发后只产生一条提醒，同时含天气与出行记忆', async () => {
    const { created, emit } = engine();
    const outcome = await created.handleMessage('我要出去了，再见');
    expect(outcome.triggered).toBe(true);
    expect(outcome.duplicate).toBe(false);
    expect(outcome.suppressed).toBe(false);
    expect(outcome.uncertain).toBe(false);
    expect(outcome.reminder).not.toBeNull();
    expect(created.list()).toHaveLength(1);
    expect(emit).toHaveBeenCalledTimes(1);

    const reminder = outcome.reminder!;
    expect(reminder.kind).toBe('outing');
    expect(reminder.text).toContain('小雨');
    expect(reminder.text).toContain('资料');
    expect(reminder.parts.weather).toContain('21.5');
    expect(reminder.parts.memory).toContain('资料');
    expect(reminder.source).toBe('sensors/reminders');
  });

  it('无出行记忆时不编造记忆内容，仍给出天气提醒', async () => {
    const { created } = engine({ searchMemory: () => [] });
    const outcome = await created.handleMessage('出门了');
    expect(outcome.reminder?.parts.memory).toBeUndefined();
    expect(outcome.reminder?.text).toContain('小雨');
    expect(outcome.reminder?.text).not.toContain('资料');
  });

  it('天气过期时 uncertain=true，文案说明不确定且不含实时温度', async () => {
    const { created } = engine({ getWeather: async () => staleWeather() });
    const outcome = await created.handleMessage('我要出去');
    expect(outcome.uncertain).toBe(true);
    expect(outcome.reminder?.text).toMatch(/不确定|过期|无法确认/);
    expect(outcome.reminder?.text).not.toContain('21.5');
  });

  it('天气获取失败时说明不确定，不抛出、不伪造', async () => {
    const { created } = engine({
      getWeather: () => Promise.reject(new Error('offline')),
    });
    const outcome = await created.handleMessage('我要出去');
    expect(outcome.triggered).toBe(true);
    expect(outcome.uncertain).toBe(true);
    expect(outcome.reminder?.text).toMatch(/不确定|无法确认|不可用/);
  });
});

describe('出门提醒：去重、安静时段、反证取消', () => {
  it('会话窗口内重复触发被去重，仍只有一条提醒', async () => {
    const { created, advance, emit } = engine();
    await created.handleMessage('我要出去');
    advance(60_000);
    const second = await created.handleMessage('出门了');
    expect(second.duplicate).toBe(true);
    expect(second.reminder).toBeNull();
    expect(created.list()).toHaveLength(1);
    expect(emit).toHaveBeenCalledTimes(1);

    advance(DEFAULT_DEDUPE_WINDOW_MS + 1);
    const third = await created.handleMessage('再见');
    expect(third.duplicate).toBe(false);
    expect(created.list()).toHaveLength(2);
  });

  it('安静时段抑制主动提醒，用户明确要求（force）时放行', async () => {
    const quiet = { start: 0, end: 24 };
    const { created, emit } = engine({}, quiet);
    const suppressed = await created.handleMessage('我要出去');
    expect(suppressed.triggered).toBe(true);
    expect(suppressed.suppressed).toBe(true);
    expect(suppressed.reason).toBe('quiet-hours');
    expect(suppressed.reminder).toBeNull();
    expect(created.list()).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();

    const forced = await created.handleMessage('我要出去', { force: true });
    expect(forced.suppressed).toBe(false);
    expect(forced.reminder).not.toBeNull();
    expect(created.list()).toHaveLength(1);
  });

  it('安静时段被抑制不占用去重窗口（之后仍可提醒）', async () => {
    let now = NOW;
    const created = createReminderEngine({
      now: () => now,
      quietHours: { start: 0, end: 24 },
      getWeather: async () => freshWeather(),
      searchMemory: () => [hit('m1', '带资料')],
    });
    await created.handleMessage('我要出去');
    expect(created.list()).toHaveLength(0);
    now = NOW;
    const forced = await created.handleMessage('我要出去', { force: true });
    expect(forced.duplicate).toBe(false);
    expect(created.list()).toHaveLength(1);
  });

  it('反证（已带伞 / 不出门）取消提醒，取消后可再次触发', async () => {
    const { created } = engine();
    await created.handleMessage('我要出去');
    expect(created.list()).toHaveLength(1);

    const cancelled = await created.handleMessage('我已经带伞了，不出门了');
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.reminder).toBeNull();
    expect(created.list()).toHaveLength(0);

    const again = await created.handleMessage('我要出去');
    expect(again.duplicate).toBe(false);
    expect(again.reminder).not.toBeNull();
  });

  it('cancel/reset 可手动清理', async () => {
    const { created } = engine();
    const outcome = await created.handleMessage('我要出去');
    expect(created.cancel(outcome.reminder!.id)).toBe(true);
    expect(created.cancel('missing')).toBe(false);
    expect(created.list()).toHaveLength(0);
    await created.handleMessage('我要出去');
    created.reset();
    expect(created.list()).toHaveLength(0);
  });
});
