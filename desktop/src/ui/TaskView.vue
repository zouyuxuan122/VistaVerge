<script setup lang="ts">
// 当前任务页（B-P-11）：接 taskService 的真实任务列表，不再硬编码门禁清单。
// 无任务时显示真实空态；数据层未就绪时如实报错，不用模拟进度冒充。
import { computed, onMounted, ref } from 'vue';
import { store } from '../app/store';
import { createTaskService, type Task } from '../plugins/taskService';

const service = createTaskService();
const tasks = ref<Task[]>([]);
const error = ref('');

function refresh(): void {
  try {
    tasks.value = service.list();
    error.value = '';
  } catch (err) {
    tasks.value = [];
    error.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(refresh);

const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: '未开始',
  IN_PROGRESS: '进行中',
  DONE: '完成',
  BLOCKED: '阻塞',
};

function stateClass(status: string): string {
  if (status === 'DONE') return 'done';
  if (status === 'BLOCKED') return 'blocked';
  return 'progress';
}

const counts = computed(() => {
  const out: Record<string, number> = { NOT_STARTED: 0, IN_PROGRESS: 0, DONE: 0, BLOCKED: 0 };
  for (const task of tasks.value) out[task.status] = (out[task.status] ?? 0) + 1;
  return out;
});

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <div class="pane-scroll">
    <span class="cap-badge">数据文件：{{ store.persistenceKind }} · 任务存本地 tasks 表</span>

    <div class="task-toolbar">
      <span class="mc-meta" data-testid="task-counts">
        未开始 {{ counts.NOT_STARTED }} · 进行中 {{ counts.IN_PROGRESS }} · 完成 {{ counts.DONE }} · 阻塞 {{ counts.BLOCKED }}
      </span>
      <button class="btn" data-testid="task-refresh" @click="refresh">刷新</button>
    </div>

    <p v-if="error" class="mc-warn" data-testid="task-error">任务数据不可用：{{ error }}</p>

    <div v-for="task in tasks" :key="task.id" class="task-row" data-testid="task-row">
      <span class="state" :class="stateClass(task.status)">{{ STATUS_LABEL[task.status] ?? task.status }}</span>
      <span class="title">{{ task.title }}</span>
      <span class="task-meta">{{ fmtTime(task.createdAt) }}<template v-if="task.dueAt"> · 截止 {{ fmtTime(task.dueAt) }}</template></span>
    </div>

    <p v-if="!error && tasks.length === 0" class="task-empty" data-testid="task-empty">
      还没有任务。任务会由教师/陪伴流程写入本地 tasks 表，这里显示真实记录，不展示模拟进度。
    </p>
  </div>
</template>

<style scoped>
.task-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 8px 0;
}
.task-meta {
  font-size: 11px;
  color: var(--muted);
}
.task-empty {
  font-size: 12px;
  color: var(--muted);
}
</style>
