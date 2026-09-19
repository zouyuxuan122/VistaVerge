<script setup lang="ts">
/**
 * UpdatePanel.vue — 应用内自动更新面板 + 首次运行检查清单。
 *
 * 依据：docs/plugins/PLUGIN_PLATFORM_UPDATES.md §5/§6、GAP_AUDIT G-REL-01。
 *
 * 诚实口径（硬性）：
 * - 更新源未配置 / 未发布 latest.json / 不在 Tauri 环境中，一律如实显示「未配置更新源」，
 *   绝不伪装成「已是最新」。
 * - 签名校验由 Rust 侧 updater 在**下载时**完成（pubkey 不匹配会直接抛错），
 *   因此「签名校验通过」只在 download() 正常返回后才标注。
 * - 首次运行清单只做真实可读的探测（CPU 逻辑核心来自 navigator.hardwareConcurrency），
 *   其余是引导入口，不编造硬件结论。
 *
 * 接线契约（由前台/设置页负责放置与处理）：
 * - 本组件自包含；「去设置」按钮直接调用 store 的 setNav('settings') 打开设置弹层。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import type { DownloadEvent, Update as TauriUpdate } from '@tauri-apps/plugin-updater';
import { isTauriAvailable } from '../platform/live2dImport';
import { setNav } from '../app/store';

type Phase =
  | 'idle'        // 未检查
  | 'checking'    // 检查中
  | 'uptodate'    // 已是最新
  | 'available'   // 有更新待下载
  | 'downloading' // 下载中
  | 'ready'       // 已下载并校验签名，待安装
  | 'installing'  // 安装中
  | 'unconfigured'// 未配置更新源（诚实态）
  | 'error';      // 其它错误

const UPDATE_ENDPOINT =
  'https://github.com/zouyuxuan122/VistaVerge/releases/latest/download/latest.json';

const phase = ref<Phase>('idle');
const errorText = ref('');
const update = ref<TauriUpdate | null>(null);
const meta = ref<{ version: string; currentVersion: string; date?: string; body?: string } | null>(null);
const downloadedBytes = ref(0);
const totalBytes = ref(0);
const signatureVerified = ref(false);
const channel = ref<'stable' | 'preview'>('stable');
/** 用户点过「稍后」：折叠安装提示，但保留已下载的更新句柄。 */
const deferred = ref(false);

const phaseLabel = computed(() => {
  switch (phase.value) {
    case 'idle': return '尚未检查';
    case 'checking': return '正在检查更新…';
    case 'uptodate': return '已是最新版本';
    case 'available': return '发现新版本';
    case 'downloading': return '正在下载更新…';
    case 'ready': return '已下载，签名校验通过';
    case 'installing': return '正在启动安装程序…';
    case 'unconfigured': return '未配置更新源';
    case 'error': return '更新检查失败';
  }
});

const busy = computed(() =>
  phase.value === 'checking' || phase.value === 'downloading' || phase.value === 'installing',
);

const progressPct = computed(() => {
  if (totalBytes.value <= 0) return 0;
  return Math.min(100, Math.round((downloadedBytes.value / totalBytes.value) * 100));
});

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 把 Rust/JS 侧的错误消息翻译成可读中文，并区分「未配置更新源」与一般错误。 */
function classifyError(e: unknown): { text: string; unconfigured: boolean } {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  const unconfigured =
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('could not fetch') ||
    lower.includes('failed to fetch') ||
    lower.includes('no release');
  if (unconfigured) {
    return {
      text: `未配置更新源：${UPDATE_ENDPOINT} 当前不可用（latest.json 尚未发布或未公开）。这不是「已是最新」。`,
      unconfigured: true,
    };
  }
  if (lower.includes('signature') || lower.includes('minisign') || lower.includes('verify') || lower.includes('public key')) {
    return { text: `签名校验失败：${msg}`, unconfigured: false };
  }
  if (
    lower.includes('dns') || lower.includes('connect') || lower.includes('network') ||
    lower.includes('timeout') || lower.includes('timed out') || lower.includes('tls')
  ) {
    return { text: `网络失败：${msg}`, unconfigured: false };
  }
  return { text: msg, unconfigured: false };
}

async function loadUpdater() {
  return import('@tauri-apps/plugin-updater');
}

