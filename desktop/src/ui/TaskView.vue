<script setup lang="ts">
import { store } from '../app/store';

const gates = [
  { title: 'FOUNDATION-01 测试与合同基础', state: 'done', note: '58 用例 + 类型/构建全绿' },
  { title: 'EXP-001 工程与品牌、EXP-002 数据层、EXP-003 语音、EXP-004 场景', state: 'done', note: '169 用例全绿' },
  { title: 'EXP-005/006 界面与插件感知集成', state: 'progress', note: '当前批次' },
  { title: '真实供应商语音验收', state: 'blocked', note: '缺 API Key' },
  { title: '真实 VRM/Live2D 资产', state: 'blocked', note: '缺授权素材' },
  { title: 'Minecraft / QQ / 智能家居 真实环境', state: 'blocked', note: '缺服务器与账号' },
];
</script>

<template>
  <div class="pane-scroll">
    <span class="cap-badge">数据文件：{{ store.persistenceKind }} · 会话与记忆本地持久化</span>
    <div v-for="g in gates" :key="g.title" class="task-row">
      <span class="state" :class="g.state === 'done' ? 'done' : g.state === 'blocked' ? 'blocked' : 'progress'">
        {{ g.state === 'done' ? '完成' : g.state === 'blocked' ? '阻塞' : '进行中' }}
      </span>
      <span class="title">{{ g.title }}</span>
      <span style="font-size:11px;color:var(--muted)">{{ g.note }}</span>
    </div>
    <p style="font-size:12px;color:var(--muted)">
      任务服务（队列/租约/恢复）随插件批次接入；此处先展示真实交付门禁状态，不用模拟数据冒充进度。
    </p>
  </div>
</template>
