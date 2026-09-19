<script setup lang="ts">
// 感知中心：温度/天气（真实 Open-Meteo 网络）+ 智能家居（Home Assistant）+ 主动提醒。
// 诚实口径：天气过期就写「不确定」不给数值；HA 未配置就写 BLOCKED；温度严格区分实测与设定。
// 16℃ 一小时 / 照度偏低走持续监测；HA 控制默认关闭且每次需显式确认（授权门）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { setNav, store } from '../app/store';
import {
  connectHa,
  controlHaEntity,
  dismissReminder,
  illuminanceEntities,
  perception,
  refreshIlluminance,
  refreshTemperature,
  refreshWeather,
  setHaControlEnabled,
  setHaLuxEntity,
  setQuietEnabled,
  startAmbientPolling,
  weatherFresh,
} from '../sensors/perceptionStore';
import { HA_BLOCKED_REASON } from '../sensors/haClient';

const haStatusLabel = computed(() => {
  const map: Record<string, string> = {
    blocked: 'BLOCKED（未配置）',
    disconnected: '未连接',
    connecting: '连接中',
    connected: '已连接',
    'auth-failed': '鉴权失败',
  };
  return map[perception.haStatus] ?? perception.haStatus;
});

// B-P-10：补括号明确优先级（原先 `a || b && c` 语义易误读）。
const tempEntities = computed(() =>
  perception.haEntities.filter(
    (e) => e.entityId.startsWith('climate.') || (e.entityId.startsWith('sensor.') && 'current_temperature' in e.attributes),
  ),
);
const luxEntities = computed(() => illuminanceEntities());

