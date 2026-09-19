// teacher-fixes.test.ts — 已登记教师域 bug 的回归测试。
// B-T-04 quoteSpan 真实命中；B-T-06 difficulty 生效；B-T-07 上下文上限；
// B-T-08 bigram 归一化一致；B-T-10 无孤儿 signal；另覆盖提示与错因归类。
import { describe, expect, it } from 'vitest';
import { createMockProvider, type ChatChunk, type LlmProvider, type StreamChatArgs } from '../../src/services/llm/provider';
import {
  MAX_CONTEXT_CHUNKS,
  askQuestion,
  findChunks,
  generateQuiz,
  gradeAnswer,
  hintFor,
  importMaterial,
  type QuizQuestion,
} from '../../src/teacher/study';

const MATERIAL_TEXT = [
  '# 光合作用',
  '',
  '光合作用把光能转化为化学能。',
  '叶绿体是光合作用发生的场所。',
  '',
  '## 呼吸作用',
  '呼吸作用在细胞的线粒体中进行，释放能量。',
  '有机物在氧气参与下被分解。',
].join('\n');

function capturingProvider(): { provider: LlmProvider; lastArgs: () => StreamChatArgs | null } {
  let last: StreamChatArgs | null = null;
  return {
    lastArgs: () => last,
    provider: {
      mock: true,
      capabilities: () => ({ streaming: true }),
      async *streamChat(args: StreamChatArgs): AsyncGenerator<ChatChunk> {
        last = args;
        yield { delta: '回答' };
        yield { done: { finishReason: 'stop' } };
      },
    },
  };
}

describe('B-T-04 quoteSpan 真实命中位置', () => {
  it('引用区间指向查询命中处，而非恒取 chunk 前 80 字', async () => {
    // 命中词前面有足够长的无关内容，确保「真实命中位置」不会被窗口扩到 0。
    const longText = ['# 章节一', '', '甲'.repeat(80), '乙'.repeat(80), '叶绿体是光合作用发生的场所。'].join('\n');
    const { material, chunks } = importMaterial({ name: 'x.md', text: longText });
    const result = await askQuestion({ material, chunks, question: '叶绿体', provider: createMockProvider() });
    const citation = result.citations[0]!;
    expect(citation.quote).toContain('叶绿体');
    expect(citation.quoteSpan.end).toBeGreaterThan(citation.quoteSpan.start);
    const chunk = chunks.find((item) => item.anchor === citation.anchor)!;
    expect(chunk.text.slice(citation.quoteSpan.start, citation.quoteSpan.end)).toContain('叶绿体');
    expect(citation.quoteSpan.start).toBeGreaterThan(0);
  });
});

describe('B-T-06 difficulty 入参生效', () => {
  it('本地降级出题按请求难度出题', async () => {
    const { material, chunks } = importMaterial({ name: 'x.md', text: MATERIAL_TEXT });
    const hard = await generateQuiz({ material, chunks, provider: createMockProvider(), count: 3, difficulty: 3 });
    expect(hard.questions.length).toBeGreaterThan(0);
    expect(hard.questions.every((question) => question.difficulty === 3)).toBe(true);

    const easy = await generateQuiz({ material, chunks, provider: createMockProvider(), count: 3, difficulty: 1 });
    expect(easy.questions.every((question) => question.difficulty === 1)).toBe(true);
  });
});

describe('B-T-07 出题上下文设上限', () => {
  it('只注入受控数量的 chunk，不把整本资料拼入请求', async () => {
    const longText = Array.from(
      { length: 24 },
      (_, index) => `第${index + 1}段：这是一段用于分块的中文资料内容，` + '内容'.repeat(40) + '。',
    ).join('\n');
    const { material, chunks } = importMaterial({ name: '长文.md', text: longText });
    expect(chunks.length).toBeGreaterThan(MAX_CONTEXT_CHUNKS);
    const { provider, lastArgs } = capturingProvider();
    await generateQuiz({ material, chunks, provider, count: 3 });
    const content = lastArgs()!.messages.map((message) => message.content).join('\n');
    const anchors = content.match(/\[[^\]]+#L\d+-L\d+\]/g) ?? [];
    expect(anchors.length).toBeLessThanOrEqual(MAX_CONTEXT_CHUNKS);
    expect(content.length).toBeLessThan(longText.length);
  });
});

describe('B-T-08 bigram 归一化一致', () => {
  it('正文含空白时仍能按去空白口径命中查询', () => {
    const { chunks } = importMaterial({ name: 'x.txt', text: '叶 绿 体 是 光 合 作 用 的 场 所' });
    const hits = findChunks(chunks, '叶绿体');
    expect(hits).toHaveLength(1);
    expect(findChunks(chunks, '量子纠缠')).toHaveLength(0);
  });
});

describe('B-T-10 无外部 signal 时不留孤儿 signal', () => {
  it('内部自建 signal 在完成后被 abort；外部 signal 不被误 abort', async () => {
    const { material, chunks } = importMaterial({ name: 'x.md', text: MATERIAL_TEXT });
    const internal = capturingProvider();
    await askQuestion({ material, chunks, question: '叶绿体', provider: internal.provider });
    expect(internal.lastArgs()!.signal.aborted).toBe(true);

    const external = capturingProvider();
    const controller = new AbortController();
    await askQuestion({ material, chunks, question: '叶绿体', provider: external.provider, signal: controller.signal });
    expect(external.lastArgs()!.signal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('渐进提示与错因归类', () => {
  const fill = (overrides: Partial<QuizQuestion> = {}): QuizQuestion => ({
    id: 'q1',
    materialId: 'm1',
    type: 'fill_blank',
    prompt: '光合作用发生在____中。',
    answer: '叶绿体',
    point: '场所',
    difficulty: 1,
    anchor: 'm1#L4-L4',
    explanation: '',
    generatedBy: 'local-fallback',
    ...overrides,
  });

  it('提示 1–3 级递增且夹取范围', () => {
    const question = fill();
    const level1 = hintFor(question, 1);
    const level2 = hintFor(question, 2);
    const level3 = hintFor(question, 3);
    expect(level1).toContain('场所');
    expect(level2).toContain('叶绿体'.slice(0, 1));
    expect(level3).toContain('叶绿体'.slice(0, 2));
    expect(level1).not.toContain('叶绿体'.slice(0, 2));
    expect(hintFor(question, 99)).toBe(level3);
    expect(hintFor(question, 0)).toBe(level1);
  });

  it('错因枚举：未作答/概念不清/表达不完整/计算错误/待验证', () => {
    expect(gradeAnswer(fill(), '   ').cause).toBe('unanswered');
    expect(gradeAnswer(fill(), '线粒体').cause).toBe('concept');
    expect(gradeAnswer(fill({ answer: '光合作用把光能转化为化学能' }), '光').cause).toBe('incomplete');
    expect(gradeAnswer(fill({ answer: '42', prompt: '结果是多少' }), '41').cause).toBe('calculation');
    expect(gradeAnswer(fill({ type: 'short_answer' }), '随便写写').cause).toBe('none');
    expect(gradeAnswer(fill(), '叶绿体').cause).toBe('none');
  });
});
