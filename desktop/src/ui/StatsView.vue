<script setup lang="ts">
// 统计：花费 / token 消耗曲线 / GitHub 风热力图。数据全部来自本地 usage_ledger（SQLite）。
// 诚实口径：供应商返回真实 usage 才算真实值；估算条目会标注占比；未设单价只显示 token。
import { computed, ref, watch } from 'vue';
import { store } from '../app/store';
import {
  usageTotals,
  usageDaily,
  usageHeatmap,
  recentUsage,
  startOfLocalDay,
  type HeatCell,
} from '../data/usage';

const rev = ref(0);
watch(() => store.usageRevision, (v) => { rev.value = v; });

const DAY_MS = 24 * 60 * 60 * 1000;

// 「今日」的边界必须在每次重算时取：之前 todayStart 在 setup 里只算一次，
// 页面跨过午夜后「今日/近7天」卡片仍是昨天的桶，与曲线末点对不上。
const totals = computed(() => {
  void rev.value;
  const todayStart = startOfLocalDay(Date.now());
  return {
    today: usageTotals(todayStart),
    week: usageTotals(todayStart - 6 * DAY_MS),
    all: usageTotals(0),
  };
});
const daily = computed(() => { void rev.value; return usageDaily(30); });
const heat = computed(() => { void rev.value; return usageHeatmap(26); });
const recent = computed(() => { void rev.value; return recentUsage(8); });

const priceSet = computed(() => store.providerSettings.llmPriceIn > 0 || store.providerSettings.llmPriceOut > 0);
const hasMock = computed(() => { void rev.value; return recent.value.some((r) => r.provider === 'mock'); });

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
function fmtCost(micros: number): string {
  if (!priceSet.value) return '—';
  const yuan = micros / 1_000_000;
  if (yuan === 0) return '¥0';
  if (yuan < 0.01) return `¥${yuan.toFixed(4)}`;
  return `¥${yuan.toFixed(2)}`;
}
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/* ── 曲线：近 30 天 token（prompt + completion） ── */
const CHART_W = 620;
const CHART_H = 150;
const chart = computed(() => {
  const data = daily.value;
  const max = Math.max(1, ...data.map((d) => d.promptTokens + d.completionTokens));
  const stepX = data.length > 1 ? CHART_W / (data.length - 1) : CHART_W;
  const yOf = (v: number) => CHART_H - 18 - (v / max) * (CHART_H - 40);
  const line = (key: 'promptTokens' | 'completionTokens') =>
    data.map((d, i) => `${(i * stepX).toFixed(1)},${yOf(d[key]).toFixed(1)}`).join(' ');
  const area = `0,${CHART_H - 18} ${line('promptTokens')} ${CHART_W},${CHART_H - 18}`;
  return { max, stepX, yOf, promptLine: line('promptTokens'), completionLine: line('completionTokens'), area, data };
});

/* ── 热力图：26 周 × 7 天，GitHub 五级配色 ── */
const heatMax = computed(() => Math.max(1, ...heat.value.map((c) => c.tokens)));
function level(cell: HeatCell): number {
  if (cell.tokens <= 0) return 0;
  const r = cell.tokens / heatMax.value;
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}
const heatWeeks = computed(() => {
  const cells = heat.value;
  const cols: HeatCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));
  return cols;
});
function heatTitle(cell: HeatCell): string {
  const cost = priceSet.value ? ` · ${fmtCost(cell.costMicros)}` : '';
  return `${cell.day} · ${cell.tokens} tokens · ${cell.calls} 次调用${cost}`;
}
</script>