function fmtTime(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 温度文案：实测与设定分开；实体不可用时不编数字。 */
const temperatureText = computed(() => {
  if (!perception.haTempEntity) return '未指定温度实体';
  if (perception.haStatus === 'blocked') return 'HA 未配置，无法读取室温';
  if (perception.haStatus !== 'connected') return 'HA 未连接，无法读取室温';
  if (!perception.tempAvailable) return '该实体当前不可用（unavailable/unknown）——不猜数值';
  const measured = perception.tempMeasuredC === null ? '无实测值' : `${perception.tempMeasuredC} ℃`;
  const setpoint = perception.tempSetpointC === null ? '无设定值' : `${perception.tempSetpointC} ℃`;
  return `实测 ${measured} · 设定 ${setpoint}`;
});

const tempWatchLabel = computed(() => {
  const map: Record<string, string> = {
    unknown: '未知（断线/不可用）',
    normal: '正常',
    accumulating: '持续偏低监测中',
    triggered: '已触发提醒',
    suppressed: '安静时段抑制（状态保留）',
    'quota-exceeded': '本小时额度已用完',
  };
  return map[perception.tempWatchStatus] ?? perception.tempWatchStatus;
});

const lightWatchLabel = computed(() => {
  const map: Record<string, string> = {
    unknown: '未知（断线/不可用）',
    normal: '正常',
    dark: '偏暗（已提醒过）',
    triggered: '已触发提醒',
    suppressed: '安静时段抑制',
    'quota-exceeded': '本小时额度已用完',
  };
  return map[perception.lightWatchStatus] ?? perception.lightWatchStatus;
});

/* ---- HA 控制（授权门：默认关 + 每次显式确认） ---- */
interface PendingControl {
  entityId: string;
  action: 'turn_on' | 'turn_off';
  label: string;
}
const pendingControl = ref<PendingControl | null>(null);
const controlNote = ref('');

/** 关/开空调示例实体：优先用已选温度实体，否则给一个明确占位（不假装存在）。 */
const acEntityId = computed(() => perception.haTempEntity || 'climate.living_room');

function requestControl(action: 'turn_on' | 'turn_off'): void {
  const label = action === 'turn_on' ? '开空调' : '关空调';
  pendingControl.value = { entityId: acEntityId.value, action, label };
  controlNote.value = '';
}

async function confirmControl(): Promise<void> {
  const request = pendingControl.value;
  if (!request) return;
  // 显式确认：用户点了「确认执行」才把 confirm 置真。
  const result = await controlHaEntity(request, () => true);
  controlNote.value = result.ok ? perception.lastControlResult : (result.reason ?? '未执行');
  pendingControl.value = null;
}

function cancelControl(): void {
  pendingControl.value = null;
  controlNote.value = '已取消：未执行任何控制';
}

let stopPolling: (() => void) | null = null;

onMounted(() => {
  void refreshWeather();
  // 持续监测：轮询 HA 温度/照度（无连接时安全，只会标为未知）。
  stopPolling = startAmbientPolling();
});

onBeforeUnmount(() => {
  stopPolling?.();
  stopPolling = null;
});

function openSettings() {
  store.settingsTab = 'perception';
  setNav('settings');
}
</script>

<template>
  <div class="pane-scroll perception-view">
    <div class="pv-head">
      <span class="mc-badge simulated">感知中心</span>
      <span class="mc-meta">观测事实 / 推测 / 持久记忆分开呈现，过期即标不确定</span>
    </div>

    <div class="pv-grid">
      <section class="mc-card">
        <h3>环境温度与天气 <small>Open-Meteo · 无需 Key</small></h3>
        <p class="pv-weather" :class="{ uncertain: perception.weatherUncertain }" data-testid="pv-weather">
          {{ perception.weatherText || '尚未获取天气' }}
        </p>
        <ul class="mc-kv">
          <li><span>定位</span><b>{{ perception.location.label }}（{{ perception.location.latitude.toFixed(3) }}, {{ perception.location.longitude.toFixed(3) }}）</b></li>
          <li><span>新鲜度</span>
            <b>
              <span v-if="!perception.weather">—</span>
              <span v-else :class="weatherFresh() ? 'pill ok' : 'pill warn'">{{ weatherFresh() ? '实时' : '已过期' }}</span>
            </b>
          </li>
          <li><span>观测时间</span><b>{{ fmtTime(perception.weather?.observedAt ?? null) }}</b></li>
          <li><span>过期时间</span><b>{{ fmtTime(perception.weather?.expiresAt ?? null) }}</b></li>
          <li v-if="perception.weather?.data"><span>体感 / 风速</span><b>{{ perception.weather.data.apparentC ?? '—' }} ℃ · {{ perception.weather.data.windKph ?? '—' }} km/h</b></li>
        </ul>
        <div class="pv-actions">
          <button class="btn" :disabled="perception.weatherLoading" @click="refreshWeather">
            {{ perception.weatherLoading ? '获取中…' : '刷新天气' }}
          </button>
          <button class="btn" @click="openSettings">改定位</button>
        </div>
        <p class="mc-note">
          室内温度需要 Home Assistant（右栏）。天气接口只给室外；不会把室外温度说成室温。
        </p>
      </section>

      <section class="mc-card">
        <h3>智能家居（Home Assistant）</h3>
        <div class="pv-status">
          <span class="pv-status-pill" :class="'st-' + perception.haStatus">{{ haStatusLabel }}</span>
          <span class="mc-meta">{{ perception.haUrl || '未填地址' }}</span>
        </div>
        <p v-if="perception.haBlockedReason" class="mc-warn">{{ HA_BLOCKED_REASON }}</p>
        <p v-if="perception.haError" class="mc-warn">{{ perception.haError }}</p>

        <h4>室内温度（实测 / 设定分开）</h4>
        <p class="pv-temp" data-testid="pv-temp">{{ temperatureText }}</p>
        <ul class="mc-kv">
          <li><span>温度实体</span><b>{{ perception.haTempEntity || '—' }}</b></li>
          <li><span>读数时间</span><b>{{ fmtTime(perception.tempObservedAt) }}</b></li>
          <li><span>已发现实体</span><b>{{ perception.haEntities.length }}</b></li>
          <li><span>16℃ 持续监测</span><b data-testid="pv-temp-watch">{{ tempWatchLabel }}（{{ Math.round(perception.tempWatchHeldMs / 60000) }} 分钟）</b></li>
        </ul>
        <p v-if="perception.tempWatchNote" class="mc-note" data-testid="pv-temp-watch-note">{{ perception.tempWatchNote }}</p>

        <div class="pv-actions">
          <button class="btn" @click="connectHa">{{ perception.haUrl ? '连接 / 重连' : '去设置里配置' }}</button>
          <button class="btn" :disabled="perception.haStatus !== 'connected'" @click="refreshTemperature">重读温度</button>
        </div>

        <details v-if="tempEntities.length" class="pv-entities">
          <summary>可选温度实体（{{ tempEntities.length }}）</summary>
          <ul class="mc-inv">
            <li v-for="entity in tempEntities.slice(0, 12)" :key="entity.entityId">
              <button class="pv-entity-btn" @click="perception.haTempEntity = entity.entityId">
                {{ entity.entityId }}
              </button>
              <span class="mc-meta">{{ entity.available ? entity.state : '不可用' }}</span>
            </li>
          </ul>
        </details>

        <h4>照度（灯光感知）</h4>
        <ul class="mc-kv">
          <li><span>照度实体</span><b>{{ perception.haLuxEntity || '未指定' }}</b></li>
          <li><span>当前照度</span>
            <b data-testid="pv-lux">
              {{ !perception.haLuxEntity ? '未指定照度实体' : perception.haStatus !== 'connected' ? 'HA 未连接' : !perception.luxAvailable ? '不可用（不猜数值）' : `${Math.round(perception.luxValue ?? 0)} lx` }}
            </b>
          </li>
          <li><span>偏低监测</span><b>{{ lightWatchLabel }}</b></li>
        </ul>
        <div class="pv-actions">
          <button class="btn" :disabled="perception.haStatus !== 'connected'" @click="refreshIlluminance">重读照度</button>
        </div>
        <details v-if="luxEntities.length" class="pv-entities">
          <summary>可选照度实体（{{ luxEntities.length }}）</summary>
          <ul class="mc-inv">
            <li v-for="entity in luxEntities.slice(0, 12)" :key="entity.entityId">
              <button class="pv-entity-btn" @click="setHaLuxEntity(entity.entityId)">
                {{ entity.entityId }}
              </button>
              <span class="mc-meta">{{ entity.available ? entity.state : '不可用' }}</span>
            </li>
          </ul>
        </details>

        <h4>家居控制（副作用动作 · 授权门）</h4>
        <label class="pv-quiet">
          <input
            type="checkbox"
            data-testid="pv-ha-control-toggle"
            :checked="perception.haControlEnabled"
            @change="setHaControlEnabled(($event.target as HTMLInputElement).checked)"
          />
          允许家居控制（默认关；每次控制仍需单独确认）
        </label>
        <p class="mc-note">
          控制是帮你按一下开关，不是医学判断或健康建议；未授权、未确认时一律不执行。
        </p>
        <div class="pv-actions pv-control">
          <button
            class="btn"
            data-testid="pv-ac-on"
            :disabled="!perception.haControlEnabled || perception.haStatus !== 'connected'"
            @click="requestControl('turn_on')"
          >
            开空调（{{ acEntityId }}）
          </button>
          <button
            class="btn"
            data-testid="pv-ac-off"
            :disabled="!perception.haControlEnabled || perception.haStatus !== 'connected'"
            @click="requestControl('turn_off')"
          >
            关空调
          </button>
        </div>
        <div v-if="pendingControl" class="pv-confirm" data-testid="pv-control-confirm">
          <p>确认执行「{{ pendingControl.label }}」？实体：{{ pendingControl.entityId }}（会真实下发控制）</p>
          <button class="btn primary" data-testid="pv-control-confirm-yes" @click="confirmControl">确认执行</button>
          <button class="btn" data-testid="pv-control-confirm-no" @click="cancelControl">取消</button>
        </div>
        <p v-if="controlNote || perception.lastControlResult" class="pv-judge" data-testid="pv-control-result">
          {{ controlNote || perception.lastControlResult }}
        </p>
      </section>

      <section class="mc-card">
        <h3>主动提醒 <small>出门 / 16℃ 持续偏低 / 照度</small></h3>
        <p class="mc-note">
          对她说「我要出门了 / 再见」会触发：查新鲜天气 + 检索「出行」标签记忆，合并成一条提醒。
          安静时段不主动打扰；说「带伞了 / 不出门」会取消提醒。
          温度/照度提醒同样走额度（默认每小时 2 条）与安静时段。
        </p>
        <p v-if="perception.lastReminderNote" class="pv-judge" data-testid="pv-reminder-judge">
          最近判定：{{ perception.lastReminderNote }}
        </p>
        <label class="pv-quiet">
          <input type="checkbox" :checked="perception.quietEnabled" @change="setQuietEnabled(($event.target as HTMLInputElement).checked)" />
          静默提醒（安静时段不主动弹出；你主动问仍会回答）
        </label>
        <ul class="pv-reminders" v-if="perception.reminders.length">
          <li v-for="reminder in perception.reminders" :key="reminder.id" data-testid="pv-reminder">
            <p>{{ reminder.text }}</p>
            <button class="btn" @click="dismissReminder(reminder.id)">知道了</button>
          </li>
        </ul>
        <p v-else class="mc-empty">当前没有提醒。提醒内容是不可信数据，不会被当成指令执行。</p>
      </section>

      <section class="mc-card">
        <h3>五感口径 <small>不假称能闻味尝味</small></h3>
        <ul class="pv-senses">
          <li><b>听觉</b>：经同意的语音与对话意图</li>
          <li><b>视觉</b>：你授权共享的画面（本机只读镜像页签）</li>
          <li><b>环境</b>：室外天气（已接）、室内温湿度/照度与设备状态（HA，需配置）</li>
          <li><b>时间/活动</b>：日程、当前任务、出门意图、安静时段</li>
          <li><b>关系/上下文</b>：偏好、此前承诺、近期交流（本地记忆库）</li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.pv-control {
  flex-wrap: wrap;
}
.pv-confirm {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px dashed var(--border, rgba(128, 128, 128, 0.5));
  border-radius: 8px;
}
.pv-confirm p {
  margin: 0 0 6px;
  font-size: 12px;
}
.pv-confirm .btn {
  margin-right: 6px;
}
</style>
