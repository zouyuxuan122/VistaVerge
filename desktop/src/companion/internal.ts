/**
 * companion/internal.ts — 陪伴域内部工具（非公开接线契约）。
 *
 * 纪律（TEACHER_COMPANION §1.3/§1.4、VOICE §1.6）：
 * - 角色卡与知识库文本一律按**数据**处理：detectInstructionText 只做标记与提示，
 *   绝不触发副作用（本模块不持有任何工具权限，也不 import 任何 UI/Vue）。
 * - 检索归一化必须**长度可映射**：归一化后的每个码点都记录其原始下标，
 *   查询与文本走同一条管道，避免 teacher/study.ts 里 B-T-08 式的归一化不一致。
 * - 本文件是独立实现，只参考公开格式规范，不搬运任何 AGPL 代码。
 */

/** 陪伴域一等事件（可审计；不记录正文之外的额外隐私）。 */
export type CompanionEventType =
  | 'charcard.imported'
  | 'charcard.degraded'
  | 'charcard.injection.detected'
  | 'charcard.parse.failed'
  | 'style.updated'
  | 'style.disabled'
  | 'knowledge.imported'
  | 'knowledge.injection.detected'
  | 'knowledge.deleted';

export interface CompanionEvent {
  type: CompanionEventType;
  at: number;
  traceId: string;
  detail?: Record<string, unknown>;
}

/** 不透明 ID（优先 crypto.randomUUID，运行时缺失时退化为本地唯一串）。 */
export function newId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = g.crypto?.randomUUID?.();
  if (typeof uuid === 'string' && uuid.length > 0) return uuid;
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function nowMs(): number {
  return Date.now();
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function makeEvent(
  type: CompanionEventType,
  detail?: Record<string, unknown>,
): CompanionEvent {
  const event: CompanionEvent = { type, at: nowMs(), traceId: newId() };
  if (detail) event.detail = detail;
  return event;
}

/* ------------------------------------------------------------------ */
/* 文本清洗与截断                                                      */
/* ------------------------------------------------------------------ */

/**
 * 控制字符清洗：统一换行、去掉 C0/C1 控制字符（保留 \n \t）。
 * `\f`（分页符）默认被当作控制字符去掉，知识库导入需用 keepFormFeed 保留。
 */
export function sanitizeControlChars(text: string, options: { keepFormFeed?: boolean } = {}): string {
  let out = String(text ?? '').replace(/\r\n?/g, '\n');
  out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (ch) => {
    if (options.keepFormFeed === true && ch === '\f') return ch;
    return '';
  });
  return out;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/** 按码点截断（不切开代理对）。 */
export function truncateText(text: string, maxChars: number): TruncateResult {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return { text: '', truncated: text.length > 0 };
  const points = [...text];
  if (points.length <= maxChars) return { text, truncated: false };
  return { text: points.slice(0, maxChars).join(''), truncated: true };
}

/* ------------------------------------------------------------------ */
/* 指令式文本检测（标记用，绝不执行）                                  */
/* ------------------------------------------------------------------ */

const INSTRUCTION_PATTERNS: RegExp[] = [
  /忽略(?:之前|以上|前面|先前|所有)(?:的)?(?:指令|规则|设定|提示)/g,
  /(?:无视|忘掉|忘记|清除|跳过)(?:之前|以上|前面|所有)(?:的)?(?:指令|规则|设定|提示)/g,
  /(?:现在|立刻|马上)?(?:请)?(?:执行|运行|调用)(?:以下|下面|这个|这段)?(?:命令|工具|函数|脚本|代码)/g,
  /调用(?:工具|函数|接口|插件|服务)(?:去)?(?:发送|删除|上传|下载|转账|购买|执行|写入)/g,
  /(?:发送|转发|上传|泄露|外发)(?:给)?(?:我|用户|他人)?(?:的)?(?:邮件|消息|文件|密钥|密码|token|api[\s_-]?key|聊天记录)/gi,
  /(?:删除|清空|销毁|格式化)(?:所有|全部|本地|整个)(?:记忆|数据|文件|记录|日志|磁盘)/g,
  /(?:系统提示|系统指令|开发者消息|system\s*prompt|developer\s*message|jailbreak|越狱)/gi,
  /(?:不要|别)(?:再)?(?:遵守|理会|执行|管)(?:任何)?(?:安全|限制|规则|约束|权限)/g,
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|above|prior|earlier)\s+(?:instructions?|rules?|prompts?)/gi,
  /disregard\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions?|rules?)/gi,
  /(?:act\s+as|you\s+are\s+now)\s+(?:a\s+)?(?:dan|jailbroken|unrestricted|root)/gi,
];

