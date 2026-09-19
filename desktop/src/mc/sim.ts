/**
 * mc/sim.ts — MC 模拟世界引擎（确定性、可复现、可单测）。
 *
 * 这里跑的是**真模拟**而不是播放动画：
 * - 地形是真实体素数据，挖掉就真的消失（`world.count` 会减少）；
 * - 移动走真实 A* 路径，走不过去就如实失败；
 * - 合成有真实材料依赖链（原木→木板→工作台→斧/镐→石/矿）；
 * - 生命值、坠落伤害、受击、死亡掉落与重生都是真实状态机。
 *
 * 与真实 Minecraft 服务端的连接属外部 BLOCKED（需固定 Java/服务端/Mineflayer 版本与账号）。
 * 本引擎不冒充真实服务器；UI 必须同时展示 SIMULATED 与 BLOCKED 两种标注。
 */

import {
  AIR,
  CRAFTING_TABLE,
  DIRT,
  LOG,
  PLANKS,
  WATER,
  canMine,
  isSolid,
  mineDurationMs,
  type BlockId,
  type ToolSet,
} from './blocks';
import { findPath, standHeight, type PathNode } from './pathfind';
import {
  HUT_BLOCK_COST,
  HUT_BLUEPRINT,
  RECIPES,
  type ParsedCommand,
  type Task,
  type TaskKind,
  type TaskStatus,
} from './tasks';
import { generateWorld, VoxelWorld, type Vec3 } from './world';

export type BotStatus = 'idle' | 'moving' | 'mining' | 'placing' | 'crafting' | 'fighting' | 'dead';

export interface McEvent {
  at: number;
  kind: 'task' | 'move' | 'mine' | 'craft' | 'build' | 'damage' | 'death' | 'combat' | 'info';
  text: string;
}

/** 值得告诉用户（由前台接到对话播报）的模拟事件种类。 */
export type McNoticeKind = 'task-done' | 'task-failed' | 'death' | 'retaliate';

export interface BotState {
  /** 脚所在位置（浮点，格中心为 .5）。 */
  x: number;
  y: number;
  z: number;
  status: BotStatus;
  health: number;
  inventory: Partial<Record<BlockId, number>>;
  tools: ToolSet;
  /** 当前挖掘目标与进度（0..1）。 */
  miningTarget: Vec3 | null;
  miningProgress: number;
  /** 当前路径（调试与绘制用）。 */
  path: PathNode[];
  pathIndex: number;
  /** 背包是否已满（用于「背包满」失败路径）。 */
  inventoryFull: boolean;
  deaths: number;
  blocksMined: number;
  blocksPlaced: number;
  distanceWalked: number;
  /** 主动/反击命中次数（战斗统计，UI 与测试用）。 */
  attacks: number;
}

/** 模拟世界里的敌对生物（受击与 PvP 的真实事件源，G-MC-02）。 */
export interface MobState {
  name: string;
  x: number;
  z: number;
  health: number;
  maxHealth: number;
  alive: boolean;
  lastAttackAt: number;
}

/** PvP 配置（DOMAIN_PLUGINS §3.3）：默认保守，关闭时不主动攻击。 */
export interface PvpConfig {
  enabled: boolean;
  retaliate: boolean;
}

export interface PlayerState {
  x: number;
  z: number;
}

export interface SimOptions {
  seed?: number;
  width?: number;
  height?: number;
  depth?: number;
  /** 移动速度（格/秒）。 */
  speed?: number;
  /** 背包容量（不同方块种类数上限）。 */
  inventorySlots?: number;
  /** 是否开启受击（验收矩阵的「受击开关」）。 */
  hostile?: boolean;
  /** PvP 主动攻击开关（默认关）。 */
  pvpEnabled?: boolean;
  /** 被攻击时是否自动反击（默认关；仅在 pvpEnabled 时生效）。 */
  pvpRetaliate?: boolean;
}

const DEFAULT_OPTIONS: Required<SimOptions> = {
  seed: 20240919,
  width: 40,
  height: 24,
  depth: 40,
  speed: 3.2,
  inventorySlots: 12,
  hostile: false,
  pvpEnabled: false,
  pvpRetaliate: false,
};

/** 到达判定阈值（格）。 */
const ARRIVE_EPS = 0.09;
/** 挖掘伸手距离（格）。 */
const REACH = 4.2;
/** 敌对生物参数（模拟参数，不是真实 MC 数值）。 */
const MOB_SPEED = 3.0;
const MOB_ATTACK_RANGE = 2.2;
const MOB_ATTACK_COOLDOWN_MS = 2000;
const MOB_DAMAGE = 2;
const MOB_MAX_HEALTH = 12;
/** 她每次攻击的伤害与出手间隔。 */
const BOT_ATTACK_DAMAGE = 4;
const BOT_ATTACK_COOLDOWN_MS = 500;
/** 低于该生命值时停止战斗并撤离求援。 */
const FLEE_HEALTH = 6;
/**
 * 每次受击后的规避持续时间（毫秒）。刻意很短：规避是「拉开一点距离」而不是
 * 无限逃跑，否则她会一路被追着跑离出生点，重生落点也会失真。
 */
const FLEE_DURATION_MS = 400;

function taskId(seq: number): string {
  return `mc-task-${seq}`;
}

export class McSimulation {
  world: VoxelWorld;
  spawn: Vec3;
  bot: BotState;
  player: PlayerState;
  /** 敌对生物：受击与 PvP 的真实事件源。 */
  mob: MobState;
  /** PvP 配置（运行时可通过 setPvp 切换）。 */
  pvp: PvpConfig;
  readonly tasks: Task[] = [];
  readonly log: McEvent[] = [];
  /** 模拟世界内累计时间（ms）。 */
  timeMs = 0;
  hostile: boolean;
  /**
   * 值得播报的事件出口（会话层接线到 setMcEventListener）。
   * 任务完成/失败、死亡、自动反击都会经此回调，供前台接到对话播报。
   */
  onNotice: ((kind: McNoticeKind, summary: string) => void) | null = null;

