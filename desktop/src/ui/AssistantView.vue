<script setup lang="ts">
// AssistantView — 「项目小助手」两个卡片区（F1-ASSIST 步骤 3）：
// 1) GitHub 只读巡检：仓库/凭据状态/立即巡检/摘要与列表/定时开关+间隔；
// 2) 社媒草稿：平台切换、收件人/内容、预览气泡、草稿列表、发送确认弹层 → 诚实未就绪。
// 依赖经 props 注入（缺省用真实服务），组件不 import app/store，可独立挂载测试。
// 样式只用 <style scoped> + 主题变量（不编辑 app.css），双主题通用。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  PATROL_STATUS_LABEL,
  createGhPatrolService,
  type GhPatrolService,
  type PatrolRunResult,
} from '../assistant/ghPatrol';
import {
  SOCIAL_CHANNEL_NOT_READY,
  SOCIAL_LIMITS,
  SOCIAL_PLATFORM_LABEL,
  createSocialDraftService,
  previewContent,
  type DraftPreview,
  type SendDecision,
  type SocialDraft,
  type SocialDraftService,
  type SocialPlatform,
} from '../assistant/socialDraft';

const props = defineProps<{
  /** 巡检服务（缺省 createGhPatrolService()，真实凭据仓 + localStorage）。 */
  patrol?: GhPatrolService;
  /** 草稿服务（缺省 createSocialDraftService()）。 */
  drafts?: SocialDraftService;
}>();

// 只有组件自己创建的服务才由组件销毁定时器；注入的服务归调用方管理。
const ownsPatrol = props.patrol === undefined;
const patrol = props.patrol ?? createGhPatrolService();
const draftService = props.drafts ?? createSocialDraftService();

/* ------------------------------ GitHub 巡检 ------------------------------ */

const initialConfig = patrol.getConfig();
const repoInput = ref(initialConfig.repos.join('\n'));
const intervalMinutes = ref(Math.max(1, Math.round(initialConfig.intervalMs / 60000)));
const scheduled = ref(initialConfig.scheduledEnabled);
const tokenState = ref<'checking' | 'present' | 'absent'>('checking');
const patrolBusy = ref(false);
const patrolResult = ref<PatrolRunResult | null>(null);
const patrolError = ref('');
const configNote = ref('');
const scheduleActive = ref(patrol.scheduledActive());
// 服务不是响应式的：仓库数单独用 ref 跟踪，避免 computed 缓存住首次快照。
const repoCount = ref(initialConfig.repos.length);

const tokenLabel = computed(() => {
  if (tokenState.value === 'checking') return '凭据状态：检查中…';
  return tokenState.value === 'present' ? '凭据状态：已配置（只读 token，不回显）' : '凭据状态：未配置';
});

async function refreshTokenState(): Promise<void> {
  try {
    tokenState.value = (await patrol.tokenPresent()) ? 'present' : 'absent';
  } catch {
    // 凭据仓不可用时按「未配置」处理，不猜。
    tokenState.value = 'absent';
  }
}

onMounted(() => {
  void refreshTokenState();
});

function saveRepos(): void {
  const parsed = patrol.setRepos(repoInput.value);
  repoInput.value = parsed.repos.join('\n');
  repoCount.value = parsed.repos.length;
  configNote.value =
    parsed.invalid.length > 0
      ? `已忽略无法识别的输入：${parsed.invalid.join('、')}（格式应为 owner/repo）`
      : parsed.repos.length === 0
        ? '未配置仓库：巡检不会发起任何请求。'
        : `已保存 ${parsed.repos.length} 个仓库。`;
  scheduleActive.value = patrol.scheduledActive();
}

function applyInterval(): void {
  const minutes = Number(intervalMinutes.value);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 1;
  intervalMinutes.value = safe;
  patrol.setConfig({ intervalMs: safe * 60000 });
  scheduleActive.value = patrol.scheduledActive();
}