async function checkNow(): Promise<void> {
  errorText.value = '';
  signatureVerified.value = false;
  deferred.value = false;
  if (!isTauriAvailable()) {
    phase.value = 'unconfigured';
    errorText.value = '未配置更新源：当前运行在浏览器开发环境（没有 Tauri updater），无法检查更新。';
    return;
  }
  phase.value = 'checking';
  try {
    const { check } = await loadUpdater();
    const found = await check();
    if (!found) {
      phase.value = 'uptodate';
      return;
    }
    update.value = found;
    meta.value = {
      version: found.version,
      currentVersion: found.currentVersion,
      date: found.date,
      body: found.body,
    };
    phase.value = 'available';
  } catch (e) {
    const { text, unconfigured } = classifyError(e);
    errorText.value = text;
    phase.value = unconfigured ? 'unconfigured' : 'error';
  }
}

async function startDownload(): Promise<void> {
  if (!update.value) return;
  errorText.value = '';
  downloadedBytes.value = 0;
  totalBytes.value = 0;
  deferred.value = false;
  phase.value = 'downloading';
  try {
    await update.value.download((event: DownloadEvent) => {
      if (event.event === 'Started') {
        totalBytes.value = event.data.contentLength ?? 0;
      } else if (event.event === 'Progress') {
        downloadedBytes.value += event.data.chunkLength;
      }
    });
    // download() 正常返回 ⇒ Rust 侧已用内置 pubkey 校验签名（不匹配会抛错）。
    signatureVerified.value = true;
    if (totalBytes.value > 0) downloadedBytes.value = totalBytes.value;
    phase.value = 'ready';
  } catch (e) {
    const { text, unconfigured } = classifyError(e);
    errorText.value = text;
    phase.value = unconfigured ? 'unconfigured' : 'error';
  }
}

async function installNow(): Promise<void> {
  if (!update.value) return;
  phase.value = 'installing';
  try {
    // Windows：install() 会以被动模式启动 NSIS 安装器并退出应用，安装器再按 /R 重启。
    await update.value.install({ restartAfterInstall: true });
  } catch (e) {
    const { text } = classifyError(e);
    errorText.value = text;
    phase.value = 'error';
  }
}

/** 稍后：保留已下载并校验过的更新句柄，折叠提示，用户可随时再点「立即安装」。 */
function later(): void {
  if (phase.value !== 'ready') return;
  deferred.value = true;
}

async function reset(): Promise<void> {
  const current = update.value;
  update.value = null;
  meta.value = null;
  signatureVerified.value = false;
  deferred.value = false;
  downloadedBytes.value = 0;
  totalBytes.value = 0;
  errorText.value = '';
  phase.value = 'idle';
  if (current) {
    try {
      await current.close();
    } catch {
      /* 句柄已释放或插件不可用，忽略 */
    }
  }
}

onBeforeUnmount(() => {
  // ready 态保留句柄以便安装；其余情况释放。
  if (update.value && phase.value !== 'ready') {
    void update.value.close().catch(() => undefined);
  }
});

/* ------------------------------------------------------------------ */
/* 首次运行检查清单（PLUGIN_PLATFORM §5 的降级实现：P2 首启向导骨架）   */
/* ------------------------------------------------------------------ */

const FIRST_RUN_KEY = 'vistaverge.firstRunChecklist.done';

function readFirstRunDone(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FIRST_RUN_KEY) === '1';
  } catch {
    return false;
  }
}

const checklistDone = ref(readFirstRunDone());

/** 真实可读的探测项：CPU 逻辑核心数（浏览器直接提供）。 */
const cpuCores = computed<number | null>(() => {
  if (typeof navigator === 'undefined') return null;
  const n = navigator.hardwareConcurrency;
  return typeof n === 'number' && n > 0 ? n : null;
});

const inTauri = computed(() => isTauriAvailable());

function finishChecklist(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(FIRST_RUN_KEY, '1');
  } catch {
    /* 隐私模式等场景写不进，静默降级：仅本次会话隐藏 */
  }
  checklistDone.value = true;
}

function reopenChecklist(): void {
  checklistDone.value = false;
}

function openSettings(): void {
  setNav('settings');
}
</script>

