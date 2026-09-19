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
import { parseCharacterCard, type CharacterProfile } from '../companion/charcard';
import {
  loadStyleProfile,
  setStyleEnabled,
  addCatchphrase,
  removeCatchphrase,
  clearStyleProfile,
  type StyleProfile,
} from '../companion/styleProfile';
import {
  importKnowledgeDocFromBytes,
  listKnowledgeDocs,
  deleteKnowledgeDoc,
  type KnowledgeDoc,
} from '../companion/knowledge';
import UpdatePanel from './UpdatePanel.vue';

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

/* ── 陪伴：角色卡 / 口癖 / 知识库 ── */
const cardFile = ref<HTMLInputElement | null>(null);
const cardBusy = ref(false);
const cardError = ref('');
const cardPreview = ref<{ profile: CharacterProfile; warnings: string[]; injection: boolean } | null>(
  store.providerSettings.personaCard
    ? { profile: store.providerSettings.personaCard as CharacterProfile, warnings: [], injection: false }
    : null,
);

async function onCardFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || cardBusy.value) return;
  cardBusy.value = true;
  cardError.value = '';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await parseCharacterCard(bytes);
    cardPreview.value = {
      profile: result.profile,
      warnings: result.warnings,
      injection: result.injectionDetected,
    };
  } catch (err) {
    cardError.value = err instanceof Error ? err.message : String(err);
  } finally {
    cardBusy.value = false;
    if (cardFile.value) cardFile.value.value = '';
  }
}

/** 应用角色卡：只写入人设快照（数据），instructions 与权限集不变。 */
async function applyCard() {
  if (!cardPreview.value) return;
  const p = cardPreview.value.profile;
  await saveProviderSettings({
    ...form,
    personaCard: {
      specVersion: p.specVersion,
      name: p.name,
      description: p.description,
      personality: p.personality,
      scenario: p.scenario,
      firstMessage: p.firstMessage,
      exampleDialogue: p.exampleDialogue,
    },
  });
  saved.value = true;
  setTimeout(() => (saved.value = false), 1600);
}

async function clearCard() {
  cardPreview.value = null;
  await saveProviderSettings({ ...form, personaCard: null });
}

const styleProfile = ref<StyleProfile | null>(null);
const newTic = ref('');

function refreshStyle() {
  try {
    styleProfile.value = loadStyleProfile();
  } catch {
    styleProfile.value = null;
  }
}

function toggleStyleEnabled(e: Event) {
  styleProfile.value = setStyleEnabled((e.target as HTMLInputElement).checked);
}

function onAddTic() {
  const text = newTic.value.trim();
  if (!text) return;
  styleProfile.value = addCatchphrase(text);
  newTic.value = '';
}

function onRemoveTic(text: string) {
  styleProfile.value = removeCatchphrase(text);
}

function onClearStyle() {
  clearStyleProfile();
  refreshStyle();
}

const knowledgeDocs = ref<KnowledgeDoc[]>([]);
const knowFile = ref<HTMLInputElement | null>(null);
const knowError = ref('');
const knowBusy = ref(false);

function refreshKnowledge() {
  try {
    knowledgeDocs.value = listKnowledgeDocs();
  } catch {
    knowledgeDocs.value = [];
  }
}

async function onKnowledgeFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || knowBusy.value) return;
  knowBusy.value = true;
  knowError.value = '';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    importKnowledgeDocFromBytes({ name: file.name, bytes, license: '用户自供资料' });
    refreshKnowledge();
  } catch (err) {
    knowError.value = err instanceof Error ? err.message : String(err);
  } finally {
    knowBusy.value = false;
    if (knowFile.value) knowFile.value.value = '';
  }
}

function onDeleteKnowledge(id: string) {
  deleteKnowledgeDoc(id);
  refreshKnowledge();
}