  private options: Required<SimOptions>;
  private seq = 0;
  private current: Task | null = null;
  private followRepathAt = 0;
  private respawnAt = 0;
  private craftUntil = 0;
  private buildQueue: Vec3[] = [];
  private depositPending = 0;
  /** B-P-01：搭建任务的「已初始化」标志，必须按任务而非全局计数器判定。 */
  private buildInitialized = false;
  /** 本次搭建任务实际放置的方块数（诚实报告，不复用累计值）。 */
  private buildPlacedForTask = 0;
  /** 攻击任务的重新寻路节流。 */
  private attackRepathAt = 0;
  private nextAttackAt = 0;
  /** 受击后的规避窗口。 */
  private fleeUntil = 0;
  /** 规避日志节流（初值 -Infinity，保证第一次受击就能留下日志）。 */
  private fleeLoggedFor = Number.NEGATIVE_INFINITY;
  /** 背包内累计采集数量（用于任务进度统计，与库存区分：木板会消耗原木）。 */
  private harvested: Partial<Record<BlockId, number>> = {};
  private minedForTask = 0;

  constructor(options: SimOptions = {}) {
    this.world = new VoxelWorld({ width: 1, height: 1, depth: 1, seed: 0 });
    this.spawn = { x: 0.5, y: 1, z: 0.5 };
    this.player = { x: 0.5, z: 0.5 };
    this.bot = {
      x: 0.5,
      y: 1,
      z: 0.5,
      status: 'idle',
      health: 20,
      inventory: {},
      tools: { axe: false, pickaxe: false },
      miningTarget: null,
      miningProgress: 0,
      path: [],
      pathIndex: 0,
      inventoryFull: false,
      deaths: 0,
      blocksMined: 0,
      blocksPlaced: 0,
      distanceWalked: 0,
      attacks: 0,
    };
    this.mob = {
      name: '敌对生物',
      x: 0.5,
      z: 0.5,
      health: MOB_MAX_HEALTH,
      maxHealth: MOB_MAX_HEALTH,
      alive: true,
      lastAttackAt: 0,
    };
    this.pvp = { enabled: false, retaliate: false };
    this.hostile = false;
    this.options = { ...DEFAULT_OPTIONS };
    this.setup(options);
  }

  /**
   * 初始化/重置世界。`reset()` 复用本方法原地重建，避免 session 层用
   * `Object.assign(sim, fresh)` 覆盖实例（那会连事件挂载点一起抹掉，B-P-09）。
   */
  private setup(options: SimOptions): void {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    const generated = generateWorld({
      width: this.options.width,
      height: this.options.height,
      depth: this.options.depth,
      seed: this.options.seed,
    });
    this.world = generated.world;
    this.spawn = generated.spawn;
    this.player = { x: generated.spawn.x + 4, z: generated.spawn.z + 3 };
    this.hostile = this.options.hostile;
    this.pvp = { enabled: this.options.pvpEnabled, retaliate: this.options.pvpRetaliate };
    this.bot.x = generated.spawn.x;
    this.bot.y = generated.spawn.y;
    this.bot.z = generated.spawn.z;
    this.bot.status = 'idle';
    this.bot.health = 20;
    this.bot.inventory = {};
    this.bot.tools = { axe: false, pickaxe: false };
    this.bot.miningTarget = null;
    this.bot.miningProgress = 0;
    this.bot.path = [];
    this.bot.pathIndex = 0;
    this.bot.deaths = 0;
    this.bot.blocksMined = 0;
    this.bot.blocksPlaced = 0;
    this.bot.distanceWalked = 0;
    this.bot.attacks = 0;
    this.mob.x = generated.spawn.x - 5;
    this.mob.z = generated.spawn.z + 4;
    this.mob.health = MOB_MAX_HEALTH;
    this.mob.alive = true;
    this.mob.lastAttackAt = 0;
    this.tasks.length = 0;
    this.log.length = 0;
    this.timeMs = 0;
    this.seq = 0;
    this.current = null;
    this.followRepathAt = 0;
    this.respawnAt = 0;
    this.craftUntil = 0;
    this.buildQueue = [];
    this.depositPending = 0;
    this.buildInitialized = false;
    this.buildPlacedForTask = 0;
    this.attackRepathAt = 0;
    this.nextAttackAt = 0;
    this.fleeUntil = 0;
    this.fleeLoggedFor = Number.NEGATIVE_INFINITY;
    this.harvested = {};
    this.minedForTask = 0;
    // inventoryFull 是派生量：库存被任何路径改动后都必须立刻正确。
    // 作为普通字段维护时，绕过 addItem/takeItem 的改动会让它长期失真。
    Object.defineProperty(this.bot, 'inventoryFull', {
      get: () => this.inventoryKinds() >= this.options.inventorySlots,
      enumerable: true,
      configurable: true,
    });
    this.pushEvent('info', `模拟世界已生成（seed=${this.options.seed}，${this.options.width}×${this.options.depth}）`);
  }

  /** 重置为同 seed 的全新世界（验收可复现），并保留事件挂载点。 */
  reset(options: SimOptions = {}): void {
    this.setup(options);
  }

  /** 运行时切换 PvP（DOMAIN_PLUGINS §3.3）。关闭时不主动攻击。 */
  setPvp(enabled: boolean, retaliate: boolean): void {
    this.pvp = { enabled, retaliate: enabled ? retaliate : false };
  }

