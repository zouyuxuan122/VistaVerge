<script setup lang="ts">
// 提醒浮层：接真实感知状态（出门提醒 + HA 状态 + 静默开关）。
// 之前挂载时没有传任何 props：reminders 恒为空、haStatus 恒为 blocked，
// 于是页面上永远挂着一张裸的 BLOCKED 卡（且无样式、占据布局高度），提醒功能不可能出现。
// 可挂载实现位于 src/sensors/views/reminderToast.ts；本 SFC 为薄包装。
import { dismissReminder, perception, setQuietEnabled } from '../sensors/perceptionStore';
import { ReminderToast } from '../sensors/views/reminderToast';

function onDismiss(id: string) {
  dismissReminder(id);
}

function onToggleQuiet(enabled: boolean) {
  setQuietEnabled(enabled);
}
</script>

<template>
  <!-- 只在真的有提醒时浮出。HA 未配置的完整说明在「感知」页签里常驻，
       不在每个页面都挂一张常驻浮卡（之前那张裸卡还占着布局高度）。 -->
  <ReminderToast
    v-if="perception.reminders.length > 0"
    :reminders="perception.reminders"
    :ha-status="perception.haStatus"
    :blocked-reason="perception.haBlockedReason ?? ''"
    :quiet-enabled="perception.quietEnabled"
    :on-dismiss="onDismiss"
    :on-toggle-quiet="onToggleQuiet"
  />
</template>
