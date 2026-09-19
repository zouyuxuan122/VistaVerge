<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  closeSettings,
  store,
  saveProviderSettings,
  setAvatarMode,
  type ProviderSettings,
} from '../app/store';
import { avatarOptionLabel, AVATAR_MODES, LIVE2D_MODEL_BUNDLED, type AvatarMode } from '../app/avatarDefaults';
import { getSecret } from '../platform/credentials';
import {
  importLive2dModel,
  importModelFromPath,
  loadImportedManifest,
  isTauriAvailable,
  type ImportResult,
} from '../platform/live2dImport';
import {
  connectHa,
  perception,
  refreshWeather,
  saveHaConfig,
  setHaTempEntity,
  setLocation,
  weatherFresh,
} from '../sensors/perceptionStore';

const form = reactive<ProviderSettings>({ ...store.providerSettings });
const apiKey = ref('');
const saved = ref(false);
const saveError = ref('');
/**
 * 密钥是否已从凭据仓读出。读出之前保存会把空串写回 keyring，
 * 静默抹掉用户已存的 API Key（异步加载与点击保存的竞态）。
 */
const keyLoaded = ref(false);

/* ── Live2D 模型导入（用户自备素材，发行版不含模型） ── */
const importSupported = isTauriAvailable();
const importing = ref(false);
const importProgress = ref('');
const importResult = ref<ImportResult | null>(loadImportedManifest());
const importError = ref('');
const importPath = ref('');

async function runImport() {
  if (importing.value) return;
  importing.value = true;
  importError.value = '';
  importProgress.value = '请在弹出的窗口里选择模型文件夹…';
  try {
    const result = await importLive2dModel((p) => {
      const mb = Math.round(p.bytesSent / 1024 / 1024);
      const total = Math.round(p.totalBytes / 1024 / 1024);
      importProgress.value = `导入中 ${p.fileIndex}/${p.fileCount} · ${p.relPath}（${mb}/${total} MB）`;
    });
    if (result === null) {
      importProgress.value = '';
      return;
    }
    applyImportResult(result, `导入完成：${result.fileCount} 个文件。`);
  } catch (err) {
    importError.value = err instanceof Error ? err.message : String(err);
    importProgress.value = '';
  } finally {
    importing.value = false;
  }
}

async function runPathImport() {
  if (importing.value) return;
  importing.value = true;
  importError.value = '';
  importProgress.value = '正在拷贝模型文件夹…';
  try {
    const result = await importModelFromPath(importPath.value);
    applyImportResult(result, `导入完成：${result.fileCount} 个文件（${Math.round(result.totalBytes / 1024 / 1024)} MB）。`);
  } catch (err) {
    importError.value = err instanceof Error ? err.message : String(err);
    importProgress.value = '';
  } finally {
    importing.value = false;
  }
}

function applyImportResult(result: ImportResult, prefix: string) {
  importResult.value = result;
  importProgress.value = result.corePath
    ? `${prefix}已切换到 Live2D。`
    : `${prefix}但缺少 Cubism Core（live2dcubismcore.min.js），需要补上才能显示。`;
  // 导入成功即切换（默认视频人，导入模型后才用 Live2D）
  if (result.corePath) setAvatarMode('live2d');
}

const haForm = reactive({ url: '', token: '' });
const locForm = reactive({
  label: '',
  latitude: 0,
  longitude: 0,
});

onMounted(async () => {
  try {
    apiKey.value = (await getSecret('llmApiKey')) ?? '';
  } catch {
    apiKey.value = '';
  } finally {
    keyLoaded.value = true;
  }
  haForm.url = perception.haUrl;
  locForm.label = perception.location.label;
  locForm.latitude = perception.location.latitude;
  locForm.longitude = perception.location.longitude;
});

async function save() {
  saveError.value = '';
  try {
    // 未读出密钥时不传 apiKey：saveProviderSettings 只在 apiKey !== undefined 时写 keyring
    await saveProviderSettings({ ...form }, keyLoaded.value ? apiKey.value : undefined);
    saved.value = true;
    setTimeout(() => (saved.value = false), 1600);
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  }
}

async function savePerception() {
  saveError.value = '';
  try {
    await saveHaConfig(haForm.url, haForm.token);
    haForm.token = '';
    setHaTempEntity(perception.haTempEntity);
    const lat = Number(locForm.latitude);
    const lon = Number(locForm.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      setLocation({ latitude: lat, longitude: lon, label: locForm.label.trim() || '自定义' });
    } else {
      saveError.value = '经纬度非法：纬度需在 ±90、经度需在 ±180 之间';
      return;
    }
    saved.value = true;
    setTimeout(() => (saved.value = false), 1600);
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  }
}

