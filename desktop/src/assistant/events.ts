/**
 * assistant/events.ts — 助手域事件挂载点（F1-ASSIST 步骤 4）。
 *
 * 与 mc/session.ts 的 setMcEventListener 同一形态：会话层（app/store.ts）注册后，
 * 巡检产生摘要时以文本回调，供她「主动插话」。本模块**不 import store**，避免环依赖；
 * 对 ghPatrol 只用 `import type`，运行期无循环。
 */
import type { PatrolRunResult } from './ghPatrol';

export interface AssistantEventListener {
  /**
   * 巡检完成（含「未配置 / 限流 / 离线」等诚实失败态）时回调。
   * @param summary 中文摘要文本（可直接播报/显示）
   * @param result  结构化结果，调用方自行决定是否细看
   */
  onPatrolSummary?: (summary: string, result: PatrolRunResult) => void;
}

let assistantEventListener: AssistantEventListener = {};

/** 注册/清空助手事件监听（传 {} 或 null 即清空）。 */
export function setAssistantEventListener(listener: AssistantEventListener | null): void {
  assistantEventListener = listener ?? {};
}

/** 内部出口：ghPatrol 巡检结束时调用。 */
export function emitPatrolSummary(summary: string, result: PatrolRunResult): void {
  assistantEventListener.onPatrolSummary?.(summary, result);
}
