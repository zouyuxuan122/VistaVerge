/**
 * mc/pathfind.ts — 真实 A* 寻路（MC 模拟的本地反应层）。
 *
 * 设计合同（docs/plugins/DOMAIN_PLUGINS.md §1.1）：**本地反应不逐帧调用 LLM**。
 * 寻路是确定性算法：节点 = 可站立格（脚下实体、身体两格空），边 = 四向走 + 上下落差。
 * 找不到路就返回 null —— 调用方必须如实报告「走不过去」，不得瞬移过去假装成功。
 */

import { AIR, WATER, isSolid, type BlockId } from './blocks';
import type { Vec3, VoxelWorld } from './world';

export interface PathNode {
  x: number;
  z: number;
}

export interface PathResult {
  /** 从起点到终点的格子序列（含终点，不含起点）。 */
  nodes: PathNode[];
  /** 路径上需要挖掉的方块（当前实现只在被完全挡住时挖一格，留给上层裁决）。 */
  dig: Vec3[];
  cost: number;
  /** 访问过的节点数，用于验证 A* 真的在搜索而不是返回预设路径。 */
  visited: number;
}

/** 身体占位：脚下 y 是站立面，身体占 y+1、y+2。 */
function canStand(world: VoxelWorld, x: number, y: number, z: number): boolean {
  if (!world.inBounds(x, y, z)) return false;
  if (!isSolid(world.get(x, y - 1, z))) return false; // 需要地面
  const feet = world.get(x, y, z);
  const head = world.get(x, y + 1, z);
  if (feet === WATER || head === WATER) return false; // 不主动下水
  if (feet !== AIR || head !== AIR) return false;
  return true;
}

/** 该列可站立的 y（自上而下第一个可站立格）；无则返回 null。 */
function standY(world: VoxelWorld, x: number, z: number, nearY: number): number | null {
  let best: number | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let y = Math.max(1, world.height - 3); y >= 1; y -= 1) {
    if (!canStand(world, x, y, z)) continue;
    const delta = Math.abs(y - nearY);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = y;
    }
  }
  return best;
}

function key(x: number, z: number): number {
  return x * 100000 + z;
}

/**
 * 目标层容差：起点所在层与目标可站立层的最大高差。
 *
 * 一列可以有多层可站立位置（树列：地面被树干占满，只有树冠顶可站）。
 * 若不限制高差，A* 会把「站在树冠上」当成目标，而树冠在地面层爬不上去，
 * 于是对一棵明明就在旁边的树报「走不过去」。超过容差就改找邻域地面层。
 */
const MAX_GOAL_RISE = 2;

/** 在 (x,z) 及其邻域内找一个「从 nearY 够得着」的可站立层。 */
function reachableStand(
  world: VoxelWorld,
  x: number,
  z: number,
  nearY: number,
  radius: number,
): { x: number; z: number; y: number } | null {
  const own = standY(world, x, z, nearY);
  if (own !== null && Math.abs(own - nearY) <= MAX_GOAL_RISE) return { x, z, y: own };
  let best: { x: number; z: number; y: number } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const gx = x + dx;
      const gz = z + dz;
      const gy = standY(world, gx, gz, nearY);
      if (gy === null || Math.abs(gy - nearY) > MAX_GOAL_RISE) continue;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = { x: gx, z: gz, y: gy };
      }
    }
  }
  return best;
}

/**
 * A* 搜索。起点用 standY 对齐到可站立层；终点若不可站立，则搜索其邻域最近可站立格。
 * 八向移动，对角线需两侧都可通行（不穿墙角）。
 */