onMounted(() => {
  refreshStyle();
  refreshKnowledge();
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
        <button :aria-pressed="store.settingsTab === 'companion'" @click="store.settingsTab = 'companion'">陪伴</button>
        <button :aria-pressed="store.settingsTab === 'perception'" @click="store.settingsTab = 'perception'">感知与家居</button>
        <button :aria-pressed="store.settingsTab === 'advanced'" @click="store.settingsTab = 'advanced'">高级</button>
        <button :aria-pressed="store.settingsTab === 'update'" @click="store.settingsTab = 'update'">更新</button>
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

      <template v-else-if="store.settingsTab === 'companion'">
        <!-- 角色卡：支持 SillyTavern v1/v2/v3 JSON 与内嵌 PNG；仅数据解析，不提升权限 -->
        <div class="field">
          <label>角色卡（v2/v3 JSON 或 PNG 卡）</label>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <input ref="cardFile" type="file" accept=".json,.png,application/json,image/png" style="display:none" @change="onCardFile" />
            <button class="btn" type="button" :disabled="cardBusy" @click="cardFile?.click()">
              {{ cardBusy ? '解析中…' : '选择角色卡文件' }}
            </button>
            <button v-if="cardPreview" class="btn" type="button" @click="clearCard">清除角色卡</button>
          </div>
          <p v-if="cardError" class="field-note" style="color:var(--err)">{{ cardError }}</p>
          <div v-if="cardPreview" class="field-note" style="border:1px dashed var(--line);border-radius:8px;padding:8px;margin-top:6px">
            <strong>{{ cardPreview.profile.name || '（未命名角色）' }}</strong>
            <span style="color:var(--muted)"> · {{ cardPreview.profile.specVersion }}</span>
            <p style="margin:6px 0 0;white-space:pre-wrap">{{ (cardPreview.profile.description || cardPreview.profile.personality || '（无描述）').slice(0, 160) }}</p>
            <p v-if="cardPreview.injection" style="color:var(--err);margin:6px 0 0">
              检测到疑似指令式文本：已按纯数据隔离，不会成为她的指令。
            </p>
            <p v-for="(w, i) in cardPreview.warnings.slice(0, 3)" :key="i" style="color:var(--muted);margin:2px 0 0">{{ w }}</p>
            <button class="btn primary" type="button" style="margin-top:8px" @click="applyCard">应用这个角色</button>
          </div>
          <p class="field-note">
            角色卡只改变她的人设与语气，不改变任何工具权限。酒馆（SillyTavern）社区的 .png/.json 卡可直接导入；
            社区卡市场接入将随插件源体系开放。
          </p>
        </div>

        <hr class="modal-hr" />
        <!-- 口癖学习 -->
        <div class="field">
          <label>口癖学习（她从你的消息里学说话习惯）</label>
          <label style="display:flex;gap:6px;align-items:center">
            <input type="checkbox" :checked="styleProfile?.enabled !== false" @change="toggleStyleEnabled" />
            启用口癖学习（强度档在「高级」页调）
          </label>
          <div v-if="styleProfile" class="field-note" style="margin-top:6px">
            已学样本 {{ styleProfile.sampleCount }} 条；平均句长 {{ Math.round(styleProfile.avgSentenceLength) }} 字。
            <div v-if="styleProfile.catchphrases.length" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
              <span v-for="tic in styleProfile.catchphrases" :key="tic.text" class="pill" style="display:inline-flex;gap:4px;align-items:center">
                {{ tic.text }}<template v-if="tic.manual">（手动）</template>
                <a href="javascript:void 0" style="color:var(--err)" @click="onRemoveTic(tic.text)">×</a>
              </span>
            </div>
            <p v-else style="color:var(--muted);margin:6px 0 0">还没学到明显口癖，多聊几句就有了。</p>
            <div style="display:flex;gap:8px;margin-top:8px">
              <input v-model="newTic" placeholder="手动加一条口癖，例如：捏" style="flex:1" @keydown.enter.prevent="onAddTic" />
              <button class="btn" type="button" @click="onAddTic">添加</button>
              <button class="btn" type="button" @click="onClearStyle">清空重学</button>
            </div>
          </div>
        </div>

        <hr class="modal-hr" />
        <!-- 知识库 -->
        <div class="field">
          <label>知识库（导入资料，她对话时自动检索引用）</label>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <input ref="knowFile" type="file" accept=".txt,.md,.text,.markdown" style="display:none" @change="onKnowledgeFile" />
            <button class="btn" type="button" :disabled="knowBusy" @click="knowFile?.click()">
              {{ knowBusy ? '导入中…' : '导入 txt/md 文档' }}
            </button>
            <span style="color:var(--muted);font-size:12px">{{ knowledgeDocs.length }} 篇文档</span>
          </div>
          <p v-if="knowError" class="field-note" style="color:var(--err)">{{ knowError }}</p>
          <ul v-if="knowledgeDocs.length" class="field-note" style="margin-top:6px;padding-left:0;list-style:none">
            <li v-for="doc in knowledgeDocs" :key="doc.id" style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dashed var(--line)">
              <span>{{ doc.name }} <span style="color:var(--muted)">（{{ doc.chunkCount }} 段）</span></span>
              <a href="javascript:void 0" style="color:var(--err)" @click="onDeleteKnowledge(doc.id)">删除</a>
            </li>
          </ul>
          <p class="field-note">资料文本按不可信数据处理；PPT 课件请到「学习」页导入，那边支持讲课。</p>
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

      <template v-else-if="store.settingsTab === 'advanced'">
        <div class="field-row">
          <div class="field">
            <label>历史轮数（0 = 不带历史）</label>
            <input v-model.number="form.historyTurns" type="number" min="0" max="32" step="1" />
          </div>
          <div class="field">
            <label>打断灵敏度（连续有声帧，1 最灵敏 / 10 最迟钝）</label>
            <input v-model.number="form.bargeInFrames" type="number" min="1" max="25" step="1" />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>语音回应门控（常听时哪些话要回）</label>
            <select v-model="form.respondMode">
              <option value="all">全回应（每段语音都回）</option>
              <option value="smart">智能（与她无关的只记不回，省 token）</option>
              <option value="name">仅唤醒名（叫名字才回）</option>
            </select>
          </div>
          <div class="field">
            <label>唤醒名（门控=仅唤醒名时生效；留空用内置名）</label>
            <input v-model="form.wakeName" placeholder="例如：小薇" />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>主动插话强度（提醒/任务完成时她主动开口）</label>
            <select v-model.number="form.proactiveIntensity">
              <option :value="0">关闭</option>
              <option :value="1">保守</option>
              <option :value="2">活泼</option>
            </select>
          </div>
          <div class="field">
            <label>口癖跟随强度（她自然呼应你的说话习惯）</label>
            <select v-model.number="form.styleIntensity">
              <option :value="0">关闭</option>
              <option :value="1">轻微</option>
              <option :value="2">明显</option>
            </select>
          </div>
        </div>
        <div class="field" style="display:flex;gap:18px;flex-wrap:wrap">
          <label style="display:flex;gap:6px;align-items:center">
            <input v-model="form.toolsEnabled" type="checkbox" /> 允许她对话中查记忆/天气（只读工具）
          </label>
          <label style="display:flex;gap:6px;align-items:center">
            <input v-model="form.styleEnabled" type="checkbox" /> 口癖学习
          </label>
          <label style="display:flex;gap:6px;align-items:center">
            <input v-model="form.knowledgeEnabled" type="checkbox" /> 记忆/知识库注入
          </label>
          <label style="display:flex;gap:6px;align-items:center">
            <input v-model="form.reduceMotion" type="checkbox" /> 减少动态效果
          </label>
        </div>
        <p class="field-note">
          回应门控/打断灵敏度在下次开启语音时生效。本地 TTS（IndexTTS-2.5、Qwen3-TTS 等）：
          启动其 OpenAI 兼容服务后，把「普通 → TTS baseUrl」填为 http://127.0.0.1:端口/v1 即可接入；
          能力徽章会如实显示流式/批式。密钥仅存系统凭据仓，诊断导出默认脱敏。
        </p>
      </template>

      <template v-else-if="store.settingsTab === 'update'">
        <UpdatePanel />
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
