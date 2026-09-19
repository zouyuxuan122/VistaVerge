/**
 * companion/proactive.ts — 回应门控与主动插话仲裁（纯函数，保守默认）。
 *
 * 依据：VOICE §1.4（主动插话由确定事件、交流间隙与用户偏好仲裁，默认保守，不因「更活泼」
 * 而频繁抢话）、§1.6（旁路对话/电视声/他人交谈不应默认当作指令；不确定时降低主动响应）；
 * §1.3（常听默认关）；MEMORY_PERCEPTION §8（常驻只做事件监听与确定规则、不每秒轮询 LLM）；
 * GAP_AUDIT G-COMP-06 / G-VOICE-01。
 *
 * 本模块**不发起任何 LLM 调用**：拿不准就返回 'uncertain'，由调用方决定是否花一次廉价
 * LLM 判断；两个函数的全部阈值都导出为可配置常量对象。
 */

import { clamp, effectiveCharCount, nowMs } from './internal';

/* ------------------------------------------------------------------ */
/* 回应门控                                                            */
/* ------------------------------------------------------------------ */

export type ReplyGate = 'respond' | 'record' | 'uncertain';

export type TranscriptSpeaker = 'user' | 'other' | 'background' | 'self' | 'unknown';

export interface ReplyGateContext {
  /** 用户给她的称呼/名字（命中即视为在对她说）。 */
  myNames?: string[];
  /** 说话人判定（调用方/VAD 上游给；'self' = 自播回声）。 */
  speaker?: TranscriptSpeaker;
  /** 显式「在对她说」（优先级高于启发式）。 */
  addressedToHer?: boolean;
  /** 自言自语（标记或上游判定）。 */
  isSelfTalk?: boolean;
  /** 背景旁白 / 电视声 / 他人交谈。 */
  isBackgroundNarration?: boolean;
  /** 接续上文（上一回合她在等回答）。 */
  continuationOfPrevious?: boolean;
  /** 阈值覆盖。 */
  thresholds?: Partial<ReplyGateThresholds>;
}

export interface ReplyGateThresholds {
  /** 有效字符数下限：低于此值视为「过短无信息」。 */
  minEffectiveChars: number;
  /** 含疑问词时视为问句的最大有效长度（更长时更可能是在自述）。 */
  questionMaxChars: number;
  /** 自言自语标记判定的最大有效长度。 */
  maxSelfTalkChars: number;
  /** 末尾「吧/呗/一下」类祈使后缀判定所需的最大有效长度。 */
  maxImperativeSuffixChars: number;
}

export const REPLY_GATE_THRESHOLDS: ReplyGateThresholds = {
  minEffectiveChars: 2,
  questionMaxChars: 40,
  maxSelfTalkChars: 6,
  maxImperativeSuffixChars: 20,
};

/** 自言自语/语气词填充标记（仅短句生效）。 */
export const SELF_TALK_PATTERNS: readonly RegExp[] = [
  /^(?:嗯+|哦+|噢+|啊+|唉+|呃+|额+|唔+|嘞+|咳)[。.!！~～…\s]*$/,
  /^(?:那个|就是|这个|然后)[。.!！~～…\s]*$/,
  /^(?:我看看|让我想想|我想想|我找找|我算算)[。.!！~～…\s]*$/,
];

/** 「明显在对别人说话」的启发式标记。 */
export const OTHER_ADDRESS_PATTERNS: readonly RegExp[] = [
  /(?:你们|大家|各位|同志们|同学们|朋友们|兄弟们|姐妹们)/,
  /(?:跟|和|对)(?:他|她|他们|她们|别人|同事|朋友|老板|客服)(?:说|讲|聊|问)/,
  /(?:他|她)(?:说|问|让我|叫我|告诉我)/,
];

const QUESTION_END_RE = /[?？]\s*$/;
const QUESTION_PARTICLE_RE = /(?:吗|呢)\s*[?？]?\s*$/;
const INTERROGATIVE_RE =
  /(?:怎么|为什么|为啥|什么|哪里|哪儿|哪个|多少|几点|几天|几次|是不是|能不能|可不可以|有没有|行不行|好不好|对不对|懂不懂)/;

