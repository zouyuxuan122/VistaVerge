<script setup lang="ts">
// ui/teacher/LectureView.vue — PPT 讲课视图（规划.txt：打开 PPT 讲课、标注、
// 放大镜、激光笔）。数据/状态机在 teacher/lecture.ts；本组件只做渲染与交互。
//
// 能力：打开 .pptx（文件选择 + 拖放）→ 幻灯片主区（按比例缩放，文本框绝对定位 +
// 图片）+ 缩略图侧栏；工具栏：批注（canvas 覆盖层，画笔颜色/粗细/橡皮/撤销/清空，
// 笔迹按页存内存）、放大镜（圆形透镜跟随指针，2x/3x/4x）、激光笔、页导航、讲稿
// 字幕区（流式 + 引用页码）、播放/暂停/提问。样式全部 scoped + 主题变量。
import { computed, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import type { LectureController } from '../../teacher/lecture';
import { parsePptx, revokeDeckUrls, type SlideDeck } from '../../teacher/pptx';
import { createAnnotationStore, type AnnotationTool, type Stroke } from '../../teacher/annotation';
import SlideSurface from './SlideSurface.vue';

const props = defineProps<{ controller: LectureController }>();
const emit = defineEmits<{ (event: 'deck-opened', deck: SlideDeck): void }>();

const tick = ref(0);
const unsubscribe = props.controller.subscribe(() => {
  tick.value += 1;
});

const state = computed(() => {
  void tick.value;
  return props.controller.state();
});
const currentPage = computed(() => {
  void tick.value;
  return props.controller.currentPage();
});
const deck = computed(() => {
  void tick.value;
  return props.controller.deck();
});
const pageCount = computed(() => {
  void tick.value;
  return props.controller.pageCount();
});
const partial = computed(() => {
  void tick.value;
  return props.controller.partial();
});
const scriptText = computed(() => {
  void tick.value;
  return props.controller.script(currentPage.value) ?? '';
});
const lastError = computed(() => {
  void tick.value;
  return props.controller.lastError();
});

const errorMessage = ref<string | null>(null);
const dragActive = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const stageWrap = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const scale = ref(1);

const annotation = createAnnotationStore();
const mode = ref<'none' | AnnotationTool>('none');
const penColor = ref('#e8543f');
const penWidth = ref(4);
const palette = ['#e8543f', '#8ea2ff', '#2e9e6b', '#f59e0b', '#2b2622'];
let drawing: Stroke | null = null;

const magnifierOn = ref(false);
const magnifierZoom = ref(2);
const laserOn = ref(false);
const pointer = ref({ x: 0, y: 0 });
const pointerInside = ref(false);
const laserTrail = ref<{ x: number; y: number }[]>([]);

const question = ref('');
const answer = ref('');
const citations = ref<{ anchor: string; quote: string; page?: number }[]>([]);
const asking = ref(false);
const pageInput = ref('1');

const LENS_SIZE = 170;

const slide = computed(() => deck.value?.slides[currentPage.value - 1] ?? null);
const widthPx = computed(() => deck.value?.widthPx ?? 960);
const heightPx = computed(() => deck.value?.heightPx ?? 540);

const stateLabel = computed(() => {
  const map: Record<string, string> = {
    idle: '未打开',
    selecting: '选页中',
    playing: '播放中',
    paused: '已暂停',
    asking: '提问中',
    finished: '已讲完',
  };
  return map[state.value] ?? state.value;
});

/* ---------------- 缩放 ---------------- */
function updateScale(): void {
  const wrap = stageWrap.value;
  if (!wrap || widthPx.value <= 0) return;
  const available = wrap.clientWidth - 8;
  scale.value = available > 0 ? Math.min(1.6, available / widthPx.value) : 1;
}

let resizeObserver: ResizeObserver | null = null;
watch(
  () => stageWrap.value,
  (wrap) => {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (wrap && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateScale());
      resizeObserver.observe(wrap);
    }
    updateScale();
  },
  { immediate: true },
);
watch([widthPx, pageCount], () => nextTick(updateScale));

/* ---------------- 打开 PPT ---------------- */
async function openBytes(name: string, bytes: Uint8Array): Promise<void> {
  errorMessage.value = null;
  try {
    const parsed = parsePptx({ name, bytes });
    const previous = deck.value;
    if (previous && previous !== parsed) revokeDeckUrls(previous);
    props.controller.open(parsed);
    emit('deck-opened', parsed);
    mode.value = 'none';
    answer.value = '';
    citations.value = [];
    annotation.clearAll();
    await nextTick();
    updateScale();
    redraw();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openBytes(file.name, bytes);
  input.value = '';
}

async function onDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  dragActive.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openBytes(file.name, bytes);
}

