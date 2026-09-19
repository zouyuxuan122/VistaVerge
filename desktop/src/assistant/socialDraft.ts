/**
 * assistant/socialDraft.ts — QQ / 微博消息草稿与预览（F1-ASSIST P0）。
 *
 * 设计合同：
 * - docs/plugins/DOMAIN_PLUGINS.md §1.5：首期只生成**草稿与预览**，默认不自动外发；
 *   无官方 API 或隔离环境不满足时如实报「不支持」，不偷偷接管宿主输入；
 *   发送是独立授权域，不因「草稿」授权而自动获得。
 * - §3.8：`social.draft(platform, content)` 只产出草稿；`social.publish` 默认禁用。
 * - §2 社媒行 / D9：未授权时零外发。
 *
 * 硬性实现约束：
 * 1. 本模块**没有任何网络调用**：`social.publish` 是接口桩，默认禁用并返回 not-authorized。
 * 2. 「发送」永远先要求显式确认；确认后仍走通道检查 → 当前恒为「通道未就绪」。
 * 3. 草稿列表本地持久化（localStorage；测试注入 StorageLike）。
 */
import { defaultStorage, readJson, writeJson, removeKey, type StorageLike } from './localStore';

export type SocialPlatform = 'qq' | 'weibo';

export const SOCIAL_PLATFORM_LABEL: Record<SocialPlatform, string> = {
  qq: 'QQ',
  weibo: '微博',
};

/**
 * 平台文本长度上限（保守默认，DOMAIN §6「可校准参数」）。
 * 微博正文上限按 2000 字；QQ 单条消息按 1000 字保守取值（不假设会员/长消息能力）。
 */
export const SOCIAL_LIMITS: Record<SocialPlatform, number> = {
  qq: 1000,
  weibo: 2000,
};

/** 诚实通道状态：首期没有合法官方 API，也没有隔离环境 + 单独授权。 */
export const SOCIAL_CHANNEL_NOT_READY =
  '当前仅支持草稿与预览，发送通道未就绪（无合法官方 API，也未在隔离环境 + 单独授权）。见 docs/plugins/DOMAIN_PLUGINS.md §1.5。';

export const SOCIAL_PUBLISH_NOT_AUTHORIZED =
  'social.publish 默认禁用：需要单独授权，并使用合法官方 API 或隔离环境自动化；不因「草稿」授权自动获得。';

const DRAFTS_KEY = 'vistaverge.assistant.socialDrafts';
const URL_PATTERN = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/i;
// 中文没有 \b 词边界（汉字不是 \w），只在 ASCII 分支用 \b。
const AT_ALL_PATTERN = /@(全体成员|所有人|all\b|everyone\b)/i;

let draftSeq = 0;

/** 草稿 id：时间戳 + 进程内序号（无需 crypto，测试可注入 id）。 */
function createDraftId(): string {
  draftSeq += 1;
  return `draft-${Date.now().toString(36)}-${draftSeq}`;
}

export type DraftWarningKind = 'empty' | 'length-over-limit' | 'at-all' | 'link';
export type DraftWarningLevel = 'block' | 'warn' | 'info';

export interface DraftWarning {
  kind: DraftWarningKind;
  level: DraftWarningLevel;
  message: string;
}

export interface SocialDraft {
  id: string;
  platform: SocialPlatform;
  /** 收件人/群名；微博为空字符串（公开可见）。 */
  to: string;
  text: string;
  createdAt: number;
  warnings: DraftWarning[];
  /** 有 block 级告警（空内容/超长）时不允许进入发送确认。 */
  blocking: boolean;
}

export interface PreviewBubble {
  /** out = 我发出的气泡；in = 对方（仅用于展示会话上下文占位）。 */
  side: 'out' | 'in';
  text: string;
  /** 气泡内的附加标注（如「链接」）。 */
  note?: string;
}

export interface DraftPreview {
  platform: SocialPlatform;
  title: string;
  bubbles: PreviewBubble[];
  meta: string;
  warnings: DraftWarning[];
  canSend: boolean;
}

export type SendDecisionCode =
  | 'confirmation-required'
  | 'channel-not-ready'
  | 'draft-blocked'
  | 'not-authorized';

export interface SendDecision {
  ok: boolean;
  code: SendDecisionCode;
  message: string;
  /** 恒为 true：任何发送动作前都必须由用户显式确认。 */
  requiresConfirmation: boolean;
  /** 恒为 false：本模块没有任何外发能力（D9 零外发）。 */
  externalSent: false;
}

