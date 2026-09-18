<script setup lang="ts">
// 桌上笔记本道具：角色场景的前景层，营造"她正对着我们操作笔记本"的陪伴感。
// 透视关系：她面向我们坐在桌后，屏幕朝她——我们看到的是盖子背面。
// 笔记本本体为真实 3D 模型（CC-BY 4.0，见 LaptopModel 与 public/models/PROVENANCE.md），
// 台面/柔光为 CSS 场景装饰；整层 aria-hidden，不宣称任何真实能力。
import { computed } from 'vue';
import { store } from '../app/store';
import LaptopModel from './LaptopModel.vue';

const stateClass = computed(() => `is-${store.sceneState}`);
</script>

<template>
  <div class="desk-scene" :class="stateClass" aria-hidden="true">
    <div class="laptop-spill" />
    <div class="laptop">
      <LaptopModel />
    </div>
    <span class="laptop-credit">笔记本模型 MacBook Pro M3 · jackbaeten / W. Laverty · CC-BY 4.0</span>
  </div>
</template>

<style scoped>
.desk-scene {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 50%; /* 与人物背景层同区 */
  z-index: 3;
  pointer-events: none;
  overflow: hidden;
  --logo: var(--orb-idle); /* Logo 灯/漏光的状态色 */
}
.desk-scene.is-listening { --logo: var(--listening); }
.desk-scene.is-working { --logo: var(--processing); }
.desk-scene.is-speaking { --logo: var(--speaking); }

/* 屏幕光洒在人物与台面上的柔光（颜色随状态） */
.laptop-spill {
  position: absolute;
  left: 58%;
  bottom: 6%;
  width: 92%;
  height: 46%;
  transform: translateX(-50%);
  background: radial-gradient(58% 68% at 50% 100%, color-mix(in srgb, var(--logo) 15%, transparent), transparent 72%);
  mix-blend-mode: screen;
  transition: background 0.5s;
}

.laptop {
  position: absolute;
  left: 58%; /* 人物视觉中心偏右，笔记本摆在她身前 */
  bottom: 12.5%; /* 底边高于胶囊导航顶，不遮键盘接触区 */
  width: min(50%, 400px);
  aspect-ratio: 10 / 7; /* 留出桌子前沿与整机高度，避免切边穿模 */
  transform: translateX(-50%);
  filter: drop-shadow(0 22px 26px rgba(0, 0, 0, 0.55));
}

/* CC-BY 署名（许可要求，低对比不抢戏；避开胶囊导航与 scene-tag） */
.laptop-credit {
  position: absolute;
  right: 12px;
  bottom: 32px;
  font-size: 9px;
  letter-spacing: 0.04em;
  color: rgba(220, 228, 246, 0.28);
}

[data-theme="handdrawn"] .laptop-credit { color: rgba(43, 38, 34, 0.5); }

/* 窄窗右侧折叠为窄条时隐藏道具，保持整洁 */
@media (max-width: 1320px) {
  .desk-scene { display: none; }
}
</style>
