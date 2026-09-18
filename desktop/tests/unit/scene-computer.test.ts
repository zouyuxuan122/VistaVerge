// EXP-004 logic-layer tests for the computer set (desktop/src/scene/computer.ts).
//
// No GPU and no renderer is instantiated here: we only construct scene-graph
// objects in Node (vitest environment 'node'). The screen canvas is a recording
// stub implementing the same 2D-context surface as the DOM canvas so the tests
// can assert what the status writer draws without a DOM. Rendering correctness
// itself is accepted later by EXP-007 GUI screenshots.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { buildComputerScene } from '../../src/scene/computer';
import type { ScreenCanvasLike, ScreenContext2DLike } from '../../src/scene/screen';

// ── Recording canvas stub ────────────────────────────────────────────────────

function makeRecordingCanvas(width = 1024, height = 576) {
  const texts: string[] = [];
  const fills: { style: string; x: number; y: number }[] = [];
  const ctx: ScreenContext2DLike = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '',
    globalAlpha: 1,
    textAlign: 'left',
    fillRect(x, y) {
      fills.push({ style: String(this.fillStyle), x, y });
    },
    clearRect() {},
    strokeRect() {},
    fillText(text) {
      texts.push(text);
    },
    save() {},
    restore() {},
  };
  const canvas: ScreenCanvasLike = { width, height, getContext: () => ctx };
  return { canvas, ctx, texts, fills };
}

function findMesh(root: THREE.Object3D, name: string): THREE.Mesh {
  const found = root.getObjectByName(name);
  expect(found, `expected an object named "${name}" in the computer group`).toBeTruthy();
  return found as THREE.Mesh;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildComputerScene (logic layer, no GPU)', () => {
  it('exposes a 16:9 emissive screen mesh', () => {
    const computer = buildComputerScene();

    const ratio = computer.dimensions.screen.width / computer.dimensions.screen.height;
    expect(Math.abs(ratio - 16 / 9)).toBeLessThan(0.02);

    const screen = findMesh(computer.group, 'screen');
    expect(screen.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    const material = screen.material as THREE.MeshBasicMaterial;
    expect(material.map).toBe(computer.screen.texture);
  });

  it('builds the keycap array as one InstancedMesh with at least 60 keys', () => {
    const computer = buildComputerScene();

    const keycaps = computer.group.getObjectByName('keycaps');
    expect(keycaps).toBeInstanceOf(THREE.InstancedMesh);
    const instanced = keycaps as THREE.InstancedMesh;
    expect(computer.keycapCount).toBeGreaterThanOrEqual(60);
    expect(instanced.count).toBe(computer.keycapCount);
    expect(instanced.instanceMatrix).toBeInstanceOf(THREE.InstancedBufferAttribute);
  });

  it('binds the provided canvas as a CanvasTexture and redraws on writeStatus', () => {
    const { canvas, texts } = makeRecordingCanvas();
    const computer = buildComputerScene({ screenCanvas: canvas });
    const versionBefore = computer.screen.texture.version;

    expect(computer.screen.texture.isCanvasTexture).toBe(true);
    expect(computer.screen.texture.image).toBe(canvas);

    computer.writeScreenStatus({ state: 'AI 工作中', task: '整理会议纪要' });
    expect(texts.some((text) => text.includes('AI 工作中'))).toBe(true);
    expect(texts.some((text) => text.includes('整理会议纪要'))).toBe(true);
    // three r186: Texture.needsUpdate is write-only (it bumps `version`).
    expect(computer.screen.texture.version).toBeGreaterThan(versionBefore);
  });

  it('accepts status writes on the default headless canvas without a DOM', () => {
    const computer = buildComputerScene();

    expect(() =>
      computer.writeScreenStatus({ state: '空闲', task: '等待指令', lines: ['会话保持中'] }),
    ).not.toThrow();
    expect(computer.screen.lastStatus?.state).toBe('空闲');
    expect(computer.screen.lastStatus?.task).toBe('等待指令');
  });

  it('builds a rounded wood desk', () => {
    const computer = buildComputerScene();

    const desk = findMesh(computer.group, 'desk');
    const material = desk.material as THREE.MeshStandardMaterial;
    expect(material.color.getHexString()).toBe('8a6142');
    const radius = (desk.geometry as unknown as { parameters?: { radius?: number } }).parameters
      ?.radius;
    expect(radius).toBeGreaterThan(0);
    expect(computer.dimensions.desk.height).toBeGreaterThan(0);
  });

  it('routes at least two cables as CatmullRom curves with >= 4 control points', () => {
    const computer = buildComputerScene();

    expect(computer.cableCurves.length).toBeGreaterThanOrEqual(2);
    for (const curve of computer.cableCurves) {
      expect(curve).toBeInstanceOf(THREE.CatmullRomCurve3);
      expect(curve.points.length).toBeGreaterThanOrEqual(4);
    }
    const firstCable = computer.group.getObjectByName('cable-0');
    expect(firstCable).toBeTruthy();
  });

  it('adds alpha-gradient contact shadows under monitor, keyboard and mouse', () => {
    const computer = buildComputerScene();

    expect(computer.contactShadows.length).toBeGreaterThanOrEqual(3);
    for (const shadow of computer.contactShadows) {
      const material = shadow.material as THREE.MeshBasicMaterial;
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
      const texture = material.map as THREE.DataTexture;
      expect(texture).toBeInstanceOf(THREE.DataTexture);
      const data = texture.image.data as Uint8Array;
      const size = texture.image.width;
      const center = data[((size / 2) * size + size / 2) * 4 + 3];
      const corner = data[3];
      expect(center).toBeGreaterThan(100);
      expect(corner).toBe(0);
    }
  });

  it('includes the mouse and the monitor stand', () => {
    const computer = buildComputerScene();

    findMesh(computer.group, 'mouse');
    const stand = computer.group.getObjectByName('monitor-stand');
    expect(stand).toBeTruthy();
  });

  it('dispose() disposes geometries/materials/textures exactly once and is idempotent', () => {
    const { canvas } = makeRecordingCanvas();
    const computer = buildComputerScene({ screenCanvas: canvas });

    const keycaps = computer.group.getObjectByName('keycaps') as THREE.InstancedMesh;
    let geometryDisposes = 0;
    keycaps.geometry.addEventListener('dispose', () => {
      geometryDisposes += 1;
    });
    let materialDisposes = 0;
    const keycapMaterial = keycaps.material as THREE.Material;
    keycapMaterial.addEventListener('dispose', () => {
      materialDisposes += 1;
    });
    let textureDisposes = 0;
    computer.screen.texture.addEventListener('dispose', () => {
      textureDisposes += 1;
    });

    computer.dispose();
    computer.dispose();

    expect(geometryDisposes).toBe(1);
    expect(materialDisposes).toBe(1);
    expect(textureDisposes).toBe(1);
  });
});
