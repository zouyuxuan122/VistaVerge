// Emissive monitor screen backed by a 2D canvas texture (EXP-004, UI_UX_AVATAR
// §1.3: the screen shows the AI workspace state; EXP-005 writes task status).
//
// The canvas is abstracted behind ScreenCanvasLike so the scene is constructible
// in Node without a DOM: production passes a real <canvas>, tests pass a
// recording stub, and the default headless path uses a no-op canvas whose last
// written status is still observable for assertions.
import * as THREE from 'three';

import { disposeOnce } from './dispose';

/** The subset of CanvasRenderingContext2D the status writer uses. */
export interface ScreenContext2DLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  globalAlpha: number;
  textAlign: CanvasTextAlign;
  fillRect(x: number, y: number, w?: number, h?: number): void;
  clearRect(x: number, y: number, w?: number, h?: number): void;
  strokeRect(x: number, y: number, w?: number, h?: number): void;
  fillText(text: string, x: number, y?: number): void;
  save(): void;
  restore(): void;
}

export interface ScreenCanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): ScreenContext2DLike | null;
}

export interface ScreenStatus {
  /** Top-line state label, e.g. "AI 工作中" / "空闲" / "倾听中". */
  state: string;
  /** Current task headline written below the state. */
  task?: string;
  /** Extra detail lines (task steps, timer, etc.). */
  lines?: string[];
  /** Accent color for the status bar; defaults to the VistaVerge green. */
  accent?: string;
}

const FONT_UI = '"Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif';

class NoopScreenContext implements ScreenContext2DLike {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000000';
  font = '';
  globalAlpha = 1;
  textAlign: CanvasTextAlign = 'left';
  fillRect(): void {}
  clearRect(): void {}
  strokeRect(): void {}
  fillText(): void {}
  save(): void {}
  restore(): void {}
}

class NoopScreenCanvas implements ScreenCanvasLike {
  width: number;
  height: number;
  private readonly ctx = new NoopScreenContext();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(contextId: '2d'): ScreenContext2DLike | null {
    return contextId === '2d' ? this.ctx : null;
  }
}

/**
 * Create the backing canvas for the screen. Prefers the DOM canvas; when no
 * document exists (Node tests, headless construction) returns a no-op canvas.
 */
export function createScreenCanvas(width: number, height: number): ScreenCanvasLike {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return new NoopScreenCanvas(width, height);
}

/**
 * The glowing monitor surface. Draw calls land on the backing canvas and flag
 * the CanvasTexture for re-upload on the next frame.
 */
export class ScreenSurface {
  readonly canvas: ScreenCanvasLike;
  readonly ctx: ScreenContext2DLike;
  readonly texture: THREE.CanvasTexture<ScreenCanvasLike>;
  private status: ScreenStatus | null = null;
  private textureDisposed = false;

  constructor(canvas?: ScreenCanvasLike, width = 1024, height = 576) {
    this.canvas = canvas ?? createScreenCanvas(width, height);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('[scene] screen canvas did not provide a 2d context');
    }
    this.ctx = ctx;
    // CanvasTexture is generic over its canvas type in three 0.186 typings;
    // instantiate with our canvas contract instead of casting.
    this.texture = new THREE.CanvasTexture<ScreenCanvasLike>(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.clear();
  }

  /** Last status written, regardless of whether the canvas could actually draw. */
  get lastStatus(): ScreenStatus | null {
    return this.status;
  }

  clear(color = '#0b0f14'): void {
    const { canvas, ctx } = this;
    ctx.save();
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    this.texture.needsUpdate = true;
  }

  /** Redraw the whole screen with the given AI workspace state. */
  writeStatus(status: ScreenStatus): void {
    const { canvas, ctx } = this;
    const w = canvas.width;
    const h = canvas.height;
    const accent = status.accent ?? '#4de3a2';

    ctx.save();
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, w, h);

    // Accent status bar.
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, w, Math.max(4, h * 0.012));

    // State headline.
    ctx.fillStyle = '#e6edf3';
    ctx.font = `600 ${Math.round(h * 0.11)}px ${FONT_UI}`;
    ctx.fillText(status.state, Math.round(w * 0.05), Math.round(h * 0.27));

    // Task headline + detail lines.
    let baseline = Math.round(h * 0.44);
    if (status.task) {
      ctx.fillStyle = '#9fb3c8';
      ctx.font = `400 ${Math.round(h * 0.075)}px ${FONT_UI}`;
      ctx.fillText(status.task, Math.round(w * 0.05), baseline);
      baseline += Math.round(h * 0.11);
    }
    if (status.lines?.length) {
      ctx.fillStyle = '#6e7f91';
      ctx.font = `400 ${Math.round(h * 0.06)}px ${FONT_UI}`;
      for (const line of status.lines) {
        ctx.fillText(line, Math.round(w * 0.05), baseline);
        baseline += Math.round(h * 0.09);
      }
    }
    ctx.restore();

    this.texture.needsUpdate = true;
    this.status = { ...status, lines: status.lines ? [...status.lines] : undefined };
  }

  /** Idempotent: shares the scene-wide once-guard with deep material disposal. */
  dispose(): void {
    if (this.textureDisposed) return;
    this.textureDisposed = true;
    disposeOnce(this.texture);
  }
}
