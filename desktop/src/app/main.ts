import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import '../styles/app.css';

// 首帧前禁用过渡/动画，避免语音球等元素在第一次绘制时"渐入"穿帮（最初前端的 booting 技巧）
document.body.classList.add('booting');

// 主题必须在挂载前落盘到 <html>：store 的默认主题是手绘漫画（亮色），
// 但用户可能存了写实（暗色）。等到 initStore（onMounted）才应用会先闪一帧错主题。
try {
  const saved = localStorage.getItem('vistaverge.theme');
  document.documentElement.dataset.theme = saved === 'realistic' || saved === 'handdrawn' ? saved : 'handdrawn';
} catch {
  document.documentElement.dataset.theme = 'handdrawn';
}

createApp(App).use(createPinia()).mount('#app');
requestAnimationFrame(() => {
  requestAnimationFrame(() => document.body.classList.remove('booting'));
});
