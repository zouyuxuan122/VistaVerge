/**
 * data/usage.ts — 用量台账：花费统计 / token 消耗曲线 / GitHub 风热力图的数据源。
 *
 * 口径（诚实标注，不制造虚假精度）：
 * - LLM：供应商返回真实 usage 时记真实值；否则按启发式**估算**（estimated=1），
 *   UI 必须显示估算占比，不得把估算当真实账单。
 * - 成本：写入时按当时设置的单价（元 / 百万 token）折算成 micros 存下来；
 *   单价默认 0 → 花费显示为 0 并提示"未设单价"，不猜价格。
 * - TTS：记字符数（units），单价未接入时不计费。
 * - STT：暂未计量（音频时长口径待定），UI 如实说明。
 */
import { getDb, type Db, type DbRow } from './db';
import { newId, nowMs } from './util';

export type UsageKind = 'llm' | 'tts' | 'stt';

export interface UsageEntry {
  kind: UsageKind;
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  units?: number;
  costMicros?: number;
  estimated?: boolean;
  conversationId?: string | null;
  ts?: number;
}

export interface UsageRecord {
  id: string;
  ts: number;
  kind: UsageKind;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  units: number;
  costMicros: number;
  estimated: boolean;
  conversationId: string | null;
}

export interface UsageTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  units: number;
  costMicros: number;
  /** 估算条目数（0 = 全部为供应商真实值） */
  estimatedCalls: number;
}

export interface DailyUsage {
  /** 本地日 YYYY-MM-DD */
  day: string;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  calls: number;
}

export interface HeatCell {
  day: string;
  tokens: number;
  costMicros: number;
  calls: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地日键（热力图/曲线都按用户本地日历切分，不用 UTC 骗人）。 */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 本地日零点。 */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 启发式 token 估算：CJK 字符≈1 token，其余按 3.5 字符≈1 token。
 * 仅在没有供应商 usage 时使用，调用方必须标记 estimated。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const rest = Math.max(0, text.length - cjk);
  return Math.max(1, Math.round(cjk + rest / 3.5));
}

function toRecord(row: DbRow): UsageRecord {
  return {
    id: String(row.id),
    ts: Number(row.ts),
    kind: String(row.kind) as UsageKind,
    model: String(row.model ?? ''),
    provider: String(row.provider ?? ''),
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    units: Number(row.units ?? 0),
    costMicros: Number(row.cost_micros ?? 0),
    estimated: Number(row.estimated ?? 0) === 1,
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
  };
}

/**
 * 数值归一化：供应商返回的 usage 字段只做过类型断言，
 * 非数字（如 `"prompt_tokens": "x"`）会让 Math.round 产出 NaN 并写进台账，
 * 之后所有统计都是 NaN。这里统一收口成非负整数。
 */
function nonNegativeInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

export function recordUsage(entry: UsageEntry): void {
  const db: Db = getDb();
  db.run(
    `INSERT INTO usage_ledger
      (id, ts, kind, model, provider, prompt_tokens, completion_tokens, units, cost_micros, estimated, conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      entry.ts ?? nowMs(),
      entry.kind,
      entry.model ?? '',
      entry.provider ?? '',
      nonNegativeInt(entry.promptTokens),
      nonNegativeInt(entry.completionTokens),
      nonNegativeInt(entry.units),
      nonNegativeInt(entry.costMicros),
      entry.estimated ? 1 : 0,
      entry.conversationId ?? null,
    ],
  );
  db.schedulePersist();
}

export function usageTotals(sinceMs = 0): UsageTotals {
  const row = getDb().get(
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(units), 0) AS units,
            COALESCE(SUM(cost_micros), 0) AS cost_micros,
            COALESCE(SUM(estimated), 0) AS estimated_calls
       FROM usage_ledger WHERE ts >= ?`,
    [sinceMs],
  );
  if (!row) return { calls: 0, promptTokens: 0, completionTokens: 0, units: 0, costMicros: 0, estimatedCalls: 0 };
  return {
    calls: Number(row.calls ?? 0),
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    units: Number(row.units ?? 0),
    costMicros: Number(row.cost_micros ?? 0),
    estimatedCalls: Number(row.estimated_calls ?? 0),
  };
}

/** 近 N 天逐日聚合（含今天，缺失日补零，便于直接画曲线）。 */
export function usageDaily(days: number, now = nowMs()): DailyUsage[] {
  const since = startOfLocalDay(now) - (days - 1) * DAY_MS;
  const rows = getDb().all(
    `SELECT ts, prompt_tokens, completion_tokens, cost_micros FROM usage_ledger WHERE ts >= ? ORDER BY ts`,
    [since],
  );
  const buckets = new Map<string, DailyUsage>();
  for (let i = 0; i < days; i++) {
    const day = localDayKey(since + i * DAY_MS);
    buckets.set(day, { day, promptTokens: 0, completionTokens: 0, costMicros: 0, calls: 0 });
  }
  for (const r of rows) {
    const key = localDayKey(Number(r.ts));
    const b = buckets.get(key);
    if (!b) continue;
    b.promptTokens += Number(r.prompt_tokens ?? 0);
    b.completionTokens += Number(r.completion_tokens ?? 0);
    b.costMicros += Number(r.cost_micros ?? 0);
    b.calls += 1;
  }
  return [...buckets.values()];
}

/** 近 N 周热力图数据（GitHub 风：每格一天，按周列排布由 UI 决定）。 */
export function usageHeatmap(weeks: number, now = nowMs()): HeatCell[] {
  const today = startOfLocalDay(now);
  const todayDow = new Date(today).getDay(); // 0=周日
  const gridStart = today - (weeks - 1) * 7 * DAY_MS - todayDow * DAY_MS;
  const rows = getDb().all(
    `SELECT ts, prompt_tokens, completion_tokens, cost_micros FROM usage_ledger WHERE ts >= ? ORDER BY ts`,
    [gridStart],
  );
  const cells = new Map<string, HeatCell>();
  const total = weeks * 7;
  for (let i = 0; i < total; i++) {
    const day = localDayKey(gridStart + i * DAY_MS);
    cells.set(day, { day, tokens: 0, costMicros: 0, calls: 0 });
  }
  for (const r of rows) {
    const cell = cells.get(localDayKey(Number(r.ts)));
    if (!cell) continue;
    cell.tokens += Number(r.prompt_tokens ?? 0) + Number(r.completion_tokens ?? 0);
    cell.costMicros += Number(r.cost_micros ?? 0);
    cell.calls += 1;
  }
  return [...cells.values()];
}

export function recentUsage(limit = 10): UsageRecord[] {
  return getDb()
    .all(`SELECT * FROM usage_ledger ORDER BY ts DESC LIMIT ?`, [limit])
    .map(toRecord);
}

/** 清空台账（设置里的显式操作；只删计量数字，不动会话与记忆）。 */
export function clearUsage(): void {
  const db = getDb();
  db.run('DELETE FROM usage_ledger');
  db.schedulePersist();
}

/** 成本折算：单价单位 = 元 / 百万 token，返回 micros（1 元 = 1e6 micros）。 */
export function costMicrosOf(promptTokens: number, completionTokens: number, priceIn: number, priceOut: number): number {
  return Math.max(0, Math.round(promptTokens * priceIn + completionTokens * priceOut));
}
