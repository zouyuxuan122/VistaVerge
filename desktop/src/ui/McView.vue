<script setup lang="ts">
// MC 模拟场景面板：真实体素世界 + 真实 A* 寻路 + 真实挖掘/合成/搭建状态机。
// 诚实标注两条：这是本地模拟（SIMULATED）；真实服务端连接是 BLOCKED。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { AIR, BLOCKS, COAL_ORE, DIRT, GRASS, IRON_ORE, LEAVES, LOG, PLANKS, STONE, WATER, type BlockId } from '../mc/blocks';
import {
  advance,
  applyCommand,
  MC_REAL_SERVER_BLOCKED,
  MC_SIMULATED_NOTICE,
  mcSession,
  resetSimulation,
  setHostile,
  setRunning,
  sim,
} from '../mc/session';
import { parseMcCommand } from '../mc/tasks';

const mapCanvas = ref<HTMLCanvasElement | null>(null);
const sideCanvas = ref<HTMLCanvasElement | null>(null);
const command = ref('');
const commandNote = ref('');

let raf = 0;
let last = 0;
let mapAccum = 0;
/** 俯视地图缓存：世界改动（挖/放）才失效，避免每帧 O(w·h·H) 全量扫描。 */
let mapCache: { id: BlockId; y: number }[] | null = null;
let mapCacheKey = '';

/** 目标像素宽度：按容器宽度铺满卡片，避免地图右边留一大片空白。 */
function cellSize(canvas: HTMLCanvasElement, cols: number, min: number): number {
  const wrap = canvas.parentElement;
  const avail = (wrap?.clientWidth ?? cols * min) - 12;
  return Math.max(min, Math.floor(avail / cols));
}

const quickCommands: { label: string; text: string; hint: string }[] = [
  { label: '跟随我', text: '跟着我', hint: '持续跟随你的位置（会持续重新寻路）' },
  { label: '停止', text: '停下', hint: '急停：取消当前与排队任务' },
  { label: '采集木头', text: '帮我采集 6 个木头', hint: '找最近原木 → 寻路 → 挖掘' },
  { label: '合成工作台', text: '合成工作台', hint: '原木→木板→工作台' },
  { label: '合成斧头', text: '合成斧头', hint: '需要工作台 + 木板 + 原木' },
  { label: '挖石头', text: '挖 6 个石头', hint: '需要镐（没有就如实失败）' },
  { label: '搭小屋', text: '搭一间小屋', hint: '按蓝图真实放置方块' },
  { label: '回家', text: '回家', hint: '寻路回出生点' },
  { label: '收纳背包', text: '把背包收进箱子', hint: '清空背包' },
];

// 模拟器本体不是 Vue reactive：所有读取模拟器状态的 computed 都必须依赖
// mcSession.revision（advance 每个节拍 +1），否则界面会停在首帧快照上
// ——任务列表空、背包不更新、日志只有第一行。
const bot = computed(() => {
  void mcSession.revision;
  return sim.bot;
});
const statusLabel: Record<string, string> = {
  idle: '待命',
  moving: '移动中',
  mining: '挖掘中',
  placing: '放置中',
  crafting: '合成中',
  dead: '已死亡（等待重生）',
};

const healthPct = computed(() => Math.max(0, Math.min(100, (bot.value.health / 20) * 100)));
const inventory = computed(() => {
  void mcSession.revision;
  return sim.inventoryList();
});
const runningTasks = computed(() => {
  void mcSession.revision;
  return sim.tasks.slice(0, 8);
});
const events = computed(() => {
  void mcSession.revision;
  return sim.log.slice(0, 14);
});
const currentTask = computed(() => {
  void mcSession.revision;
  return sim.currentTask;
});
const worldStats = computed(() => {
  void mcSession.revision;
  return {
    logs: sim.countBlock(4),
    stone: sim.countBlock(3),
    planks: sim.countBlock(9),
    water: sim.waterCount(),
  };
});
const hostileOn = computed(() => mcSession.hostile);

/** 图例：把地图上的颜色和挖掘代价对应起来（硬度与工具要求都来自方块表）。 */
const legend = [GRASS, DIRT, STONE, LOG, LEAVES, WATER, COAL_ORE, IRON_ORE, PLANKS].map((id) => BLOCKS[id]);

function mapKey(): string {
  return `${bot.value.blocksMined}:${bot.value.blocksPlaced}`;
}

