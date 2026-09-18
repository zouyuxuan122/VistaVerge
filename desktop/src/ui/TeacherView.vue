<script setup lang="ts">
// EXP-006 教师面板（导入 → 提问带锚点 → 小测 → 批改证据 → 错题本）。
// 可挂载实现位于 src/teacher/views/teacherView.ts；本 SFC 为薄包装。
import { TeacherView } from '../teacher/views/teacherView';
</script>

<template>
  <TeacherView />
</template>