  /** 测试/调试：移动敌对生物位置。 */
  moveMob(x: number, z: number): void {
    this.mob.x = x;
    this.mob.z = z;
  }

  /* ---------------- 事件与任务 ---------------- */

  private pushEvent(kind: McEvent['kind'], text: string): void {
    this.log.unshift({ at: this.timeMs, kind, text });
    if (this.log.length > 120) this.log.pop();
  }

  /** 入队一个任务；返回任务对象（含 id，便于 UI 追踪）。 */
  enqueue(command: ParsedCommand): Task {
    this.seq += 1;
    const task: Task = {
      id: taskId(this.seq),
      kind: command.kind,
      label: command.label,
      params: { ...command.params },
      status: 'queued',
      progress: 0,
      note: '',
      createdAt: this.timeMs,
      finishedAt: null,
    };
    this.tasks.unshift(task);
    if (this.tasks.length > 40) this.tasks.pop();
    this.pushEvent('task', `任务入队：${task.label}`);
    return task;
  }

  private finish(task: Task, status: TaskStatus, note: string): void {
    task.status = status;
    task.note = note;
    task.progress = 1;
    task.finishedAt = this.timeMs;
    this.pushEvent(status === 'done' ? 'task' : 'info', `${task.label} → ${status === 'done' ? '完成' : '失败'}：${note}`);
    if (status === 'done' || status === 'failed') {
      this.onNotice?.(status === 'done' ? 'task-done' : 'task-failed', `${task.label}：${note}`);
    }
    this.current = null;
    // B-P-02：把**全部**任务态一并重置。只清 miningTarget/path 会留下
    // craftUntil/depositPending 等残留计时器，下一条同类任务会跳过材料校验
    // 或跳过等待，直接「完成」——那是谎报。
    this.resetTaskState();
  }

  /** 任务级状态清理（finish 与新任务开始时共用）。 */
  private resetTaskState(): void {
    this.bot.miningTarget = null;
    this.bot.miningProgress = 0;
    this.bot.path = [];
    this.bot.pathIndex = 0;
    this.buildQueue = [];
    this.craftUntil = 0;
    this.depositPending = 0;
    this.minedForTask = 0;
    this.buildInitialized = false;
    this.buildPlacedForTask = 0;
    this.followRepathAt = 0;
    this.attackRepathAt = 0;
    this.nextAttackAt = 0;
  }

  /** 停止：取消当前与排队任务（急停，对应验收矩阵的「停止」）。 */
  cancelAll(): void {
    if (this.current) this.finish(this.current, 'cancelled', '被停止指令取消');
    for (const task of this.tasks) {
      if (task.status === 'queued') {
        task.status = 'cancelled';
        task.note = '被停止指令取消';
        task.finishedAt = this.timeMs;
      }
    }
    this.bot.status = 'idle';
    this.pushEvent('task', '已停止：队列清空，动作中断');
  }

  get currentTask(): Task | null {
    return this.current;
  }

  /** 背包总格数（用于 UI 与「背包满」判定）。 */
  inventoryKinds(): number {
    return Object.values(this.bot.inventory).filter((n) => (n ?? 0) > 0).length;
  }

  private addItem(id: BlockId, count: number): void {
    this.bot.inventory[id] = (this.bot.inventory[id] ?? 0) + count;
  }

  private takeItem(id: BlockId, count: number): boolean {
    const have = this.bot.inventory[id] ?? 0;
    if (have < count) return false;
    const left = have - count;
    if (left > 0) this.bot.inventory[id] = left;
    else delete this.bot.inventory[id];
    return true;
  }

  hasItem(id: BlockId, count = 1): boolean {
    return (this.bot.inventory[id] ?? 0) >= count;
  }

  /* ---------------- 移动 ---------------- */

  private setPath(target: { x: number; z: number }): boolean {
    // 参考高度用她「真正站立的那一层」：bot.y 在台阶过渡期间是插值中间值，
    // 拿它当参考会让「可达层」判定漂移，甚至把旁边的树判定为够不着。
    const refY =
      standHeight(this.world, Math.floor(this.bot.x), Math.floor(this.bot.z), Math.round(this.bot.y)) ??
      Math.round(this.bot.y);
    const result = findPath(this.world, { x: this.bot.x, y: refY, z: this.bot.z }, target);
    if (!result) {
      this.bot.path = [];
      this.bot.pathIndex = 0;
      return false;
    }
    this.bot.path = result.nodes;
    this.bot.pathIndex = 0;
    return true;
  }

  /** 沿路径推进；返回 'arrived' | 'moving' | 'blocked'。 */
  private advance(dtMs: number): 'arrived' | 'moving' | 'blocked' {
    if (this.bot.pathIndex >= this.bot.path.length) return 'arrived';
    const node = this.bot.path[this.bot.pathIndex];
    const targetY = standHeight(this.world, node.x, node.z, Math.round(this.bot.y));
    if (targetY === null) {
      // 路径上的格子在行进途中被改坏（例如被放置了方块）→ 重新寻路
      this.bot.path = [];
      return 'blocked';
    }
    const tx = node.x + 0.5;
    const tz = node.z + 0.5;
    const dx = tx - this.bot.x;
    const dz = tz - this.bot.z;
    const dist = Math.hypot(dx, dz);
    const step = (this.options.speed * dtMs) / 1000;
    if (dist <= Math.max(step, ARRIVE_EPS)) {
      this.bot.x = tx;
      this.bot.z = tz;
      this.bot.y = targetY;
      this.bot.pathIndex += 1;
      if (this.bot.pathIndex >= this.bot.path.length) return 'arrived';
      return 'moving';
    }
    const nx = this.bot.x + (dx / dist) * step;
    const nz = this.bot.z + (dz / dist) * step;
    this.bot.distanceWalked += Math.hypot(nx - this.bot.x, nz - this.bot.z);
    this.bot.x = nx;
    this.bot.z = nz;
    // 平滑抬升/下落（台阶高度差）
    this.bot.y += (targetY - this.bot.y) * Math.min(1, step * 2.2);
    return 'moving';
  }

