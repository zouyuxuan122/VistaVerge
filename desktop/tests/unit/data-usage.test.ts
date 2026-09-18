// 用量台账：聚合口径、成本折算、估算标记、本地日切分（node 环境，真 SQLite）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/data/db';
import {
  clearUsage,
  costMicrosOf,
  estimateTokens,
  localDayKey,
  recordUsage,
  recentUsage,
  startOfLocalDay,
  usageDaily,
  usageHeatmap,
  usageTotals,
} from '../../src/data/usage';

const DAY = 24 * 60 * 60 * 1000;

describe('data/usage：用量台账', () => {
  beforeEach(async () => {
    const { initDb } = await import('../../src/data/db');
    await initDb();
    clearUsage();
  });
  afterEach(() => {
    closeDb();
  });

  it('记账并按时间窗口聚合，估算条目单独计数', () => {
    const now = Date.now();
    recordUsage({ kind: 'llm', promptTokens: 100, completionTokens: 50, costMicros: 1000, ts: now });
    recordUsage({ kind: 'llm', promptTokens: 20, completionTokens: 10, costMicros: 100, estimated: true, ts: now - DAY });
    recordUsage({ kind: 'tts', units: 42, ts: now });

    const all = usageTotals(0);
    expect(all.calls).toBe(3);
    expect(all.promptTokens).toBe(120);
    expect(all.completionTokens).toBe(60);
    expect(all.costMicros).toBe(1100);
    expect(all.units).toBe(42);
    expect(all.estimatedCalls).toBe(1);

    // 只看今天：昨天那条不计入
    const today = usageTotals(startOfLocalDay(now));
    expect(today.calls).toBe(2);
    expect(today.promptTokens).toBe(100);
  });

  it('逐日序列补齐空日，按本地日切分', () => {
    const now = Date.now();
    const today = startOfLocalDay(now);
    recordUsage({ kind: 'llm', promptTokens: 10, completionTokens: 5, ts: today + 1000 });
    recordUsage({ kind: 'llm', promptTokens: 7, completionTokens: 3, ts: today - 2 * DAY + 1000 });

    const series = usageDaily(4, now);
    expect(series).toHaveLength(4);
    expect(series[series.length - 1].day).toBe(localDayKey(now));
    expect(series[series.length - 1].promptTokens).toBe(10);
    expect(series[series.length - 3].promptTokens).toBe(7);
    expect(series[series.length - 2].calls).toBe(0); // 空日补零
  });

  it('热力图覆盖整周网格且累加当日 token', () => {
    const now = Date.now();
    recordUsage({ kind: 'llm', promptTokens: 300, completionTokens: 200, ts: now });

    const cells = usageHeatmap(26, now);
    expect(cells).toHaveLength(26 * 7);
    const todayCell = cells.find((c) => c.day === localDayKey(now));
    expect(todayCell?.tokens).toBe(500);
    expect(cells.filter((c) => c.tokens === 0).length).toBe(cells.length - 1);
  });

  it('成本折算按单价（元/百万 token）与估算器口径', () => {
    // 1000 输入 + 500 输出，单价 2 元/1M 与 8 元/1M → 2000 + 4000 micros
    expect(costMicrosOf(1000, 500, 2, 8)).toBe(6000);
    expect(costMicrosOf(0, 0, 2, 8)).toBe(0);
    // CJK 每字≈1 token，英文按 3.5 字符≈1 token
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('hello world')).toBeGreaterThanOrEqual(3);
    expect(estimateTokens('')).toBe(0);
  });

  it('最近记录按时间倒序且带估算标记', () => {
    const now = Date.now();
    recordUsage({ kind: 'llm', promptTokens: 1, completionTokens: 1, ts: now - 5000 });
    recordUsage({ kind: 'llm', promptTokens: 2, completionTokens: 2, estimated: true, ts: now });
    const list = recentUsage(5);
    expect(list[0].promptTokens).toBe(2);
    expect(list[0].estimated).toBe(true);
    expect(list[1].estimated).toBe(false);
  });
});
