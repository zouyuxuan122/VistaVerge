/**
 * mc/world.ts — 确定性体素世界（MC 模拟）。
 *
 * 同一 seed 必然生成同一世界（可复现的验收前提，见 docs/quality/ACCEPTANCE_MATRIX.md
 * 「固定种子」要求）。地形用整数 hash 值噪声，不依赖 Math.random，便于单测断言。
 */

import {
  AIR,
  COAL_ORE,
  DIRT,
  GRASS,
  IRON_ORE,
  LEAVES,
  LOG,
  STONE,
  WATER,
  type BlockId,
} from './blocks';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 32 位整数 hash（xorshift 混合），保证同 seed 同结果。 */
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = seed >>> 0;
  h = (h ^ Math.imul(x | 0, 0x27d4eb2d)) >>> 0;
  h = (h ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = (h ^ Math.imul(z | 0, 0x9e3779b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** 归一化到 [0,1)。 */
function hashUnit(x: number, y: number, z: number, seed: number): number {
  return hash3(x, y, z, seed) / 0x100000000;
}

/** 双线性插值的值噪声，返回 [0,1)。 */
export function valueNoise2D(x: number, z: number, seed: number, scale: number): number {
  const fx = x / scale;
  const fz = z / scale;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const n00 = hashUnit(x0, 0, z0, seed);
  const n10 = hashUnit(x0 + 1, 0, z0, seed);
  const n01 = hashUnit(x0, 0, z0 + 1, seed);
  const n11 = hashUnit(x0 + 1, 0, z0 + 1, seed);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sz;
}

export interface WorldOptions {
  width: number;
  height: number;
  depth: number;
  seed: number;
}

export interface TreeRecord {
  x: number;
  z: number;
  baseY: number;
  height: number;
}

/**
 * 体素世界。坐标：x∈[0,width)、y∈[0,height) 自下而上、z∈[0,depth)。
 * 越界读取返回 STONE（世界外视为实心，避免 bot 走出边界）。
 */
export class VoxelWorld {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly seed: number;
  readonly trees: TreeRecord[] = [];
  private readonly cells: Uint8Array;

  constructor(options: WorldOptions) {
    this.width = options.width;
    this.height = options.height;
    this.depth = options.depth;
    this.seed = options.seed;
    this.cells = new Uint8Array(this.width * this.height * this.depth);
  }

  private index(x: number, y: number, z: number): number {
    return (y * this.depth + z) * this.width + x;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height && z >= 0 && z < this.depth;
  }

  /** 越界一律 STONE：世界外是实心，防止越界移动。 */
  get(x: number, y: number, z: number): BlockId {
    if (!this.inBounds(x, y, z)) return STONE;
    return this.cells[this.index(x, y, z)] as BlockId;
  }

  /** 越界写入被忽略（返回 false），不抛错。 */
  set(x: number, y: number, z: number, id: BlockId): boolean {
    if (!this.inBounds(x, y, z)) return false;
    this.cells[this.index(x, y, z)] = id;
    return true;
  }

  /** 地表高度：该列最高实体方块的上表面 y（无实体返回 0）。 */
  surfaceY(x: number, z: number): number {
    for (let y = this.height - 1; y >= 0; y -= 1) {
      const id = this.get(x, y, z);
      if (id !== AIR && id !== WATER) return y;
    }
    return 0;
  }

  /** 统计某方块的存量（用于验收「采集是否真的减少了世界里的方块」）。 */
  count(id: BlockId): number {
    let total = 0;
    for (let i = 0; i < this.cells.length; i += 1) if (this.cells[i] === id) total += 1;
    return total;
  }

  /** 在半径内找最近的指定方块；返回 null 表示确实找不到（任务据此如实失败）。 */
  findNearest(
    from: Vec3,
    predicate: (id: BlockId, x: number, y: number, z: number) => boolean,
    radius: number,
  ): Vec3 | null {
    let best: Vec3 | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    const x0 = Math.max(0, Math.floor(from.x - radius));
    const x1 = Math.min(this.width - 1, Math.ceil(from.x + radius));
    const z0 = Math.max(0, Math.floor(from.z - radius));
    const z1 = Math.min(this.depth - 1, Math.ceil(from.z + radius));
    for (let x = x0; x <= x1; x += 1) {
      for (let z = z0; z <= z1; z += 1) {
        for (let y = 0; y < this.height; y += 1) {
          const id = this.get(x, y, z);
          if (!predicate(id, x, y, z)) continue;
          const dx = x + 0.5 - from.x;
          const dy = y + 0.5 - from.y;
          const dz = z + 0.5 - from.z;
          const dist = dx * dx + dy * dy * 4 + dz * dz; // y 权重高：优先同层
          if (dist < bestDist) {
            bestDist = dist;
            best = { x, y, z };
          }
        }
      }
    }
    return best;
  }

  /** 俯视最高实体方块的 id（地图绘制用）。 */
  topBlockId(x: number, z: number): BlockId {
    for (let y = this.height - 1; y >= 0; y -= 1) {
      const id = this.get(x, y, z);
      if (id !== AIR) return id;
    }
    return AIR;
  }
}

export interface GeneratedWorld {
  world: VoxelWorld;
  /** 出生点（地表之上的可站立位置）。 */
  spawn: Vec3;
}

/**
 * 生成地形：起伏地表 + 石头层 + 矿脉 + 树 + 一处水塘。
 * 全部由 seed 决定，可复现。
 */
export function generateWorld(options: WorldOptions): GeneratedWorld {
  const { width, height, depth, seed } = options;
  const world = new VoxelWorld(options);
  const baseY = Math.floor(height * 0.34);

  // 1) 地表高度场：两层噪声叠加，产生丘陵与平地
  const heights = new Int16Array(width * depth);
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < depth; z += 1) {
      const broad = valueNoise2D(x, z, seed, 14);
      const detail = valueNoise2D(x, z, seed ^ 0x5bf03635, 5);
      const h = Math.round(baseY + (broad - 0.5) * 7 + (detail - 0.5) * 2.4);
      heights[z * width + x] = Math.max(2, Math.min(height - 12, h));
    }
  }

  // 2) 水塘：取一处低洼中心，把低于水位的地表填成水
  const pondX = Math.floor(width * 0.24);
  const pondZ = Math.floor(depth * 0.72);
  const waterLevel = world.height > 0 ? heights[pondZ * width + pondX] + 1 : 0;

  // 3) 填充：草/土/石 + 矿脉
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < depth; z += 1) {
      const top = heights[z * width + x];
      const distToPond = Math.hypot(x - pondX, z - pondZ);
      const underwater = distToPond < 3.4 && top <= waterLevel;
      for (let y = 0; y <= top; y += 1) {
        let id: BlockId = STONE;
        if (y === top) id = underwater ? DIRT : GRASS;
        else if (y >= top - 2) id = DIRT;
        else {
          id = STONE;
          // 矿脉：石头层内的 hash 概率分布，深度越深铁越多
          const roll = hashUnit(x, y, z, seed ^ 0x1f123bb5);
          const deepBonus = y < baseY - 3 ? 0.02 : 0;
          if (roll < 0.012 + deepBonus) id = IRON_ORE;
          else if (roll < 0.045) id = COAL_ORE;
        }
        world.set(x, y, z, id);
      }
      if (underwater) {
        for (let y = top + 1; y <= waterLevel; y += 1) world.set(x, y, z, WATER);
      }
    }
  }

  // 4) 树：在草地上按 hash 稀疏放置，避开出生点与水塘
  const spawnX = Math.floor(width / 2);
  const spawnZ = Math.floor(depth / 2);
  for (let x = 2; x < width - 2; x += 1) {
    for (let z = 2; z < depth - 2; z += 1) {
      if (hashUnit(x, 7, z, seed ^ 0x2a1b3c4d) > 0.035) continue;
      if (Math.hypot(x - spawnX, z - spawnZ) < 3) continue;
      if (Math.hypot(x - pondX, z - pondZ) < 5) continue;
      const ground = heights[z * width + x];
      if (world.get(x, ground, z) !== GRASS) continue;
      if (world.get(x, ground + 1, z) !== AIR) continue;
      const trunk = 4 + Math.floor(hashUnit(x, 11, z, seed ^ 0x77aa33bb) * 3);
      if (ground + trunk + 2 >= height) continue;
      for (let i = 1; i <= trunk; i += 1) world.set(x, ground + i, z, LOG);
      for (let dy = -1; dy <= 2; dy += 1) {
        const r = dy <= 0 ? 2 : 1;
        for (let dx = -r; dx <= r; dx += 1) {
          for (let dz = -r; dz <= r; dz += 1) {
            if (Math.abs(dx) === r && Math.abs(dz) === r && dy > 0) continue;
            const ly = ground + trunk + dy;
            if (world.get(x + dx, ly, z + dz) === AIR) world.set(x + dx, ly, z + dz, LEAVES);
          }
        }
      }
      world.trees.push({ x, z, baseY: ground, height: trunk });
    }
  }

  const spawn: Vec3 = { x: spawnX + 0.5, y: world.surfaceY(spawnX, spawnZ) + 1, z: spawnZ + 0.5 };
  return { world, spawn };
}
