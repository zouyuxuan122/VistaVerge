/**
 * mc/tasks.ts — 任务模型、中文指令解析与合成配方（MC 模拟）。
 *
 * 分工（DOMAIN_PLUGINS §1.1）：LLM 只做**高层规划**（把「帮我弄点木头」变成任务），
 * 本地确定性代码执行并裁决成功/失败。指令解析是纯函数，可单测。
 */

import { COAL_ORE, DIRT, IRON_ORE, LOG, PLANKS, STONE, CRAFTING_TABLE, type BlockId } from './blocks';

export type TaskKind =
  | 'follow'
  | 'stop'
  | 'goto'
  | 'gather'
  | 'mine'
  | 'build'
  | 'craft'
  | 'deposit'
  | 'attack';

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  kind: TaskKind;
  /** 人类可读标签（面板与事件日志共用）。 */
  label: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  /** 0..1；失败/完成时为 1。 */
  progress: number;
  note: string;
  createdAt: number;
  finishedAt: number | null;
}

export interface ParsedCommand {
  kind: TaskKind;
  params: Record<string, unknown>;
  label: string;
}

/** 方块中文别名 → BlockId（指令解析用）。 */
export const BLOCK_ALIASES: { id: BlockId; words: string[] }[] = [
  { id: LOG, words: ['木头', '原木', '木材', 'log', 'wood'] },
  { id: STONE, words: ['石头', '石料', 'stone', 'cobble'] },
  { id: COAL_ORE, words: ['煤', '煤矿', 'coal'] },
  { id: IRON_ORE, words: ['铁', '铁矿', 'iron'] },
  { id: DIRT, words: ['泥土', '土', 'dirt'] },
  { id: PLANKS, words: ['木板', 'planks'] },
];

function matchBlock(text: string): BlockId | null {
  for (const entry of BLOCK_ALIASES) {
    for (const word of entry.words) if (text.includes(word)) return entry.id;
  }
  return null;
}

/** 从文本里取数量（「10个」「二十」不支持，只认阿拉伯数字），缺省 fallback。 */
function matchCount(text: string, fallback: number): number {
  const m = text.match(/(\d+)\s*(?:个|块|根|棵|条)?/);
  if (!m) return fallback;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 128);
}

const FOLLOW_WORDS = ['跟随我', '跟着我', '跟我走', '跟紧', '过来', 'follow me', 'follow'];
const STOP_WORDS = ['停下', '停止', '别动', '站住', '不要动', 'stop', 'halt'];
const HOME_WORDS = ['回家', '回出生点', '回来', '回基地', 'go home'];
const BUILD_WORDS = ['搭', '建', '盖', '房子', '小屋', 'shelter', 'build'];
const CRAFT_WORDS = ['合成', '制作', '做个', '做一个', '做一', 'craft', 'make'];
const GATHER_WORDS = ['采集', '收集', '挖点', '砍', '弄点', '帮我拿', 'gather', 'collect', 'chop'];
const MINE_WORDS = ['挖矿', '采矿', '挖', 'mine', 'dig'];
const DEPOSIT_WORDS = ['存起来', '放箱子', '收纳', 'deposit'];
/**
 * 攻击/反击指令（G-MC-02）。默认保守：即使识别出指令，PvP 开关关闭时
 * 也不执行（session 层直接拒绝并说明原因），绝不因一句「打他」就自动开打。
 */
const ATTACK_WORDS = ['打他', '打它', '打回去', '反击', '揍他', '揍它', '攻击', 'attack', 'retaliate'];

/**
 * 解析自然语言指令为任务。无法识别返回 null（上层不得硬猜成某个任务）。
 * 纯函数，无副作用。
 */