  /** 返回 true 表示这一下打死了她（调用方必须立刻停止推进本 tick）。 */
  private damage(amount: number, reason: string): boolean {
    if (this.bot.status === 'dead') return true;
    this.bot.health = Math.max(0, this.bot.health - amount);
    this.pushEvent('damage', `受到 ${amount} 点伤害（${reason}），剩余生命 ${this.bot.health}`);
    if (this.bot.health <= 0) {
      this.bot.status = 'dead';
      this.bot.deaths += 1;
      this.bot.inventory = {};
      this.bot.tools = { axe: false, pickaxe: false };
      this.bot.miningTarget = null;
      this.bot.miningProgress = 0;
      this.respawnAt = this.timeMs + 2000;
      this.pushEvent('death', '生命归零：背包掉落，2 秒后在出生点重生');
      this.onNotice?.('death', '我在游戏里被击倒了：背包掉落，稍后在出生点重生。');
      if (this.current) this.finish(this.current, 'failed', '死亡中断');
      return true;
    }
    this.reactToHit();
    return false;
  }

  /**
   * 受击反应（G-MC-02，纯本地状态机，不逐帧调用 LLM）：
   * - PvP 开启且允许反击 → 自动还手（入队 attack 任务）；
   * - 否则只规避不还手；生命值过低时一律撤离并求援。
   */
  private reactToHit(): void {
    const lowHealth = this.bot.health <= FLEE_HEALTH;
    if (!lowHealth && this.pvp.enabled && this.pvp.retaliate) {
      const alreadyFighting =
        this.current?.kind === 'attack' ||
        this.tasks.some((task) => task.status === 'queued' && task.kind === 'attack');
      if (!alreadyFighting) {
        this.enqueue({ kind: 'attack', params: { target: 'mob' }, label: '反击敌对生物' });
        this.pushEvent('combat', '被攻击：PvP 反击已开启，立刻还手');
        this.onNotice?.('retaliate', '我在游戏里被攻击了，正在反击。');
      }
      return;
    }
    this.fleeUntil = this.timeMs + FLEE_DURATION_MS;
    if (this.timeMs - this.fleeLoggedFor < 1500) return;
    this.fleeLoggedFor = this.timeMs;
    if (lowHealth) {
      this.pushEvent('combat', `生命值偏低（${this.bot.health}/20）：停止战斗，撤离并求援`);
      this.onNotice?.('retaliate', `我在游戏里血量只剩 ${this.bot.health}，先撤了，需要支援。`);
    } else {
      this.pushEvent('combat', 'PvP 关闭：只规避不还手（撤回出生点躲避）');
    }
  }

