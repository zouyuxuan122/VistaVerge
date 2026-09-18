<script setup lang="ts">
// 真实 3D 笔记本道具：CC-BY 4.0 "MacBook Pro M3 16-inch 2024"（来源与许可见 public/models/PROVENANCE.md）。
// 屏幕朝她——我们只看到盖子背面；屏幕自发光材质随 sceneState 变色（真实屏幕光，非贴图假扮）。
// WebGL 不可用（jsdom/老环境）→ 回退 CSS 版，不假装渲染成功。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { store } from '../app/store';

const MODEL_URL = '/models/macbook-source.glb';

const hostEl = ref<HTMLDivElement | null>(null);
const failed = ref(false);

let renderer: THREE.WebGLRenderer | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let scene: THREE.Scene | null = null;
let draco: DRACOLoader | null = null;
let raf = 0;
let emissiveMats: THREE.MeshStandardMaterial[] = [];
let modelRoot: THREE.Object3D | null = null;
let outlineTargets: THREE.Mesh[] = [];
let outlineShells: THREE.Mesh[] = [];
let outlineMat: THREE.MeshBasicMaterial | null = null;
let deskMat: THREE.MeshStandardMaterial | null = null;
let woodTex: THREE.CanvasTexture | null = null;
let shadowTex: THREE.CanvasTexture | null = null;
// ResizeObserver 必须在 setup 作用域持有：写在 onMounted 的 await 之后再注册
// onBeforeUnmount，此时 Vue 的 currentInstance 已重置，钩子根本不会注册（泄漏）。
let ro: ResizeObserver | null = null;
// PMREM 产出的 render target 需要自己释放：pmrem.dispose() 只释放生成器内部资源。
let envTarget: THREE.WebGLRenderTarget | null = null;
// 卸载标志：GLB 加载可能比组件生命周期长，续体必须知道自己已经卸载。
let unmounted = false;
// WebGL 上下文丢失提示（驱动重置/TDR 后不应静默停更）。
const contextLost = ref(false);

// 程序化木纹（canvas 纹理：暖木底 + 纵向深浅纹）
function makeWoodTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#9a7448';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 46; i++) {
    const x = Math.random() * 256;
    const dark = 60 + ((Math.random() * 40) | 0);
    ctx.strokeStyle = `rgba(${dark}, ${38 + ((Math.random() * 26) | 0)}, 18, ${0.08 + Math.random() * 0.12})`;
    ctx.lineWidth = 1 + Math.random() * 2.4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + 6, 80, x - 6, 170, x + 3, 256);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// 接触软影（径向渐变 blob，让笔记本"落"在台面上）
function makeShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
  g.addColorStop(0, 'rgba(0,0,0,0.42)');
  g.addColorStop(0.62, 'rgba(0,0,0,0.16)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// 漫画主题：给模型套油墨描边壳（反向外扩壳），亮色环境光同步调亮
function setComicMode(on: boolean) {
  if (scene) scene.environmentIntensity = on ? 0.8 : 0.55;
  deskMat?.color.setHex(on ? 0xcaa06a : 0x8a6440);
  const targets = outlineTargets.filter((m) => m.parent || outlineShells.length > 0);
  if (on && outlineShells.length === 0) {
    const mat = outlineMat ?? (outlineMat = new THREE.MeshBasicMaterial({ color: 0x2b2622, side: THREE.BackSide }));
    for (const mesh of targets) {
      const shell = new THREE.Mesh(mesh.geometry, mat);
      shell.scale.setScalar(1.018);
      shell.renderOrder = -1;
      shell.userData.isOutline = true;
      mesh.add(shell);
      outlineShells.push(shell);
    }
  } else if (!on && outlineShells.length > 0) {
    for (const s of outlineShells) s.removeFromParent();
    outlineShells = [];
  }
}

// 与 CSS 道具同一套状态色（写实紫/青/琥珀；手绘主题暖色由全局滤镜难以覆盖 3D，保持同色系即可）
const STATE_GLOW: Record<string, { color: number; intensity: number }> = {
  idle: { color: 0x8b7dff, intensity: 0.85 },
  listening: { color: 0x22d3ee, intensity: 1.25 },
  working: { color: 0xf59e0b, intensity: 1.7 },
  speaking: { color: 0x8b7dff, intensity: 1.5 },
};

function applyGlow(state: string) {
  const glow = STATE_GLOW[state] ?? STATE_GLOW.idle;
  for (const m of emissiveMats) {
    m.emissive.setHex(glow.color);
    m.emissiveIntensity = glow.intensity;
  }
}

function disposeModel(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      std.map?.dispose();
      std.emissiveMap?.dispose();
      std.normalMap?.dispose();
      std.roughnessMap?.dispose();
      std.metalnessMap?.dispose();
      m.dispose();
    }
  });
}

