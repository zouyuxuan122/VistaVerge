/**
 * mc/blocks.ts — 方块定义表（MC 模拟世界的唯一真值来源）。
 *
 * 这里定义的是**模拟世界**的方块语义：硬度、是否实体、掉落物、颜色。
 * 真实 Minecraft 服务器接入属外部 BLOCKED（需固定 Java/服务端/Mineflayer 版本与账号，
 * 见 docs/plugins/DOMAIN_PLUGINS.md §1.1）；本模块不声称与真实服务端一致，
 * 数值是本地模拟参数，用于让任务的成功/失败有真实原因。
 */

export type BlockId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const AIR: BlockId = 0;
export const GRASS: BlockId = 1;
export const DIRT: BlockId = 2;
export const STONE: BlockId = 3;
export const LOG: BlockId = 4;
export const LEAVES: BlockId = 5;
export const WATER: BlockId = 6;
export const COAL_ORE: BlockId = 7;
export const IRON_ORE: BlockId = 8;
export const PLANKS: BlockId = 9;
export const CRAFTING_TABLE: BlockId = 10;

export interface BlockDef {
  id: BlockId;
  name: string;
  /** 实体方块阻挡移动与视线。 */
  solid: boolean;
  /** 基础硬度（秒），0 表示可穿过。 */
  hardness: number;
  /** 挖掘是否必须工具（无工具则挖不动，任务会如实失败）。 */
  needsTool: 'none' | 'axe' | 'pickaxe';
  /** 挖掉后进入背包的方块（草→土）。 */
  drops: BlockId | null;
  /** 地图绘制色。 */
  color: string;
  /** 顶面（俯视图）绘制色。 */
  topColor: string;
}

export const BLOCKS: Record<BlockId, BlockDef> = {
  0: { id: AIR, name: '空气', solid: false, hardness: 0, needsTool: 'none', drops: null, color: '#00000000', topColor: '#00000000' },
  1: { id: GRASS, name: '草方块', solid: true, hardness: 0.6, needsTool: 'none', drops: DIRT, color: '#6b9b4a', topColor: '#7cb155' },
  2: { id: DIRT, name: '泥土', solid: true, hardness: 0.5, needsTool: 'none', drops: DIRT, color: '#8a6543', topColor: '#96703f' },
  3: { id: STONE, name: '石头', solid: true, hardness: 1.5, needsTool: 'pickaxe', drops: STONE, color: '#8b8b8b', topColor: '#9a9a9a' },
  // 原木/木板/工作台都可以徒手处理（只是慢）：若要求斧头，就会形成
  // 「斧头需要木板 → 木板需要原木 → 原木需要斧头」的死锁。
  4: { id: LOG, name: '原木', solid: true, hardness: 2.0, needsTool: 'none', drops: LOG, color: '#6d4c2f', topColor: '#8a6035' },
  5: { id: LEAVES, name: '树叶', solid: true, hardness: 0.2, needsTool: 'none', drops: null, color: '#4f7d3a', topColor: '#5c8f42' },
  6: { id: WATER, name: '水', solid: false, hardness: 0, needsTool: 'none', drops: null, color: '#3f7fbf', topColor: '#4a8fd0' },
  7: { id: COAL_ORE, name: '煤矿石', solid: true, hardness: 3.0, needsTool: 'pickaxe', drops: COAL_ORE, color: '#6e6e6e', topColor: '#2f2f2f' },
  8: { id: IRON_ORE, name: '铁矿石', solid: true, hardness: 3.0, needsTool: 'pickaxe', drops: IRON_ORE, color: '#9c8f7d', topColor: '#c8a887' },
  9: { id: PLANKS, name: '木板', solid: true, hardness: 2.0, needsTool: 'none', drops: PLANKS, color: '#b98a52', topColor: '#c99a5f' },
  10: { id: CRAFTING_TABLE, name: '工作台', solid: true, hardness: 2.5, needsTool: 'none', drops: CRAFTING_TABLE, color: '#a8763f', topColor: '#b8854a' },
};

/** 可放置方块白名单（背包里能放回世界的）。 */
export const PLACEABLE: readonly BlockId[] = [DIRT, STONE, LOG, PLANKS, CRAFTING_TABLE, GRASS];

export function blockDef(id: BlockId): BlockDef {
  return BLOCKS[id];
}

export function blockName(id: BlockId): string {
  return BLOCKS[id].name;
}

export function isSolid(id: BlockId): boolean {
  return BLOCKS[id].solid;
}

/** 工具能力：手 = 无工具；斧/镐由合成获得。 */
export type ToolKind = 'none' | 'axe' | 'pickaxe';

export interface ToolSet {
  axe: boolean;
  pickaxe: boolean;
}

/** 判定当前工具能否挖掘该方块（挖不动时任务必须如实失败，不能假装成功）。 */
export function canMine(id: BlockId, tools: ToolSet): { ok: boolean; reason?: string } {
  const def = BLOCKS[id];
  if (!def.solid || def.hardness <= 0) return { ok: false, reason: `${def.name} 不可挖掘` };
  if (def.needsTool === 'axe' && !tools.axe) return { ok: false, reason: `需要斧头才能挖${def.name}` };
  if (def.needsTool === 'pickaxe' && !tools.pickaxe) return { ok: false, reason: `需要镐子才能挖${def.name}` };
  return { ok: true };
}

/** 挖掘耗时：无合适工具时更慢（手撸），有工具按硬度。 */
export function mineDurationMs(id: BlockId, tools: ToolSet): number {
  const def = BLOCKS[id];
  const suited =
    (def.needsTool === 'axe' && tools.axe) || (def.needsTool === 'pickaxe' && tools.pickaxe);
  const factor = def.needsTool === 'none' ? 1 : suited ? 1.5 : 4;
  return Math.round(def.hardness * 420 * factor);
}
