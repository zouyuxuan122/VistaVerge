<script setup lang="ts">
// 布局以项目最初前端（s2s/demo）为基座：人物全 bleed 背景层贴右 + 内容层浮于其上；
// 在其上加：左侧电脑屏幕（ScreenPane）、底部胶囊导航、桌上笔记本。
// 注意：中央语音球（VoiceOrb）已按负责人要求移除，语音入口 = 输入框「语音」按钮 + 顶栏状态。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { store, initStore, setNav, setTheme, closeSettings, voiceStateLabel, llmBadge } from './store';
import ThemeSwitch from '../ui/ThemeSwitch.vue';
import NavPill from '../ui/NavPill.vue';
import ScreenPane from '../ui/ScreenPane.vue';
import VideoAvatar from '../ui/VideoAvatar.vue';
import Live2DAvatar from '../ui/Live2DAvatar.vue';
import SceneCanvas from '../ui/SceneCanvas.vue';
import DeskLaptop from '../ui/DeskLaptop.vue';
import SettingsModal from '../ui/SettingsModal.vue';
import ReminderToast from '../ui/ReminderToast.vue';
import SceneStatusTag from '../ui/decor/SceneStatusTag.vue';
import DeskTrinkets from '../ui/decor/DeskTrinkets.vue';

const isMock = computed(() => store.providerSettings.kind === 'mock');

/** 顶栏中段实时时钟（G-UI-06）：让顶栏中段有内容，不再空着。 */
const clock = ref('');
let clockTimer: ReturnType<typeof setInterval> | null = null;
function tickClock() {
  clock.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function goChat() { setNav('chat'); }

/**
 * 主题切换全页 crossfade（G-UI-07）：有 View Transitions 就用它做整页交叉淡入，
 * 没有（或系统要求减少动效）就直切——降级无动画，功能不受影响。
 */
function changeTheme(theme: 'realistic' | 'handdrawn') {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
  const reduce = document.documentElement.classList.contains('reduce-motion');
  if (typeof doc.startViewTransition === 'function' && !reduce) {
    doc.startViewTransition(() => setTheme(theme));
  } else {
    setTheme(theme);
  }
}

/** Esc 关闭设置弹层（B-U-08）：在 App 层监听，不改 SettingsModal 本体。 */
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && store.settingsOpen) {
    e.preventDefault();
    closeSettings();
  }
}

onMounted(() => {
  tickClock();
  clockTimer = setInterval(tickClock, 1000);
  window.addEventListener('keydown', onGlobalKeydown);
  void initStore();
});
onBeforeUnmount(() => {
  if (clockTimer !== null) clearInterval(clockTimer);
  window.removeEventListener('keydown', onGlobalKeydown);
});
</script>

<template>
  <div v-if="store.initError" class="boot-screen">
    <div class="err">初始化失败：{{ store.initError }}</div>
  </div>
  <div v-else-if="!store.ready" class="boot-screen">正在启动 VistaVerge…</div>
  <div v-else class="app-shell">
    <!-- 人物全 bleed 背景层（z0，装饰性不拦截输入；诚实标注保留在各形象组件内） -->
    <div class="avatar-side">
      <Live2DAvatar v-if="store.avatarMode === 'live2d'" />
      <VideoAvatar v-else-if="store.avatarMode === 'video'" />
      <SceneCanvas v-else />
      <div class="side-keylight" aria-hidden="true" />
      <DeskLaptop />
    </div>

    <!-- 人物区状态浮签：她在做什么（装饰 HUD，不拦输入） -->
    <SceneStatusTag />

    <header class="topbar">
      <div class="brand">
        <div class="ident">
          <div class="ident-head">
            <span class="ident-title">VistaVerge</span>
            <span class="brand-tag">AI COMPANION</span>
          </div>
          <p class="ident-blurb">语音数字人伙伴：STT / LLM / TTS 均为可配置的 OpenAI 兼容接口，数据本地优先。</p>
          <div class="ident-meta">链路&nbsp;&nbsp;麦克风 → VAD → 识别 → 对话 → 合成 → 数字人</div>
        </div>
      </div>

      <!-- 顶栏中段：链路状态 + 实时时钟 + 装饰分隔（G-UI-06，纯展示） -->
      <div class="topbar-mid" aria-hidden="true">
        <span class="tm-rule" />
        <div class="tm-readout">
          <span class="tm-status" :class="{ offline: !!store.initError, mock: isMock }">
            <span class="dot" />{{ store.initError ? '链路离线' : isMock ? '演示链路' : '链路在线' }}
          </span>
          <span class="tm-time">{{ clock }}</span>
        </div>
        <span class="tm-rule" />
      </div>

      <div class="topbar-right">
        <span class="cloud-badge" :class="{ mock: isMock }" :title="'供应商：' + store.providerSettings.kind">
          <span class="dot" />{{ llmBadge }}
        </span>
        <ThemeSwitch :model-value="store.theme" @update:model-value="changeTheme" />
        <span class="voice-state" :class="'st-' + store.voiceState">
          <span class="dot" />{{ voiceStateLabel() }}
        </span>
        <button class="icon-btn" type="button" title="对话" aria-label="对话" @click="goChat">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
        </button>
        <button class="icon-btn" type="button" title="设置" aria-label="设置" @click="setNav('settings')">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82A1.65 1.65 0 0 0 4.6 15H4a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 6 9.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.82.33l.06.06a2 2 0 1 1 2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82.33V15z" /></svg>
        </button>
      </div>
    </header>

    <main class="stage">
      <ScreenPane />
      <!-- 显示器底座（纯装饰，位于屏幕面板下方、胶囊导航上方） -->
      <span class="monitor-stand" aria-hidden="true" />
    </main>

    <footer class="statusbar">本地优先 · STT / LLM / TTS 均为可配置的 OpenAI 兼容接口 · 密钥仅存系统凭据仓</footer>

    <!-- 桌面小物：底部两侧的漫画贴纸/便签（装饰，不拦输入） -->
    <DeskTrinkets />

    <NavPill :current="store.nav" @select="setNav" />
    <!-- 设置弹层 scale+fade 入场/退场（G-UI-07）：Transition 包在组件外，不改 SettingsModal 本体 -->
    <Transition name="modal">
      <SettingsModal v-if="store.settingsOpen" />
    </Transition>
    <ReminderToast />
  </div>
</template>
