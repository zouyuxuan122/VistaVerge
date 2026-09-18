<script setup lang="ts">
// 感知中心：温度/天气（真实 Open-Meteo 网络）+ 智能家居（Home Assistant）+ 主动提醒。
// 诚实口径：天气过期就写「不确定」不给数值；HA 未配置就写 BLOCKED；温度严格区分实测与设定。
import { computed, onMounted } from 'vue';
import { setNav, store } from '../app/store';
import {
  connectHa,
  dismissReminder,
  perception,
  refreshTemperature,
  refreshWeather,
  setQuietEnabled,
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

const tempEntities = computed(() =>
  perception.haEntities.filter(
    (e) => e.entityId.startsWith('climate.') || e.entityId.startsWith('sensor.') && 'current_temperature' in e.attributes,
  ),
);

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

onMounted(() => {
  void refreshWeather();
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
        </ul>

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
      </section>

      <section class="mc-card">
        <h3>主动提醒 <small>出门场景</small></h3>
        <p class="mc-note">
          对她说「我要出门了 / 再见」会触发：查新鲜天气 + 检索「出行」标签记忆，合并成一条提醒。
          安静时段不主动打扰；说「带伞了 / 不出门」会取消提醒。
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
          <li><b>环境</b>：室外天气（已接）、室内温湿度与设备状态（HA，需配置）</li>
          <li><b>时间/活动</b>：日程、当前任务、出门意图、安静时段</li>
          <li><b>关系/上下文</b>：偏好、此前承诺、近期交流（本地记忆库）</li>
        </ul>
      </section>
    </div>
  </div>
</template>