<template>
  <section class="update-panel" aria-label="应用更新">
    <!-- 首次运行检查清单：完成前一直显示（localStorage 标记） -->
    <div v-if="!checklistDone" class="upd-card upd-firstrun" role="region" aria-label="首次运行检查清单">
      <header class="upd-head">
        <h3>首次运行检查清单</h3>
        <button type="button" class="upd-ghost" @click="finishChecklist">不再显示</button>
      </header>
      <ol class="upd-checklist">
        <li>
          <strong>硬件探测</strong>
          <span class="upd-muted">
            CPU 逻辑核心：{{ cpuCores ?? '读取不到' }}；
            运行环境：{{ inTauri ? 'Tauri 桌面应用' : '浏览器（功能受限）' }}。
            Windows / WebView2 / GPU 详细探测在设置页后续接入。
          </span>
        </li>
        <li>
          <strong>供应商配置</strong>
          <span class="upd-muted">填入 OpenAI 兼容端点与 API Key 后，对话与语音才会真正联网。</span>
          <button type="button" class="upd-link" @click="openSettings">去设置配置 →</button>
        </li>
        <li>
          <strong>麦克风测试</strong>
          <span class="upd-muted">在设置中运行麦克风与播放测试，确认输入输出设备可用。</span>
          <button type="button" class="upd-link" @click="openSettings">打开设置 →</button>
        </li>
      </ol>
    </div>
    <div v-else class="upd-card upd-firstrun-collapsed">
      <span class="upd-muted">首次运行检查清单已完成。</span>
      <button type="button" class="upd-ghost" @click="reopenChecklist">重新查看</button>
    </div>

    <!-- 更新面板 -->
    <div class="upd-card">
      <header class="upd-head">
        <h3>应用更新</h3>
        <div class="upd-channels" role="group" aria-label="更新渠道">
          <button
            type="button"
            :aria-pressed="channel === 'stable'"
            @click="channel = 'stable'"
          >稳定</button>
          <button
            type="button"
            disabled
            title="预留：预览渠道尚未开放"
            :aria-pressed="channel === 'preview'"
          >预览</button>
        </div>
      </header>

      <p class="upd-muted upd-endpoint">更新端点：<code>{{ UPDATE_ENDPOINT }}</code></p>

      <p class="upd-status" role="status" aria-live="polite">
        {{ phaseLabel }}
        <span v-if="meta && phase !== 'uptodate'" class="upd-ver">
          {{ meta.currentVersion }} → {{ meta.version }}
        </span>
      </p>

      <p v-if="phase === 'unconfigured'" class="upd-note upd-warn">{{ errorText }}</p>
      <p v-else-if="phase === 'error'" class="upd-note upd-err">{{ errorText }}</p>

      <div v-if="meta && (phase === 'available' || phase === 'downloading' || phase === 'ready' || phase === 'installing')" class="upd-meta">
        <dl>
          <div><dt>新版本</dt><dd>{{ meta.version }}</dd></div>
          <div v-if="meta.date"><dt>发布时间</dt><dd>{{ meta.date }}</dd></div>
          <div><dt>当前版本</dt><dd>{{ meta.currentVersion }}</dd></div>
        </dl>
        <details v-if="meta.body" class="upd-notes">
          <summary>更新日志</summary>
          <pre>{{ meta.body }}</pre>
        </details>
      </div>

      <div v-if="phase === 'downloading'" class="upd-progress">
        <div
          class="upd-bar"
          role="progressbar"
          :aria-valuenow="progressPct"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <i :style="{ width: progressPct + '%' }" />
        </div>
        <span class="upd-bytes">{{ fmtBytes(downloadedBytes) }} / {{ totalBytes > 0 ? fmtBytes(totalBytes) : '未知大小' }}</span>
      </div>

      <p v-if="signatureVerified" class="upd-note upd-ok">
        签名校验通过（由 updater 在下载阶段用内置公钥验证）。
      </p>
      <p v-if="phase === 'ready' && deferred" class="upd-note upd-muted">
        更新已下载并校验，稍后安装。可随时点「立即安装并重启」。
      </p>

      <div class="upd-actions">
        <button
          v-if="phase === 'idle' || phase === 'uptodate' || phase === 'unconfigured' || phase === 'error'"
          type="button"
          class="upd-primary"
          :disabled="busy"
          @click="checkNow"
        >检查更新</button>

        <button
          v-if="phase === 'available'"
          type="button"
          class="upd-primary"
          :disabled="busy"
          @click="startDownload"
        >下载更新</button>

        <template v-if="phase === 'downloading'">
          <button type="button" class="upd-primary" disabled>下载中…</button>
        </template>

        <template v-if="phase === 'ready'">
          <button type="button" class="upd-primary" :disabled="busy" @click="installNow">立即安装并重启</button>
          <button v-if="!deferred" type="button" class="upd-ghost" :disabled="busy" @click="later">稍后</button>
        </template>

        <template v-if="phase === 'installing'">
          <button type="button" class="upd-primary" disabled>正在启动安装程序…</button>
        </template>

        <button
          v-if="phase !== 'idle' && phase !== 'checking' && phase !== 'downloading' && phase !== 'installing'"
          type="button"
          class="upd-ghost"
          :disabled="busy"
          @click="reset"
        >重置</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.update-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--text);
  font-family: var(--font-display);
}

