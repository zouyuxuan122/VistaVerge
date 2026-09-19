<script setup lang="ts">
// 桌面小物（G-UI-06）：底部两侧的漫画贴纸与便签，纯装饰、不拦输入、不宣称任何能力。
// 手绘主题下呈现；写实主题保持电影感的极简，由 app.css 隐藏。
</script>

<template>
  <div class="desk-trinkets" aria-hidden="true">
    <span class="trinket trinket-sticker">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3l2.4 5.4 5.9.5-4.5 3.9 1.4 5.8L12 15.8 6.8 18.6l1.4-5.8L3.7 8.9l5.9-.5z" />
      </svg>
      保持好奇
    </span>
    <span class="trinket trinket-note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1v1h6v-1c0-.4.1-.8.5-1.1A6 6 0 0 0 12 3z" />
      </svg>
      记得喝水
    </span>
  </div>
</template>