/* ------------------------------------------------------------------ */
/* 纯函数：敏感检查 / 预览                                              */
/* ------------------------------------------------------------------ */

/** 敏感检查：长度上限、@全体 警示、链接标注（DOMAIN §1.5 首期草稿路径）。 */
export function inspectDraft(platform: SocialPlatform, text: string): DraftWarning[] {
  const warnings: DraftWarning[] = [];
  if (text.trim().length === 0) {
    warnings.push({ kind: 'empty', level: 'block', message: '内容为空，先写点什么再存草稿。' });
  }
  const limit = SOCIAL_LIMITS[platform];
  if (text.length > limit) {
    warnings.push({
      kind: 'length-over-limit',
      level: 'block',
      message: `超过 ${SOCIAL_PLATFORM_LABEL[platform]} 文本上限 ${limit} 字（当前 ${text.length} 字），平台会截断或拒收。`,
    });
  }
  if (AT_ALL_PATTERN.test(text)) {
    warnings.push({
      kind: 'at-all',
      level: 'warn',
      message: '@全体成员 会打扰所有人：确认这是有意为之再发。',
    });
  }
  if (URL_PATTERN.test(text)) {
    warnings.push({ kind: 'link', level: 'info', message: '含链接：预览已标注，发送前请确认链接可信。' });
  }
  return warnings;
}

/** 预览渲染数据（气泡样式）：视图只负责画，不在模板里做判定。 */
export function renderPreview(draft: SocialDraft): DraftPreview {
  const warnings = inspectDraft(draft.platform, draft.text);
  const limit = SOCIAL_LIMITS[draft.platform];
  const hasLink = warnings.some((warning) => warning.kind === 'link');
  const bubbles: PreviewBubble[] = [
    {
      side: 'out',
      text: draft.text,
      ...(hasLink ? { note: '链接（预览标注）' } : {}),
    },
  ];
  const title =
    draft.platform === 'qq'
      ? `QQ · 发给 ${draft.to.trim() || '（未填收件人）'}`
      : '微博 · 公开发布（草稿，不会外发）';
  return {
    platform: draft.platform,
    title,
    bubbles,
    meta: `${draft.text.length} / ${limit} 字`,
    warnings,
    canSend: !warnings.some((warning) => warning.level === 'block'),
  };
}

export interface CreateDraftInput {
  to?: string;
  text: string;
}

export interface CreateDraftOptions {
  now?: () => number;
  id?: () => string;
}

/** 纯构造：产出一条草稿（含敏感检查），不落盘。 */
export function createDraft(
  platform: SocialPlatform,
  input: CreateDraftInput,
  options: CreateDraftOptions = {},
): SocialDraft {
  const now = options.now ?? (() => Date.now());
  const text = typeof input.text === 'string' ? input.text : '';
  const warnings = inspectDraft(platform, text);
  return {
    id: (options.id ?? createDraftId)(),
    platform,
    to: (input.to ?? '').trim(),
    text,
    createdAt: now(),
    warnings,
    blocking: warnings.some((warning) => warning.level === 'block'),
  };
}

/** 未落盘的实时预览：编辑框边写边看气泡与告警。 */
export function previewContent(platform: SocialPlatform, input: CreateDraftInput): DraftPreview {
  return renderPreview(createDraft(platform, input, { now: () => 0, id: () => 'preview' }));
}

/* ------------------------------------------------------------------ */
/* 发送流程：永远先确认，确认后如实报通道未就绪                          */

/** 第 1 步：请求发送 → 恒要求显式确认（不会直接外发）。 */
export function requestSend(draft: SocialDraft): SendDecision {
  if (draft.blocking) {
    return {
      ok: false,
      code: 'draft-blocked',
      message: '草稿有阻塞级告警（空内容/超长），先修好再谈发送。',
      requiresConfirmation: false,
      externalSent: false,
    };
  }
  return {
    ok: false,
    code: 'confirmation-required',
    message: `发送前需要你再次确认（${SOCIAL_PLATFORM_LABEL[draft.platform]} 草稿）。确认后仍会先检查通道，不会偷偷外发。`,
    requiresConfirmation: true,
    externalSent: false,
  };
}

