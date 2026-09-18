/**
 * sensors/views/reminderToast.ts — 提醒浮层（可挂载组件实现）。
 *
 * 需求（EXP-006 步骤 5）：去重与静默可配；HA 未配置显示 BLOCKED 卡。
 * - 去重：同一文本只显示一条（引擎已按会话窗口去重，这里再做展示层去重）。
 * - 静默：开启后不弹出提醒，只显示“已静默”指示；用户可切换。
 * - HA 未配置：显示 BLOCKED 卡，不伪装已连接。
 */

import { computed, defineComponent, h, type PropType } from 'vue';
import { HA_BLOCKED_REASON, type HaStatus } from '../haClient';
import type { Reminder } from '../reminders';

export const ReminderToast = defineComponent({
  name: 'ReminderToast',
  props: {
    reminders: { type: Array as PropType<Reminder[]>, default: () => [] },
    haStatus: { type: String as PropType<HaStatus>, default: 'blocked' },
    blockedReason: { type: String, default: HA_BLOCKED_REASON },
    quietEnabled: { type: Boolean, default: false },
    onDismiss: { type: Function as PropType<(id: string) => void>, default: undefined },
    onToggleQuiet: { type: Function as PropType<(enabled: boolean) => void>, default: undefined },
  },
  emits: ['dismiss', 'toggle-quiet'],
  setup(props, { emit }) {
    /** 展示层去重：相同文本只保留第一条（先到先显示）。 */
    const visible = computed(() => {
      const seen = new Set<string>();
      const list: Reminder[] = [];
      for (const reminder of props.reminders) {
        const key = reminder.text.trim();
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(reminder);
      }
      return list;
    });

    function dismiss(id: string): void {
      emit('dismiss', id);
      props.onDismiss?.(id);
    }

    function toggleQuiet(event: Event): void {
      const enabled = (event.target as HTMLInputElement).checked;
      emit('toggle-quiet', enabled);
      props.onToggleQuiet?.(enabled);
    }

    return () =>
      h('aside', { 'data-test': 'reminder-toast-root', class: 'reminder-toast-root' }, [
        h('label', { class: 'reminder-quiet-row' }, [
          h('input', {
            type: 'checkbox',
            'data-test': 'reminder-quiet-toggle',
            checked: props.quietEnabled,
            onChange: toggleQuiet,
          }),
          '静默提醒（安静时段不主动打扰）',
        ]),
        props.quietEnabled
          ? h('p', { 'data-test': 'reminder-quiet-indicator', class: 'reminder-quiet-indicator' }, '已静默：提醒不弹出，用户主动询问不受影响。')
          : null,
        props.quietEnabled
          ? null
          : h(
              'ul',
              { class: 'reminder-list' },
              visible.value.map((reminder) =>
                h('li', { 'data-test': 'reminder-toast', class: 'reminder-toast' }, [
                  h('span', { 'data-test': 'reminder-text' }, reminder.text),
                  h('button', { 'data-test': 'reminder-dismiss', onClick: () => dismiss(reminder.id) }, '知道了'),
                ]),
              ),
            ),
        props.haStatus === 'blocked'
          ? h('div', { 'data-test': 'ha-blocked-card', class: 'ha-blocked-card' }, [
              h('strong', {}, 'HA 家居集成：BLOCKED'),
              h('p', {}, props.blockedReason),
            ])
          : null,
      ]);
  },
});

export default ReminderToast;
