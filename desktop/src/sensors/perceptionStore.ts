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
import { newId } from '../data/util';
import { setSecret, getSecret } from '../platform/credentials';
import { createHaClient, HA_BLOCKED_REASON, type HaClient, type HaEntityState, type HaStatus } from './haClient';
import {
  authorizeHaControl,
  type HaControlConfirm,
  type HaControlRequest,
  type HaControlResult,
} from './haControl';
import { createReminderEngine, DEFAULT_QUIET_HOURS, type Reminder } from './reminders';
import {
  createTemperatureWatch,
  TEMP_WATCH_SOURCE,
  type TemperatureWatchOutcome,
  type TemperatureWatchStatus,
} from './temperatureWatch';
import { createLightWatch, LIGHT_WATCH_SOURCE, type LightWatchOutcome, type LightWatchStatus } from './lightWatch';
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
const LS_LUX_ENTITY = 'vistaverge.haLuxEntity';
const LS_HA_CONTROL = 'vistaverge.haControlEnabled';
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

  /* ---- G-SENSE-01 16℃ 一小时 ---- */
  tempWatchStatus: TemperatureWatchStatus;
  tempWatchHeldMs: number;
  tempWatchNote: string;

  /* ---- G-SENSE-02 照度 ---- */
  haLuxEntity: string;
  luxValue: number | null;
  luxAvailable: boolean;
  luxObservedAt: number | null;
  lightWatchStatus: LightWatchStatus;

  /* ---- G-SENSE-03 HA 控制（授权门） ---- */
  /** 默认关；关闭时 controlHaEntity 直接拒绝，不做任何写操作。 */
  haControlEnabled: boolean;
  lastControlResult: string;
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

  tempWatchStatus: 'normal',
  tempWatchHeldMs: 0,
  tempWatchNote: '',

  haLuxEntity: safeGet(LS_LUX_ENTITY) ?? '',
  luxValue: null,
  luxAvailable: false,
  luxObservedAt: null,
  lightWatchStatus: 'normal',

  haControlEnabled: safeGet(LS_HA_CONTROL) === '1',
  lastControlResult: '',
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

export function setHaLuxEntity(entityId: string): void {
  perception.haLuxEntity = entityId.trim();
  safeSet(LS_LUX_ENTITY, perception.haLuxEntity);
}

/** HA 控制授权门开关（默认关）。开启本身不等于已授权某次控制。 */
export function setHaControlEnabled(enabled: boolean): void {
  perception.haControlEnabled = enabled;
  safeSet(LS_HA_CONTROL, enabled ? '1' : '0');
  if (!enabled) perception.lastControlResult = 'HA 控制已关闭（授权门关闭）';
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
  clearIlluminance();
}

function clearTemperature(): void {
  perception.tempMeasuredC = null;
  perception.tempSetpointC = null;
  perception.tempAvailable = false;
  perception.tempObservedAt = null;
  markTemperatureUnknown();
}

function clearIlluminance(): void {
  perception.luxValue = null;
  perception.luxAvailable = false;
  perception.luxObservedAt = null;
  markIlluminanceUnknown();
}

/** HA 实体中可用的照度传感器（sensor.* + illuminance/lux 语义）。 */
export function illuminanceEntities(): HaEntityState[] {
  return perception.haEntities.filter(
    (entity) =>
      entity.entityId.startsWith('sensor.') &&
      (entity.attributes.device_class === 'illuminance' ||
        'illuminance' in entity.attributes ||
        'lux' in entity.attributes),
  );
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
    // 未指定照度实体时，自动选第一个可用照度传感器（用户可在面板改）。
    if (!perception.haLuxEntity) {
      const candidate = illuminanceEntities().find((entity) => entity.available);
      if (candidate) setHaLuxEntity(candidate.entityId);
    }
    await refreshTemperature();
    await refreshIlluminance();
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
  // G-SENSE-01：把读数喂给持续监测（区分实测/设定，断线未知）。
  const outcome = tempWatch.sample({
    setpointC: reading.setpointC,
    measuredC: reading.measuredC,
    available: reading.available,
    at: reading.observedAt,
  });
  applyTemperatureOutcome(outcome);
}

