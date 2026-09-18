<script setup lang="ts">
import { computed, ref } from 'vue';
import { store, setTab, type ScreenTab } from '../app/store';
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
const pluginsTab = ref<'market' | 'memory'>('market');
</script>

<template>
  <section class="screen-pane" aria-label="电脑屏幕工作区">
    <div v-if="showTabs" class="screen-tabs" role="tablist">
      <button
        v-for="t in tabs"
        :key="t.id"
        role="tab"
        :aria-selected="store.tab === t.id"
        @click="setTab(t.id)"
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
        <button role="tab" :aria-selected="pluginsTab === 'market'" @click="pluginsTab = 'market'">插件市场</button>
        <button role="tab" :aria-selected="pluginsTab === 'memory'" @click="pluginsTab = 'memory'">本地记忆</button>
      </div>
      <MarketView v-if="pluginsTab === 'market'" />
      <MemoryView v-else />
    </div>
  </section>
</template>
