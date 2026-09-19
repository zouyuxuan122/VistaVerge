/**
 * 给非对话链路（教师/讲课等）提供与主对话一致的供应商解析。
 * 不在 store.ts 里直接导出，是为了让模块只依赖这一个轻入口。
 */
import { store } from './store';
import { createMockProvider, createOpenAiCompatProvider } from '../services/llm/provider';
import type { LlmProvider } from '../services/llm/provider';

/** 返回当前用户配置的 LLM provider；未配置时为 mock（调用方需如实标注）。 */
export function getAppProvider(): LlmProvider {
  return store.providerSettings.kind === 'openai'
    ? createOpenAiCompatProvider()
    : createMockProvider();
}
