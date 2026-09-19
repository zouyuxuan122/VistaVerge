// app/store.ts — 应用状态：主题、导航、会话分支、语音状态与供应商能力。
// 数据一律经 data 层持久化；密钥只走 platform/credentials（OS 凭据仓）。
import { reactive, computed } from 'vue';
import { initDb } from '../data/db';
import { createPersistence, type PersistenceHandle } from '../platform/persistence';
import {
  createConversation,
  addMessage,
  editMessage,
  retryFrom,
  listBranches,
  listMessages,
  type BranchRecord,
  type MessageRecord,
} from '../data/conversations';
import { setSecret, getSecret } from '../platform/credentials';
import { recordUsage, estimateTokens, costMicrosOf } from '../data/usage';
import {
  createMockProvider,
  createOpenAiCompatProvider,
  type ChatMessage,
  type LlmProvider,
} from '../services/llm/provider';
import { VoiceSession, type VoiceSessionState } from '../services/session/voiceSession';
import {
  DIRECTIVE_INSTRUCTION,
  parseDirectives,
  stripDirectives,
  stripPartialDirective,
} from './expressionProtocol';
import { avatarAction, avatarExpression, avatarFacing, avatarGaze, avatarMouth } from './avatarBridge';
import { resolveDefaultAvatarMode, LIVE2D_MODEL_BUNDLED, type AvatarMode } from './avatarDefaults';
import { maybeHandleOuting, loadHaTokenPresence, connectHa, perception } from '../sensors/perceptionStore';
import { maybeHandleMcCommand } from '../mc/session';
import { registerBuiltinTools } from '../plugins/tools';

export type ThemeName = 'realistic' | 'handdrawn';
export type { AvatarMode } from './avatarDefaults';
export type NavTarget = 'chat' | 'study' | 'tasks' | 'plugins' | 'settings';
export type ScreenTab = 'chat' | 'mirror' | 'workspace' | 'perception' | 'mc' | 'tasks' | 'stats';

export interface ProviderSettings {
  kind: 'mock' | 'openai';
  llmBaseUrl: string;
  llmModel: string;
  sttBaseUrl: string;
  sttModel: string;
  ttsBaseUrl: string;
  ttsModel: string;
  ttsVoice: string;
  instructions: string;
  /** 成本折算单价（元 / 百万 token）；0 = 未设置，统计只显示 token 不显示花费。 */
  llmPriceIn: number;
  llmPriceOut: number;
}

export interface StoreDeps {
  provider?: LlmProvider;
  persistence?: PersistenceHandle;
}

const LS_THEME = 'vistaverge.theme';
const LS_PROVIDER = 'vistaverge.provider';

function defaultProviderSettings(): ProviderSettings {
  return {
    kind: 'mock',
    llmBaseUrl: '',
    llmModel: '',
    sttBaseUrl: '',
    sttModel: '',
    ttsBaseUrl: '',
    ttsModel: '',
    ttsVoice: '',
    llmPriceIn: 0,
    llmPriceOut: 0,
    instructions:
      '你是 VistaVerge，一位认真、温和的伙伴。回答简洁口语化，不冒充真人。' +
      DIRECTIVE_INSTRUCTION,
  };
}

function safeGet(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch { /* 无存储权限时仅会话内生效 */ }
}

function loadProviderSettings(): ProviderSettings {
  try {
    const raw = safeGet(LS_PROVIDER);
    return raw ? { ...defaultProviderSettings(), ...JSON.parse(raw) } : defaultProviderSettings();
  } catch {
    return defaultProviderSettings();
  }
}

export const store = reactive({
  ready: false,
  initError: '',
  theme: (safeGet(LS_THEME) as ThemeName) || 'handdrawn', // 默认手绘漫画风（亮色）；写实暗色可切换
  // 默认形象按「构建产物里有没有 Live2D 模型」裁决：没有就默认视频数字人，
  // 用户显式选过则永远尊重（见 app/avatarDefaults.ts）。
  avatarMode: resolveDefaultAvatarMode(LIVE2D_MODEL_BUNDLED, safeGet('vistaverge.avatarMode')),
  avatarGaze: { x: 0, y: 0 },
  nav: 'chat' as NavTarget,
  /** 打开设置前的导航位置（关闭时还原，避免导航与内容不一致）。 */
  navBeforeSettings: null as NavTarget | null,
  tab: 'chat' as ScreenTab,
  settingsOpen: false,
  settingsTab: 'normal' as 'normal' | 'perception' | 'advanced',

  conversationId: '',
  branchId: '',
  branches: [] as BranchRecord[],
  messages: [] as MessageRecord[],
  streaming: null as string | null,
  busy: false,
  error: '',

  voiceState: 'idle' as VoiceSessionState,
  voiceEnabled: false,
  provider: null as LlmProvider | null,
  providerSettings: loadProviderSettings(),
  persistenceKind: 'memory' as string,
  sceneState: 'idle' as 'idle' | 'listening' | 'speaking' | 'working',
  mouthLevel: 0,
  /** 每次记一笔用量就 +1：统计视图靠它触发重读台账（数据本身在 SQLite）。 */
  usageRevision: 0,
});