function drawMap() {
  const canvas = mapCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const CELL = cellSize(canvas, sim.world.width, 7);
  const w = sim.world.width * CELL;
  const h = sim.world.depth * CELL;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const key = mapKey();
  if (!mapCache || mapCacheKey !== key) {
    mapCache = sim.topMap();
    mapCacheKey = key;
  }
  const map = mapCache;

  // 地形：按高度做明暗，形成可读的起伏
  for (let x = 0; x < sim.world.width; x += 1) {
    for (let z = 0; z < sim.world.depth; z += 1) {
      const cell = map[z * sim.world.width + x];
      if (!cell || cell.id === AIR) continue;
      const def = BLOCKS[cell.id];
      ctx.fillStyle = cell.id === 4 || cell.id === 5 ? def.color : def.topColor;
      ctx.fillRect(x * CELL, z * CELL, CELL, CELL);
      const shade = Math.max(-0.28, Math.min(0.22, (cell.y - 12) * 0.035));
      ctx.fillStyle = shade >= 0 ? `rgba(255,255,255,${shade})` : `rgba(0,0,0,${-shade})`;
      ctx.fillRect(x * CELL, z * CELL, CELL, CELL);
    }
  }

  // 路径
  if (bot.value.path.length > 0) {
    ctx.strokeStyle = 'rgba(232,84,63,0.85)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(bot.value.x * CELL, bot.value.z * CELL);
    for (let i = bot.value.pathIndex; i < bot.value.path.length; i += 1) {
      const node = bot.value.path[i];
      ctx.lineTo((node.x + 0.5) * CELL, (node.z + 0.5) * CELL);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 挖掘目标
  const target = bot.value.miningTarget;
  if (target) {
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.strokeRect(target.x * CELL - 1, target.z * CELL - 1, CELL + 2, CELL + 2);
  }

  // 用户（玩家）
  ctx.fillStyle = '#2f7fd0';
  ctx.beginPath();
  ctx.arc(sim.player.x * CELL, sim.player.z * CELL, CELL * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 机器人
  ctx.fillStyle = bot.value.status === 'dead' ? '#8a8a8a' : '#e8543f';
  ctx.fillRect(bot.value.x * CELL - CELL * 0.45, bot.value.z * CELL - CELL * 0.45, CELL * 0.9, CELL * 0.9);
  ctx.strokeStyle = '#2b2622';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(bot.value.x * CELL - CELL * 0.45, bot.value.z * CELL - CELL * 0.45, CELL * 0.9, CELL * 0.9);
}

function drawSide() {
  const canvas = sideCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const z = Math.max(0, Math.min(sim.world.depth - 1, Math.round(bot.value.z)));
  const profile = sim.sideProfile(z);
  const cellW = cellSize(canvas, profile.length, 7);
  const cellH = Math.max(4, Math.round(cellW * 0.78));
  const w = profile.length * cellW;
  const h = sim.world.height * cellH;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  for (let x = 0; x < profile.length; x += 1) {
    const cell = profile[x];
    if (cell.id === AIR) continue;
    ctx.fillStyle = BLOCKS[cell.id].color;
    const top = h - (cell.y + 1) * cellH;
    ctx.fillRect(x * cellW, top, cellW, (cell.y + 1) * cellH);
  }
  // 机器人竖线位置
  ctx.fillStyle = '#e8543f';
  ctx.fillRect(Math.round(bot.value.x) * cellW + 1, 0, 3, h);
}

function loop(now: number) {
  raf = requestAnimationFrame(loop);
  if (document.hidden) {
    last = now;
    return;
  }
  const dt = last === 0 ? 16 : Math.min(120, now - last);
  last = now;
  advance(dt);
  mapAccum += dt;
  if (mapAccum >= 60) {
    mapAccum = 0;
    drawMap();
    drawSide();
  }
}

function run(text: string) {
  const parsed = parseMcCommand(text);
  if (!parsed) {
    commandNote.value = `未识别：「${text}」——不会硬猜成某个任务`;
    return;
  }
  applyCommand(parsed);
  commandNote.value = `已执行：${parsed.label}`;
}

function submitCommand() {
  const text = command.value.trim();
  if (!text) return;
  run(text);
  command.value = '';
}

onMounted(() => {
  raf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  raf = 0;
});

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
</script>

<template>
  <div class="pane-scroll mc-view">
    <div class="mc-head">
      <span class="mc-badge simulated">SIMULATED · 本地模拟世界</span>
      <span class="mc-badge blocked">真实 MC 服务端：BLOCKED</span>
      <span class="mc-meta">seed {{ sim.world.seed }} · {{ sim.world.width }}×{{ sim.world.depth }}×{{ sim.world.height }} · 已运行 {{ fmtMs(mcSession.elapsedMs) }}</span>
    </div>
    <p class="mc-notice">
      {{ MC_SIMULATED_NOTICE }} {{ MC_REAL_SERVER_BLOCKED }}
    </p>

    <div class="mc-grid">
      <section class="mc-card mc-map-card">
        <h3>俯视地图 <small>红=她 · 蓝=你 · 虚线=当前路径 · 黄框=挖掘目标</small></h3>
        <div class="mc-map-scroll">
          <canvas ref="mapCanvas" data-testid="mc-map" />
        </div>
        <h4>立面剖面（她所在 z 行）</h4>
        <div class="mc-map-scroll">
          <canvas ref="sideCanvas" data-testid="mc-side" />
        </div>
        <h4>方块图例</h4>
        <ul class="mc-legend">
          <li v-for="def in legend" :key="def.id">
            <span class="mc-swatch" :style="{ background: def.topColor }" />{{ def.name }}
            <small>{{ def.solid ? `${def.hardness}s` : '可穿过' }}{{ def.needsTool === 'none' ? ' · 徒手' : def.needsTool === 'axe' ? ' · 需斧' : ' · 需镐' }}</small>
          </li>
        </ul>
      </section>

      <section class="mc-card">
        <h3>她的状态</h3>
        <div class="mc-status">
          <span class="mc-state" :class="'st-' + bot.status">{{ statusLabel[bot.status] ?? bot.status }}</span>
          <span class="mc-pos">({{ bot.x.toFixed(1) }}, {{ bot.y.toFixed(1) }}, {{ bot.z.toFixed(1) }})</span>
        </div>
        <div class="mc-health" role="img" aria-label="生命值">
          <i :style="{ width: healthPct + '%' }" />
          <span>{{ bot.health }} / 20</span>
        </div>
        <ul class="mc-kv">
          <li><span>行走距离</span><b>{{ bot.distanceWalked.toFixed(1) }} 格</b></li>
          <li><span>挖掉方块</span><b>{{ bot.blocksMined }}</b></li>
          <li><span>放置方块</span><b>{{ bot.blocksPlaced }}</b></li>
          <li><span>死亡次数</span><b>{{ bot.deaths }}</b></li>
          <li><span>工具</span><b>{{ bot.tools.axe ? '斧' : '—' }} / {{ bot.tools.pickaxe ? '镐' : '—' }}</b></li>
        </ul>

        <h3>背包 <small>{{ inventory.length }} 类</small></h3>
        <ul class="mc-inv" v-if="inventory.length">
          <li v-for="item in inventory" :key="item.id">
            <span class="mc-swatch" :style="{ background: BLOCKS[item.id].topColor }" />{{ item.name }} × {{ item.count }}
          </li>
        </ul>
        <p v-else class="mc-empty">背包是空的（挖到的东西会出现在这里）</p>
        <p v-if="bot.inventoryFull" class="mc-warn">背包已满：采集任务会如实失败，先「收纳背包」。</p>

        <h3>世界存量</h3>
        <ul class="mc-kv">
          <li><span>原木</span><b>{{ worldStats.logs }}</b></li>
          <li><span>石头</span><b>{{ worldStats.stone }}</b></li>
          <li><span>木板</span><b>{{ worldStats.planks }}</b></li>
          <li><span>水</span><b>{{ worldStats.water }}</b></li>
        </ul>
      </section>

      <section class="mc-card mc-cmd-card">
        <h3>对她下指令 <small>本地解析，不猜意图</small></h3>
        <div class="mc-cmd-row">
          <input
            v-model="command"
            data-testid="mc-command"
            placeholder="例如：跟着我 / 挖 6 个木头 / 合成斧头 / 搭一间小屋"
            @keydown.enter.prevent="submitCommand"
          />
          <button class="btn primary" @click="submitCommand">下达</button>
        </div>
        <p class="mc-note" v-if="commandNote">{{ commandNote }}</p>
        <div class="mc-quick">
          <button v-for="q in quickCommands" :key="q.label" class="mc-quick-btn" :title="q.hint" @click="run(q.text)">
            {{ q.label }}
          </button>
        </div>
        <div class="mc-toggles">
          <label><input type="checkbox" :checked="mcSession.running" @change="setRunning(($event.target as HTMLInputElement).checked)" /> 模拟运行中</label>
          <label><input type="checkbox" :checked="hostileOn" @change="setHostile(($event.target as HTMLInputElement).checked)" /> 受击开关（每 3 秒受 2 点伤害）</label>
          <button class="btn" @click="resetSimulation()">重置世界（同 seed）</button>
        </div>

        <h3>任务队列 <small>当前：{{ currentTask ? currentTask.label : '无' }}</small></h3>
        <ul class="mc-tasks" v-if="runningTasks.length">
          <li v-for="task in runningTasks" :key="task.id" :class="'st-' + task.status">
            <div class="mc-task-top">
              <span class="mc-task-state">{{ task.status === 'done' ? '完成' : task.status === 'failed' ? '失败' : task.status === 'cancelled' ? '取消' : task.status === 'running' ? '进行中' : '排队' }}</span>
              <span class="mc-task-label">{{ task.label }}</span>
              <span class="mc-task-pct">{{ Math.round(task.progress * 100) }}%</span>
            </div>
            <div class="mc-bar"><i :style="{ width: Math.round(task.progress * 100) + '%' }" /></div>
            <p v-if="task.note" class="mc-task-note">{{ task.note }}</p>
          </li>
        </ul>
        <p v-else class="mc-empty">还没有任务。用上面的指令或快捷按钮让她干活。</p>

        <h3>事件日志 <small>最新在前</small></h3>
        <ul class="mc-log">
          <li v-for="(event, i) in events" :key="i" :class="'ev-' + event.kind">
            <span class="mc-log-t">{{ (event.at / 1000).toFixed(1) }}s</span>{{ event.text }}
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