function toggleSchedule(): void {
  patrol.setConfig({ scheduledEnabled: scheduled.value });
  scheduleActive.value = patrol.scheduledActive();
}

async function runPatrol(): Promise<void> {
  if (patrolBusy.value) return;
  patrolBusy.value = true;
  patrolError.value = '';
  try {
    patrolResult.value = await patrol.run();
    // 巡检可能刚发现 token 失效/未配置，顺带刷新一次凭据状态（只显示已配/未配）。
    await refreshTokenState();
  } catch (err) {
    patrolError.value = err instanceof Error ? err.message : String(err);
  } finally {
    patrolBusy.value = false;
  }
}

function fmtTime(iso: string): string {
  if (!iso) return '时间未知';
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : iso;
}

/* ------------------------------ 社媒草稿 ------------------------------ */

const platform = ref<SocialPlatform>('qq');
const recipient = ref('');
const content = ref('');
const draftList = ref<SocialDraft[]>(draftService.list());
const selectedId = ref<string | null>(null);
const sendDecision = ref<SendDecision | null>(null);
const confirmOpen = ref(false);

const livePreview = computed<DraftPreview>(() =>
  previewContent(platform.value, { to: recipient.value, text: content.value }),
);

const selectedDraft = computed(() => draftList.value.find((draft) => draft.id === selectedId.value) ?? null);
const selectedPreview = computed<DraftPreview | null>(() =>
  selectedDraft.value ? previewContent(selectedDraft.value.platform, { to: selectedDraft.value.to, text: selectedDraft.value.text }) : null,
);

function refreshDrafts(): void {
  draftList.value = draftService.list();
}

function saveDraft(): void {
  const draft = draftService.createDraft(platform.value, { to: recipient.value, text: content.value });
  refreshDrafts();
  selectedId.value = draft.id;
  sendDecision.value = null;
  confirmOpen.value = false;
}

function selectDraft(id: string): void {
  selectedId.value = id;
  sendDecision.value = null;
  confirmOpen.value = false;
}

function removeDraft(id: string): void {
  draftService.remove(id);
  refreshDrafts();
  if (selectedId.value === id) {
    selectedId.value = null;
    sendDecision.value = null;
    confirmOpen.value = false;
  }
}

/** 「发送」按钮：先弹确认层，绝不直接外发。 */
function requestSend(): void {
  const draft = selectedDraft.value;
  if (!draft) return;
  sendDecision.value = draftService.requestSend(draft.id);
  confirmOpen.value = sendDecision.value?.code === 'confirmation-required';
}

function confirmSend(): void {
  const draft = selectedDraft.value;
  if (!draft) return;
  sendDecision.value = draftService.confirmSend(draft.id, { confirmed: true });
  confirmOpen.value = false;
}

function cancelSend(): void {
  confirmOpen.value = false;
  sendDecision.value = null;
}

/** 预留接口桩：social.publish 默认禁用（恒 not-authorized）。 */
function tryPublish(): void {
  const draft = selectedDraft.value;
  if (!draft) return;
  sendDecision.value = draftService.publish(draft.id);
  confirmOpen.value = false;
}

onBeforeUnmount(() => {
  if (ownsPatrol) patrol.dispose();
});
</script>

