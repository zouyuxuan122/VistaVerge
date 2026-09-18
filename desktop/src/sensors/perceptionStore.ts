/**
 * sensors/perceptionStore.ts — 感知中心状态（温度/天气/家居/提醒）。
 *
 * 设计合同（VISTAVERGE_DESIGN §7、DOMAIN_PLUGINS §2/§3）：
 * - 天气走 Open-Meteo 真实网络（无 Key），带 observedAt/expiresAt；过期即「不确定」，
 *   绝不显示过期数值当实时值。
 * - HA 未配置 → status='blocked' 且文案明说；**不冒充已连接**。
 * - 温度读数严格区分 measured（current_temperature）与 setpoint（temperature），
 *   绝不把设定值说成实际温度。
 * - 提醒引擎由对话触发（出门场景），合并「新鲜天气 + 出行记忆」为一条。
 */

import { reactive } from 'vue';
import { searchMemory } from '../data/memory';
import { setSecret, getSecret } from '../platform/credentials';
import { createHaClient, HA_BLOCKED_REASON, type HaClient, type HaEntityState, type HaStatus } from './haClient';
import { createReminderEngine, DEFAULT_QUIET_HOURS, type Reminder } from './reminders';
import {
  fetchWeather,
  isFresh,
  unavailableWeather,
  weatherSummary,
  WeatherError,
  type WeatherSnapshot,
} from './weather';

export interface GeoLocation {
  latitude: number;
  longitude: number;
  label: string;
}

/** 默认定位：北京（用户可在设置里改；不读系统定位以免未经授权）。 */
export const DEFAULT_LOCATION: GeoLocation = { latitude: 39.9042, longitude: 116.4074, label: '北京' };

const LS_LOCATION = 'vistaverge.location';
const LS_HA_URL = 'vistaverge.haUrl';
const LS_QUIET = 'vistaverge.quietEnabled';
const LS_TEMP_ENTITY = 'vistaverge.haTempEntity';
const HA_TOKEN_KEY = 'haToken';

function safeGet(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* 无存储权限时仅会话内生效 */
  }
}

function loadLocation(): GeoLocation {
  try {
    const raw = safeGet(LS_LOCATION);
    if (!raw) return DEFAULT_LOCATION;
    const parsed = JSON.parse(raw) as Partial<GeoLocation>;
    if (typeof parsed.latitude !== 'number' || typeof parsed.longitude !== 'number') return DEFAULT_LOCATION;
    return {
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      label: typeof parsed.label === 'string' && parsed.label ? parsed.label : '自定义',
    };
  } catch {
    return DEFAULT_LOCATION;
  }
}

export interface PerceptionState {
  location: GeoLocation;
  weatherLoading: boolean;
  weather: WeatherSnapshot | null;
  /** 面向用户的一句话天气（过期时 uncertain=true，不含实时温度）。 */
  weatherText: string;
  weatherUncertain: boolean;

  haUrl: string;
  haTokenConfigured: boolean;
  haStatus: HaStatus;
  haBlockedReason: string | null;
  haError: string;
  haEntities: HaEntityState[];
  haTempEntity: string;
  /** 实测温度（℃）；null = 无数据或实体不可用。 */
  tempMeasuredC: number | null;
  /** 设定温度（℃）；与实测分开，绝不混用。 */
  tempSetpointC: number | null;
  tempAvailable: boolean;
  tempObservedAt: number | null;

  reminders: Reminder[];
  quietEnabled: boolean;
  lastReminderNote: string;
}

export const perception = reactive<PerceptionState>({
  location: loadLocation(),
  weatherLoading: false,
  weather: null,
  weatherText: '',
  weatherUncertain: false,

  haUrl: safeGet(LS_HA_URL) ?? '',
  haTokenConfigured: false,
  haStatus: 'blocked',
  haBlockedReason: HA_BLOCKED_REASON,
  haError: '',
  haEntities: [],
  haTempEntity: safeGet(LS_TEMP_ENTITY) ?? 'climate.living_room',
  tempMeasuredC: null,
  tempSetpointC: null,
  tempAvailable: false,
  tempObservedAt: null,

  reminders: [],
  quietEnabled: safeGet(LS_QUIET) === '1',
  lastReminderNote: '',
});

let haClient: HaClient | null = null;

/* ------------------------------------------------------------------ */
/* 天气                                                                */
/* ------------------------------------------------------------------ */

/** 拉取真实天气（Open-Meteo）。失败时降级为「不确定」，不伪造数值。 */
export async function refreshWeather(): Promise<void> {
  perception.weatherLoading = true;
  try {
    const snapshot = await fetchWeather(perception.location);
    perception.weather = snapshot;
  } catch (error) {
    const reason = error instanceof WeatherError ? error.code : 'offline';
    perception.weather = unavailableWeather(reason);
  } finally {
    perception.weatherLoading = false;
    applyWeatherSummary();
  }
}

function applyWeatherSummary(): void {
  if (!perception.weather) {
    perception.weatherText = '尚未获取天气。';
    perception.weatherUncertain = true;
    return;
  }
  const summary = weatherSummary(perception.weather);
  perception.weatherText = summary.text;
  perception.weatherUncertain = summary.uncertain;
}

/** 天气是否仍然新鲜（供 UI 显示「实时/已过期」标签）。 */
export function weatherFresh(): boolean {
  return perception.weather !== null && isFresh(perception.weather, Date.now());
}