const IMPERATIVE_PREFIX_RE =
  /^(?:请|帮我|帮忙|给我|把|打开|关闭|关掉|关一下|查一下|查查|看看|听听|说一下|讲一下|唱|记住|提醒我|提醒|别|不要|来|去|做|写|画|发|放|停|开始|继续|过来|坐下|睡觉|起床)/;
const IMPERATIVE_REQUEST_RE = /(?:帮我|给我|麻烦你|你能不能|你可以|能不能帮我|帮我一下|拜托)/;
const IMPERATIVE_SUFFIX_RE = /(?:一下|吧|呗|好吗|行吗|可以吗)\s*[。.!！~～…]?\s*$/;
const REQUEST_VERB_RE = /(?:你|来|去|帮|说|讲|唱|看|听|写|画|放|停|开|关|查|找|记住|提醒|陪|抱|夸)/;

export interface ReplyGateExplanation {
  gate: ReplyGate;
  /** 判定依据（人类可读，便于调试与审计）。 */
  reasons: string[];
}

function hasNameMention(transcript: string, names: readonly string[]): boolean {
  return names.some((name) => name.trim().length > 0 && transcript.includes(name.trim()));
}

/**
 * 回应门控：`'respond'` 明确该回、`'record'` 只记录不回应、`'uncertain'` 拿不准。
 *
 * 规则（保守优先）：
 * - 背景旁白 / 自播回声 / 明显对他人说话 / 自言自语标记 / 过短无信息 → record
 * - 含对她的称呼、问句、祈使指令、接续上文短答 → respond
 * - 其余 → uncertain（调用方可选一次廉价 LLM 判断；本模块不发 LLM）
 */
export function explainReplyGate(
  transcript: string,
  ctx: ReplyGateContext = {},
): ReplyGateExplanation {
  const thresholds: ReplyGateThresholds = { ...REPLY_GATE_THRESHOLDS, ...(ctx.thresholds ?? {}) };
  const text = String(transcript ?? '').trim();
  const effective = effectiveCharCount(text);
  const reasons: string[] = [];

  // 1) 明确的「不是对我说的」信号优先（VOICE §1.6）。
  if (ctx.speaker === 'self') return { gate: 'record', reasons: ['自播回声/自身输出，不当作输入'] };
  if (ctx.speaker === 'background' || ctx.isBackgroundNarration === true) {
    return { gate: 'record', reasons: ['背景旁白/他人交谈，不默认当作指令'] };
  }
  if (ctx.addressedToHer === true) {
    return { gate: 'respond', reasons: ['调用方显式标记「在对她说」'] };
  }
  if (ctx.speaker === 'other') return { gate: 'record', reasons: ['说话人判定为他人'] };
  if (ctx.isSelfTalk === true) return { gate: 'record', reasons: ['自言自语'] };
  if (effective === 0) return { gate: 'record', reasons: ['无有效内容（空/纯标点）'] };

  if (effective <= thresholds.maxSelfTalkChars && SELF_TALK_PATTERNS.some((re) => re.test(text))) {
    return { gate: 'record', reasons: ['自言自语/语气词填充标记'] };
  }
  if (OTHER_ADDRESS_PATTERNS.some((re) => re.test(text))) {
    return { gate: 'record', reasons: ['明显在对他人说话'] };
  }

  // 2) 接续上文短答：即使很短也回（她在等回答）。
  if (ctx.continuationOfPrevious === true) {
    return { gate: 'respond', reasons: ['接续上文，她在等回答'] };
  }

  // 3) 过短无信息 → 只记录。
  if (effective < thresholds.minEffectiveChars) {
    return { gate: 'record', reasons: [`有效字符 ${effective} < ${thresholds.minEffectiveChars}，信息量不足`] };
  }

  // 4) 明确该回的信号。
  const names = ctx.myNames ?? [];
  if (hasNameMention(text, names)) {
    return { gate: 'respond', reasons: ['包含对她的称呼'] };
  }
  const isQuestion =
    QUESTION_END_RE.test(text) ||
    QUESTION_PARTICLE_RE.test(text) ||
    (INTERROGATIVE_RE.test(text) && effective <= thresholds.questionMaxChars);
  if (isQuestion) {
    reasons.push('问句');
    return { gate: 'respond', reasons };
  }
  const isImperative =
    IMPERATIVE_PREFIX_RE.test(text) ||
    IMPERATIVE_REQUEST_RE.test(text) ||
    (IMPERATIVE_SUFFIX_RE.test(text) &&
      effective <= thresholds.maxImperativeSuffixChars &&
      REQUEST_VERB_RE.test(text));
  if (isImperative) {
    return { gate: 'respond', reasons: ['祈使/请求指令'] };
  }

  // 5) 拿不准：交给调用方决定（本模块不发起 LLM）。
  return { gate: 'uncertain', reasons: ['无明确回应/忽略信号，拿不准'] };
}

