/**
 * teacher/annotation.ts — PPT 批注数据（按页存取，内存态）。
 *
 * 规划.txt：「在 PPT 上做标注」；TEACHER_COMPANION §1.1(1) 页码/锚点。
 * 纯数据结构 + 纯函数，不触碰 canvas/DOM，便于 node 单测；UI 层只负责把
 * 指针事件转成点序列并绘制。笔迹按页保存，撤销/清空均按页操作。
 */

import { newId } from '../data/util';

export interface AnnotationPoint {
  x: number;
  y: number;
}

export type AnnotationTool = 'pen' | 'eraser';

export interface Stroke {
  id: string;
  tool: AnnotationTool;
  /** CSS 颜色（pen 使用；eraser 忽略）。 */
  color: string;
  /** CSS 像素线宽。 */
  width: number;
  points: AnnotationPoint[];
}

export interface AnnotationStore {
  /** 该页笔迹（含橡皮擦除轨迹，供重放）。 */
  strokes(page: number): Stroke[];
  /** 追加一条完整笔迹；点数 < 2 时返回 null（点按不算笔画）。 */
  addStroke(page: number, stroke: Omit<Stroke, 'id'>): Stroke | null;
  /** 撤销该页最后一笔，返回是否撤销成功。 */
  undo(page: number): boolean;
  /** 清空该页。 */
  clear(page: number): void;
  /** 清空全部页。 */
  clearAll(): void;
  /** 已有笔迹的页号（升序）。 */
  pages(): number[];
  /** 深拷贝快照（复盘/导出用）。 */
  snapshot(): Record<number, Stroke[]>;
  /** 该页是否有笔迹。 */
  hasStrokes(page: number): boolean;
  /** 笔迹总数（跨页）。 */
  strokeCount(): number;
}

function cloneStroke(stroke: Stroke): Stroke {
  return { ...stroke, points: stroke.points.map((point) => ({ ...point })) };
}

export function createAnnotationStore(): AnnotationStore {
  const pages = new Map<number, Stroke[]>();

  function list(page: number): Stroke[] {
    return pages.get(page) ?? [];
  }

  return {
    strokes(page) {
      return list(page).map(cloneStroke);
    },
    addStroke(page, input) {
      if (!Number.isFinite(page) || input.points.length < 2) return null;
      const stroke: Stroke = {
        id: newId(),
        tool: input.tool,
        color: input.color,
        width: input.width,
        points: input.points.map((point) => ({ x: point.x, y: point.y })),
      };
      pages.set(page, [...list(page), stroke]);
      return cloneStroke(stroke);
    },
    undo(page) {
      const current = list(page);
      if (current.length === 0) return false;
      const next = current.slice(0, -1);
      if (next.length === 0) pages.delete(page);
      else pages.set(page, next);
      return true;
    },
    clear(page) {
      pages.delete(page);
    },
    clearAll() {
      pages.clear();
    },
    pages() {
      return [...pages.keys()].sort((a, b) => a - b);
    },
    snapshot() {
      const out: Record<number, Stroke[]> = {};
      for (const page of pages.keys()) out[page] = list(page).map(cloneStroke);
      return out;
    },
    hasStrokes(page) {
      return list(page).length > 0;
    },
    strokeCount() {
      let total = 0;
      for (const strokes of pages.values()) total += strokes.length;
      return total;
    },
  };
}
