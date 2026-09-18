<script setup lang="ts">
// AI 工作区：应用自己拥有的执行平面（演示）。大光标只在这个面内移动，
// 不碰宿主鼠标/焦点（VISTAVERGE_DESIGN §2.2 硬约束）。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

interface WsEvent {
  actionId: number;
  surfaceId: string;
  frameId: number;
  x: number;
  y: number;
  note: string;
}

const SURFACE_ID = 'demo-surface-1';
const icons = [
  { name: '浏览器', glyph: '🌐', left: 22, top: 42 },
  { name: '文件夹', glyph: '📁', left: 22, top: 126 },
  { name: '记事本', glyph: '📝', left: 22, top: 210 },
  { name: '回收站', glyph: '🗑', left: 22, top: 294 },
];

/** 演示任务的计划步骤：面板里实时显示走到哪一步（不只是光标在动）。 */
const plan = [
  { icon: '浏览器', text: '打开浏览器', done: false },
  { icon: '记事本', text: '打开记事本并粘贴草稿', done: false },
  { icon: '文件夹', text: '在文件夹里归档', done: false },
];

const cursor = reactive({ x: 40, y: 60 });
const events = ref<WsEvent[]>([]);
const running = ref(false);
const stepIndex = ref(-1);
const currentStep = ref('');
let actionSeq = 0;
let frameSeq = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
/** 组件卸载后不再推进演示（否则会继续写已卸载组件的状态）。 */
let alive = true;

function clampToSurface(x: number, y: number) {
  return { x: Math.max(0, Math.min(800, x)), y: Math.max(0, Math.min(320, y)) };
}

function log(note: string, x = cursor.x, y = cursor.y) {
  actionSeq += 1;
  frameSeq += 1;
  events.value.unshift({ actionId: actionSeq, surfaceId: SURFACE_ID, frameId: frameSeq, x: Math.round(x), y: Math.round(y), note });
  if (events.value.length > 12) events.value.pop();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
}

async function runDemo() {
  if (running.value) return;
  running.value = true;
  for (const step of plan) step.done = false;
  stepIndex.value = -1;
  log('任务开始：打开浏览器（演示）');
  for (let i = 0; i < plan.length; i += 1) {
    const icon = icons[i];
    stepIndex.value = i;
    if (!alive) return;
    currentStep.value = `前往「${icon.name}」`;
    await wait(620);
    if (!alive) return;
    const target = clampToSurface(icon.left + 37, icon.top + 32);
    cursor.x = target.x;
    cursor.y = target.y;
    log(`移动到「${icon.name}」`, target.x, target.y);
    await wait(380);
    if (!alive) return;
    log(`点击「${icon.name}」`, target.x, target.y);
    plan[i].done = true;
  }
  stepIndex.value = -1;
  currentStep.value = '';
  log('任务完成：动作全部发生在演示工作区内，未触碰本机鼠标', cursor.x, cursor.y);
  running.value = false;
}

onBeforeUnmount(() => {
  alive = false;
  if (timer !== null) clearTimeout(timer);
});

const lastEvent = computed(() => events.value[0]);
const progressPct = computed(() => {
  const done = plan.filter((s) => s.done).length;
  return Math.round((done / plan.length) * 100);
});
const clock = ref('');
let clockTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  const tick = () => {
    clock.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  clockTimer = setInterval(tick, 20000);
});
onBeforeUnmount(() => {
  if (clockTimer !== null) clearInterval(clockTimer);
});
</script>

<template>
  <div class="pane-scroll">
    <span class="demo-tag">演示工作区 · 大光标仅在此面内移动，不动你的鼠标</span>
    <div class="workspace-stage" data-testid="demo-surface">
      <div class="ws-titlebar" aria-hidden="true">
        <span class="ws-dot r" /><span class="ws-dot y" /><span class="ws-dot g" />
        <span class="ws-title">vistaverge — ai-workspace</span>
        <span class="ws-plane">独立执行平面</span>
      </div>

      <div
        v-for="icon in icons"
        :key="icon.name"
        class="ws-icon"
        :style="{ left: icon.left + 'px', top: icon.top + 'px' }"
      >
        <span class="glyph">{{ icon.glyph }}</span>{{ icon.name }}
      </div>

      <!-- 任务计划窗：让「她在做什么」可见，而不是只有一个光标在动 -->
      <div class="ws-window" data-testid="ws-plan">
        <div class="ws-window-head">
          <span>任务计划 · 演示</span>
          <span class="ws-window-pct">{{ progressPct }}%</span>
        </div>
        <ol class="ws-plan">
          <li v-for="(step, i) in plan" :key="step.text" :class="{ done: step.done, active: stepIndex === i }">
            <span class="ws-plan-mark">{{ step.done ? '✓' : stepIndex === i ? '▸' : '·' }}</span>{{ step.text }}
          </li>
        </ol>
        <div class="ws-window-bar"><i :style="{ width: progressPct + '%' }" /></div>
        <p class="ws-window-note">
          大光标只在映射视口内绘制；不调用 SetCursorPos / SendInput，也不抢宿主焦点。
        </p>
      </div>

      <div class="virtual-cursor" :style="{ left: cursor.x + 'px', top: cursor.y + 'px' }" />

      <div class="ws-taskbar" aria-hidden="true">
        <span class="ws-chip">{{ SURFACE_ID }}</span>
        <span class="ws-chip">frame {{ lastEvent ? lastEvent.frameId : frameSeq }}</span>
        <span>{{ currentStep || (running ? '运行中…' : '空闲 · 未接管宿主输入') }}</span>
        <span class="ws-clock">{{ clock }}</span>
      </div>
    </div>

    <div style="margin-top:10px; display:flex; gap:10px; align-items:center">
      <button class="btn primary" :disabled="running" @click="runDemo">
        {{ running ? '演示运行中…' : '运行演示任务' }}
      </button>
      <span class="mc-meta">动作全部带 surfaceId / frameId，可审计</span>
    </div>

    <div class="ws-log" data-testid="ws-log">
      <div v-if="!events.length">还没有动作。点上面的按钮，看大光标只在工作区里移动。</div>
      <div v-for="e in events" :key="e.actionId">
        #{{ e.actionId }} [{{ e.surfaceId }}:{{ e.frameId }}] ({{ e.x }},{{ e.y }}) {{ e.note }}
      </div>
    </div>
  </div>
</template>