/** 读取照度：实体不可用时 available=false，不猜数值。 */
export async function refreshIlluminance(): Promise<void> {
  if (!haClient || perception.haStatus !== 'connected' || !perception.haLuxEntity) {
    clearIlluminance();
    return;
  }
  const reading = await haClient.readIlluminance(perception.haLuxEntity);
  if (!reading) {
    clearIlluminance();
    return;
  }
  perception.luxAvailable = reading.available;
  perception.luxValue = reading.lux;
  perception.luxObservedAt = reading.observedAt;
  // G-SENSE-02：占用状态未知不阻塞保守提醒（DOMAIN §1.2.2）。
  const outcome = lightWatch.sample({
    lux: reading.lux,
    available: reading.available,
    occupied: null,
    at: reading.observedAt,
  });
  applyLightOutcome(outcome);
}

/* ------------------------------------------------------------------ */
/* 提醒（出门场景 + 持续监测）                                          */
/* ------------------------------------------------------------------ */

/** 统一入队到 perception.reminders（按文本去重，最多保留 6 条）。 */
function pushReminder(reminder: Reminder): void {
  if (!perception.reminders.some((item) => item.text === reminder.text)) {
    perception.reminders.unshift(reminder);
    if (perception.reminders.length > 6) perception.reminders.pop();
  }
}

function makeReminder(text: string, source: string): Reminder {
  return {
    id: newId(),
    kind: 'generic',
    text,
    parts: {},
    createdAt: Date.now(),
    expiresAt: null,
    source,
    untrusted: true,
  };
}

const engine = createReminderEngine({
  getWeather: async () => {
    if (!perception.weather || !weatherFresh()) await refreshWeather();
    if (!perception.weather) throw new WeatherError('offline', '天气不可用');
    return perception.weather;
  },
  searchMemory: (input) => searchMemory(input),
  quietHours: DEFAULT_QUIET_HOURS,
  quietEnabled: perception.quietEnabled,
  emit: (reminder) => pushReminder(reminder),
});

/** 温度持续偏低监测（G-SENSE-01）。 */
const tempWatch = createTemperatureWatch({
  quietHours: DEFAULT_QUIET_HOURS,
  quietEnabled: perception.quietEnabled,
  emit: (text) => {
    pushReminder(makeReminder(text, TEMP_WATCH_SOURCE));
    perception.lastReminderNote = '16℃ 持续偏低提醒已发出（区分实测/设定）';
  },
});

/** 照度偏低监测（G-SENSE-02）。 */
const lightWatch = createLightWatch({
  quietHours: DEFAULT_QUIET_HOURS,
  quietEnabled: perception.quietEnabled,
  emit: (text) => {
    pushReminder(makeReminder(text, LIGHT_WATCH_SOURCE));
    perception.lastReminderNote = '照度偏低提醒已发出';
  },
});

function applyTemperatureOutcome(outcome: TemperatureWatchOutcome): void {
  perception.tempWatchStatus = outcome.status;
  perception.tempWatchHeldMs = outcome.heldMs;
  if (outcome.status === 'unknown') perception.tempWatchNote = '断线/实体不可用：温度状态未知，不做确定性判断';
  else if (outcome.status === 'accumulating')
    perception.tempWatchNote = `持续偏低监测中（已 ${Math.round(outcome.heldMs / 60000)} 分钟，依据${outcome.source === 'measured' ? '实测' : '设定'}值）`;
  else if (outcome.status === 'suppressed') perception.tempWatchNote = '安静时段：暂不主动提醒（状态保留）';
  else if (outcome.status === 'quota-exceeded') perception.tempWatchNote = '本小时提醒额度已用完';
  else if (outcome.status === 'triggered') perception.tempWatchNote = '已触发关怀提醒';
  else perception.tempWatchNote = '';
}

