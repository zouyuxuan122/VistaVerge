/**
 * sensors/weather.ts — Open-Meteo 当前天气（无 API key），带观测/过期语义。
 *
 * 设计合同（DOMAIN_PLUGINS §3.6、§2 天气行；MEMORY_PERCEPTION 观测过期语义）：
 * `weather.get` 返回 `{ data, observedAt, expiresAt, confidence }`；**过期即视为
 * 不可用**，文案必须说明不确定，绝不胡编实时天气。离线/HTTP 错误/响应格式错误
 * 一律抛 WeatherError（带 code），由调用方降级为“不确定”而不是伪造数据。
 *
 * 定位授权不在本模块处理：无经纬度直接 no-location。
 */

export type WeatherErrorCode = 'offline' | 'http' | 'malformed' | 'no-location' | 'timeout';

export class WeatherError extends Error {
  readonly code: WeatherErrorCode;
  constructor(code: WeatherErrorCode, message: string) {
    super(message);
    this.name = 'WeatherError';
    this.code = code;
  }
}

/** 最小 HTTP 响应合同（便于注入 fake fetch；与 registry 共用）。 */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /**
   * 原始字节（可选）。数据包下载必须优先用它，避免 text() 的
   * UTF-8 解码/重编码改变字节数导致 sha256 与 size 误报（B-P-06）。
   */
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<HttpResponseLike>;

export interface WeatherLocation {
  latitude: number;
  longitude: number;
  label?: string;
}

export interface WeatherData {
  temperatureC: number;
  apparentC: number | null;
  weatherCode: number;
  windKph: number | null;
  isDay: boolean;
  description: string;
}

export interface WeatherSnapshot {
  data: WeatherData | null;
  observedAt: number | null;
  expiresAt: number | null;
  confidence: 'high' | 'low' | 'none';
  source: 'open-meteo';
  location: WeatherLocation | null;
  stale: boolean;
  reason?: string;
}

export interface FetchWeatherDeps {
  fetch?: FetchLike;
  now?: () => number;
  /** 新鲜度窗口（毫秒）。过期即视为不可用。 */
  freshnessMs?: number;
  timeoutMs?: number;
}

/** 默认新鲜度窗口：短窗口（DOMAIN_PLUGINS §6「天气新鲜度窗口」可校准）。 */
export const DEFAULT_FRESHNESS_MS = 15 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 8000;
export const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const CURRENT_FIELDS = ['temperature_2m', 'apparent_temperature', 'weather_code', 'wind_speed_10m', 'is_day'];