onMounted(async () => {
  unmounted = false;
  try {
    if (!hostEl.value) return;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      contextLost.value = true;
    });
    renderer.domElement.addEventListener('webglcontextrestored', () => {
      contextLost.value = false;
    });
    hostEl.value.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.55; // 压暗环境反射，亮银铝壳沉成深空灰
    pmrem.dispose();

    camera = new THREE.PerspectiveCamera(24, 1, 0.01, 20);
    camera.position.set(0, 0.46, 2.6); // 长焦拉远：盖子不变形、整机与桌子完整入画不切边
    camera.lookAt(0, 0.3, 0);

    const key = new THREE.DirectionalLight(0xfff2e0, 1.1);
    key.position.set(0.8, 1.6, 0.9);
    scene.add(key);

    draco = new DRACOLoader().setDecoderPath('/draco/');
    const loader = new GLTFLoader().setDRACOLoader(draco);
    const gltf = await loader.loadAsync(MODEL_URL);
    const model = gltf.scene;

    // 卸载早于加载完成：释放刚加载的模型并退出，绝不触碰已置空的 scene。
    if (unmounted) {
      disposeModel(model);
      return;
    }
    if (!scene) {
      disposeModel(model);
      return;
    }

    // 归一化：宽=1，底部落在 y=0，中心对齐
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    model.scale.setScalar(1 / size.x);
    const box2 = new THREE.Box3().setFromObject(model);
    model.position.set(-(box2.min.x + box2.max.x) / 2, -box2.min.y, -(box2.min.z + box2.max.z) / 2);
    // 屏幕朝她：盖子背面转向相机（模型原始朝向以 GUI 截图校准）
    model.rotation.y = Math.PI;
    scene.add(model);
    modelRoot = model;

    // 实体桌子：PBR 木纹台面接住笔记本（真几何，非贴图）+ 接触软影
    woodTex = makeWoodTexture();
    deskMat = new THREE.MeshStandardMaterial({ map: woodTex, color: 0x8a6440, roughness: 0.72, metalness: 0 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.05, 1.35), deskMat);
    desk.position.set(0, -0.026, 0.3); // 台面顶面 y=0 = 笔记本底面，前沿探出到镜头前
    scene.add(desk);
    shadowTex = makeShadowTexture();
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1.35, 0.9),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(0, 0.0015, 0.05);
    scene.add(blob);

    // 描边壳目标：笔记本全部网格 + 桌面（软影不描）
    const targets: THREE.Mesh[] = [desk];
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && !mesh.userData.isOutline) targets.push(mesh);
    });
    outlineTargets = targets;

    // 收集屏幕自发光材质（有 emissiveMap 或自发光色非黑；
    // 不能用 emissiveIntensity>0 判断——three 默认值是 1，会把所有材质都染色）。
    // 非发光浅色铝壳统一压暗成深空灰（对模型的再着色属 CC-BY 允许的修改）。
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial;
        if (!std.isMeshStandardMaterial) continue;
        if (std.emissiveMap || std.emissive.getHex() > 0) {
          emissiveMats.push(std);
          continue;
        }
        const hsl = { h: 0, s: 0, l: 0 };
        std.color.getHSL(hsl);
        if (hsl.l > 0.45) std.color.multiplyScalar(0.42);
        std.roughness = Math.min(1, std.roughness + 0.15);
      }
    });
    applyGlow(store.sceneState);
    setComicMode(store.theme === 'handdrawn');

    const resize = () => {
      if (!hostEl.value || !renderer || !camera) return;
      const w = hostEl.value.clientWidth || 1;
      const h = hostEl.value.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    ro = new ResizeObserver(resize);
    ro.observe(hostEl.value);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden || !renderer || !scene || !camera) return;
      renderer.render(scene, camera);
    };
    tick();
  } catch {
    if (!unmounted) failed.value = true;
  }
});