let deps: StoreDeps = {};
let voice: VoiceSession | null = null;

export const llmBadge = computed(() => {
  if (store.providerSettings.kind === 'mock') return 'MOCK 演示供应商';
  const streaming = store.provider?.capabilities().streaming;
  return streaming ? '流式' : '分句/批式';
});

export function configureStore(d: StoreDeps): void {
  deps = d;
}

export async function initStore(): Promise<void> {
  try {
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = store.theme;
    const persistence = deps.persistence ?? createPersistence();
    store.persistenceKind = persistence.kind;
    await initDb(persistence);
    registerBuiltinTools();
    const conv = createConversation();
    store.conversationId = conv.id;
    store.branchId = conv.branchId;
    store.provider = resolveProvider();
    refreshConversation();
    store.ready = true;
    // 感知：只读凭据仓判断 HA 是否已配置（不回显明文）；天气按需拉取，不阻塞首屏。
    void loadHaTokenPresence();
    if (perception.haUrl) void connectHa();
  } catch (err) {
    store.initError = err instanceof Error ? err.message : String(err);
  }
}

export function setTheme(theme: ThemeName): void {
  store.theme = theme;
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
  safeSet(LS_THEME, theme);
}

export function setAvatarMode(mode: AvatarMode): void {
  store.avatarMode = mode;
  safeSet('vistaverge.avatarMode', mode);
}

export function setNav(nav: NavTarget): void {
  if (nav === 'settings') {
    // 设置是覆盖层：记住打开前的导航位置，关闭时原样还回去，
    // 否则「导航高亮=对话、屏幕内容却停在统计」这种不一致会出现。
    if (store.nav !== 'settings') store.navBeforeSettings = store.nav;
    store.nav = nav;
    store.settingsOpen = true;
    return;
  }
  store.nav = nav;
  if (nav === 'tasks') store.tab = 'tasks';
  if (nav === 'chat') store.tab = 'chat';
}

/** 关闭设置弹层并恢复到打开前的导航位置。 */
export function closeSettings(): void {
  store.settingsOpen = false;
  store.nav = store.navBeforeSettings ?? 'chat';
  store.navBeforeSettings = null;
}

export function setTab(tab: ScreenTab): void {
  store.tab = tab;
}

export function refreshConversation(): void {
  store.branches = listBranches(store.conversationId);
  store.messages = listMessages(store.branchId);
}

export function switchBranch(branchId: string): void {
  store.branchId = branchId;
  refreshConversation();
}

function resolveProvider(): LlmProvider {
  if (deps.provider) return instrumentProvider(deps.provider);
  if (store.providerSettings.kind === 'openai') return instrumentProvider(createOpenAiCompatProvider());
  return instrumentProvider(createMockProvider());
}

/** 记一笔 LLM 用量：优先供应商真实 usage，缺则估算（estimated=1，UI 会标注）。 */
function recordLlmUsage(
  promptText: string,
  completionText: string,
  usage: { promptTokens?: number; completionTokens?: number } | null,
  providerKind: string,
): void {
  if (!store.ready) return; // 未初始化数据库（单测/早期启动）不记账，也不报错
  try {
    const s = store.providerSettings;
    const promptTokens = usage?.promptTokens ?? estimateTokens(promptText);
    const completionTokens = usage?.completionTokens ?? estimateTokens(completionText);
    recordUsage({
      kind: 'llm',
      model: s.llmModel || (providerKind === 'mock' ? 'mock' : ''),
      provider: providerKind,
      promptTokens,
      completionTokens,
      costMicros: costMicrosOf(promptTokens, completionTokens, s.llmPriceIn, s.llmPriceOut),
      estimated: !usage,
      conversationId: store.conversationId,
    });
    store.usageRevision += 1;
  } catch (err) {
    // 记账失败绝不能影响对话本身，但要留可见痕迹
    console.error('[vistaverge] usage record failed:', err);
  }
}

/**
 * 供应商计量外壳：对话、重试、语音会话共用同一条 LLM 路径，
 * 在唯一的出口处记账，避免各调用点各记一套导致漏记/重复。
 */
