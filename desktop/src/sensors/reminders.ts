/**
 * sensors/reminders.ts — 出门提醒规则（DOMAIN_PLUGINS §1.3、§2 天气行）。
 *
 * 规则：
 * - 触发词（“我要出去 / 我要出门 / 出门了 / 要出去了 / 再见 / 我走了 / 出门啦”）→
 *   新鲜天气 + `tag:出行` 记忆 → **合并为一条**简短提醒。
 * - 天气过期/无定位/请求失败 → 说明不确定，不胡编实时天气。
 * - 安静时段（默认夜间）抑制**主动**提醒；用户明确要求（force）时放行；
 *   被抑制不占用会话去重窗口。
 * - 会话内去重：窗口内重复触发只提醒一次。
 * - 反证（已带伞 / 不出门）取消提醒，并允许之后重新触发。
 */

import { searchMemory as defaultSearchMemory, type MemoryHit, type SearchMemoryInput } from '../data/memory';
import { newId } from '../data/util';
import { WeatherError, unavailableWeather, weatherSummary, type WeatherSnapshot } from './weather';

export const OUTING_TRIGGERS = ['我要出去', '我要出门', '出门了', '要出去了', '再见', '我走了', '出门啦'] as const;

export const COUNTER_EVIDENCE = ['带伞了', '已带伞', '带了伞', '不出去', '不出门', '不用提醒'] as const;