export function parseMcCommand(input: string): ParsedCommand | null {
  const text = (input ?? '').trim().toLowerCase();
  if (text.length === 0) return null;

  if (STOP_WORDS.some((w) => text.includes(w))) {
    return { kind: 'stop', params: {}, label: '停止当前动作' };
  }
  if (HOME_WORDS.some((w) => text.includes(w))) {
    return { kind: 'goto', params: { target: 'home' }, label: '返回出生点' };
  }
  if (FOLLOW_WORDS.some((w) => text.includes(w))) {
    return { kind: 'follow', params: {}, label: '跟随你' };
  }
  if (CRAFT_WORDS.some((w) => text.includes(w))) {
    if (text.includes('镐') || text.includes('pickaxe')) {
      return { kind: 'craft', params: { item: 'pickaxe' }, label: '合成石镐' };
    }
    if (text.includes('斧') || text.includes('axe')) {
      return { kind: 'craft', params: { item: 'axe' }, label: '合成斧头' };
    }
    if (text.includes('工作台') || text.includes('table')) {
      return { kind: 'craft', params: { item: 'crafting_table' }, label: '合成工作台' };
    }
    return { kind: 'craft', params: { item: 'planks' }, label: '合成木板' };
  }
  if (BUILD_WORDS.some((w) => text.includes(w))) {
    return { kind: 'build', params: { structure: 'hut' }, label: '搭一间小屋' };
  }
  if (DEPOSIT_WORDS.some((w) => text.includes(w))) {
    return { kind: 'deposit', params: {}, label: '把背包收进箱子' };
  }
  if (ATTACK_WORDS.some((w) => text.includes(w))) {
    return { kind: 'attack', params: { target: 'mob' }, label: '反击敌对生物' };
  }

  const block = matchBlock(text);
  if (block !== null) {
    const count = matchCount(text, 8);
    const kind: TaskKind = GATHER_WORDS.some((w) => text.includes(w)) ? 'gather' : 'mine';
    const verb = kind === 'gather' ? '采集' : '挖取';
    return {
      kind,
      params: { block, count },
      label: `${verb}${count} 个${blockLabel(block)}`,
    };
  }
  if (MINE_WORDS.some((w) => text.includes(w))) {
    const count = matchCount(text, 8);
    return { kind: 'mine', params: { block: STONE, count }, label: `挖取${count} 个石头` };
  }
  return null;
}

export function blockLabel(id: BlockId): string {
  return BLOCK_ALIASES.find((entry) => entry.id === id)?.words[0] ?? '方块';
}

/* ------------------------------------------------------------------ */
/* 合成配方                                                            */
/* ------------------------------------------------------------------ */

export interface Recipe {
  item: string;
  label: string;
  /** 所需材料：BlockId → 数量。 */
  cost: { block: BlockId; count: number }[];
  /** 是否需要工作台在场（背包里有工作台即可）。 */
  needsTable: boolean;
  /** 产物：方块 id 或工具名。 */
  output: { block?: BlockId; count?: number; tool?: 'axe' | 'pickaxe' };
}

export const RECIPES: Record<string, Recipe> = {
  planks: {
    item: 'planks',
    label: '木板',
    cost: [{ block: LOG, count: 1 }],
    needsTable: false,
    output: { block: PLANKS, count: 4 },
  },
  crafting_table: {
    item: 'crafting_table',
    label: '工作台',
    cost: [{ block: PLANKS, count: 4 }],
    needsTable: false,
    output: { block: CRAFTING_TABLE, count: 1 },
  },
  axe: {
    item: 'axe',
    label: '斧头',
    cost: [
      { block: PLANKS, count: 3 },
      { block: LOG, count: 2 },
    ],
    needsTable: true,
    output: { tool: 'axe' },
  },
  pickaxe: {
    item: 'pickaxe',
    label: '石镐',
    cost: [
      { block: PLANKS, count: 3 },
      { block: LOG, count: 2 },
    ],
    needsTable: true,
    output: { tool: 'pickaxe' },
  },
};

/** 小屋蓝图：相对锚点的 (dx,dy,dz) → 方块；留一个门洞。 */
export const HUT_BLUEPRINT: { dx: number; dy: number; dz: number }[] = (() => {
  const cells: { dx: number; dy: number; dz: number }[] = [];
  const size = 3;
  for (let dy = 0; dy < 3; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      for (let dz = 0; dz < size; dz += 1) {
        const isShell = dx === 0 || dz === 0 || dx === size - 1 || dz === size - 1;
        if (!isShell) continue;
        if (dy === 0 && dx === 1 && dz === 0) continue; // 门洞
        if (dy === 2) continue; // 留空顶（省材料，形状可辨）
        cells.push({ dx, dy, dz });
      }
    }
  }
  return cells;
})();

export const HUT_BLOCK_COST = HUT_BLUEPRINT.length;