<template>
  <div class="pane-scroll assistant-pane">
    <span class="cap-badge" data-testid="assistant-cap">
      项目小助手：GitHub 只读巡检 + QQ/微博草稿（默认不外发）
    </span>

    <!-- GitHub 巡检 -->
    <section class="mc-card assistant-card" data-testid="assistant-gh-card">
      <h3>GitHub 巡检 <small>只读：仅 GET，零写操作</small></h3>

      <label class="field">
        <span class="field-label">仓库列表（每行一个 owner/repo）</span>
        <textarea
          v-model="repoInput"
          class="input area"
          rows="3"
          placeholder="octocat/Hello-World"
          data-testid="gh-repos-input"
        />
      </label>

      <div class="row">
        <button class="btn" data-testid="gh-save-repos" @click="saveRepos">保存仓库</button>
        <span class="mc-meta" data-testid="gh-token-state">{{ tokenLabel }}</span>
      </div>
      <p v-if="configNote" class="note" data-testid="gh-config-note">{{ configNote }}</p>

      <div class="row">
        <button class="btn primary" data-testid="gh-run" :disabled="patrolBusy" @click="runPatrol">
          {{ patrolBusy ? '巡检中…' : '立即巡检' }}
        </button>
        <span class="mc-meta" data-testid="gh-repo-count">已配置 {{ repoCount }} 个仓库</span>
      </div>

      <div class="row schedule-row">
        <label class="check">
          <input v-model="scheduled" type="checkbox" data-testid="gh-schedule-toggle" @change="toggleSchedule" />
          <span>开启定时巡检（默认关闭）</span>
        </label>
        <label class="inline-field">
          <span class="field-label">间隔（分钟）</span>
          <input
            v-model.number="intervalMinutes"
            class="input num"
            type="number"
            min="1"
            data-testid="gh-interval"
            @change="applyInterval"
          />
        </label>
        <span class="mc-meta" data-testid="gh-schedule-state">
          {{ scheduleActive ? `定时运行中（每 ${intervalMinutes} 分钟）` : '定时未运行' }}
        </span>
      </div>

      <p v-if="patrolError" class="mc-warn" data-testid="gh-error">巡检失败：{{ patrolError }}</p>

      <template v-if="patrolResult">
        <h4>本次摘要</h4>
        <pre class="summary" data-testid="gh-summary">{{ patrolResult.summary }}</pre>

        <div v-for="repo in patrolResult.repos" :key="repo.repo" class="repo-block" data-testid="gh-repo-row">
          <div class="repo-head">
            <strong>{{ repo.repo }}</strong>
            <span class="status" :class="repo.status" data-testid="gh-repo-status">
              {{ PATROL_STATUS_LABEL[repo.status] }}
            </span>
            <span class="mc-meta">
              open PR {{ repo.openPrs }}（草稿 {{ repo.draftPrs }} / 待评审 {{ repo.awaitingReview }}）· issue {{ repo.openIssues }}
              · 新增 {{ repo.newItems }} · 更新 {{ repo.updatedItems }}
            </span>
          </div>
          <p v-if="repo.status !== 'ok'" class="note" data-testid="gh-repo-message">
            {{ repo.message || '本次未取得数据，不编造列表。' }}
          </p>
          <ul class="item-list">
            <li v-for="item in repo.items" :key="`${item.kind}#${item.number}`" class="item" data-testid="gh-item">
              <span class="kind" :class="item.kind">{{ item.kind === 'pr' ? 'PR' : 'Issue' }}</span>
              <span class="num">#{{ item.number }}</span>
              <span class="title">{{ item.title }}</span>
              <span class="mc-meta">{{ item.author }} · {{ fmtTime(item.updatedAt) }}</span>
              <span v-if="item.draft" class="tag warn">草稿</span>
              <span v-for="label in item.labels" :key="label" class="tag">{{ label }}</span>
            </li>
          </ul>
        </div>
      </template>

      <p v-else class="note" data-testid="gh-empty">
        还没有巡检结果。点「立即巡检」会真实请求 api.github.com（仅 GET）；未配置 token 时如实报「未配置」，不编造列表。
      </p>
    </section>

    <!-- 社媒草稿 -->
    <section class="mc-card assistant-card" data-testid="assistant-social-card">
      <h3>QQ / 微博草稿 <small>首期只出草稿与预览，默认不外发</small></h3>

      <p class="note channel-note" data-testid="social-channel-note">{{ SOCIAL_CHANNEL_NOT_READY }}</p>

      <div class="row">
        <button
          class="btn"
          :class="{ primary: platform === 'qq' }"
          data-testid="social-platform-qq"
          @click="platform = 'qq'"
        >
          QQ
        </button>
        <button
          class="btn"
          :class="{ primary: platform === 'weibo' }"
          data-testid="social-platform-weibo"
          @click="platform = 'weibo'"
        >
          微博
        </button>
        <span class="mc-meta" data-testid="social-limit">上限 {{ SOCIAL_LIMITS[platform] }} 字</span>
      </div>

      <label v-if="platform === 'qq'" class="field">
        <span class="field-label">收件人 / 群名</span>
        <input v-model="recipient" class="input" type="text" placeholder="小美" data-testid="social-to" />
      </label>
      <p v-else class="note" data-testid="social-weibo-note">微博按公开发布处理，草稿阶段不连接任何账号。</p>

      <label class="field">
        <span class="field-label">内容</span>
        <textarea
          v-model="content"
          class="input area"
          rows="4"
          placeholder="写点什么…（@全体成员 会告警，链接会被标注）"
          data-testid="social-text"
        />
      </label>

      <ul v-if="livePreview.warnings.length > 0" class="warn-list" data-testid="social-warnings">
        <li v-for="warning in livePreview.warnings" :key="warning.kind" :class="warning.level">
          {{ warning.message }}
        </li>
      </ul>

      <h4>预览</h4>
      <div class="preview" data-testid="social-preview">
        <div class="preview-title">{{ livePreview.title }} <span class="mc-meta">{{ livePreview.meta }}</span></div>
        <div
          v-for="(bubble, index) in livePreview.bubbles"
          :key="index"
          class="bubble"
          :class="bubble.side"
          data-testid="social-preview-bubble"
        >
          <span>{{ bubble.text || '（空）' }}</span>
          <span v-if="bubble.note" class="bubble-note">{{ bubble.note }}</span>
        </div>
      </div>

      <div class="row">
        <button class="btn" data-testid="social-save" :disabled="livePreview.canSend === false" @click="saveDraft">
          存为草稿
        </button>
      </div>

      <h4>草稿列表</h4>
      <ul v-if="draftList.length > 0" class="draft-list" data-testid="social-draft-list">
        <li
          v-for="draft in draftList"
          :key="draft.id"
          class="draft"
          :class="{ active: draft.id === selectedId }"
          data-testid="social-draft"
        >
          <button class="draft-main" data-testid="social-select" @click="selectDraft(draft.id)">
            <span class="tag">{{ SOCIAL_PLATFORM_LABEL[draft.platform] }}</span>
            <span class="draft-to">{{ draft.platform === 'qq' ? draft.to || '（未填收件人）' : '公开' }}</span>
            <span class="draft-text">{{ draft.text }}</span>
            <span v-if="draft.blocking" class="tag warn">有阻塞告警</span>
          </button>
          <button class="btn danger" data-testid="social-delete" @click="removeDraft(draft.id)">删除</button>
        </li>
      </ul>
      <p v-else class="note" data-testid="social-empty">还没有草稿。存下来的草稿只在本机，不会外发。</p>

      <template v-if="selectedDraft && selectedPreview">
        <div class="row send-row">
          <button class="btn primary" data-testid="social-send" :disabled="selectedDraft.blocking" @click="requestSend">
            发送
          </button>
          <button class="btn" data-testid="social-publish" @click="tryPublish">尝试 social.publish（接口桩）</button>
        </div>

        <div v-if="confirmOpen" class="confirm" data-testid="social-confirm">
          <p class="confirm-text">
            确认要发送这条 {{ SOCIAL_PLATFORM_LABEL[selectedDraft.platform] }} 草稿吗？确认后仍会先检查发送通道。
          </p>
          <div class="row">
            <button class="btn primary" data-testid="social-confirm-yes" @click="confirmSend">确认发送</button>
            <button class="btn" data-testid="social-confirm-no" @click="cancelSend">取消</button>
          </div>
        </div>

        <p v-if="sendDecision" class="decision" :class="{ blocked: !sendDecision.ok }" data-testid="social-decision">
          {{ sendDecision.message }}
        </p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.assistant-pane {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.assistant-card {
  padding: 14px 16px;
}
.assistant-card h3 {
  margin: 0 0 10px;
  font-size: 14px;
}
.assistant-card h3 small {
  font-weight: 400;
  font-size: 10.5px;
  color: var(--faint);
  letter-spacing: 0;
}
.assistant-card h4 {
  margin: 12px 0 6px;
  font-size: 11px;
  color: var(--faint);
  font-weight: 600;
  letter-spacing: 0.06em;
}
.field {
  display: block;
  margin: 8px 0;
}
.field-label {
  display: block;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 4px;
}
.input {
  width: 100%;
  box-sizing: border-box;
  background: var(--panel-solid);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: 7px 9px;
  font: inherit;
  font-size: 12px;
}
.input:focus {
  outline: none;
  border-color: var(--accent);
}
.input.area {
  resize: vertical;
  line-height: 1.6;
}
.input.num {
  width: 78px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 8px 0;
}
.schedule-row {
  gap: 14px;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}
.inline-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.note {
  margin: 4px 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--muted);
}
.channel-note {
  color: var(--accent-warm);
}
.summary {
  margin: 0;
  padding: 9px 11px;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.8;
  white-space: pre-wrap;
  color: var(--text);
}
.repo-block {
  margin-top: 10px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
}
.repo-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}
.status {
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  color: var(--muted);
}
.status.ok {
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 45%, transparent);
}
.status.rate-limited,
.status.offline,
.status.auth-failed,
.status.not-found,
.status.error {
  color: var(--err);
  border-color: color-mix(in srgb, var(--err) 45%, transparent);
}
.item-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}
.item {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 5px 0;
  border-bottom: 1px dashed var(--line);
  font-size: 12px;
}
.item:last-child {
  border-bottom: none;
}
.item .title {
  flex: 1;
  min-width: 140px;
}
.kind {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
}
.kind.issue {
  background: color-mix(in srgb, var(--accent-warm) 18%, transparent);
  color: var(--accent-warm);
}
.num {
  font-family: var(--font-mono);
  color: var(--faint);
}
.tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  color: var(--muted);
}
.tag.warn {
  color: var(--accent-warm);
  border-color: color-mix(in srgb, var(--accent-warm) 50%, transparent);
}
.warn-list {
  list-style: none;
  margin: 6px 0;
  padding: 0;
}
.warn-list li {
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--muted);
}
.warn-list li.block {
  color: var(--err);
}
.warn-list li.warn {
  color: var(--accent-warm);
}
.preview {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--panel-solid);
  padding: 10px 12px;
}
.preview-title {
  font-size: 11px;
  color: var(--faint);
  margin-bottom: 8px;
}
.bubble {
  max-width: 78%;
  margin: 6px 0;
  padding: 7px 11px;
  border-radius: var(--radius-lg);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble.out {
  margin-left: auto;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--text);
}
.bubble.in {
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--text);
}
.bubble-note {
  display: block;
  margin-top: 4px;
  font-size: 10px;
  color: var(--faint);
}
.draft-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.draft {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--line);
}
.draft.active {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border-radius: var(--radius-md);
}
.draft-main {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  padding: 4px 6px;
}
.draft-to {
  color: var(--muted);
}
.draft-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.send-row {
  margin-top: 12px;
}
.confirm {
  border: 1px solid color-mix(in srgb, var(--accent-warm) 55%, transparent);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  background: color-mix(in srgb, var(--accent-warm) 10%, transparent);
}
.confirm-text {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text);
}
.decision {
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--ok);
}
.decision.blocked {
  color: var(--err);
}
</style>
