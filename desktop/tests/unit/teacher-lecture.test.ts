// teacher-lecture.test.ts — 讲课状态机（播放/暂停/提问/翻页/讲稿缓存/事件/注入）。
import { describe, expect, it } from 'vitest';
import { createLectureController } from '../../src/teacher/lecture';
import { createMockProvider, type ChatChunk, type LlmProvider, type StreamChatArgs } from '../../src/services/llm/provider';
import type { SlideDeck } from '../../src/teacher/pptx';

function slide(index: number, text: string): SlideDeck['slides'][number] {
  return {
    index,
    partPath: `ppt/slides/slide${index}.xml`,
    texts: [
      {
        id: `t${index}`,
        name: 'Body',
        x: 0,
        y: 0,
        width: 800,
        height: 200,
        paragraphs: [{ level: 0, text }],
        text,
      },
    ],
    images: [],
    notes: '',
    injectionDetected: false,
  };
}

const DECK: SlideDeck = {
  name: '演示.pptx',
  widthPx: 960,
  heightPx: 540,
  events: [],
  slides: [slide(1, '光合作用在叶绿体中进行'), slide(2, '呼吸作用在线粒体中进行')],
};

function slowProvider(): { provider: LlmProvider; release: () => void } {
  let releaseFn: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  return {
    release: () => releaseFn(),
    provider: {
      mock: true,
      capabilities: () => ({ streaming: true }),
      async *streamChat(args: StreamChatArgs): AsyncGenerator<ChatChunk> {
        yield { delta: '第一段' };
        await gate;
        if (args.signal.aborted) throw new DOMException('aborted', 'AbortError');
        yield { delta: '第二段' };
        yield { done: { finishReason: 'stop' } };
      },
    },
  };
}

describe('讲课状态机', () => {
  it('open 进入选页态，并把每页注册为资料（锚点 幻灯片 第N页）', () => {
    const controller = createLectureController({ provider: createMockProvider() });
    expect(controller.state()).toBe('idle');
    controller.open(DECK);
    expect(controller.state()).toBe('selecting');
    expect(controller.pageCount()).toBe(2);
    expect(controller.material()?.sourceKind).toBe('pptx');
    expect(controller.chunks()[0]?.anchor).toBe('幻灯片 第1页');
  });

  it('播放：逐页生成讲稿、自动翻页、讲完置 finished，讲稿按页缓存', async () => {
    const spoken: { page: number; done: boolean }[] = [];
    const controller = createLectureController({
      provider: createMockProvider(),
      autoAdvance: true,
      speak: (_text, meta) => spoken.push(meta),
    });
    controller.open(DECK);
    await controller.play();
    expect(controller.state()).toBe('finished');
    expect(controller.currentPage()).toBe(2);
    expect(controller.script(1)).toContain('[MOCK]');
    expect(controller.script(2)).toContain('[MOCK]');
    const types = controller.events().map((event) => event.type);
    expect(types).toContain('lecture.started');
    expect(types).toContain('slide.changed');
    expect(types.filter((type) => type === 'slide.explained')).toHaveLength(2);
    expect(types).toContain('lecture.finished');
    expect(controller.events().every((event) => typeof event.traceId === 'string' && event.traceId.length > 0)).toBe(true);
    expect(spoken.some((entry) => entry.page === 2 && entry.done)).toBe(true);
  });

  it('关闭自动翻页：讲完本页停在 paused，不越页', async () => {
    const controller = createLectureController({ provider: createMockProvider(), autoAdvance: false });
    controller.open(DECK);
    await controller.play();
    expect(controller.state()).toBe('paused');
    expect(controller.currentPage()).toBe(1);
    expect(controller.script(1)).toContain('[MOCK]');
    expect(controller.script(2)).toBeNull();
  });

  it('暂停：中断流式生成，不缓存半截讲稿，可恢复', async () => {
    const { provider, release } = slowProvider();
    const controller = createLectureController({ provider, autoAdvance: false });
    controller.open(DECK);
    const playing = controller.play();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.pause();
    release();
    await playing;
    expect(controller.state()).toBe('paused');
    expect(controller.script(1)).toBeNull();
    expect(controller.events().some((event) => event.type === 'lecture.paused')).toBe(true);
  });

  it('提问：暂停讲解→基于资料回答→可继续；引用带页锚点', async () => {
    const controller = createLectureController({ provider: createMockProvider() });
    controller.open(DECK);
    const result = await controller.ask('叶绿体');
    expect(result?.notFound).toBe(false);
    expect(result?.answer).toContain('[MOCK]');
    expect(result?.citations[0]?.anchor).toBe('幻灯片 第1页');
    expect(result?.citations[0]?.page).toBe(1);
    expect(controller.state()).toBe('paused');
    expect(controller.events().some((event) => event.type === 'question.asked')).toBe(true);
  });

  it('页导航：goto 夹取范围，next/prev 不越界', () => {
    const controller = createLectureController({ provider: createMockProvider() });
    controller.open(DECK);
    controller.goto(99);
    expect(controller.currentPage()).toBe(2);
    controller.goto(-5);
    expect(controller.currentPage()).toBe(1);
    controller.next();
    expect(controller.currentPage()).toBe(2);
    controller.next();
    expect(controller.currentPage()).toBe(2);
    controller.prev();
    expect(controller.currentPage()).toBe(1);
  });

  it('close 回到 idle 并清空状态', () => {
    const controller = createLectureController({ provider: createMockProvider() });
    controller.open(DECK);
    controller.close();
    expect(controller.state()).toBe('idle');
    expect(controller.deck()).toBeNull();
    expect(controller.material()).toBeNull();
  });
});
