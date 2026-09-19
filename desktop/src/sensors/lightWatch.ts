/**
 * sensors/lightWatch.ts — 照度偏低关怀（G-SENSE-02；规划「觉得太暗了」）。
 *
 * 规则：
 * - 只有 HA 照度实体可用时才有证据；不可用/断线 → 状态未知，不猜数值。
 * - 照度低于阈值（默认 50 lx，可配）且在「有人活动时段」→ 提醒「有点暗，要不要开灯」。
 * - 占用状态缺失不强行阻塞保守提醒（DOMAIN §1.2.2）；显式 occupied=false 才跳过。
 * - 同样走安静时段与每小时额度（默认 2）；文案不做医学判断。
 */

import { DEFAULT_QUIET_HOURS, isQuietNow, type QuietHours } from './reminders';

export const DEFAULT_LUX_THRESHOLD = 50;
export const DEFAULT_LIGHT_HOURLY_QUOTA = 2;
export const LIGHT_WATCH_SOURCE = 'sensors/lightWatch';

export interface LightSample {
  lux: number | null;
  available: boolean;
  /** 占用/活动状态；null/undefined = 未知（不阻塞保守提醒），false = 明确无人。 */
  occupied?: boolean | null;
  at?: number;
}

export type LightWatchStatus = 'unknown' | 'normal' | 'dark' | 'triggered' | 'suppressed' | 'quota-exceeded';

export interface LightWatchOutcome {
  status: LightWatchStatus;
  lux: number | null;
  text: string | null;
}

export interface LightWatchDeps {
  now?: () => number;
  thresholdLux?: number;
  hourlyQuota?: number;
  quietHours?: QuietHours | null;
  quietEnabled?: boolean;
  emit?: (text: string, outcome: LightWatchOutcome) => void;
}

export interface LightWatch {
  sample(input: LightSample): LightWatchOutcome;
  setQuietEnabled(enabled: boolean): void;
  reset(): void;
  state(): { status: LightWatchStatus; triggersThisHour: number };
}

/** 关怀文案：情境提醒，不做医学判断。 */
export function lightCareText(lux: number): string {
  return `屋里有点暗（照度约 ${Math.round(lux)} lx），要不要开盏灯？`;
}

export function createLightWatch(deps: LightWatchDeps = {}): LightWatch {
  const now = deps.now ?? (() => Date.now());
  const thresholdLux = deps.thresholdLux ?? DEFAULT_LUX_THRESHOLD;
  const hourlyQuota = deps.hourlyQuota ?? DEFAULT_LIGHT_HOURLY_QUOTA;
  const quietHours = deps.quietHours ?? DEFAULT_QUIET_HOURS;
  let quietEnabled = deps.quietEnabled === true;
  let lastStatus: LightWatchStatus = 'normal';
  let lastTriggeredAt: number | null = null;
  const triggerTimes: number[] = [];

  function triggersThisHour(at: number): number {
    while (triggerTimes.length > 0 && at - (triggerTimes[0] as number) >= 3_600_000) triggerTimes.shift();
    return triggerTimes.length;
  }

  function isQuiet(at: number): boolean {
    if (quietEnabled) return true;
    return quietHours !== null && isQuietNow(at, quietHours);
  }

  return {
    sample(input: LightSample): LightWatchOutcome {
      const at = input.at ?? now();
      if (!input.available || input.lux === null) {
        lastStatus = 'unknown';
        return { status: 'unknown', lux: null, text: null };
      }
      // 明确无人活动时不打扰（占用缺失不阻塞）。
      if (input.occupied === false) {
        lastStatus = 'normal';
        return { status: 'normal', lux: input.lux, text: null };
      }
      if (input.lux >= thresholdLux) {
        lastStatus = 'normal';
        return { status: 'normal', lux: input.lux, text: null };
      }
      if (isQuiet(at)) {
        lastStatus = 'suppressed';
        return { status: 'suppressed', lux: input.lux, text: null };
      }
      // 同一小时内按额度提醒，避免反复打扰。
      if (lastTriggeredAt !== null && at - lastTriggeredAt < 600_000) {
        lastStatus = 'dark';
        return { status: 'dark', lux: input.lux, text: null };
      }
      if (triggersThisHour(at) >= hourlyQuota) {
        lastStatus = 'quota-exceeded';
        return { status: 'quota-exceeded', lux: input.lux, text: null };
      }
      const text = lightCareText(input.lux);
      lastTriggeredAt = at;
      triggerTimes.push(at);
      lastStatus = 'triggered';
      const outcome: LightWatchOutcome = { status: 'triggered', lux: input.lux, text };
      deps.emit?.(text, outcome);
      return outcome;
    },

    setQuietEnabled(enabled: boolean) {
      quietEnabled = enabled;
    },

    reset() {
      lastStatus = 'normal';
      lastTriggeredAt = null;
      triggerTimes.length = 0;
    },

    state() {
      return { status: lastStatus, triggersThisHour: triggersThisHour(now()) };
    },
  };
}