/**
 * 返回命中的指令式文本片段（仅用于标记与提示，不执行、不改变权限）。
 * 独立实现，与 teacher/study.ts 的 detectInjection 不共享代码。
 */
export function detectInstructionText(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits: string[] = [];
  for (const pattern of INSTRUCTION_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches) hits.push(...matches);
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* 检索归一化（长度可映射，查询与文本同管道）                          */
/* ------------------------------------------------------------------ */

/** 单字符归一化：NFKC + 小写；长度变化时保留原字符（保证下标映射可靠）。 */
function normalizeChar(ch: string): string {
  const folded = ch.normalize('NFKC');
  if ([...folded].length !== 1) return ch;
  const lowered = folded.toLowerCase();
  return lowered.length === 1 ? lowered : folded;
}

/** 空白与控制字符。 */
const SEARCH_SPACE_RE = /[\s\u00a0\u3000]/;
/** 标点（ASCII 标点 + CJK 标点 + 全角标点）；emoji/字母/数字/汉字保留。 */
const SEARCH_PUNCT_RE =
  /[\u0000-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e\u00a1-\u00bf\u2000-\u206f\u3001-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/;

export interface NormalizedText {
  /** 去掉空白与标点、NFKC + 小写后的检索文本。 */
  normalized: string;
  /** normalized[i] 对应原文的码元下标；长度与 normalized 一致。 */
  map: number[];
}

/**
 * 检索归一化：查询与文本必须调用同一个函数，保证「同管道」。
 * 归一化后每个字符都能映射回原文下标，用于生成可定位的 snippet。
 */
export function normalizeForSearch(text: string): NormalizedText {
  const source = String(text ?? '');
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const raw = source[i];
    if (SEARCH_SPACE_RE.test(raw)) continue;
    const ch = normalizeChar(raw);
    if (SEARCH_PUNCT_RE.test(ch)) continue;
    chars.push(ch);
    map.push(i);
  }
  return { normalized: chars.join(''), map };
}

/**
 * 检索 n-gram：归一化长度 ≥2 用 bigram；单字查询退化为 unigram（否则短查询永远无命中）。
 * 返回去重后的 gram 列表，保证打分不重复计权。
 */
export function searchGrams(normalized: string): string[] {
  if (normalized.length === 0) return [];
  if (normalized.length === 1) return [normalized];
  const grams: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    const gram = normalized.slice(i, i + 2);
    if (seen.has(gram)) continue;
    seen.add(gram);
    grams.push(gram);
  }
  return grams;
}

/** 不重叠出现次数（needle 为空返回 0）。 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 有效字符数：去掉空白/标点后的码点数（用于「过短无信息」判定）。 */
export function effectiveCharCount(text: string): number {
  return [...normalizeForSearch(text).normalized].length;
}

/** 把归一化下标映射回原文下标；越界时钳到 [0, source.length]。 */
export function mapToSource(map: number[], normalizedIndex: number, sourceLength: number): number {
  if (map.length === 0) return 0;
  if (normalizedIndex <= 0) return map[0];
  if (normalizedIndex >= map.length) return sourceLength;
  return map[normalizedIndex];
}