watch(() => store.sceneState, (s) => applyGlow(s));
watch(() => store.theme, (t) => setComicMode(t === 'handdrawn'));

onBeforeUnmount(() => {
  unmounted = true;
  cancelAnimationFrame(raf);
  ro?.disconnect();
  ro = null;
  for (const s of outlineShells) s.removeFromParent();
  outlineShells = [];
  outlineMat?.dispose();
  outlineMat = null;
  modelRoot = null;
  if (scene) disposeModel(scene);
  envTarget?.dispose();
  envTarget = null;
  draco?.dispose();
  draco = null;
  renderer?.dispose();
  renderer?.domElement.remove();
  renderer = null;
  scene = null;
  camera = null;
  emissiveMats = [];
  outlineTargets = [];
});
</script>

<template>
  <div class="laptop-gl-wrap">
    <div v-if="!failed" ref="hostEl" class="laptop-gl" />
    <!-- CSS 回退（无 WebGL）：盖子背面对我们 + Logo 灯，与 3D 版同一朝向语义 -->
    <div v-else class="laptop-css">
      <div class="css-leak" />
      <div class="css-lid"><div class="css-logo"><i /></div></div>
      <div class="css-lip" />
    </div>
    <span v-if="contextLost" class="laptop-gl-notice">3D 渲染上下文丢失，已停更画面（切换主题或重开应用可恢复）</span>
  </div>
</template>

<style scoped>
.laptop-gl-wrap { position: absolute; inset: 0; pointer-events: none; }
.laptop-gl { position: absolute; inset: 0; }
.laptop-gl :deep(canvas) { width: 100% !important; height: 100% !important; display: block; }
.laptop-gl-notice {
  position: absolute; left: 50%; top: 8px; transform: translateX(-50%);
  max-width: 90%; text-align: center;
  font-size: 10px; line-height: 1.5; color: var(--err);
}

/* ── CSS 回退（无 WebGL 环境，如 jsdom 单测） ── */
.laptop-css { position: absolute; inset: 0; }
.css-lid {
  position: absolute; left: 10%; right: 10%; top: 0; height: 94%;
  transform: rotateX(-7deg); transform-origin: bottom center;
  background:
    radial-gradient(90% 70% at 50% 0%, rgba(255, 255, 255, 0.05), transparent 55%),
    linear-gradient(160deg, #26262c, #121215 68%);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-bottom: 0;
  border-radius: 12px 12px 0 0;
}
.css-logo {
  position: absolute; left: 50%; top: 46%; width: 15%; aspect-ratio: 1;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, color-mix(in srgb, var(--logo) 85%, white), var(--logo) 62%);
  box-shadow: 0 0 18px color-mix(in srgb, var(--logo) 65%, transparent), 0 0 46px color-mix(in srgb, var(--logo) 30%, transparent);
}
.css-logo i {
  position: absolute; left: 26%; top: 20%; width: 30%; height: 22%;
  border-radius: 50%; background: rgba(255, 255, 255, 0.5); filter: blur(2px);
}
.css-leak {
  position: absolute; left: 14%; right: 14%; top: -3%; height: 22%;
  background: radial-gradient(50% 100% at 50% 100%, color-mix(in srgb, var(--logo) 22%, transparent), transparent 78%);
  filter: blur(6px);
}
.css-lip {
  position: absolute; left: 7.5%; right: 7.5%; bottom: 0; height: 4.5%;
  background: linear-gradient(180deg, #1a1a1e, #0c0c0f);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-top-color: rgba(0, 0, 0, 0.6);
  border-radius: 2px 2px 9px 9px;
}
</style>
