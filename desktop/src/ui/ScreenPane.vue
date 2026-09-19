<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { store, setTab, setTheme, type ScreenTab } from '../app/store';
import ChatView from './ChatView.vue';
import MirrorView from './MirrorView.vue';
import WorkspaceView from './WorkspaceView.vue';
import TaskView from './TaskView.vue';
import TeacherView from './TeacherView.vue';
import MarketView from './MarketView.vue';
import MemoryView from './MemoryView.vue';
import StatsView from './StatsView.vue';
import PerceptionView from './PerceptionView.vue';
import McView from './McView.vue';
import AssistantView from './AssistantView.vue';

const tabs: { id: ScreenTab; label: string }[] = [
  { id: 'chat', label: '对话' },
  { id: 'mirror', label: '本机只读镜像' },
  { id: 'workspace', label: 'AI 工作区' },
  { id: 'perception', label: '感知' },
  { id: 'mc', label: 'MC 模拟' },
  { id: 'tasks', label: '当前任务' },
  { id: 'stats', label: '统计' },
];

// 设置是覆盖层，不应切换工作区内容；学习/插件才切换为独立模块
const showTabs = computed(() => store.nav !== 'study' && store.nav !== 'plugins');
const pluginsTab = ref<'market' | 'memory' | 'assistant'>('market');
const tabsEl = ref<HTMLElement | null>(null);

/** 与 App.vue 一致的切换语义：有 View Transitions 就整页 crossfade，否则直切（降级无动画）。 */
function changeTheme(theme: 'realistic' | 'handdrawn') {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
  const reduce = document.documentElement.classList.contains('reduce-motion');
  if (typeof doc.startViewTransition === 'function' && !reduce) {
    doc.startViewTransition(() => setTheme(theme));
  } else {
    setTheme(theme);
  }
}

/**
 * 页签键盘可达（B-U-09）：roving tabindex + 左右方向键 + Home/End。
 * 焦点移动后同步选中，读屏与键盘用户都能确定「当前在哪一页」。
 */
function onTabKeydown(e: KeyboardEvent, index: number) {
  let next = index;
  if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  else return;
  e.preventDefault();
  setTab(tabs[next].id);
  void nextTick(() => {
    const buttons = tabsEl.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next]?.focus();
  });
}
</script>

<template>
  <section class="screen-pane" aria-label="电脑屏幕工作区">
    <!-- 显示器化：外框厚度 + 内屏凹槽 + 电源灯（纯装饰，不拦输入） -->
    <span class="monitor-bezel" aria-hidden="true"><i class="monitor-led" /></span>

    <!-- 屏幕左上角：二次元 / 正常 物理拨杆（复用 setTheme；顶栏 ThemeSwitch 保留不删） -->
    <div class="monitor-bar">
      <div class="theme-lever" role="group" aria-label="界面风格：二次元（手绘） / 正常（写实）">
        <button
          type="button"
          class="tl-opt"
          :aria-pressed="store.theme === 'handdrawn'"
          title="二次元手绘风"
          @click="changeTheme('handdrawn')"
        >二次元</button>
        <button
          type="button"
          class="tl-opt"
          :aria-pressed="store.theme === 'realistic'"
          title="正常写实风"
          @click="changeTheme('realistic')"
        >正常</button>
        <span class="tl-knob" :class="store.theme === 'handdrawn' ? 'is-left' : 'is-right'" aria-hidden="true" />
      </div>

      <!-- 对话 / 映射 快捷拨杆（不动下方既有 7 页签） -->
      <div v-if="showTabs" class="view-toggle" role="group" aria-label="快速切换：对话 / 映射">
        <button type="button" :aria-pressed="store.tab === 'chat'" @click="setTab('chat')">对话</button>
        <button type="button" :aria-pressed="store.tab === 'mirror'" @click="setTab('mirror')">映射</button>
      </div>

      <span class="monitor-brand" aria-hidden="true">VISTAVERGE · DISPLAY</span>
    </div>

    <div v-if="showTabs" class="screen-tabs" role="tablist" aria-label="屏幕页签" ref="tabsEl">
      <button
        v-for="(t, i) in tabs"
        :key="t.id"
        role="tab"
        :aria-selected="store.tab === t.id"
        :tabindex="store.tab === t.id ? 0 : -1"
        @click="setTab(t.id)"
        @keydown="onTabKeydown($event, i)"
      >{{ t.label }}</button>
    </div>

    <template v-if="showTabs">
      <ChatView v-if="store.tab === 'chat'" />
      <MirrorView v-else-if="store.tab === 'mirror'" />
      <WorkspaceView v-else-if="store.tab === 'workspace'" />
      <PerceptionView v-else-if="store.tab === 'perception'" />
      <McView v-else-if="store.tab === 'mc'" />
      <StatsView v-else-if="store.tab === 'stats'" />
      <TaskView v-else />
    </template>

    <div v-else-if="store.nav === 'study'" class="screen-body">
      <TeacherView />
    </div>

    <div v-else class="screen-body">
      <div class="screen-tabs" role="tablist">
        <button role="tab" :aria-selected="pluginsTab === 'market'" :tabindex="pluginsTab === 'market' ? 0 : -1" @click="pluginsTab = 'market'">插件市场</button>
        <button role="tab" :aria-selected="pluginsTab === 'memory'" :tabindex="pluginsTab === 'memory' ? 0 : -1" @click="pluginsTab = 'memory'">本地记忆</button>
        <button role="tab" :aria-selected="pluginsTab === 'assistant'" :tabindex="pluginsTab === 'assistant' ? 0 : -1" @click="pluginsTab = 'assistant'">助手</button>
      </div>
      <MarketView v-if="pluginsTab === 'market'" />
      <MemoryView v-else-if="pluginsTab === 'memory'" />
      <AssistantView v-else />
    </div>
  </section>
</template>