function instrumentProvider(base: LlmProvider): LlmProvider {
  const kind = base.mock ? 'mock' : 'openai';
  return {
    mock: base.mock,
    capabilities: () => base.capabilities(),
    async *streamChat(args) {
      const promptText = args.messages.map((m) => m.content).join('\n');
      let completion = '';
      let usage: { promptTokens?: number; completionTokens?: number } | null = null;
      try {
        for await (const chunk of base.streamChat(args)) {
          if ('done' in chunk) {
            // 供应商返回的 usage 只做过类型断言：必须按数字校验，
            // 否则非数字会经 recordUsage 写进台账（NaN 污染所有统计）。
            const raw = (chunk.done as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
            if (raw) {
              const prompt = raw.prompt_tokens;
              const completion = raw.completion_tokens;
              usage = {
                promptTokens: typeof prompt === 'number' && Number.isFinite(prompt) ? prompt : undefined,
                completionTokens: typeof completion === 'number' && Number.isFinite(completion) ? completion : undefined,
              };
              if (usage.promptTokens === undefined && usage.completionTokens === undefined) usage = null;
            }
            yield chunk;
            break;
          }
          completion += chunk.delta;
          yield chunk;
        }
      } finally {
        // 调用方拿到 done 就 break → 迭代器 return()，循环后的代码不会执行；
        // 记账必须放 finally（中止/提前退出也要把已消耗的 token 记上，估算标记已标注）。
        recordLlmUsage(promptText, completion, usage, kind);
      }
    },
  };
}

/**
 * 组装 LLM 请求。密钥必须在这里从凭据仓取：
 * 之前硬编码 apiKey:'' 导致文本对话对真实供应商全部 401（语音路径自己取密钥所以看起来正常）。
 */
async function llmArgs(history: MessageRecord[], userText: string) {
  const s = store.providerSettings;
  const apiKey = s.kind === 'openai' ? ((await getSecret('llmApiKey')) ?? '') : '';
  return {
    baseUrl: s.llmBaseUrl,
    model: s.llmModel,
    apiKey,
    messages: [
      { role: 'system', content: s.instructions },
      ...history.slice(-16).map((m) => ({ role: m.role, content: m.text })),
      { role: 'user', content: userText },
    ] as ChatMessage[],
    signal: new AbortController().signal,
  };
}

function applyAvatarDirectives(text: string): void {
  for (const d of parseDirectives(text)) {
    if (d.kind === 'emo') avatarExpression(d.value);
    else if (d.kind === 'act') avatarAction(d.value);
    else if (d.kind === 'face') avatarFacing(d.value === 'auto' ? null : (d.value as 'user' | 'screen'));
    else if (d.kind === 'gaze') {
      const [x, y] = d.value.split(',').map(Number);
      avatarGaze(x, y);
    }
  }
}

async function streamAssistant(userText: string, history: MessageRecord[]): Promise<string> {
  const provider = store.provider;
  if (!provider) throw new Error('供应商未配置');
  let full = '';
  store.streaming = '';
  try {
    for await (const chunk of provider.streamChat(await llmArgs(history, userText))) {
      if ('done' in chunk) break;
      full += chunk.delta;
      store.streaming = stripPartialDirective(full);
    }
  } finally {
    // 必须放 finally：中途报错/中止时若不清空，聊天区会永久停在一个半截的流式气泡上。
    store.streaming = null;
  }
  applyAvatarDirectives(full);
  return stripDirectives(full);
}

/** 返回 true 表示这轮真的被受理（busy 时返回 false，调用方据此决定是否清空输入框）。 */
export async function sendUserText(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed || store.busy) return false;
  store.busy = true;
  store.error = '';
  try {
    addMessage({
      conversationId: store.conversationId,
      branchId: store.branchId,
      role: 'user',
      text: trimmed,
      parentId: store.messages.at(-1)?.id ?? null,
    });
    const history = listMessages(store.branchId);
    refreshConversation();
    store.sceneState = 'working';
    await maybeHandleMcCommand(trimmed);
    await maybeHandleOuting(trimmed);
    const full = await streamAssistant(trimmed, history.slice(0, -1));
    addMessage({
      conversationId: store.conversationId,
      branchId: store.branchId,
      role: 'assistant',
      text: full,
      parentId: store.messages.at(-1)?.id ?? null,
    });
    refreshConversation();
    return true;
  } catch (err) {
    store.error = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    store.busy = false;
    store.sceneState = 'idle';
  }
}

export function editUserMessage(id: string, newText: string): void {
  const result = editMessage(id, newText);
  store.branchId = result.branchId;
  refreshConversation();
}