.upd-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  box-shadow: var(--shadow);
}

.upd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.upd-head h3 {
  margin: 0;
  font-size: 15px;
  letter-spacing: 0.02em;
}

.upd-muted {
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.55;
}

.upd-endpoint {
  margin: 0 0 8px;
  word-break: break-all;
}

.upd-endpoint code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--accent);
}

.upd-status {
  margin: 4px 0 8px;
  font-size: 13.5px;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.upd-ver {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent-warm);
}

.upd-note {
  margin: 6px 0;
  font-size: 12.5px;
  line-height: 1.5;
  padding: 8px 10px;
  border-radius: var(--radius-md);
}

.upd-warn {
  color: var(--accent-warm);
  background: color-mix(in srgb, var(--accent-warm) 14%, transparent);
  border: 1px dashed var(--accent-warm);
}

.upd-err {
  color: var(--err);
  background: color-mix(in srgb, var(--err) 12%, transparent);
  border: 1px dashed var(--err);
}

.upd-ok {
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 12%, transparent);
  border: 1px solid var(--ok);
}

.upd-meta dl {
  display: flex;
  gap: 18px;
  margin: 8px 0;
  flex-wrap: wrap;
}

.upd-meta dl > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.upd-meta dt {
  color: var(--faint);
  font-size: 11px;
}

.upd-meta dd {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
}

.upd-notes summary {
  cursor: pointer;
  font-size: 12.5px;
  color: var(--muted);
}

.upd-notes pre {
  margin: 6px 0 0;
  padding: 8px 10px;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 12px;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}

.upd-progress {
  margin: 10px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.upd-bar {
  height: 10px;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: 999px;
  overflow: hidden;
}

.upd-bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-warm));
  transition: width 0.15s linear;
}

.upd-bytes {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
}

.upd-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.upd-actions button,
.upd-channels button {
  font: inherit;
  cursor: pointer;
  border-radius: var(--radius-md);
  padding: 7px 14px;
  font-size: 12.5px;
}

.upd-primary {
  background: var(--accent);
  color: var(--bg0);
  border: 1px solid var(--accent);
  font-weight: 600;
}

.upd-primary:disabled,
.upd-ghost:disabled {
  opacity: 0.55;
  cursor: default;
}

.upd-ghost {
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--line-strong);
}

.upd-channels {
  display: inline-flex;
  gap: 4px;
}

.upd-channels button {
  padding: 4px 10px;
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--line);
}

.upd-channels button[aria-pressed='true'] {
  color: var(--accent);
  border-color: var(--accent);
}

.upd-channels button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.upd-checklist {
  margin: 6px 0 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.upd-checklist li {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12.5px;
}

.upd-checklist strong {
  font-size: 13px;
}

.upd-link {
  align-self: flex-start;
  background: transparent;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 2px 0;
  font: inherit;
  font-size: 12.5px;
  text-decoration: underline dotted;
}

.upd-firstrun-collapsed {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

/* 手绘主题：虚线描边 + 硬投影，与 app.css 的漫画块一致 */
:global([data-theme='handdrawn']) .upd-card {
  border: 2px solid var(--ink);
  box-shadow: 4px 4px 0 rgba(43, 38, 34, 0.5);
}

:global([data-theme='handdrawn']) .upd-primary {
  color: #fffcf4;
}

:global([data-theme='handdrawn']) .upd-warn,
:global([data-theme='handdrawn']) .upd-err,
:global([data-theme='handdrawn']) .upd-ok {
  border-style: dashed;
  border-width: 2px;
}
</style>