<template>
  <div class="pane-scroll stats-view">
    <span class="cap-badge" :class="{ mock: hasMock }">
      {{ hasMock ? '含 MOCK 演示数据（非真实账单）' : '本地台账 · 仅存计量数字' }}
    </span>

    <!-- 花费与用量卡片 -->
    <div class="stat-cards">
      <div class="stat-card">
        <span class="k">今日</span>
        <strong>{{ fmtTokens(totals.today.promptTokens + totals.today.completionTokens) }}</strong>
        <span class="sub">{{ totals.today.calls }} 次调用 · {{ fmtCost(totals.today.costMicros) }}</span>
      </div>
      <div class="stat-card">
        <span class="k">近 7 天</span>
        <strong>{{ fmtTokens(totals.week.promptTokens + totals.week.completionTokens) }}</strong>
        <span class="sub">{{ totals.week.calls }} 次调用 · {{ fmtCost(totals.week.costMicros) }}</span>
      </div>
      <div class="stat-card">
        <span class="k">累计</span>
        <strong>{{ fmtTokens(totals.all.promptTokens + totals.all.completionTokens) }}</strong>
        <span class="sub">{{ totals.all.calls }} 次调用 · {{ fmtCost(totals.all.costMicros) }}</span>
      </div>
    </div>
    <p class="stat-note">
      输入 {{ fmtTokens(totals.all.promptTokens) }} / 输出 {{ fmtTokens(totals.all.completionTokens) }} tokens
      <template v-if="!priceSet"> · 未设单价，花费不显示（设置 → 高级可填）</template>
      <template v-if="totals.all.estimatedCalls > 0">
        · 其中 {{ totals.all.estimatedCalls }} 条为估算（供应商未返回 usage，按字符启发式折算）
      </template>
    </p>

    <!-- token 消耗曲线 -->
    <h3 class="stat-h">Token 消耗 · 近 30 天</h3>
    <div class="stat-chart">
      <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" role="img" aria-label="近 30 天 token 消耗曲线">
        <line v-for="i in 3" :key="i" x1="0" :y1="CHART_H - 18 - (i * (CHART_H - 40)) / 4"
              :x2="CHART_W" :y2="CHART_H - 18 - (i * (CHART_H - 40)) / 4" class="grid" />
        <polygon :points="chart.area" class="area" />
        <polyline :points="chart.promptLine" class="line-prompt" />
        <polyline :points="chart.completionLine" class="line-completion" />
        <circle v-for="(d, i) in chart.data" :key="d.day"
                :cx="i * chart.stepX" :cy="chart.yOf(d.promptTokens + d.completionTokens)" r="2.4" class="dot">
          <title>{{ d.day }} · {{ d.promptTokens + d.completionTokens }} tokens · {{ d.calls }} 次</title>
        </circle>
        <text x="0" :y="CHART_H - 4" class="axis">{{ chart.data[0]?.day.slice(5) }}</text>
        <text :x="CHART_W" :y="CHART_H - 4" class="axis" text-anchor="end">
          {{ chart.data[chart.data.length - 1]?.day.slice(5) }}
        </text>
        <text :x="CHART_W" y="12" class="axis" text-anchor="end">峰值 {{ fmtTokens(chart.max) }}</text>
      </svg>
      <p class="legend">
        <span class="lg lg-prompt" /> 输入 <span class="lg lg-completion" /> 输出
      </p>
    </div>

    <!-- GitHub 风热力图 -->
    <h3 class="stat-h">活跃热力图 · 近 26 周</h3>
    <div class="heat-wrap">
      <div class="heat-grid">
        <div v-for="(week, wi) in heatWeeks" :key="wi" class="heat-col">
          <span v-for="cell in week" :key="cell.day" class="heat-cell" :class="'lv' + level(cell)" :title="heatTitle(cell)" />
        </div>
      </div>
      <p class="legend heat-legend">
        少 <span class="heat-cell lv0" /><span class="heat-cell lv1" /><span class="heat-cell lv2" /><span class="heat-cell lv3" /><span class="heat-cell lv4" /> 多
      </p>
    </div>

    <!-- 最近记录 -->
    <h3 class="stat-h">最近记录</h3>
    <div v-if="recent.length === 0" class="stat-empty">
      还没有用量记录。发一条消息或开一次语音对话，这里就会出现曲线与热力图。
    </div>
    <table v-else class="stat-table">
      <thead><tr><th>时间</th><th>类型</th><th>模型</th><th>tokens</th><th>花费</th></tr></thead>
      <tbody>
        <tr v-for="r in recent" :key="r.id">
          <td>{{ fmtTime(r.ts) }}</td>
          <td>{{ r.kind === 'llm' ? '对话' : r.kind === 'tts' ? '语音合成' : '语音识别' }}<span v-if="r.estimated" class="est">估算</span></td>
          <td class="mono">{{ r.model || r.provider || '—' }}</td>
          <td class="mono">{{ r.kind === 'llm' ? fmtTokens(r.promptTokens + r.completionTokens) : `${r.units} 字` }}</td>
          <td class="mono">{{ fmtCost(r.costMicros) }}</td>
        </tr>
      </tbody>
    </table>
    <p class="stat-note">
      计量说明：LLM 用量优先取供应商回传的真实 usage（已开启 stream_options.include_usage），
      缺失时按字符启发式估算并标注；语音合成只计字符数，语音识别暂未计量；台账只存数字不存正文。
    </p>
  </div>