/* ---------------- 批注 ---------------- */
function canvasPoint(event: PointerEvent): { x: number; y: number } {
  const canvas = canvasRef.value;
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width > 0 ? widthPx.value / rect.width : 1;
  const sy = rect.height > 0 ? heightPx.value / rect.height : 1;
  return { x: (event.clientX - rect.left) * sx, y: (event.clientY - rect.top) * sy };
}

function onPointerDown(event: PointerEvent): void {
  if (mode.value === 'none') return;
  const point = canvasPoint(event);
  drawing = { id: 'draft', tool: mode.value, color: penColor.value, width: penWidth.value, points: [point] };
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  const point = canvasPoint(event);
  pointer.value = point;
  pointerInside.value = true;
  if (laserOn.value) {
    laserTrail.value = [...laserTrail.value.slice(-6), point];
  }
  if (drawing) {
    drawing.points.push(point);
    redraw();
  }
}

function onPointerUp(): void {
  if (!drawing) return;
  const draft = drawing;
  drawing = null;
  if (draft.points.length >= 2) {
    annotation.addStroke(currentPage.value, {
      tool: draft.tool,
      color: draft.color,
      width: draft.width,
      points: draft.points,
    });
  }
  redraw();
}

function redraw(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = [...annotation.strokes(currentPage.value)];
  if (drawing) strokes.push(drawing);
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.tool === 'eraser' ? stroke.width * 4 : stroke.width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(stroke.points[0]!.x, stroke.points[0]!.y);
    for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function undo(): void {
  annotation.undo(currentPage.value);
  redraw();
}
function clearPage(): void {
  annotation.clear(currentPage.value);
  redraw();
}

watch(currentPage, () => {
  drawing = null;
  laserTrail.value = [];
  redraw();
});

/* ---------------- 讲稿/提问 ---------------- */
async function togglePlay(): Promise<void> {
  if (state.value === 'playing') {
    props.controller.pause();
    return;
  }
  await props.controller.play();
}

async function askQuestion(): Promise<void> {
  const text = question.value.trim();
  if (text.length === 0 || asking.value) return;
  asking.value = true;
  try {
    const result = await props.controller.ask(text);
    answer.value = result?.answer ?? '（提问失败）';
    citations.value = (result?.citations ?? []).map((citation) => ({
      anchor: citation.anchor,
      quote: citation.quote,
      page: citation.page,
    }));
  } finally {
    asking.value = false;
  }
}

function gotoPage(): void {
  const page = Number.parseInt(pageInput.value, 10);
  if (Number.isFinite(page)) props.controller.goto(page);
}
watch(currentPage, (page) => {
  pageInput.value = String(page);
});

function jumpToCitation(page?: number): void {
  if (page !== undefined) props.controller.goto(page);
}

onBeforeUnmount(() => {
  unsubscribe();
  resizeObserver?.disconnect();
  const current = deck.value;
  if (current) revokeDeckUrls(current);
});
</script>

<template>
  <section
    class="lecture-view"
    data-test="lecture-view"
    @dragover.prevent="dragActive = true"
    @dragleave="dragActive = false"
    @drop="onDrop"
  >
    <header class="lecture-bar">
      <input
        ref="fileInput"
        data-test="lecture-file"
        class="lecture-file"
        type="file"
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        @change="onFileChange"
      />
      <button data-test="lecture-open" class="lecture-btn" @click="fileInput?.click()">打开 .pptx</button>
      <span class="lecture-state" data-test="lecture-state">{{ stateLabel }}</span>
      <button data-test="lecture-play" class="lecture-btn primary" @click="togglePlay">
        {{ state === 'playing' ? '暂停' : '播放' }}
      </button>
      <button data-test="lecture-prev" class="lecture-btn" @click="props.controller.prev()">上一页</button>
      <input v-model="pageInput" data-test="lecture-page-input" class="lecture-page-input" @keyup.enter="gotoPage" />
      <span class="lecture-page-total">/ {{ pageCount }}</span>
      <button data-test="lecture-next" class="lecture-btn" @click="props.controller.next()">下一页</button>
      <label class="lecture-check">
        <input
          type="checkbox"
          :checked="props.controller.autoAdvance()"
          @change="props.controller.setAutoAdvance(($event.target as HTMLInputElement).checked)"
        />
        自动翻页
      </label>
    </header>

    <p v-if="errorMessage" class="lecture-error" data-test="lecture-error">{{ errorMessage }}</p>
    <p v-else-if="lastError" class="lecture-error">{{ lastError }}</p>
    <p v-if="!deck" class="lecture-hint">
      打开或拖入一个 .pptx 文件即可开始讲课（旧版 .ppt 请先另存为 .pptx）。
    </p>

    <div v-if="deck" class="lecture-body">
      <aside class="lecture-thumbs" data-test="lecture-thumbs">
        <button
          v-for="item in deck.slides"
          :key="item.index"
          class="lecture-thumb"
          :class="{ active: item.index === currentPage }"
          :data-test="`lecture-thumb-${item.index}`"
          @click="props.controller.goto(item.index)"
        >{{ item.index }}</button>
      </aside>

      <div class="lecture-main">
        <div ref="stageWrap" class="lecture-stage-wrap">
          <div
            class="lecture-stage"
            data-test="lecture-stage"
            :style="{
              width: `${widthPx}px`,
              height: `${heightPx}px`,
              transform: `scale(${scale})`,
            }"
            @pointermove="onPointerMove"
            @pointerleave="pointerInside = false; laserTrail = []"
          >
            <SlideSurface :slide="slide" :width-px="widthPx" :height-px="heightPx" />
            <canvas
              ref="canvasRef"
              class="lecture-canvas"
              :width="widthPx"
              :height="heightPx"
              :style="{ pointerEvents: mode === 'none' ? 'none' : 'auto' }"
              @pointerdown="onPointerDown"
              @pointermove="onPointerMove"
              @pointerup="onPointerUp"
              @pointerleave="onPointerUp"
            />
            <div
              v-if="magnifierOn && pointerInside"
              class="lecture-lens"
              :style="{
                left: `${pointer.x * scale}px`,
                top: `${pointer.y * scale}px`,
                width: `${LENS_SIZE}px`,
                height: `${LENS_SIZE}px`,
              }"
            >
              <div
                class="lecture-lens-inner"
                :style="{
                  transform: `translate(${LENS_SIZE / 2 - pointer.x * magnifierZoom}px, ${
                    LENS_SIZE / 2 - pointer.y * magnifierZoom
                  }px) scale(${magnifierZoom})`,
                }"
              >
                <SlideSurface :slide="slide" :width-px="widthPx" :height-px="heightPx" />
              </div>
            </div>
            <div
              v-if="laserOn && pointerInside"
              class="lecture-laser"
              :style="{ left: `${pointer.x * scale}px`, top: `${pointer.y * scale}px` }"
            />
          </div>
        </div>

        <div class="lecture-toolbar">
          <div class="lecture-tool-group">
            <span class="lecture-tool-label">批注</span>
            <button
              class="lecture-btn"
              :class="{ active: mode === 'pen' }"
              data-test="lecture-pen"
              @click="mode = mode === 'pen' ? 'none' : 'pen'"
            >画笔</button>
            <button
              class="lecture-btn"
              :class="{ active: mode === 'eraser' }"
              data-test="lecture-eraser"
              @click="mode = mode === 'eraser' ? 'none' : 'eraser'"
            >橡皮</button>
            <button class="lecture-btn" data-test="lecture-undo" @click="undo">撤销</button>
            <button class="lecture-btn" data-test="lecture-clear" @click="clearPage">清空</button>
            <button
              v-for="color in palette"
              :key="color"
              class="lecture-swatch"
              :class="{ active: penColor === color }"
              :style="{ background: color }"
              :aria-label="`画笔颜色 ${color}`"
              @click="penColor = color"
            />
            <input v-model.number="penWidth" class="lecture-width" type="range" min="1" max="12" />
          </div>

          <div class="lecture-tool-group">
            <button
              class="lecture-btn"
              :class="{ active: magnifierOn }"
              data-test="lecture-magnifier"
              @click="magnifierOn = !magnifierOn"
            >放大镜</button>
            <button
              v-for="zoom in [2, 3, 4]"
              :key="zoom"
              class="lecture-btn small"
              :class="{ active: magnifierOn && magnifierZoom === zoom }"
              @click="magnifierOn = true; magnifierZoom = zoom"
            >{{ zoom }}x</button>
            <button
              class="lecture-btn"
              :class="{ active: laserOn }"
              data-test="lecture-laser"
              @click="laserOn = !laserOn"
            >激光笔</button>
          </div>
        </div>

        <div class="lecture-subtitle" data-test="lecture-subtitle">
          <p v-if="partial" class="lecture-subtitle-text streaming">{{ partial }}</p>
          <p v-else-if="scriptText" class="lecture-subtitle-text">{{ scriptText }}</p>
          <p v-else class="lecture-subtitle-empty">点击「播放」开始讲解本页。</p>
        </div>

        <div class="lecture-ask">
          <input
            v-model="question"
            data-test="lecture-question"
            class="lecture-question"
            placeholder="就资料提问（会暂停讲解）"
            @keyup.enter="askQuestion"
          />
          <button class="lecture-btn" data-test="lecture-ask" :disabled="asking" @click="askQuestion">提问</button>
        </div>
        <div v-if="answer" class="lecture-answer-block">
          <p class="lecture-answer" data-test="lecture-answer">{{ answer }}</p>
          <ul class="lecture-citations">
            <li
              v-for="(citation, index) in citations"
              :key="index"
              class="lecture-citation"
              data-test="lecture-citation"
              @click="jumpToCitation(citation.page)"
            >[{{ citation.anchor }}] {{ citation.quote }}</li>
          </ul>
        </div>
      </div>
    </div>

    <div v-if="dragActive" class="lecture-drop" data-test="lecture-drop">松开以打开 .pptx</div>
  </section>