function applyLightOutcome(outcome: LightWatchOutcome): void {
  perception.lightWatchStatus = outcome.status;
}

/** 温度不可用/断线：状态未知，重置持续计时。 */
function markTemperatureUnknown(): void {
  applyTemperatureOutcome(tempWatch.sample({ setpointC: null, measuredC: null, available: false }));
}

function markIlluminanceUnknown(): void {
  applyLightOutcome(lightWatch.sample({ lux: null, available: false }));
}

export function setQuietEnabled(enabled: boolean): void {
  perception.quietEnabled = enabled;
  safeSet(LS_QUIET, enabled ? '1' : '0');
  // B-P-03/G-SENSE-04：开关必须真正影响引擎与两个监测器（运行时立即生效）。
  engine.setQuietEnabled(enabled);
  tempWatch.setQuietEnabled(enabled);
  lightWatch.setQuietEnabled(enabled);
}

/* ------------------------------------------------------------------ */
/* HA 控制（授权门，G-SENSE-03）                                        */
/* ------------------------------------------------------------------ */

export type { HaControlAction, HaControlConfirm, HaControlRequest, HaControlResult } from './haControl';

let haControlConfirmer: HaControlConfirm | null = null;

/** 注册全局确认回调（UI 也可在单次调用时传入 confirm 覆盖）。 */
export function setHaControlConfirm(confirmer: HaControlConfirm | null): void {
  haControlConfirmer = confirmer;
}

/**
 * 家居控制（副作用动作，DOMAIN_PLUGINS §3.4）：
 * 必须同时满足「授权门已开启」+「每次显式确认」，否则直接拒绝且不发起任何写操作。
 * 判定逻辑在 sensors/haControl（纯函数，可用注入 fake 单测）。
 */
export async function controlHaEntity(
  request: HaControlRequest,
  confirm?: HaControlConfirm,
): Promise<HaControlResult> {
  const result = await authorizeHaControl(request, {
    controlEnabled: perception.haControlEnabled,
    connected: perception.haStatus === 'connected' && haClient !== null,
    confirm: confirm ?? haControlConfirmer,
    callService: (domain, service, serviceData) =>
      haClient
        ? haClient.callService(domain, service, serviceData)
        : Promise.resolve({ ok: false, error: 'HA 客户端不存在' }),
  });
  perception.lastControlResult = result.ok
    ? `已执行：${request.label}（${request.entityId} → ${request.action}）`
    : (result.reason ?? '未执行');
  return result;
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
    perception.lastReminderNote = '静默/安静时段 → 不主动打扰（你直接问我仍会回答）';
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

/** 供测试/调试：重置提醒引擎与持续监测。 */
export function resetPerception(): void {
  engine.reset();
  tempWatch.reset();
  lightWatch.reset();
  perception.reminders = [];
  perception.lastReminderNote = '';
  perception.tempWatchStatus = 'normal';
  perception.tempWatchHeldMs = 0;
  perception.tempWatchNote = '';
  perception.lightWatchStatus = 'normal';
  perception.lastControlResult = '';
}

/* ------------------------------------------------------------------ */
/* 轮询：持续读取 HA 温度/照度（G-SENSE-01/02）                          */
/* ------------------------------------------------------------------ */

let ambientTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动环境读数轮询（温度 + 照度）。返回停止函数。
 * 无 HA 连接时调用是安全的：refresh* 会把状态标为未知，不会伪造读数。
 */
export function startAmbientPolling(intervalMs = 60_000): () => void {
  stopAmbientPolling();
  ambientTimer = setInterval(() => {
    void refreshTemperature();
    void refreshIlluminance();
  }, Math.max(1000, intervalMs));
  return stopAmbientPolling;
}

export function stopAmbientPolling(): void {
  if (ambientTimer !== null) clearInterval(ambientTimer);
  ambientTimer = null;
}