/** 第 2 步：用户确认后执行通道检查 → 当前恒为「通道未就绪」。 */
export function confirmSend(draft: SocialDraft, options: { confirmed: boolean }): SendDecision {
  if (!options.confirmed) {
    return requestSend(draft);
  }
  if (draft.blocking) {
    return {
      ok: false,
      code: 'draft-blocked',
      message: '草稿有阻塞级告警（空内容/超长），未进入通道检查。',
      requiresConfirmation: false,
      externalSent: false,
    };
  }
  return {
    ok: false,
    code: 'channel-not-ready',
    message: SOCIAL_CHANNEL_NOT_READY,
    requiresConfirmation: false,
    externalSent: false,
  };
}

/** 预留 `social.publish` 接口桩：默认禁用（DOMAIN §3.8），恒返回 not-authorized。 */
export function socialPublish(_draft: SocialDraft): SendDecision & { enabled: false } {
  return {
    ok: false,
    code: 'not-authorized',
    message: SOCIAL_PUBLISH_NOT_AUTHORIZED,
    requiresConfirmation: true,
    externalSent: false,
    enabled: false,
  };
}

/* ------------------------------------------------------------------ */
/* 服务封装（草稿列表本地持久化）                                        */
/* ------------------------------------------------------------------ */

export interface SocialDraftService {
  list(): SocialDraft[];
  createDraft(platform: SocialPlatform, input: CreateDraftInput): SocialDraft;
  remove(id: string): boolean;
  preview(id: string): DraftPreview | null;
  requestSend(id: string): SendDecision | null;
  confirmSend(id: string, options: { confirmed: boolean }): SendDecision | null;
  publish(id: string): (SendDecision & { enabled: false }) | null;
}

export interface SocialDraftServiceDeps {
  storage?: StorageLike | null;
  now?: () => number;
  id?: () => string;
}

function isPlatform(value: unknown): value is SocialPlatform {
  return value === 'qq' || value === 'weibo';
}

/** 读草稿列表；损坏条目跳过（不猜字段），保持诚实。 */
function loadDrafts(storage: StorageLike | null): SocialDraft[] {
  const raw = readJson<unknown>(storage, DRAFTS_KEY);
  if (!Array.isArray(raw)) return [];
  const out: SocialDraft[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Partial<SocialDraft>;
    if (typeof obj.id !== 'string' || !isPlatform(obj.platform) || typeof obj.text !== 'string') continue;
    const warnings = inspectDraft(obj.platform, obj.text);
    out.push({
      id: obj.id,
      platform: obj.platform,
      to: typeof obj.to === 'string' ? obj.to : '',
      text: obj.text,
      createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : 0,
      warnings,
      blocking: warnings.some((warning) => warning.level === 'block'),
    });
  }
  return out;
}

export function createSocialDraftService(deps: SocialDraftServiceDeps = {}): SocialDraftService {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  let drafts = loadDrafts(storage);

  const persist = (): void => {
    if (drafts.length === 0) removeKey(storage, DRAFTS_KEY);
    else writeJson(storage, DRAFTS_KEY, drafts);
  };

  const find = (id: string): SocialDraft | null => drafts.find((draft) => draft.id === id) ?? null;

  return {
    list(): SocialDraft[] {
      return drafts.map((draft) => ({ ...draft, warnings: [...draft.warnings] }));
    },
    createDraft(platform: SocialPlatform, input: CreateDraftInput): SocialDraft {
      const draft = createDraft(platform, input, { now: deps.now, id: deps.id });
      // 最新的排前面，UI 列表更顺手。
      drafts = [draft, ...drafts];
      persist();
      return { ...draft, warnings: [...draft.warnings] };
    },
    remove(id: string): boolean {
      const before = drafts.length;
      drafts = drafts.filter((draft) => draft.id !== id);
      if (drafts.length === before) return false;
      persist();
      return true;
    },
    preview(id: string): DraftPreview | null {
      const draft = find(id);
      return draft ? renderPreview(draft) : null;
    },
    requestSend(id: string): SendDecision | null {
      const draft = find(id);
      return draft ? requestSend(draft) : null;
    },
    confirmSend(id: string, options: { confirmed: boolean }): SendDecision | null {
      const draft = find(id);
      return draft ? confirmSend(draft, options) : null;
    },
    publish(id: string) {
      const draft = find(id);
      return draft ? socialPublish(draft) : null;
    },
  };
}