</template>

<style scoped>
.stats-view { position: relative; }
.stat-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 10px; }
.stat-card {
  display: flex; flex-direction: column; gap: 2px;
  padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.03);
}
.stat-card .k { font-size: 11px; letter-spacing: 0.08em; color: var(--faint); }
.stat-card strong { font-size: 22px; font-family: var(--font-display); }
.stat-card .sub { font-size: 11px; color: var(--muted); }
.stat-note { font-size: 11px; line-height: 1.9; color: var(--faint); margin: 6px 0 4px; }
.stat-h { font-size: 13px; margin: 18px 0 8px; color: var(--text); font-family: var(--font-display); }
.stat-chart svg { width: 100%; height: auto; display: block; }
.stat-chart .grid { stroke: var(--line); stroke-width: 1; }
.stat-chart .area { fill: rgba(142, 162, 255, 0.14); }
.stat-chart .line-prompt { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
.stat-chart .line-completion { fill: none; stroke: var(--accent-warm); stroke-width: 1.6; stroke-dasharray: 4 3; }
.stat-chart .dot { fill: var(--accent); }
.stat-chart .axis { fill: var(--faint); font-size: 10px; font-family: var(--font-mono); }
.legend { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--faint); margin: 6px 0 0; }
.legend .lg { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
.lg-prompt { background: var(--accent); }
.lg-completion { background: var(--accent-warm); }
.heat-wrap { overflow-x: auto; }
.heat-grid { display: flex; gap: 3px; min-width: max-content; }
.heat-col { display: flex; flex-direction: column; gap: 3px; }
/* 空态格子用 --line：写实是极淡白、手绘是可见的墨灰，两个主题都看得见（B-U-01）。 */
.heat-cell { width: 11px; height: 11px; border-radius: 2.5px; display: inline-block; background: var(--line); }
.heat-cell.lv1 { background: color-mix(in srgb, var(--ok) 32%, transparent); }
.heat-cell.lv2 { background: color-mix(in srgb, var(--ok) 55%, transparent); }
.heat-cell.lv3 { background: color-mix(in srgb, var(--ok) 78%, transparent); }
.heat-cell.lv4 { background: var(--ok); }
.heat-legend { margin-top: 8px; }
.stat-empty { font-size: 12px; color: var(--muted); padding: 10px 0 4px; }
.stat-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.stat-table th { text-align: left; font-size: 10px; letter-spacing: 0.08em; color: var(--faint); font-weight: 500; padding: 4px 6px; }
.stat-table td { padding: 7px 6px; border-top: 1px solid var(--line); color: var(--muted); }
.stat-table .mono { font-family: var(--font-mono); font-size: 11px; }
.stat-table .est { margin-left: 6px; font-size: 9px; color: var(--accent-warm); border: 1px solid currentColor; border-radius: 4px; padding: 0 3px; }

/* ── 手绘漫画主题：油墨卡 + 硬投影 + 手绘曲线（G-UI-02） ──
   选择器带 data-theme 前缀 + scoped 属性，特异性高于基础规则，双主题互不干扰。 */
[data-theme="handdrawn"] .stat-card {
  background: #fff; border: 1.5px solid var(--ink); color: var(--ink);
  border-radius: var(--radius-md);
  box-shadow: 3px 3px 0 rgba(43, 38, 34, 0.22);
}
[data-theme="handdrawn"] .stat-card:nth-child(1) { transform: rotate(-0.6deg); }
[data-theme="handdrawn"] .stat-card:nth-child(2) { transform: rotate(0.4deg); }
[data-theme="handdrawn"] .stat-card:nth-child(3) { transform: rotate(-0.3deg); }
[data-theme="handdrawn"] .stat-card .k { color: var(--faint); }
[data-theme="handdrawn"] .stat-card strong { color: var(--accent); }
[data-theme="handdrawn"] .stat-card .sub { color: var(--muted); }
[data-theme="handdrawn"] .stat-note { color: var(--muted); }
[data-theme="handdrawn"] .stat-h {
  color: var(--ink); font-family: var(--font-display); font-weight: 400;
  border-bottom: 1.5px dashed rgba(43, 38, 34, 0.35); padding-bottom: 5px;
}
[data-theme="handdrawn"] .stat-chart {
  background: #fff; border: 1.5px solid var(--ink); border-radius: var(--radius-md);
  padding: 10px 12px 4px; box-shadow: 3px 3px 0 rgba(43, 38, 34, 0.16);
}
[data-theme="handdrawn"] .stat-chart .grid { stroke: rgba(43, 38, 34, 0.18); stroke-dasharray: 3 4; }
[data-theme="handdrawn"] .stat-chart .area { fill: rgba(232, 84, 63, 0.12); }
[data-theme="handdrawn"] .stat-chart .line-prompt { stroke: var(--accent); stroke-width: 2.4; }
[data-theme="handdrawn"] .stat-chart .line-completion { stroke: #0e9aa8; stroke-width: 1.8; }
[data-theme="handdrawn"] .stat-chart .dot { fill: var(--accent); stroke: #fff; stroke-width: 1; }
[data-theme="handdrawn"] .stat-chart .axis { fill: var(--muted); }
[data-theme="handdrawn"] .legend { color: var(--muted); }
[data-theme="handdrawn"] .lg-completion { background: #0e9aa8; }
[data-theme="handdrawn"] .heat-cell { border: 1px solid rgba(43, 38, 34, 0.28); border-radius: 3px 2px 3px 2px; }
[data-theme="handdrawn"] .heat-cell.lv1 { background: color-mix(in srgb, var(--ok) 30%, #fff); }
[data-theme="handdrawn"] .heat-cell.lv2 { background: color-mix(in srgb, var(--ok) 55%, #fff); }
[data-theme="handdrawn"] .heat-cell.lv3 { background: color-mix(in srgb, var(--ok) 78%, #fff); }
[data-theme="handdrawn"] .heat-cell.lv4 { background: var(--ok); }
[data-theme="handdrawn"] .stat-empty {
  color: var(--muted); background: rgba(255, 253, 247, 0.7);
  border: 1.5px dashed var(--ink); border-radius: var(--radius-md); padding: 12px 14px;
}
[data-theme="handdrawn"] .stat-table th { color: var(--faint); }
[data-theme="handdrawn"] .stat-table td { border-top: 1.5px solid rgba(43, 38, 34, 0.22); color: var(--ink); }
[data-theme="handdrawn"] .stat-table .est { color: var(--accent); }
</style>
