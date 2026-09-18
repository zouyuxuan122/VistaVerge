<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import {
  store,
  llmBadge,
  sendUserText,
  editUserMessage,
  retryAssistant,
  copyText,
  switchBranch,
  toggleVoice,
  getVoice,
} from '../app/store';

const draft = ref('');
const editingId = ref<string | null>(null);
const editingText = ref('');
const composing = ref(false);
const scroller = ref<HTMLElement | null>(null);

watch(
  () => [store.messages.length, store.streaming],
  async () => {
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  },
);

async function send() {
  // 先提交，再清空：生成中按 Enter 时 sendUserText 会拒收，
  // 之前无条件清空输入框会把用户刚打的字丢掉且没有任何反馈。
  if (store.busy || !draft.value.trim()) return;
  const text = draft.value;
  const accepted = await sendUserText(text);
  if (accepted && draft.value === text) draft.value = '';
}

function onEnter(e: KeyboardEvent) {
  if (composing.value || e.isComposing) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

function startEdit(id: string, text: string) {
  editingId.value = id;
  editingText.value = text;
}

function confirmEdit() {
  if (editingId.value && editingText.value.trim()) {
    editUserMessage(editingId.value, editingText.value.trim());
  }
  editingId.value = null;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="branch-bar" v-if="store.branches.length > 1">
    分支
    <select :value="store.branchId" @change="switchBranch(($event.target as HTMLSelectElement).value)">
      <option v-for="(b, i) in store.branches" :key="b.id" :value="b.id">
        {{ b.title || `分支 ${i + 1}` }}（{{ b.messageCount }} 条）
      </option>
    </select>
    <span>编辑历史消息会生成新分支，原分支保留</span>
  </div>

  <div class="pane-scroll" ref="scroller" data-testid="chat-scroll">
    <span class="cap-badge" :class="{ mock: store.providerSettings.kind === 'mock' }">
      供应商：{{ llmBadge }}
    </span>

    <div v-for="m in store.messages" :key="m.id" class="msg" :class="'role-' + m.role">
      <div class="avatar">{{ m.role === 'user' ? '你' : 'V' }}</div>
      <div>
        <div class="bubble">
          <template v-if="editingId === m.id">
            <textarea v-model="editingText" rows="3" style="width:100%" />
          </template>
          <template v-else>{{ m.text }}</template>
        </div>
        <div class="tools">
          <span style="font-size:10px;color:var(--muted)">{{ fmtTime(m.createdAt) }}</span>
          <button @click="copyText(m.text)">复制</button>
          <template v-if="m.role === 'user'">
            <button v-if="editingId !== m.id" @click="startEdit(m.id, m.text)">编辑</button>
            <template v-else>
              <button @click="confirmEdit">生成新分支</button>
              <button @click="editingId = null">取消</button>
            </template>
          </template>
          <button v-if="m.role === 'assistant'" @click="retryAssistant(m.id)">重试</button>
        </div>
      </div>
    </div>

    <div v-if="store.streaming !== null" class="msg role-assistant">
      <div class="avatar">V</div>
      <div class="bubble streaming-caret">{{ store.streaming }}</div>
    </div>
    <div v-if="store.error" class="msg"><div class="bubble" style="border-color:var(--err);color:var(--err)">{{ store.error }}</div></div>

    <!-- 漫画主题空态：手绘涂鸦引导（仅手绘主题显示，写实主题 display:none） -->
    <div v-if="!store.messages.length && store.streaming === null" class="chat-empty" aria-hidden="true">
      <svg width="86" height="72" viewBox="0 0 86 72" fill="none" stroke="#2b2622" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M66 6 C 50 16, 34 26, 30 46" />
        <path d="M30 46 l -6 -13" />
        <path d="M30 46 l 12 -8" />
        <path d="M76 30 q 4 4 0 8 q -4 4 -8 0 q -4 -4 0 -8 q 4 -4 8 0" opacity="0.5" />
      </svg>
      <p class="doodle-note">先对她说点什么吧！</p>
    </div>
  </div>

  <div class="composer">
    <div class="composer-row">
      <textarea
        v-model="draft"
        placeholder="对 VistaVerge 说点什么…（Enter 发送，Shift+Enter 换行）"
        @keydown="onEnter"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      />
      <button class="btn" :class="{ danger: store.voiceState !== 'idle' }" @click="toggleVoice()">
        {{ store.voiceState === 'idle' ? '🎙 语音' : '■ 停止' }}
      </button>
      <button class="btn primary" :disabled="store.busy || !draft.trim()" @click="send">发送</button>
    </div>
    <div class="composer-hint">
      语音输入与回答都会显示在这里；打断她说话也会形成新的一轮。{{ getVoice() ? '' : '' }}
    </div>
  </div>
</template>