async function applyLocationAndFetch() {
  const lat = Number(locForm.latitude);
  const lon = Number(locForm.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    saveError.value = '经纬度非法：纬度需在 ±90、经度需在 ±180 之间';
    return;
  }
  setLocation({ latitude: lat, longitude: lon, label: locForm.label.trim() || '自定义' });
  await refreshWeather();
}

const haStatusText = computed(() => {
  const map: Record<string, string> = {
    blocked: 'BLOCKED（未配置）',
    disconnected: '未连接',
    connecting: '连接中',
    connected: '已连接',
    'auth-failed': '鉴权失败',
  };
  return map[perception.haStatus] ?? perception.haStatus;
});

function close() {
  closeSettings();
}
</script>

<template>
  <div class="modal-mask" @click.self="close">
    <div class="modal" role="dialog" aria-label="设置">
      <h2>设置</h2>
      <div class="subtabs">
        <button :aria-pressed="store.settingsTab === 'normal'" @click="store.settingsTab = 'normal'">普通</button>
        <button :aria-pressed="store.settingsTab === 'perception'" @click="store.settingsTab = 'perception'">感知与家居</button>
        <button :aria-pressed="store.settingsTab === 'advanced'" @click="store.settingsTab = 'advanced'">高级</button>
      </div>

      <template v-if="store.settingsTab === 'normal'">
        <div class="field">
          <label>数字人形象</label>
          <select :value="store.avatarMode" @change="setAvatarMode(($event.target as HTMLSelectElement).value as AvatarMode)">
            <option v-for="mode in AVATAR_MODES" :key="mode" :value="mode">{{ avatarOptionLabel(mode) }}</option>
          </select>
          <small v-if="!LIVE2D_MODEL_BUNDLED" class="field-hint">
            本安装包未内置 Live2D 模型（授权禁分发），已默认使用视频数字人；导入模型后即可切换。
          </small>
        </div>
        <div v-if="!LIVE2D_MODEL_BUNDLED || importSupported" class="field">
          <label>导入 Live2D 模型（模型文件夹需含 *.model3.json；Cubism Core 需一并提供）</label>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn" type="button" :disabled="importing || !importSupported" @click="runImport">
              {{ importing ? '导入中…' : '选择模型文件夹并导入' }}
            </button>
            <span v-if="importResult" class="mc-meta">
              已导入：{{ importResult.modelPath }}<template v-if="importResult.corePath"> · 含 Cubism Core</template>
            </span>
          </div>
          <div v-if="importSupported" style="display:flex;gap:10px;margin-top:8px">
            <input
              v-model="importPath"
              data-testid="import-path"
              style="flex:1"
              placeholder="或直接粘贴模型文件夹路径，例如 D:\models\fense"
              @keydown.enter.prevent="runPathImport"
            />
            <button class="btn" type="button" data-testid="import-path-btn" :disabled="importing || importPath.trim().length === 0" @click="runPathImport">
              按路径导入
            </button>
          </div>
          <p v-if="importProgress" class="field-note" data-testid="import-progress">{{ importProgress }}</p>
          <p v-if="importError" class="field-note" style="color:var(--err)">{{ importError }}</p>
          <p v-if="!importSupported" class="field-note">模型导入需要在桌面应用中使用（浏览器开发模式没有本机文件通道）。</p>
          <p class="field-note">
            导入的模型只存在你电脑的应用数据目录里，不会被上传或分发。缺 Cubism Core 时：从 Live2D 官网下载
            Cubism SDK for Web，取其中的 live2dcubismcore.min.js 与模型放同一文件夹后重新导入。
          </p>
        </div>
        <div class="field">
          <label>供应商模式</label>
          <select v-model="form.kind">
            <option value="mock">Mock 演示（离线，不用密钥）</option>
            <option value="openai">OpenAI 兼容（硅基流动/DeepSeek/官方等）</option>
          </select>
        </div>
        <template v-if="form.kind === 'openai'">
          <div class="field-row">
            <div class="field"><label>LLM baseUrl</label><input v-model="form.llmBaseUrl" placeholder="https://api.siliconflow.cn/v1" /></div>
            <div class="field"><label>LLM 模型</label><input v-model="form.llmModel" placeholder="Qwen/Qwen3-14B" /></div>
          </div>
          <div class="field">
            <label>API Key（存入系统凭据仓，不写配置文件）</label>
            <input v-model="apiKey" type="password" placeholder="sk-…" />
            <small v-if="!keyLoaded" class="field-hint">正在读取已保存的密钥…（读取完成前保存不会改动已存密钥）</small>
          </div>
          <div class="field-row">
            <div class="field"><label>STT baseUrl（语音用）</label><input v-model="form.sttBaseUrl" /></div>
            <div class="field"><label>STT 模型</label><input v-model="form.sttModel" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label>TTS baseUrl（语音用）</label><input v-model="form.ttsBaseUrl" /></div>
            <div class="field"><label>TTS 模型</label><input v-model="form.ttsModel" /></div>
          </div>
          <div class="field"><label>TTS 音色</label><input v-model="form.ttsVoice" /></div>
          <div class="field-row">
            <div class="field"><label>输入单价（元 / 百万 token）</label><input v-model.number="form.llmPriceIn" type="number" min="0" step="0.1" /></div>
            <div class="field"><label>输出单价（元 / 百万 token）</label><input v-model.number="form.llmPriceOut" type="number" min="0" step="0.1" /></div>
          </div>
          <p class="field-note">
            单价用于「统计」页的花费折算，按你实际供应商的计价填；留 0 则只显示 token 用量、不显示花费。
          </p>
        </template>
        <div class="field">
          <label>角色指令（人设提示词）</label>
          <textarea v-model="form.instructions" rows="3" />
        </div>
      </template>

      <template v-else-if="store.settingsTab === 'perception'">
        <div class="field-row">
          <div class="field"><label>地点名（仅显示用）</label><input v-model="locForm.label" placeholder="北京" /></div>
          <div class="field"><label>纬度 / 经度</label>
            <div style="display:flex;gap:8px">
              <input v-model.number="locForm.latitude" type="number" step="0.0001" min="-90" max="90" />
              <input v-model.number="locForm.longitude" type="number" step="0.0001" min="-180" max="180" />
            </div>
          </div>
        </div>
        <p class="field-note">
          天气走 Open-Meteo 公共接口（无需 Key）。默认不读系统定位——不填就只显示「不确定」，绝不编造实时天气。
          当前：{{ perception.weatherText || '尚未获取' }}
          <span v-if="perception.weather" :class="weatherFresh() ? 'pill ok' : 'pill warn'">
            {{ weatherFresh() ? '实时' : '已过期' }}
          </span>
        </p>
        <div class="field">
          <button class="btn" type="button" @click="applyLocationAndFetch">保存定位并拉取天气</button>
        </div>

        <hr class="modal-hr" />
        <div class="field">
          <label>Home Assistant 地址</label>
          <input v-model="haForm.url" placeholder="http://homeassistant.local:8123" />
        </div>
        <div class="field">
          <label>长期访问令牌（存入系统凭据仓）</label>
          <input v-model="haForm.token" type="password" :placeholder="perception.haTokenConfigured ? '已保存（留空则不修改）' : '粘贴 HA 长期访问令牌'" />
        </div>
        <div class="field">
          <label>温度实体 id（实测与设定会分开显示）</label>
          <input v-model="perception.haTempEntity" placeholder="climate.living_room" />
        </div>
        <p class="field-note">
          当前状态：<strong>{{ haStatusText }}</strong>
          <span v-if="perception.haBlockedReason"> · {{ perception.haBlockedReason }}</span>
          <span v-if="perception.haError"> · {{ perception.haError }}</span>
        </p>
        <div class="field" style="display:flex;gap:10px">
          <button class="btn" type="button" @click="savePerception">保存家居配置</button>
          <button class="btn" type="button" @click="connectHa">测试连接并读取实体</button>
        </div>
      </template>

      <template v-else>
        <div class="field"><label>语音识别停顿（ms，语音引擎参数）</label><input value="1200" disabled /></div>
        <div class="field"><label>历史轮数</label><input value="8" disabled /></div>
        <p class="field-note">
          高级项（VAD/队列容量/代际调试/数据目录）将在运行时面板开放；当前固定为已调优默认值。密钥仅存系统凭据仓，诊断导出默认脱敏。
        </p>
      </template>

      <div class="actions">
        <span v-if="saveError" class="save-error">{{ saveError }}</span>
        <span v-else-if="saved" class="save-ok">已保存</span>
        <button class="btn" @click="close">关闭</button>
        <button class="btn primary" @click="store.settingsTab === 'perception' ? savePerception() : save()">保存</button>
      </div>
    </div>
  </div>
</template>
