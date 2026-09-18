/**
 * data/util.ts — 数据层内部小工具。
 */

/** 生成不透明 ID（RFC4122 v4 uuid）。 */
export function newId(): string {
  return crypto.randomUUID();
}

/** 当前 Unix 毫秒时间戳。 */
export function nowMs(): number {
  return Date.now();
}

/** 去重、去空白、保序的标签规范化。 */
export function normalizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}
