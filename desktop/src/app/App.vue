<script setup lang="ts">
// 布局以项目最初前端（s2s/demo）为基座：人物全 bleed 背景层贴右 + 内容层浮于其上；
// 在其上加：左侧电脑屏幕（ScreenPane）、中央语音球（VoiceOrb）、底部胶囊导航、桌上笔记本。
import { computed, onMounted } from 'vue';
import { store, initStore, setNav, setTheme, voiceStateLabel, llmBadge } from './store';
import ThemeSwitch from '../ui/ThemeSwitch.vue';
import NavPill from '../ui/NavPill.vue';
import ScreenPane from '../ui/ScreenPane.vue';
import VideoAvatar from '../ui/VideoAvatar.vue';
import Live2DAvatar from '../ui/Live2DAvatar.vue';
import SceneCanvas from '../ui/SceneCanvas.vue';
import DeskLaptop from '../ui/DeskLaptop.vue';
import SettingsModal from '../ui/SettingsModal.vue';
import ReminderToast from '../ui/ReminderToast.vue';

const isMock = computed(() => store.providerSettings.kind === 'mock');

function goChat() { setNav('chat'); }

onMounted(() => { void initStore(); });
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
      <div class="topbar-right">
        <span class="cloud-badge" :class="{ mock: isMock }" :title="'供应商：' + store.providerSettings.kind">
          <span class="dot" />{{ llmBadge }}
        </span>
        <ThemeSwitch :model-value="store.theme" @update:model-value="setTheme" />
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
    </main>

    <footer class="statusbar">本地优先 · STT / LLM / TTS 均为可配置的 OpenAI 兼容接口 · 密钥仅存系统凭据仓</footer>

    <NavPill :current="store.nav" @select="setNav" />
    <SettingsModal v-if="store.settingsOpen" />
    <ReminderToast />
  </div>
</template>