  /**
   * 规避：撤回出生点（家）躲避，而不是无限远离威胁。
   * 这样落点有界、可复现；被追着跑离出生点会让重生落点失真。
   */
  private fleeStep(dtMs: number): void {
    const dx = this.spawn.x - this.bot.x;
    const dz = this.spawn.z - this.bot.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1) return;
    const step = Math.min((this.options.speed * dtMs) / 1000, dist);
    const nx = this.bot.x + (dx / dist) * step;
    const nz = this.bot.z + (dz / dist) * step;
    this.bot.distanceWalked += Math.hypot(nx - this.bot.x, nz - this.bot.z);
    this.bot.x = nx;
    this.bot.z = nz;
    const standY = standHeight(this.world, Math.floor(nx), Math.floor(nz), Math.round(this.bot.y));
    if (standY !== null) this.bot.y += (standY - this.bot.y) * 0.3;
    this.bot.path = [];
    this.bot.pathIndex = 0;
  }

  /** 敌对生物追击并攻击（受击开关开启时）；返回 true 表示这一下打死了她。 */
  private stepMob(dtMs: number): boolean {
    if (!this.mob.alive) return false;
    const dx = this.bot.x - this.mob.x;
    const dz = this.bot.z - this.mob.z;
    const dist = Math.hypot(dx, dz);
    if (dist > MOB_ATTACK_RANGE) {
      const step = Math.min((MOB_SPEED * dtMs) / 1000, dist - MOB_ATTACK_RANGE + 0.01);
      if (dist > 0) {
        this.mob.x += (dx / dist) * step;
        this.mob.z += (dz / dist) * step;
      }
      return false;
    }
    if (this.timeMs - this.mob.lastAttackAt < MOB_ATTACK_COOLDOWN_MS) return false;
    this.mob.lastAttackAt = this.timeMs;
    // 这一下可能正好打死她：死亡状态必须立刻生效并进入重生倒计时。
    return this.damage(MOB_DAMAGE, '附近有敌对生物攻击');
  }

  /** 她攻击敌对生物一次；返回是否击倒目标。 */
  private botAttack(): boolean {
    this.mob.health = Math.max(0, this.mob.health - BOT_ATTACK_DAMAGE);
    this.bot.attacks += 1;
    this.pushEvent('combat', `命中${this.mob.name}（剩余生命 ${this.mob.health}）`);
    if (this.mob.health <= 0) {
      this.mob.alive = false;
      this.pushEvent('combat', `${this.mob.name}已被击退`);
      return true;
    }
    return false;
  }

  private respawn(): void {
    this.bot.x = this.spawn.x;
    this.bot.y = this.spawn.y;
    this.bot.z = this.spawn.z;
    this.bot.health = 20;
    this.bot.status = 'idle';
    this.pushEvent('death', '已在出生点重生（生命恢复 20）');
  }

  /* ---------------- 主循环 ---------------- */

  /** 固定步长推进。dtMs 建议 16–100；内部按需拆分为 ≤100ms 子步，保证大 dt 也稳定。 */
  tick(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return;
    let remaining = Math.min(dtMs, 2000);
    while (remaining > 0) {
      const step = Math.min(remaining, 100);
      this.stepOnce(step);
      remaining -= step;
    }
  }

  private stepOnce(dtMs: number): void {
    this.timeMs += dtMs;

    if (this.bot.status === 'dead') {
      if (this.timeMs >= this.respawnAt) this.respawn();
      return;
    }

    // 受击开关开启时，敌对生物会真实追击并攻击（受击反应见 reactToHit）。
    if (this.hostile && this.stepMob(dtMs)) {
      // 这一下正好打死她：死亡状态必须立刻生效并进入重生倒计时，
      // 否则会被下面的「无任务 → idle」分支覆盖，导致血量永远停在 0 且永不重生。
      return;
    }

    // 规避窗口优先于任务推进（PvP 关闭或低血量时只规避不还手）。
    if (this.timeMs < this.fleeUntil) {
      this.bot.status = 'moving';
      this.fleeStep(dtMs);
      return;
    }

    if (!this.current) {
      const next = this.tasks.find((task) => task.status === 'queued');
      if (!next) {
        this.bot.status = 'idle';
        return;
      }
      next.status = 'running';
      this.current = next;
      // 新任务从干净的任务态开始：清掉上一条任务的残留计时器与队列。
      this.resetTaskState();
    }

    const task = this.current;
    switch (task.kind) {
      case 'stop':
        this.finish(task, 'done', '已停止');
        this.bot.status = 'idle';
        return;
      case 'follow':
        this.stepFollow(task, dtMs);
        return;
      case 'goto':
        this.stepGoto(task, dtMs);
        return;
      case 'gather':
      case 'mine':
        this.stepGather(task, dtMs);
        return;
      case 'craft':
        this.stepCraft(task, dtMs);
        return;
      case 'build':
        this.stepBuild(task, dtMs);
        return;
      case 'deposit':
        this.stepDeposit(task, dtMs);
        return;
      case 'attack':
        this.stepAttack(task, dtMs);
        return;
      default:
        this.finish(task, 'failed', `未知任务类型 ${String(task.kind)}`);
    }
  }

  /* ---------------- 各任务状态机 ---------------- */

  private stepFollow(task: Task, dtMs: number): void {
    this.bot.status = 'moving';
    const goal = { x: Math.floor(this.player.x), z: Math.floor(this.player.z) };
    const needRepath =
      this.bot.pathIndex >= this.bot.path.length ||
      this.timeMs >= this.followRepathAt ||
      (this.bot.path.length > 0 &&
        Math.hypot(this.bot.path[this.bot.path.length - 1].x - goal.x, this.bot.path[this.bot.path.length - 1].z - goal.z) > 1.5);
    if (needRepath) {
      this.followRepathAt = this.timeMs + 600;
      if (!this.setPath(goal)) {
        task.note = '暂时走不到你那里（被地形挡住）';
        task.progress = 0.5;
        return;
      }
    }
    const state = this.advance(dtMs);
    if (state === 'blocked') this.followRepathAt = 0;
    const distToPlayer = Math.hypot(this.bot.x - this.player.x, this.bot.z - this.player.z);
    task.progress = Math.max(0, Math.min(0.95, 1 - distToPlayer / 24));
    task.note = distToPlayer < 2.5 ? '就在你身边' : `距离你 ${distToPlayer.toFixed(1)} 格`;
  }

  private stepGoto(task: Task, dtMs: number): void {
    const target = task.params.target === 'home' ? { x: this.spawn.x, z: this.spawn.z } : null;
    if (!target) {
      this.finish(task, 'failed', '未知目的地');
      return;
    }
    this.bot.status = 'moving';
    if (this.bot.pathIndex >= this.bot.path.length && this.bot.path.length === 0) {
      if (Math.hypot(this.bot.x - target.x, this.bot.z - target.z) < 1.2) {
        this.finish(task, 'done', '已回到出生点');
        this.bot.status = 'idle';
        return;
      }
      if (!this.setPath(target)) {
        this.finish(task, 'failed', '找不到通往出生点的路');
        return;
      }
    }
    const state = this.advance(dtMs);
    const remaining = Math.hypot(this.bot.x - target.x, this.bot.z - target.z);
    task.progress = Math.max(0, Math.min(0.99, 1 - remaining / 20));
    if (state === 'arrived') {
      // 诚实报告落点：地形可能只让她走到出生点附近（例如中间隔着落差）。
      this.finish(
        task,
        'done',
        remaining <= 1.5
          ? '已回到出生点'
          : `已到达最近可达位置（距出生点 ${remaining.toFixed(1)} 格，中间地形过不去）`,
      );
      this.bot.status = 'idle';
    } else if (state === 'blocked') {
      if (!this.setPath(target)) this.finish(task, 'failed', '路径被阻断');
    }
  }

  private stepGather(task: Task, dtMs: number): void {
    const block = task.params.block as BlockId;
    const want = (task.params.count as number) ?? 8;
    if (this.minedForTask >= want) {
      this.finish(task, 'done', `已获得 ${this.minedForTask} 个${blockLabelSafe(block)}`);
      this.bot.status = 'idle';
      return;
    }
    if (this.bot.inventoryFull) {
      this.finish(task, 'failed', '背包已满，先让我「把背包收进箱子」');
      return;
    }

    // 正在挖：推进进度
    if (this.bot.miningTarget) {
      const target = this.bot.miningTarget;
      const currentId = this.world.get(target.x, target.y, target.z);
      if (currentId === AIR) {
        // 目标已被挖掉（不该发生，但如实处理）
        this.bot.miningTarget = null;
        this.bot.miningProgress = 0;
        return;
      }
      this.bot.status = 'mining';
      const duration = mineDurationMs(currentId, this.bot.tools);
      this.bot.miningProgress += dtMs / duration;
      task.progress = Math.min(0.99, (this.minedForTask + this.bot.miningProgress) / want);
      if (this.bot.miningProgress < 1) {
        task.note = `正在挖${blockLabelSafe(currentId)}（${Math.round(this.bot.miningProgress * 100)}%）`;
        return;
      }
      this.world.set(target.x, target.y, target.z, AIR);
      const def = this.world ? null : null;
      void def;
      this.harvested[currentId] = (this.harvested[currentId] ?? 0) + 1;
      this.minedForTask += 1;
      this.bot.blocksMined += 1;
      this.bot.miningTarget = null;
      this.bot.miningProgress = 0;
      // 掉落物入包（草→土等按 blocks 表）
      const drop = dropOf(currentId);
      if (drop !== null) this.addItem(drop, 1);
      this.pushEvent('mine', `挖掉一个${blockLabelSafe(currentId)}（世界内该方块剩余 ${this.world.count(currentId)}）`);
      if (this.minedForTask >= want) {
        this.finish(task, 'done', `已获得 ${this.minedForTask} 个${blockLabelSafe(block)}`);
        this.bot.status = 'idle';
      }
      return;
    }

    // 找最近的同类方块
    const found = this.world.findNearest(
      { x: this.bot.x, y: this.bot.y, z: this.bot.z },
      (id) => id === block,
      24,
    );
    if (!found) {
      this.finish(task, 'failed', `世界内找不到${blockLabelSafe(block)}（已采集 ${this.minedForTask} 个）`);
      return;
    }
    const mineable = canMine(block, this.bot.tools);
    if (!mineable.ok) {
      this.finish(task, 'failed', mineable.reason ?? '工具不足');
      return;
    }

    const dist = Math.hypot(found.x + 0.5 - this.bot.x, found.z + 0.5 - this.bot.z);
    // 已经伸手可及：直接开挖。
    if (dist <= REACH) {
      this.bot.miningTarget = found;
      this.bot.miningProgress = 0;
      return;
    }
    // 只在「没有可用路径」时重新寻路。
    // 之前把「距离 > 伸手距离」也当成重新寻路条件，导致每 tick 都重新规划、
    // 永远走不到 advance()，bot 原地卡死（任务永远 running）。
    if (this.bot.pathIndex >= this.bot.path.length) {
      const ok = this.setPath({ x: found.x, z: found.z });
      if (!ok) {
        this.finish(task, 'failed', `${blockLabelSafe(block)} 走不过去（无可行路径）`);
        return;
      }
      if (this.bot.path.length === 0) {
        // 空路径 = 已经站在可达的最近格子上，但仍在伸手距离之外
        this.finish(
          task,
          'failed',
          `最近的${blockLabelSafe(block)}在 ${dist.toFixed(1)} 格外，超出伸手距离（${REACH} 格）`,
        );
        return;
      }
      task.note = `前往最近的${blockLabelSafe(block)}（${dist.toFixed(1)} 格外）`;
    }

    this.bot.status = 'moving';
    const state = this.advance(dtMs);
    if (state === 'arrived') {
      const nowDist = Math.hypot(found.x + 0.5 - this.bot.x, found.z + 0.5 - this.bot.z);
      if (nowDist <= REACH) {
        this.bot.miningTarget = found;
        this.bot.miningProgress = 0;
      } else if (!this.setPath({ x: found.x, z: found.z })) {
        this.finish(task, 'failed', `${blockLabelSafe(block)} 走不过去（无可行路径）`);
      } else if (this.bot.path.length === 0) {
        this.finish(
          task,
          'failed',
          `最近的${blockLabelSafe(block)}在 ${nowDist.toFixed(1)} 格外，超出伸手距离（${REACH} 格）`,
        );
      }
    } else if (state === 'blocked') {
      if (!this.setPath({ x: found.x, z: found.z })) {
        this.finish(task, 'failed', `${blockLabelSafe(block)} 走不过去（路径被阻断）`);
      }
    }
  }

  private stepCraft(task: Task, dtMs: number): void {
    const item = String(task.params.item ?? 'planks');
    const recipe = RECIPES[item];
    if (!recipe) {
      this.finish(task, 'failed', `没有「${item}」的配方`);
      return;
    }
    if (this.craftUntil === 0) {
      // 首次进入：检查材料（缺什么就如实说缺什么）
      if (recipe.needsTable && !this.hasItem(CRAFTING_TABLE)) {
        this.finish(task, 'failed', '需要先合成并带着工作台');
        return;
      }
      const missing: string[] = [];
      for (const need of recipe.cost) {
        if (!this.hasItem(need.block, need.count)) {
          missing.push(`${blockLabelSafe(need.block)}×${need.count - (this.bot.inventory[need.block] ?? 0)}`);
        }
      }
      if (missing.length > 0) {
        this.finish(task, 'failed', `材料不足：还缺 ${missing.join('、')}`);
        return;
      }
      this.craftUntil = this.timeMs + 500;
      this.bot.status = 'crafting';
      task.note = `合成中（${recipe.label}）`;
      return;
    }
    task.progress = Math.min(0.99, 1 - (this.craftUntil - this.timeMs) / 500);
    if (this.timeMs < this.craftUntil) return;
    for (const need of recipe.cost) this.takeItem(need.block, need.count);
    if (recipe.output.tool) {
      this.bot.tools[recipe.output.tool] = true;
      this.pushEvent('craft', `合成出${recipe.label}（现在可以${recipe.output.tool === 'axe' ? '砍树' : '挖石头/矿'}了）`);
    } else if (recipe.output.block !== undefined) {
      this.addItem(recipe.output.block, recipe.output.count ?? 1);
      this.pushEvent('craft', `合成出${recipe.output.count ?? 1} 个${recipe.label}`);
    }
    this.craftUntil = 0;
    this.finish(task, 'done', `合成完成：${recipe.label}`);
    this.bot.status = 'idle';
  }

  private stepBuild(task: Task, dtMs: number): void {
    // B-P-01：首次判定必须是**任务级标志**。之前用 `blocksPlaced === 0`，
    // 第二次搭建时（她已放过方块）会跳过初始化，buildQueue 为空 →
    // 立刻「小屋搭好了（放置 N 个方块）」，把上一条任务的成果谎报成本次成果。
    if (!this.buildInitialized) {
      this.buildInitialized = true;
      if (!this.hasItem(PLANKS, HUT_BLOCK_COST)) {
        this.finish(task, 'failed', `材料不足：小屋需要 ${HUT_BLOCK_COST} 个木板，现有 ${this.bot.inventory[PLANKS] ?? 0} 个`);
        return;
      }
      // 在 bot 面前找一块平地作为锚点
      const anchorX = Math.round(this.bot.x) + 1;
      const anchorZ = Math.round(this.bot.z);
      const anchorY = this.world.surfaceY(anchorX, anchorZ) + 1;
      const queue: Vec3[] = [];
      for (const cell of HUT_BLUEPRINT) {
        const pos = { x: anchorX + cell.dx, y: anchorY + cell.dy, z: anchorZ + cell.dz };
        if (this.world.get(pos.x, pos.y, pos.z) === AIR) queue.push(pos);
      }
      this.buildQueue = queue;
      this.buildPlacedForTask = 0;
      task.note = `开始搭建：需要放置 ${queue.length} 个方块`;
      this.pushEvent('build', `开始搭建小屋（锚点 ${anchorX},${anchorY},${anchorZ}，${queue.length} 个方块）`);
      if (queue.length === 0) {
        this.finish(task, 'done', '目标位置已被方块占满，本次未放置任何方块');
        this.bot.status = 'idle';
        return;
      }
    }

    if (this.buildQueue.length === 0) {
      this.finish(task, 'done', this.buildNote());
      this.bot.status = 'idle';
      return;
    }
    task.progress = Math.min(0.99, this.buildPlacedForTask / Math.max(1, HUT_BLOCK_COST));
    this.bot.status = 'placing';
    // 每 tick 放一块（有节奏，便于观察；不是瞬移式一次性铺满）
    const target = this.buildQueue[0];
    const dist = Math.hypot(target.x + 0.5 - this.bot.x, target.z + 0.5 - this.bot.z);
    if (dist > REACH) {
      // 同 stepGather：只在没有可用路径时重新规划，否则会每 tick 重规划而永不推进。
      if (this.bot.pathIndex >= this.bot.path.length) {
        if (!this.setPath({ x: target.x, z: target.z })) {
          this.finish(task, 'failed', '搭建点走不过去');
          return;
        }
        if (this.bot.path.length === 0) {
          this.finish(task, 'failed', `搭建点在 ${dist.toFixed(1)} 格外，超出伸手距离`);
          return;
        }
      }
      this.bot.status = 'moving';
      const state = this.advance(dtMs);
      if (state === 'blocked') {
        if (!this.setPath({ x: target.x, z: target.z })) this.finish(task, 'failed', '搭建点路径被阻断');
      }
      return;
    }
    if (!this.hasItem(PLANKS, 1)) {
      this.finish(task, 'failed', `木板用完了（还差 ${this.buildQueue.length} 个方块的材料）`);
      return;
    }
    if (this.world.get(target.x, target.y, target.z) === AIR) {
      this.world.set(target.x, target.y, target.z, PLANKS);
      this.takeItem(PLANKS, 1);
      this.bot.blocksPlaced += 1;
      this.buildPlacedForTask += 1;
    }
    this.buildQueue.shift();
    task.progress = Math.min(0.99, this.buildPlacedForTask / Math.max(1, HUT_BLOCK_COST));
    if (this.buildQueue.length === 0) {
      this.finish(task, 'done', this.buildNote());
      this.bot.status = 'idle';
    }
  }

  /** 搭建完成文案：只报告**本次任务**放置的方块数，不复用累计值。 */
  private buildNote(): string {
    return this.buildPlacedForTask > 0
      ? `小屋搭好了（本次放置 ${this.buildPlacedForTask} 个方块）`
      : '没有需要放置的方块（本次放置 0 个）';
  }

  /**
   * 攻击/反击敌对生物（G-MC-02）。PvP 关闭时不执行（如实失败），
   * 生命值过低时停止战斗并撤离求援。
   */
  private stepAttack(task: Task, dtMs: number): void {
    if (!this.pvp.enabled) {
      this.finish(task, 'failed', 'PvP 已关闭：不主动攻击（开启后才会还手）');
      this.bot.status = 'idle';
      return;
    }
    if (!this.mob.alive) {
      this.finish(task, 'failed', '附近没有可攻击的目标');
      this.bot.status = 'idle';
      return;
    }
    if (this.bot.health <= FLEE_HEALTH) {
      this.fleeUntil = this.timeMs + FLEE_DURATION_MS * 2;
      this.finish(task, 'failed', `生命值过低（${this.bot.health}/20）：停止攻击并撤离求援`);
      this.bot.status = 'moving';
      return;
    }

    const dist = Math.hypot(this.mob.x - this.bot.x, this.mob.z - this.bot.z);
    if (dist > REACH) {
      this.bot.status = 'moving';
      const goal = { x: Math.floor(this.mob.x), z: Math.floor(this.mob.z) };
      const needRepath = this.bot.pathIndex >= this.bot.path.length || this.timeMs >= this.attackRepathAt;
      if (needRepath) {
        this.attackRepathAt = this.timeMs + 600;
        if (!this.setPath(goal)) {
          task.note = '走不到目标那里（被地形挡住）';
          task.progress = 0.4;
          return;
        }
      }
      const state = this.advance(dtMs);
      if (state === 'blocked') this.attackRepathAt = 0;
      task.progress = 0.4;
      task.note = `接近${this.mob.name}（${dist.toFixed(1)} 格外）`;
      return;
    }

    this.bot.status = 'fighting';
    if (this.timeMs < this.nextAttackAt) {
      task.progress = 0.8;
      task.note = `正在与${this.mob.name}交战`;
      return;
    }
    this.nextAttackAt = this.timeMs + BOT_ATTACK_COOLDOWN_MS;
    const downed = this.botAttack();
    if (downed) {
      this.finish(task, 'done', `已击退${this.mob.name}（命中 ${this.bot.attacks} 次）`);
      this.bot.status = 'idle';
      return;
    }
    task.progress = 0.8;
    task.note = `命中${this.mob.name}（剩余生命 ${this.mob.health}）`;
  }

  private stepDeposit(task: Task, dtMs: number): void {
    if (this.depositPending === 0) {
      this.depositPending = this.timeMs + 600;
      this.bot.status = 'crafting';
      task.note = '把背包里的东西收进箱子…';
      return;
    }
    task.progress = Math.min(0.99, 1 - (this.depositPending - this.timeMs) / 600);
    if (this.timeMs < this.depositPending) return;
    const moved: string[] = [];
    for (const [key, value] of Object.entries(this.bot.inventory)) {
      const id = Number(key) as BlockId;
      if ((value ?? 0) > 0) moved.push(`${blockLabelSafe(id)}×${value}`);
    }
    this.bot.inventory = {};
    this.depositPending = 0;
    this.finish(task, 'done', moved.length > 0 ? `已收纳：${moved.join('、')}` : '背包本来就是空的');
    this.bot.status = 'idle';
  }

  /* ---------------- 观察与调试 ---------------- */

  /** 玩家（用户）位置移动：跟随任务的真实目标。 */
  movePlayer(x: number, z: number): void {
    this.player.x = x;
    this.player.z = z;
  }

  /** 世界内某方块总量（验收断言用：采集后必须减少）。 */
  countBlock(id: BlockId): number {
    return this.world.count(id);
  }

  /** 背包快照（UI 渲染用，避免直接改内部对象）。 */
  inventoryList(): { id: BlockId; name: string; count: number }[] {
    return Object.entries(this.bot.inventory)
      .map(([key, value]) => ({ id: Number(key) as BlockId, name: blockLabelSafe(Number(key) as BlockId), count: value ?? 0 }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count);
  }

  /** 俯视地图快照：返回最高非空气方块（供 canvas 绘制）。 */
  topMap(): { id: BlockId; y: number }[] {
    const out: { id: BlockId; y: number }[] = new Array(this.world.width * this.world.depth);
    for (let x = 0; x < this.world.width; x += 1) {
      for (let z = 0; z < this.world.depth; z += 1) {
        let id: BlockId = AIR;
        let topY = 0;
        for (let y = this.world.height - 1; y >= 0; y -= 1) {
          const cell = this.world.get(x, y, z);
          if (cell !== AIR) {
            id = cell;
            topY = y;
            break;
          }
        }
        out[z * this.world.width + x] = { id, y: topY };
      }
    }
    return out;
  }

  /** 侧视剖面（沿 bot 所在 z 行）：返回每列最高方块，用于立面小图。 */
  sideProfile(z: number): { id: BlockId; y: number }[] {
    const out: { id: BlockId; y: number }[] = [];
    for (let x = 0; x < this.world.width; x += 1) {
      let id: BlockId = AIR;
      let topY = 0;
      for (let y = this.world.height - 1; y >= 0; y -= 1) {
        const cell = this.world.get(x, y, z);
        if (cell !== AIR) {
          id = cell;
          topY = y;
          break;
        }
      }
      out.push({ id, y: topY });
    }
    return out;
  }

  /** 世界内可站立判定（调试）。 */
  isStandableAt(x: number, y: number, z: number): boolean {
    return isSolid(this.world.get(x, y - 1, z)) && this.world.get(x, y, z) === AIR && this.world.get(x, y + 1, z) === AIR;
  }

  /** 供 UI 显示：当前世界里的水格数（用于确认地形稳定）。 */
  waterCount(): number {
    return this.world.count(WATER);
  }
}

/* ------------------------------------------------------------------ */
/* 局部工具                                                            */
/* ------------------------------------------------------------------ */

function blockLabelSafe(id: BlockId): string {
  // 延迟引入避免循环依赖：blocks 表里已有名称
  const names: Record<number, string> = {
    0: '空气',
    1: '草方块',
    2: '泥土',
    3: '石头',
    4: '原木',
    5: '树叶',
    6: '水',
    7: '煤矿石',
    8: '铁矿石',
    9: '木板',
    10: '工作台',
  };
  return names[id] ?? '方块';
}

function dropOf(id: BlockId): BlockId | null {
  const drops: Record<number, BlockId | null> = {
    1: DIRT,
    2: DIRT,
    3: 3,
    4: LOG,
    5: null,
    6: null,
    7: 7,
    8: 8,
    9: PLANKS,
    10: CRAFTING_TABLE,
  };
  return id in drops ? drops[id] : null;
}

export type { Task, TaskKind };