export function findPath(
  world: VoxelWorld,
  from: Vec3,
  to: { x: number; z: number },
  options: { maxNodes?: number; allowDiagonal?: boolean } = {},
): PathResult | null {
  const maxNodes = options.maxNodes ?? 20000;
  const allowDiagonal = options.allowDiagonal ?? true;

  const startY = standY(world, Math.floor(from.x), Math.floor(from.z), Math.round(from.y));
  if (startY === null) return null;
  const start: PathNode = { x: Math.floor(from.x), z: Math.floor(from.z) };

  // 目标：先看目标格本身，够不着就找邻域里同层的可站立格。
  const resolved = reachableStand(world, Math.floor(to.x), Math.floor(to.z), startY, 3);
  if (!resolved) return null;
  const goal: PathNode = { x: resolved.x, z: resolved.z };
  if (goal.x === start.x && goal.z === start.z) return { nodes: [], dig: [], cost: 0, visited: 0 };

  const steps: PathNode[] = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 },
  ];
  if (allowDiagonal) {
    steps.push({ x: 1, z: 1 }, { x: 1, z: -1 }, { x: -1, z: 1 }, { x: -1, z: -1 });
  }

  const heuristic = (n: PathNode): number => {
    const dx = Math.abs(n.x - goal.x);
    const dz = Math.abs(n.z - goal.z);
    // 八向启发式
    return allowDiagonal ? Math.max(dx, dz) + 0.4142 * Math.min(dx, dz) : dx + dz;
  };

  const open: { node: PathNode; y: number; g: number; f: number }[] = [
    { node: start, y: startY, g: 0, f: heuristic(start) },
  ];
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, PathNode>();
  const yOf = new Map<number, number>();
  gScore.set(key(start.x, start.z), 0);
  yOf.set(key(start.x, start.z), startY);
  const closed = new Set<number>();
  let visited = 0;

  while (open.length > 0 && visited < maxNodes) {
    // 取 f 最小（规模小，线性取最小足够；保持实现无依赖、可复现）
    let bestIdx = 0;
    for (let i = 1; i < open.length; i += 1) if (open[i].f < open[bestIdx].f) bestIdx = i;
    const current = open.splice(bestIdx, 1)[0];
    const ck = key(current.node.x, current.node.z);
    if (closed.has(ck)) continue;
    closed.add(ck);
    visited += 1;

    if (current.node.x === goal.x && current.node.z === goal.z) {
      const nodes: PathNode[] = [];
      let cursor: PathNode | undefined = current.node;
      let guard = 0;
      while (cursor && guard < 4096) {
        const isStart = cursor.x === start.x && cursor.z === start.z;
        if (!isStart) nodes.push(cursor);
        cursor = cameFrom.get(key(cursor.x, cursor.z));
        guard += 1;
      }
      nodes.reverse();
      return { nodes, dig: [], cost: current.g, visited };
    }

    for (const step of steps) {
      const nx = current.node.x + step.x;
      const nz = current.node.z + step.z;
      const nk = key(nx, nz);
      if (closed.has(nk)) continue;
      const ny = standY(world, nx, nz, current.y);
      if (ny === null) continue;
      const rise = ny - current.y;
      if (rise > 1) continue; // 爬不上去
      if (rise < -3) continue; // 落差太大，不下去（避免摔伤路径）
      const diagonal = step.x !== 0 && step.z !== 0;
      if (diagonal) {
        // 不穿墙角：两侧正交格必须都能走
        const sideA = standY(world, current.node.x + step.x, current.node.z, current.y);
        const sideB = standY(world, current.node.x, current.node.z + step.z, current.y);
        if (sideA === null || sideB === null) continue;
      }
      const stepCost = (diagonal ? 1.4142 : 1) + Math.max(0, rise) * 0.6 + Math.max(0, -rise) * 0.2;
      const tentative = current.g + stepCost;
      if (tentative >= (gScore.get(nk) ?? Number.POSITIVE_INFINITY)) continue;
      gScore.set(nk, tentative);
      yOf.set(nk, ny);
      cameFrom.set(nk, current.node);
      open.push({ node: { x: nx, z: nz }, y: ny, g: tentative, f: tentative + heuristic({ x: nx, z: nz }) });
    }
  }
  return null;
}

/** 供测试/调试：某格是否可站立。 */
export function isStandable(world: VoxelWorld, x: number, y: number, z: number): boolean {
  return canStand(world, x, y, z);
}

/** 供调试：该列的站立高度。 */
export function standHeight(world: VoxelWorld, x: number, z: number, nearY: number): number | null {
  return standY(world, x, z, nearY);
}

export type { BlockId };