</template>

<style scoped>
.lecture-view {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  color: var(--text);
}
.lecture-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.lecture-file { display: none; }
.lecture-btn {
  padding: 5px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.lecture-btn:hover { border-color: var(--accent); color: var(--accent); }
.lecture-btn.primary { background: var(--accent); border-color: transparent; color: #0b0e18; font-weight: 600; }
.lecture-btn.active { border-color: var(--accent); color: var(--accent); }
.lecture-btn.small { padding: 4px 8px; }
.lecture-btn:disabled { opacity: 0.5; cursor: default; }
.lecture-state { font-size: 12px; color: var(--muted); }
.lecture-page-input {
  width: 48px;
  padding: 4px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: center;
}
.lecture-page-total { font-size: 12px; color: var(--muted); }
.lecture-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
.lecture-error { margin: 0; color: var(--err); font-size: 12px; }
.lecture-hint { margin: 0; color: var(--muted); font-size: 13px; }
.lecture-body { display: flex; gap: 12px; align-items: flex-start; }
.lecture-thumbs {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 420px;
  overflow-y: auto;
  padding-right: 4px;
}
.lecture-thumb {
  width: 34px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.lecture-thumb.active { border-color: var(--accent); color: var(--accent); }
.lecture-main { flex: 1; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.lecture-stage-wrap {
  position: relative;
  width: 100%;
  height: 320px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
}
.lecture-stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
}
.lecture-canvas { position: absolute; inset: 0; }
.lecture-lens {
  position: absolute;
  transform: translate(-50%, -50%);
  border: 2px solid var(--accent);
  border-radius: 50%;
  overflow: hidden;
  pointer-events: none;
  box-shadow: var(--shadow);
}
.lecture-lens-inner { position: absolute; top: 0; left: 0; transform-origin: top left; }
.lecture-laser {
  position: absolute;
  width: 10px;
  height: 10px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: #ff4d4d;
  box-shadow: 0 0 12px 4px rgba(255, 77, 77, 0.7);
  pointer-events: none;
}
.lecture-toolbar { display: flex; flex-wrap: wrap; gap: 12px; }
.lecture-tool-group { display: flex; align-items: center; gap: 6px; }
.lecture-tool-label { font-size: 12px; color: var(--muted); }
.lecture-swatch {
  width: 18px;
  height: 18px;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
}
.lecture-swatch.active { border-color: var(--text); }
.lecture-width { width: 90px; }
.lecture-subtitle {
  min-height: 64px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
}
.lecture-subtitle-text { margin: 0; font-size: 13px; line-height: 1.7; }
.lecture-subtitle-text.streaming::after { content: "▍"; color: var(--accent); }
.lecture-subtitle-empty { margin: 0; font-size: 12px; color: var(--muted); }
.lecture-ask { display: flex; gap: 8px; }
.lecture-question {
  flex: 1;
  padding: 7px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.lecture-answer-block { display: flex; flex-direction: column; gap: 6px; }
.lecture-answer { margin: 0; font-size: 13px; line-height: 1.7; }
.lecture-citations { margin: 0; padding-left: 18px; }
.lecture-citation { font-size: 12px; color: var(--muted); cursor: pointer; }
.lecture-citation:hover { color: var(--accent); }
.lecture-drop {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--accent);
  border-radius: var(--radius-lg);
  background: var(--panel);
  color: var(--accent);
  font-size: 14px;
  pointer-events: none;
}
</style>
