// teacher-annotation.test.ts — 批注数据结构按页存取（撤销/清空/快照）。
import { describe, expect, it } from 'vitest';
import { createAnnotationStore } from '../../src/teacher/annotation';

const stroke = (x: number, y: number) => ({
  tool: 'pen' as const,
  color: '#e8543f',
  width: 4,
  points: [
    { x, y },
    { x: x + 10, y: y + 10 },
  ],
});

describe('批注按页存取', () => {
  it('按页隔离：第 1 页与第 2 页互不影响', () => {
    const store = createAnnotationStore();
    store.addStroke(1, stroke(0, 0));
    store.addStroke(2, stroke(100, 100));
    store.addStroke(2, stroke(120, 120));
    expect(store.strokes(1)).toHaveLength(1);
    expect(store.strokes(2)).toHaveLength(2);
    expect(store.pages()).toEqual([1, 2]);
    expect(store.strokeCount()).toBe(3);
  });

  it('点数 < 2 的点按不记为笔迹', () => {
    const store = createAnnotationStore();
    expect(store.addStroke(1, { tool: 'pen', color: '#000', width: 2, points: [{ x: 1, y: 1 }] })).toBeNull();
    expect(store.hasStrokes(1)).toBe(false);
  });

  it('撤销只影响当前页，可连续撤销到空', () => {
    const store = createAnnotationStore();
    store.addStroke(1, stroke(0, 0));
    store.addStroke(1, stroke(5, 5));
    store.addStroke(2, stroke(9, 9));
    expect(store.undo(1)).toBe(true);
    expect(store.strokes(1)).toHaveLength(1);
    expect(store.strokes(2)).toHaveLength(1);
    expect(store.undo(1)).toBe(true);
    expect(store.undo(1)).toBe(false);
    expect(store.hasStrokes(1)).toBe(false);
  });

  it('清空单页与清空全部', () => {
    const store = createAnnotationStore();
    store.addStroke(1, stroke(0, 0));
    store.addStroke(2, stroke(1, 1));
    store.clear(1);
    expect(store.hasStrokes(1)).toBe(false);
    expect(store.hasStrokes(2)).toBe(true);
    store.clearAll();
    expect(store.strokeCount()).toBe(0);
  });

  it('snapshot 为深拷贝，外部修改不影响内部', () => {
    const store = createAnnotationStore();
    store.addStroke(1, stroke(0, 0));
    const snapshot = store.snapshot();
    snapshot[1]![0]!.points[0]!.x = 999;
    expect(store.strokes(1)[0]!.points[0]!.x).toBe(0);
  });

  it('橡皮笔迹按工具类型保存，供重放', () => {
    const store = createAnnotationStore();
    store.addStroke(1, { tool: 'eraser', color: '#000', width: 8, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });
    expect(store.strokes(1)[0]!.tool).toBe('eraser');
  });
});