export interface QuietHours {
  /** 起始小时（含），0–23。 */
  start: number;
  /** 结束小时（不含），0–24。 */
  end: number;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { start: 22, end: 7 };
export const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
export const REMINDER_SOURCE = 'sensors/reminders';
/** 出行记忆检索标签（MEMORY_PERCEPTION 出门场景约定）。 */
export const OUTING_TAG = '出行';

export interface Reminder {
  id: string;
  kind: 'outing' | 'generic';
  text: string;
  parts: { weather?: string; memory?: string };
  createdAt: number;
  expiresAt: number | null;
  source: string;
  /** 外部观测/记忆内容是数据不是指令。 */
  untrusted: boolean;
}

export interface OutingOutcome {
  triggered: boolean;
  duplicate: boolean;
  suppressed: boolean;
  cancelled: boolean;
  uncertain: boolean;
  reminder: Reminder | null;
  reason?: string;
  evidence: { weather: string; memories: string[] };
}

export interface ReminderEngineDeps {
  getWeather?: () => Promise<WeatherSnapshot>;
  searchMemory?: (input: SearchMemoryInput) => MemoryHit[];
  now?: () => number;
  quietHours?: QuietHours | null;
  dedupeWindowMs?: number;
  emit?: (reminder: Reminder) => void;
}

export interface ReminderEngine {
  handleMessage(text: string, options?: { force?: boolean }): Promise<OutingOutcome>;
  list(): Reminder[];
  cancel(id: string): boolean;
  reset(): void;
}

/** 返回首个命中的触发词（未命中返回 null）。 */
export function detectOutingTrigger(text: string): string | null {
  if (typeof text !== 'string') return null;
  for (const trigger of OUTING_TRIGGERS) {
    if (text.includes(trigger)) return trigger;
  }
  return null;
}

/** 返回首个命中的反证短语（未命中返回 null）。 */
export function detectCounterEvidence(text: string): string | null {
  if (typeof text !== 'string') return null;
  for (const phrase of COUNTER_EVIDENCE) {
    if (text.includes(phrase)) return phrase;
  }
  return null;
}

/** 安静时段判定：左闭右开；跨午夜区间（start > end）正确环绕。 */
export function isQuietNow(when: Date | number, quiet: QuietHours): boolean {
  const hour = (when instanceof Date ? when : new Date(when)).getHours();
  if (quiet.start === quiet.end) return true;
  if (quiet.start < quiet.end) return hour >= quiet.start && hour < quiet.end;
  return hour >= quiet.start || hour < quiet.end;
}

export function createReminderEngine(deps: ReminderEngineDeps = {}): ReminderEngine {
  const now = deps.now ?? (() => Date.now());
  const dedupeWindowMs = deps.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const quietHours = deps.quietHours ?? null;
  const searchMemory = deps.searchMemory ?? defaultSearchMemory;
  const getWeather =
    deps.getWeather ??
    (async () => {
      // 未配置定位：明确“不确定”，不猜天气（DOMAIN_PLUGINS §2 天气行）。
      throw new WeatherError('no-location', '未配置定位');
    });

  const reminders: Reminder[] = [];
  let lastOutingAt: number | null = null;

  function cancelOutings(): void {
    for (let i = reminders.length - 1; i >= 0; i -= 1) {
      if (reminders[i]?.kind === 'outing') reminders.splice(i, 1);
    }
  }

  function emptyOutcome(partial: Partial<OutingOutcome>): OutingOutcome {
    return {
      triggered: false,
      duplicate: false,
      suppressed: false,
      cancelled: false,
      uncertain: false,
      reminder: null,
      evidence: { weather: '', memories: [] },
      ...partial,
    };
  }

  return {
    async handleMessage(text: string, options: { force?: boolean } = {}): Promise<OutingOutcome> {
      const counter = detectCounterEvidence(text);
      if (counter) {
        // 出现反证即取消提醒，并清空去重窗口（用户之后仍可正常出门）。
        cancelOutings();
        lastOutingAt = null;
        return emptyOutcome({ cancelled: true, reason: 'counter-evidence' });
      }

      const trigger = detectOutingTrigger(text);
      if (!trigger) {
        return emptyOutcome({ reason: 'no-trigger' });
      }

      const timestamp = now();
      if (quietHours && isQuietNow(timestamp, quietHours) && options.force !== true) {
        return emptyOutcome({ triggered: true, suppressed: true, reason: 'quiet-hours' });
      }

      if (lastOutingAt !== null && timestamp - lastOutingAt < dedupeWindowMs) {
        return emptyOutcome({ triggered: true, duplicate: true, reason: 'dedupe' });
      }

      let snapshot: WeatherSnapshot;
      try {
        snapshot = await getWeather();
      } catch (error) {
        const reason = error instanceof WeatherError ? error.code : 'offline';
        snapshot = unavailableWeather(reason);
      }
      const summary = weatherSummary(snapshot, timestamp);

      let memories: MemoryHit[] = [];
      try {
        memories = searchMemory({ tags: [OUTING_TAG], topK: 2 });
      } catch {
        memories = [];
      }
      const memoryTexts = memories.map((hit) => hit.text.trim()).filter((value) => value.length > 0);
      const memoryPart =
        memoryTexts.length > 0 ? `今天出行相关：${memoryTexts.join('；')}` : undefined;

      const parts: Reminder['parts'] = { weather: summary.text };
      if (memoryPart !== undefined) parts.memory = memoryPart;
      const reminder: Reminder = {
        id: newId(),
        kind: 'outing',
        text: `出门提醒：${summary.text}${memoryPart ? ` ${memoryPart}` : ''}`,
        parts,
        createdAt: timestamp,
        expiresAt: snapshot.expiresAt,
        source: REMINDER_SOURCE,
        untrusted: true,
      };

      lastOutingAt = timestamp;
      reminders.push(reminder);
      deps.emit?.(reminder);

      return emptyOutcome({
        triggered: true,
        uncertain: summary.uncertain,
        reminder,
        evidence: { weather: summary.text, memories: memoryTexts },
      });
    },

    list() {
      return [...reminders];
    },

    cancel(id: string) {
      const index = reminders.findIndex((reminder) => reminder.id === id);
      if (index < 0) return false;
      reminders.splice(index, 1);
      return true;
    },

    reset() {
      reminders.length = 0;
      lastOutingAt = null;
    },
  };
}