export function setLocation(next: GeoLocation): void {
  perception.location = next;
  safeSet(LS_LOCATION, JSON.stringify(next));
}

/* ------------------------------------------------------------------ */
/* Home Assistant                                                      */
/* ------------------------------------------------------------------ */

export async function saveHaConfig(url: string, token?: string): Promise<void> {
  perception.haUrl = url.trim();
  safeSet(LS_HA_URL, perception.haUrl);
  if (token !== undefined) {
    await setSecret(HA_TOKEN_KEY, token);
    perception.haTokenConfigured = token.trim().length > 0;
  }
  closeHa();
}

export function setHaTempEntity(entityId: string): void {
  perception.haTempEntity = entityId.trim();
  safeSet(LS_TEMP_ENTITY, perception.haTempEntity);
}

/** 读取已保存的 HA token 是否存在于凭据仓（只判断有无，不回显明文）。 */
export async function loadHaTokenPresence(): Promise<void> {
  try {
    const token = await getSecret(HA_TOKEN_KEY);
    perception.haTokenConfigured = typeof token === 'string' && token.length > 0;
  } catch {
    perception.haTokenConfigured = false;
  }
}

function closeHa(): void {
  haClient?.close();
  haClient = null;
  perception.haStatus = perception.haUrl ? 'disconnected' : 'blocked';
  perception.haBlockedReason = perception.haUrl ? null : HA_BLOCKED_REASON;
  perception.haEntities = [];
  clearTemperature();
}

function clearTemperature(): void {
  perception.tempMeasuredC = null;
  perception.tempSetpointC = null;
  perception.tempAvailable = false;
  perception.tempObservedAt = null;
}

/** 连接 HA 并拉取实体。未配置 → blocked，不冒充连接。 */
export async function connectHa(): Promise<void> {
  if (!perception.haUrl) {
    perception.haStatus = 'blocked';
    perception.haBlockedReason = HA_BLOCKED_REASON;
    perception.haError = '';
    return;
  }
  let token = '';
  try {
    token = (await getSecret(HA_TOKEN_KEY)) ?? '';
  } catch {
    token = '';
  }
  perception.haTokenConfigured = token.length > 0;
  haClient?.close();
  haClient = createHaClient({ url: perception.haUrl, token });
  perception.haError = '';
  const result = await haClient.connect();
  perception.haStatus = result.status;
  perception.haBlockedReason = haClient.blockedReason;
  if (!result.ok) {
    perception.haError = result.error ?? '连接失败';
    clearTemperature();
    return;
  }
  try {
    perception.haEntities = await haClient.getStates();
    await refreshTemperature();
  } catch (error) {
    perception.haError = error instanceof Error ? error.message : String(error);
  }
}

/** 读取温度：measured 与 setpoint 分开，实体不可用时 available=false。 */
export async function refreshTemperature(): Promise<void> {
  if (!haClient || perception.haStatus !== 'connected') {
    clearTemperature();
    return;
  }
  const reading = await haClient.readTemperature(perception.haTempEntity);
  if (!reading) {
    clearTemperature();
    return;
  }
  perception.tempAvailable = reading.available;
  perception.tempMeasuredC = reading.measuredC;
  perception.tempSetpointC = reading.setpointC;
  perception.tempObservedAt = reading.observedAt;
}

/* ------------------------------------------------------------------ */
/* 提醒（出门场景）                                                     */
/* ------------------------------------------------------------------ */

const engine = createReminderEngine({
  getWeather: async () => {
    if (!perception.weather || !weatherFresh()) await refreshWeather();
    if (!perception.weather) throw new WeatherError('offline', '天气不可用');
    return perception.weather;
  },
  searchMemory: (input) => searchMemory(input),
  quietHours: DEFAULT_QUIET_HOURS,
  emit: (reminder) => {
    if (!perception.reminders.some((item) => item.text === reminder.text)) {
      perception.reminders.unshift(reminder);
      if (perception.reminders.length > 6) perception.reminders.pop();
    }
  },
});

export function setQuietEnabled(enabled: boolean): void {
  perception.quietEnabled = enabled;
  safeSet(LS_QUIET, enabled ? '1' : '0');
}

export function dismissReminder(id: string): void {
  perception.reminders = perception.reminders.filter((reminder) => reminder.id !== id);
  engine.cancel(id);
}

/**
 * 对话触发出门提醒。返回一句话说明（写入感知面板的最近判定），
 * 便于验收时确认「为什么不提醒」而不是靠猜。
 */
export async function maybeHandleOuting(text: string): Promise<void> {
  const outcome = await engine.handleMessage(text, { force: false });
  if (outcome.cancelled) {
    perception.reminders = [];
    perception.lastReminderNote = '检测到反证（已带伞/不出门）→ 已取消出行提醒';
    return;
  }
  if (outcome.duplicate) {
    perception.lastReminderNote = '同一会话窗口内已提醒过 → 去重跳过';
    return;
  }
  if (outcome.suppressed) {
    perception.lastReminderNote = '安静时段 → 不主动打扰（你直接问我仍会回答）';
    return;
  }
  if (outcome.triggered && outcome.reminder) {
    perception.lastReminderNote = outcome.uncertain
      ? '已提醒（天气不确定，已如实说明）'
      : '已提醒（新鲜天气 + 出行记忆已合并）';
    return;
  }
  perception.lastReminderNote = '';
}

/** 供测试/调试：重置提醒引擎。 */
export function resetPerception(): void {
  engine.reset();
  perception.reminders = [];
  perception.lastReminderNote = '';
}