function assertLocation(location: WeatherLocation): void {
  const { latitude, longitude } = location;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new WeatherError('no-location', `纬度非法或缺失：${String(latitude)}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new WeatherError('no-location', `经度非法或缺失：${String(longitude)}`);
  }
}

/** 构造 Open-Meteo 请求 URL（无 key）。经纬度非法时抛 no-location。 */
export function buildForecastUrl(location: WeatherLocation): string {
  assertLocation(location);
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: CURRENT_FIELDS.join(','),
    timezone: 'UTC',
  });
  return `${OPEN_METEO_ENDPOINT}?${params.toString()}`;
}

const WEATHER_CODE_TEXT: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨',
  56: '冻毛毛雨',
  57: '冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷雨',
  96: '雷暴伴冰雹',
  99: '雷暴伴冰雹',
};

/** WMO 天气码 → 中文描述；未知码明确返回“未知天气”，不猜。 */
export function weatherCodeToText(code: number): string {
  return WEATHER_CODE_TEXT[code] ?? '未知天气';
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 解析 Open-Meteo 的 `current.time`。
 *
 * 请求里带了 `timezone=UTC`，服务端返回的是**不带时区标记**的字符串
 * （如 `2026-09-19T04:15`）。JS 的 `Date.parse` 把这种裸字符串按**本地时区**解释，
 * 在东八区就会把观测时间算早 8 小时 → 新鲜度判定永远「已过期」，
 * 于是真实天气被当成不可用。裸时间戳必须显式按 UTC 解析。
 */
export function parseObservedAt(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim());
  return Date.parse(hasZone ? value : `${value}Z`);
}

/**
 * 拉取当前天气。失败一律抛 WeatherError，调用方据此输出“不确定”。
 */
export async function fetchWeather(
  location: WeatherLocation,
  deps: FetchWeatherDeps = {},
): Promise<WeatherSnapshot> {
  const url = buildForecastUrl(location);
  const now = deps.now ?? (() => Date.now());
  const freshnessMs = deps.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') {
    throw new WeatherError('offline', '当前环境没有可用的 fetch');
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: HttpResponseLike;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    if (timedOut) throw new WeatherError('timeout', `天气请求超时（${timeoutMs}ms）`);
    const message = error instanceof Error ? error.message : String(error);
    throw new WeatherError('offline', `天气请求失败：${message}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new WeatherError('http', `天气服务返回 HTTP ${response.status}`);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WeatherError('offline', `天气响应读取失败：${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WeatherError('malformed', '天气响应不是合法 JSON');
  }

  const current = (parsed as { current?: Record<string, unknown> } | null)?.current;
  if (typeof current !== 'object' || current === null) {
    throw new WeatherError('malformed', '天气响应缺少 current 字段');
  }
  const observedAt = parseObservedAt(current.time);
  const temperatureC = numberOrNull(current.temperature_2m);
  const weatherCode = numberOrNull(current.weather_code);
  if (!Number.isFinite(observedAt) || temperatureC === null || weatherCode === null) {
    throw new WeatherError('malformed', '天气响应缺少 time/temperature_2m/weather_code');
  }

  const isDayRaw = current.is_day;
  const isDay = typeof isDayRaw === 'number' ? isDayRaw === 1 : isDayRaw !== false;
  const expiresAt = observedAt + freshnessMs;
  const snapshot: WeatherSnapshot = {
    data: {
      temperatureC,
      apparentC: numberOrNull(current.apparent_temperature),
      weatherCode,
      windKph: numberOrNull(current.wind_speed_10m),
      isDay,
      description: weatherCodeToText(weatherCode),
    },
    observedAt,
    expiresAt,
    confidence: 'high',
    source: 'open-meteo',
    location,
    stale: now() >= expiresAt,
  };
  return snapshot;
}

/** 构造“不可用”快照：data 为 null，绝不含猜测数值。 */
export function unavailableWeather(reason: string): WeatherSnapshot {
  return {
    data: null,
    observedAt: null,
    expiresAt: null,
    confidence: 'none',
    source: 'open-meteo',
    location: null,
    stale: true,
    reason,
  };
}

/** 新鲜度判定：无数据、无过期时间或已过期都视为不可用。 */
export function isFresh(snapshot: WeatherSnapshot, now: number): boolean {
  if (!snapshot.data || snapshot.expiresAt === null) return false;
  return now < snapshot.expiresAt;
}

function formatObservedAt(observedAt: number | null): string {
  if (observedAt === null) return '未知时间';
  return new Date(observedAt).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * 面向用户的天气摘要。过期/不可用时 uncertain=true，且**不输出实时温度**。
 */
export function weatherSummary(
  snapshot: WeatherSnapshot,
  now: number = Date.now(),
): { text: string; uncertain: boolean } {
  if (!snapshot.data || !isFresh(snapshot, now)) {
    const why =
      snapshot.data === null
        ? `天气数据不可用（${snapshot.reason ?? '未知原因'}）`
        : `天气数据已过期（最近观测 ${formatObservedAt(snapshot.observedAt)}）`;
    return {
      text: `${why}，我不确定现在的天气，出门前请自行确认。`,
      uncertain: true,
    };
  }
  const { temperatureC, description } = snapshot.data;
  return {
    text: `外面${description}，约 ${temperatureC}℃（观测 ${formatObservedAt(snapshot.observedAt)}）。`,
    uncertain: false,
  };
}