/** 只取门控结论（任务书接口）。 */
export function decideReplyGate(transcript: string, ctx: ReplyGateContext = {}): ReplyGate {
  return explainReplyGate(transcript, ctx).gate;
}

/* ------------------------------------------------------------------ */
/* 主动插话仲裁                                                        */
/* ------------------------------------------------------------------ */

export type ProactiveEventKind =
  | 'reminder'
  | 'mc_task_complete'
  | 'question_unanswered'
  | 'user_home'
  | 'gh_patrol'
  | 'idle_care';

export interface ProactiveEvent {
  kind: ProactiveEventKind;
  /** 事件发生时刻（epoch ms）。 */
  at: number;
  /** 覆盖默认优先级（越大越该说）。 */
  priority?: number;
  detail?: string;
}

export interface QuietHours {
  /** 0-23；跨午夜（start > end）也支持。 */
  startHour: number;
  endHour: number;
}

export interface ProactiveThresholds {
  /** 每小时主动发言额度（默认 2，VOICE §1.4 保守）。 */
  hourlyQuota: number;
  /** 两次主动发言最小间隔（ms）。 */
  minGapMs: number;
  /** 安静时段；null = 不启用。 */
  quietHours: QuietHours | null;
  /** 优先级高到可以突破安静时段（默认 4 = 高于任何事件，即默认不突破）。 */
  quietBypassPriority: number;
  /** 各强度档的最低优先级：0 关 / 1 保守 / 2 活泼。 */
  intensityMinPriority: Record<0 | 1 | 2, number>;
  /** 事件默认优先级。 */
  eventPriority: Record<ProactiveEventKind, number>;
  /** 事件最长排队时长；超过则丢弃（避免过时信息补说打断用户）。 */
  maxQueueAgeMs: number;
}

export const PROACTIVE_THRESHOLDS: ProactiveThresholds = {
  hourlyQuota: 2,
  minGapMs: 90_000,
  quietHours: { startHour: 23, endHour: 8 },
  quietBypassPriority: 4,
  intensityMinPriority: { 0: Number.POSITIVE_INFINITY, 1: 2, 2: 1 },
  eventPriority: {
    reminder: 3,
    question_unanswered: 3,
    user_home: 2,
    gh_patrol: 2, // 用户显式配置的巡检结果：保守档也值得说
    mc_task_complete: 1,
    idle_care: 1,
  },
  maxQueueAgeMs: 180_000,
};

export type ProactiveReason =
  | 'ok'
  | 'no-event'
  | 'intensity-off'
  | 'low-priority'
  | 'quiet-hours'
  | 'hourly-quota'
  | 'busy-playing'
  | 'busy-generating'
  | 'min-gap'
  | 'stale-event';

export interface ProactiveContext {
  /** 当前时刻（epoch ms；缺省 Date.now()）。 */
  now?: number;
  /** 用户强度档：0 关 / 1 保守 / 2 活泼。 */
  intensity?: 0 | 1 | 2;
  /** 本小时已主动发言次数。 */
  spokenThisHour?: number;
  /** 上次主动发言时刻（epoch ms）。 */
  lastSpokenAt?: number | null;
  /** 正在播放语音 → 不插话（排队）。 */
  isPlayingAudio?: boolean;
  /** 正在生成/合成 → 不插话（排队）。 */
  isGenerating?: boolean;
  /** 阈值覆盖。 */
  thresholds?: Partial<ProactiveThresholds>;
}

