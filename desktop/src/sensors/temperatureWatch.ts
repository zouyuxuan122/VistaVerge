/**
 * sensors/temperatureWatch.ts — 温度持续偏低关怀（G-SENSE-01；DOMAIN_PLUGINS §1.2、§3.5、D6）。
 *
 * 规则（纯函数式状态机，可单测；不在 UI 层做判断）：
 * - 只依据**可得证据**：有实测值（measured）就用实测；只有设定值（setpoint）时
 *   文案必须明确标注「设定值，不是实测室温」；实体不可用/断线 → 状态未知，
 *   绝不生成确定性温度陈述（DOMAIN §3.5）。
 * - 连续低于阈值（默认 16℃）达到持续时间（默认 1 小时）才触发一条关怀提醒。
 * - 提醒走安静时段与每小时额度（默认 2）约束；安静时段抑制不丢失状态，
 *   解除后仍可基于同一段持续偏低给出提醒。
 * - 文案是情境提醒，**不是医学判断**，不输出健康诊断。
 */

import { DEFAULT_QUIET_HOURS, isQuietNow, type QuietHours } from './reminders';

/** 默认偏低阈值（℃）。可校准参数（DOMAIN §6「温度告警阈值 保守」）。 */
export const DEFAULT_TEMP_THRESHOLD_C = 16;
/** 默认持续时长：1 小时。 */
export const DEFAULT_LOW_DURATION_MS = 3_600_000;
/** 默认每小时提醒额度。 */
export const DEFAULT_TEMP_HOURLY_QUOTA = 2;
export const TEMP_WATCH_SOURCE = 'sensors/temperatureWatch';

export interface TemperatureSample {
  setpointC: number | null;
  measuredC: number | null;
  /** false = 实体不可用/未连接，禁止生成确定性陈述。 */
  available: boolean;
  at?: number;
}

export type TemperatureWatchStatus =
  | 'unknown'
  | 'normal'
  | 'accumulating'
  | 'triggered'
  | 'suppressed'
  | 'quota-exceeded';

export interface TemperatureWatchOutcome {
  status: TemperatureWatchStatus;
  /** 连续偏低已持续时长（ms）；不处于偏低状态时为 0。 */
  heldMs: number;
  /** 判定依据：measured 优先，只有设定值时用 setpoint。 */
  source: 'measured' | 'setpoint' | null;
  /** 触发时的提醒文本（未触发为 null）。 */
  text: string | null;
}

export interface TemperatureWatchDeps {
  now?: () => number;
  thresholdC?: number;
  durationMs?: number;
  hourlyQuota?: number;
  quietHours?: QuietHours | null;
  quietEnabled?: boolean;
  emit?: (text: string, outcome: TemperatureWatchOutcome) => void;
}

export interface TemperatureWatch {
  sample(input: TemperatureSample): TemperatureWatchOutcome;
  setQuietEnabled(enabled: boolean): void;
  reset(): void;
  state(): {
    status: TemperatureWatchStatus;
    heldMs: number;
    belowSince: number | null;
    lastTriggeredAt: number | null;
    triggersThisHour: number;
  };
}

function formatDuration(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 1) {
    const rounded = Math.round(hours * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} 小时`;
  }
  return `${Math.max(1, Math.round(ms / 60_000))} 分钟`;
}

/**
 * 关怀文案：区分实测与设定，不做医学判断（DOMAIN §1.2.3）。
 * 导出以便测试直接断言口径。
 */
export function temperatureCareText(input: {
  thresholdC: number;
  heldMs: number;
  measuredC: number | null;
  setpointC: number | null;
}): string {
  const held = formatDuration(input.heldMs);
  if (input.measuredC !== null) {
    return `你那边室温实测 ${input.measuredC}℃ 已经连续 ${held} 低于 ${input.thresholdC}℃ 了，要不要看看空调或暖气？`;
  }
  return `你设定的温度是 ${input.setpointC}℃（设定值，不是实测室温），已经持续 ${held} 低于 ${input.thresholdC}℃；如果觉得冷可以调高一点。`;
}

export function createTemperatureWatch(deps: TemperatureWatchDeps = {}): TemperatureWatch {
  const now = deps.now ?? (() => Date.now());
  const thresholdC = deps.thresholdC ?? DEFAULT_TEMP_THRESHOLD_C;
  const durationMs = deps.durationMs ?? DEFAULT_LOW_DURATION_MS;
  const hourlyQuota = deps.hourlyQuota ?? DEFAULT_TEMP_HOURLY_QUOTA;
  const quietHours = deps.quietHours ?? DEFAULT_QUIET_HOURS;
  let quietEnabled = deps.quietEnabled === true;

  let belowSince: number | null = null;
  let lastTriggeredAt: number | null = null;
  let lastStatus: TemperatureWatchStatus = 'normal';
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
    sample(input: TemperatureSample): TemperatureWatchOutcome {
      const at = input.at ?? now();
      if (!input.available || (input.measuredC === null && input.setpointC === null)) {
        // 断线/不可用：状态未知，不猜数值（DOMAIN §2 HA 读取行）。
        belowSince = null;
        lastStatus = 'unknown';
        return { status: 'unknown', heldMs: 0, source: null, text: null };
      }
      const useMeasured = input.measuredC !== null;
      const value = useMeasured ? (input.measuredC as number) : (input.setpointC as number);
      const source: 'measured' | 'setpoint' = useMeasured ? 'measured' : 'setpoint';

      if (value > thresholdC) {
        belowSince = null;
        lastStatus = 'normal';
        return { status: 'normal', heldMs: 0, source, text: null };
      }
      if (belowSince === null) belowSince = at;
      const heldMs = Math.max(0, at - belowSince);

      if (heldMs < durationMs) {
        lastStatus = 'accumulating';
        return { status: 'accumulating', heldMs, source, text: null };
      }
      // 同一段持续偏低只提醒一次；要再提醒需再满足一个完整时长窗口。
      if (lastTriggeredAt !== null && at - lastTriggeredAt < durationMs) {
        lastStatus = 'accumulating';
        return { status: 'accumulating', heldMs, source, text: null };
      }
      if (isQuiet(at)) {
        // 抑制不丢失状态：安静时段结束后仍可基于同一段偏低提醒。
        lastStatus = 'suppressed';
        return { status: 'suppressed', heldMs, source, text: null };
      }
      if (triggersThisHour(at) >= hourlyQuota) {
        lastStatus = 'quota-exceeded';
        return { status: 'quota-exceeded', heldMs, source, text: null };
      }

      const text = temperatureCareText({
        thresholdC,
        heldMs,
        measuredC: input.measuredC,
        setpointC: input.setpointC,
      });
      lastTriggeredAt = at;
      triggerTimes.push(at);
      lastStatus = 'triggered';
      const outcome: TemperatureWatchOutcome = { status: 'triggered', heldMs, source, text };
      deps.emit?.(text, outcome);
      return outcome;
    },

    setQuietEnabled(enabled: boolean) {
      quietEnabled = enabled;
    },

    reset() {
      belowSince = null;
      lastTriggeredAt = null;
      lastStatus = 'normal';
      triggerTimes.length = 0;
    },

    state() {
      const at = now();
      return {
        status: lastStatus,
        heldMs: belowSince === null ? 0 : Math.max(0, at - belowSince),
        belowSince,
        lastTriggeredAt,
        triggersThisHour: triggersThisHour(at),
      };
    },
  };
}
