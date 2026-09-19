<script setup lang="ts">
// 人物区状态浮签（G-UI-06）：把 store.sceneState / 当前页签翻译成「她在做什么」。
// 纯装饰 HUD，不拦截输入；状态语义已在顶栏 voice-state 播报，这里 aria-hidden 避免重复朗读。
import { computed } from 'vue';
import { store } from '../../app/store';

const activity = computed(() => {
  switch (store.sceneState) {
    case 'speaking': return '正在回答你';
    case 'listening': return '在听你说';
    case 'working': return '正在处理中';
    default: break;
  }
  switch (store.tab) {
    case 'mirror': return '在看共享的画面';
    case 'workspace': return '在演示工作区待命';
    case 'perception': return '在留意周围';
    case 'mc': return '在 MC 世界里忙';
    case 'tasks': return '在盯任务进度';
    case 'stats': return '在核算用量';
    default: return '待机 · 等你说点什么';
  }
});
</script>

<template>
  <div class="scene-status" :class="'st-' + store.sceneState" aria-hidden="true">
    <span class="ss-dot" />
    <span class="ss-label">她在做什么</span>
    <strong class="ss-value">{{ activity }}</strong>
  </div>
</template>