export interface ProactiveDecision {
  shouldSpeak: boolean;
  reason: ProactiveReason;
  /** 选中事件的优先级（无事件为 0）。 */
  priority: number;
  /** true = 该事件仍值得稍后重试（排队），false = 直接丢弃。 */
  queued: boolean;
  /** 选中/被判定的事件（无事件时省略）。 */
  event?: ProactiveEvent;
}

/** 安静时段判定（支持跨午夜）。 */
export function isQuietHour(hour: number, quiet: QuietHours | null): boolean {
  if (!quiet) return false;
  const start = ((Math.floor(quiet.startHour) % 24) + 24) % 24;
  const end = ((Math.floor(quiet.endHour) % 24) + 24) % 24;
  const value = ((Math.floor(hour) % 24) + 24) % 24;
  if (start === end) return false;
  if (start < end) return value >= start && value < end;
  return value >= start || value < end;
}

/** 统计窗口内已发言次数（前台可用它算 spokenThisHour）。 */
export function countSpokenInWindow(timestamps: readonly number[], now: number, windowMs: number): number {
  const from = now - Math.max(0, windowMs);
  return timestamps.filter((ts) => Number.isFinite(ts) && ts > from && ts <= now).length;
}

/**
 * 主动插话仲裁：从事件里挑一件最该说的，按安静时段 / 每小时额度 / 强度档 /
 * 播放与生成状态 / 最小间隔逐条约束；不满足时给出可审计的 reason。
 */
export function arbitrateProactive(
  events: readonly ProactiveEvent[],
  ctx: ProactiveContext = {},
): ProactiveDecision {
  const thresholds: ProactiveThresholds = { ...PROACTIVE_THRESHOLDS, ...(ctx.thresholds ?? {}) };
  const now = Number.isFinite(ctx.now) ? Number(ctx.now) : nowMs();
  const intensity: 0 | 1 | 2 = (ctx.intensity == null ? 1 : clamp(Math.round(ctx.intensity), 0, 2)) as 0 | 1 | 2;

  if (intensity === 0) {
    return { shouldSpeak: false, reason: 'intensity-off', priority: 0, queued: false };
  }

  const priorityOf = (event: ProactiveEvent): number => {
    if (Number.isFinite(event.priority)) return Number(event.priority);
    return thresholds.eventPriority[event.kind] ?? 1;
  };

  const candidates = events
    .filter((event) => Number.isFinite(event.at) && event.at <= now)
    .filter((event) => now - event.at <= thresholds.maxQueueAgeMs)
    .sort((a, b) => priorityOf(b) - priorityOf(a) || a.at - b.at);

  if (candidates.length === 0) {
    const stale = events.some((event) => Number.isFinite(event.at) && event.at <= now);
    return { shouldSpeak: false, reason: stale ? 'stale-event' : 'no-event', priority: 0, queued: false };
  }

  const event = candidates[0];
  const priority = priorityOf(event);
  const base = { priority, event };

  // 安静时段：默认任何事件都不突破（quietBypassPriority=4 > 最高事件优先级 3）。
  if (isQuietHour(new Date(now).getHours(), thresholds.quietHours) && priority < thresholds.quietBypassPriority) {
    return { ...base, shouldSpeak: false, reason: 'quiet-hours', queued: true };
  }
  // 正在播放/生成：不抢话，排队（VOICE §1.4 默认保守）。
  if (ctx.isPlayingAudio === true) {
    return { ...base, shouldSpeak: false, reason: 'busy-playing', queued: true };
  }
  if (ctx.isGenerating === true) {
    return { ...base, shouldSpeak: false, reason: 'busy-generating', queued: true };
  }
  if (Number(ctx.spokenThisHour ?? 0) >= thresholds.hourlyQuota) {
    return { ...base, shouldSpeak: false, reason: 'hourly-quota', queued: true };
  }
  if (priority < thresholds.intensityMinPriority[intensity]) {
    return { ...base, shouldSpeak: false, reason: 'low-priority', queued: false };
  }
  if (
    ctx.lastSpokenAt != null &&
    Number.isFinite(ctx.lastSpokenAt) &&
    now - Number(ctx.lastSpokenAt) < thresholds.minGapMs
  ) {
    return { ...base, shouldSpeak: false, reason: 'min-gap', queued: true };
  }
  return { ...base, shouldSpeak: true, reason: 'ok', queued: false };
}