export async function retryAssistant(fromMessageId: string): Promise<void> {
  if (store.busy) return;
  const result = retryFrom(fromMessageId);
  store.branchId = result.branchId;
  refreshConversation();
  const lastUser = [...store.messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return;
  // 新分支已止于该用户消息，llmArgs 会再追加一次 userText：
  // 必须把末尾这条用户消息从历史里去掉，否则模型收到 [user X, user X] 重复输入。
  const history = store.messages.at(-1)?.id === lastUser.id ? store.messages.slice(0, -1) : store.messages;
  store.busy = true;
  try {
    store.sceneState = 'working';
    const full = await streamAssistant(lastUser.text, history);
    addMessage({
      conversationId: store.conversationId,
      branchId: store.branchId,
      role: 'assistant',
      text: full,
      parentId: store.messages.at(-1)?.id ?? null,
    });
    refreshConversation();
  } catch (err) {
    store.error = err instanceof Error ? err.message : String(err);
  } finally {
    store.busy = false;
    store.sceneState = 'idle';
  }
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function getVoice(): VoiceSession | null {
  return voice;
}

export async function toggleVoice(): Promise<void> {
  if (voice && store.voiceState !== 'idle') {
    await voice.stop();
    voice = null;
    store.voiceState = 'idle';
    store.sceneState = 'idle';
    return;
  }
  const s = store.providerSettings;
  if (s.kind !== 'openai' || !s.sttBaseUrl || !s.ttsBaseUrl || !s.llmBaseUrl) {
    store.error = '语音需要先在设置中选择 OpenAI 兼容供应商并填写 STT/LLM/TTS 端点';
    return;
  }
  const apiKey = (await getSecret('llmApiKey')) ?? '';
  voice = new VoiceSession(
    {
      stt: { baseUrl: s.sttBaseUrl, model: s.sttModel, apiKey },
      llm: { baseUrl: s.llmBaseUrl, model: s.llmModel, apiKey },
      tts: { baseUrl: s.ttsBaseUrl, model: s.ttsModel, apiKey },
      ttsVoice: s.ttsVoice,
      ttsSampleRate: 24000,
      instructions: s.instructions,
      gateDb: -66,
      minSilenceMs: 1200,
      minSpeechMs: 500,
      speechPadMs: 300,
      audioInputId: '',
      historyTurns: 8,
    },
    { provider: store.provider ?? createOpenAiCompatProvider() },
  );
  voice.addEventListener('state', (e) => {
    store.voiceState = (e as CustomEvent<{ state: VoiceSessionState }>).detail.state;
    store.sceneState =
      store.voiceState === 'ai-speaking'
        ? 'speaking'
        : store.voiceState === 'idle'
          ? 'idle'
          : store.voiceState === 'processing'
            ? 'working'
            : 'listening';
  });
  voice.addEventListener('user-turn', (e) => {
    const { text } = (e as CustomEvent<{ text: string }>).detail;
    addMessage({ conversationId: store.conversationId, branchId: store.branchId, role: 'user', text });
    refreshConversation();
  });
  voice.addEventListener('reply', (e) => {
    const { text } = (e as CustomEvent<{ text: string }>).detail;
    addMessage({ conversationId: store.conversationId, branchId: store.branchId, role: 'assistant', text });
    refreshConversation();
  });
  voice.addEventListener('sentence', (e) => {
    // TTS 计量：记合成字符数（单价未接入 → 只计用量不计费）
    const { text } = (e as CustomEvent<{ text: string }>).detail;
    if (!store.ready || !text) return;
    try {
      recordUsage({ kind: 'tts', units: text.length, provider: 'openai', conversationId: store.conversationId });
      store.usageRevision += 1;
    } catch (err) {
      console.error('[vistaverge] tts usage record failed:', err);
    }
  });
  voice.addEventListener('error', (e) => {
    store.error = (e as CustomEvent<{ message: string }>).detail.message;
  });
  // 回放电平 → 数字人口型包络（近似口型，非 viseme；Live2DAvatar 消费）
  voice.addEventListener('output-level', (e) => {
    const level = (e as CustomEvent<{ rms: number }>).detail?.rms ?? 0;
    store.mouthLevel = level;
    avatarMouth(level);
  });
  try {
    await voice.start();
  } catch (err) {
    // 麦克风被拒/worklet 加载失败时，必须回到 idle 并给出可读原因，
    // 否则界面会永久停在「连接中」且只有一条未处理拒绝。
    const message = err instanceof Error ? err.message : String(err);
    store.error = `语音启动失败：${message}（请检查麦克风权限与供应商配置）`;
    try {
      await voice.stop();
    } catch {
      /* 停止失败不覆盖上面的原因 */
    }
    voice = null;
    store.voiceState = 'idle';
    store.sceneState = 'idle';
  }
}

export async function saveProviderSettings(next: ProviderSettings, apiKey?: string): Promise<void> {
  store.providerSettings = { ...next };
  safeSet(LS_PROVIDER, JSON.stringify(next));
  if (apiKey !== undefined) await setSecret('llmApiKey', apiKey);
  store.provider = resolveProvider();
}

export function voiceStateLabel(): string {
  const map: Record<VoiceSessionState, string> = {
    idle: '待机',
    connecting: '连接中',
    listening: '聆听',
    'user-speaking': '你在说',
    processing: '思考中',
    'ai-speaking': '正在回答',
  };
  return map[store.voiceState];
}
