/**
 * MC 模拟世界的 P0 回归与新增能力（G-MC-02 / B-P-01 / B-P-02 / 事件挂载点）。
 *
 * 目的：证明「二次搭建不谎报」「合成/收纳取消后重进正常」「被打/反击走真实状态机
 * 且受 PvP 开关约束」——任何一条退回「假装成功」都会在这里失败。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIR, LOG, PLANKS } from '../../src/mc/blocks';
import { McSimulation } from '../../src/mc/sim';
import {
  applyCommand,
  maybeHandleMcCommand,
  mcSession,
  resetSimulation,
  setMcEventListener,
  setPvp,
  setRunning,
  sim,
} from '../../src/mc/session';
import { HUT_BLOCK_COST, parseMcCommand } from '../../src/mc/tasks';

function makeSim(opts = {}): McSimulation {
  return new McSimulation({ seed: 20240919, width: 32, height: 20, depth: 32, ...opts });
}

function runUntilDone(sim: McSimulation, limitMs = 60000, stepMs = 50): number {
  let elapsed = 0;
  while (elapsed < limitMs) {
    sim.tick(stepMs);
    elapsed += stepMs;
    const task = sim.tasks[0];
    if (task && (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')) {
      return elapsed;
    }
  }
  return elapsed;
}

beforeEach(() => {
  resetSimulation({ seed: 20240919, width: 24, height: 18, depth: 24 });
  setRunning(true);
  setPvp(false, false);
  setMcEventListener(null);
});

describe('B-P-01 二次搭建不谎报', () => {
  it('第二次搭建只报告本次放置数，绝不复用累计 blocksPlaced', () => {
    const sim = makeSim();
    sim.bot.inventory[PLANKS] = HUT_BLOCK_COST * 3;
    sim.enqueue({ kind: 'build', params: { structure: 'hut' }, label: '搭一间小屋' });
    runUntilDone(sim, 60000);
    expect(sim.tasks[0].status).toBe('done');
    const firstPlaced = sim.bot.blocksPlaced;
    expect(firstPlaced).toBeGreaterThan(0);

    // 第二次搭建：旧实现会因 blocksPlaced!==0 跳过初始化，直接
    // 「小屋搭好了（放置 <累计> 个方块）」——本次放置数必须独立统计。
    sim.enqueue({ kind: 'build', params: { structure: 'hut' }, label: '再搭一间小屋' });
    runUntilDone(sim, 60000);
    const second = sim.tasks[0];
    expect(second.status).toBe('done');

    const match = /本次放置 (\d+)/.exec(second.note);
    expect(match, `note=${second.note}`).not.toBeNull();
    const placedThisTask = Number(match?.[1]);
    const total = sim.bot.blocksPlaced;
    if (placedThisTask === 0) {
      // 位置被占满时如实报告未放置，而不是报累计值。
      expect(second.note).toMatch(/未放置/);
      expect(total).toBe(firstPlaced);
    } else {
      expect(placedThisTask).toBe(total - firstPlaced);
    }
  });

  it('首次搭建仍真实放置并消耗木板（修复不误伤正常路径）', () => {
    const sim = makeSim();
    sim.bot.inventory[PLANKS] = HUT_BLOCK_COST + 4;
    sim.enqueue({ kind: 'build', params: { structure: 'hut' }, label: '搭一间小屋' });
    runUntilDone(sim, 60000);
    const task = sim.tasks[0];
    expect(task.status).toBe('done');
    expect(sim.bot.blocksPlaced).toBeGreaterThan(0);
    expect(task.note).toMatch(/本次放置/);
    expect(sim.bot.inventory[PLANKS]).toBe(HUT_BLOCK_COST + 4 - sim.bot.blocksPlaced);
  });
});

describe('B-P-02 finish() 重置全部任务态', () => {
  it('合成任务被取消后重进：必须重新校验材料，不得无材料凭空产出', () => {
    const sim = makeSim();
    sim.bot.inventory[LOG] = 5;
    sim.enqueue({ kind: 'craft', params: { item: 'planks' }, label: '合成木板' });
    sim.tick(50); // 进入合成等待，craftUntil 已设置
    sim.cancelAll(); // 取消：finish 必须清掉 craftUntil

    // 抽走材料后再来一条合成
    sim.bot.inventory[LOG] = 0;
    sim.enqueue({ kind: 'craft', params: { item: 'planks' }, label: '合成木板' });
    runUntilDone(sim, 5000);

    expect(sim.tasks[0].status).toBe('failed');
    expect(sim.tasks[0].note).toMatch(/材料不足/);
    // 不得出现幽灵木板
    expect(sim.bot.inventory[PLANKS] ?? 0).toBe(0);
  });

  it('收纳任务被取消后重进：必须重新等待，不得瞬间清空背包', () => {
    const sim = makeSim();
    sim.enqueue({ kind: 'deposit', params: {}, label: '收纳' });
    sim.tick(50);
    sim.cancelAll();
    sim.tick(2000); // 让残留计时器过期（旧实现会据此立即完成）

    sim.bot.inventory[LOG] = 3;
    sim.enqueue({ kind: 'deposit', params: {}, label: '收纳' });
    sim.tick(50); // 新任务第一步只应开始等待
    expect(sim.bot.inventory[LOG]).toBe(3);

    runUntilDone(sim, 5000);
    expect(sim.tasks[0].status).toBe('done');
    expect(sim.bot.inventory[LOG] ?? 0).toBe(0);
  });
});

describe('G-MC-02 被打 / 反击', () => {
  it('识别攻击/反击指令', () => {
    expect(parseMcCommand('反击')?.kind).toBe('attack');
    expect(parseMcCommand('打他')?.kind).toBe('attack');
    expect(parseMcCommand('打回去')?.kind).toBe('attack');
  });

  it('PvP 关闭时指令被直接拒绝，不入队', () => {
    expect(maybeHandleMcCommand('反击')).toBe(true);
    expect(sim.tasks.length).toBe(0);
    expect(mcSession.lastParseNote).toMatch(/PvP 已关闭/);
  });

  it('PvP 开启时攻击任务真实命中并击退目标', () => {
    setPvp(true, false);
    sim.moveMob(sim.bot.x + 1, sim.bot.z);
    const task = applyCommand(parseMcCommand('反击')!);
    expect(task).not.toBeNull();
    runUntilDone(sim, 20000);
    expect(sim.tasks[0].status).toBe('done');
    expect(sim.mob.alive).toBe(false);
    expect(sim.bot.attacks).toBeGreaterThan(0);
  });

  it('PvP 关闭时被攻击只规避不还手（不产生攻击任务）', () => {
    sim.hostile = true;
    sim.moveMob(sim.bot.x + 1, sim.bot.z);
    sim.mob.lastAttackAt = -10000;
    const before = sim.bot.health;
    for (let i = 0; i < 20; i += 1) sim.tick(100);
    expect(sim.bot.health).toBeLessThan(before);
    expect(sim.tasks.some((t) => t.kind === 'attack')).toBe(false);
    expect(sim.log.some((e) => e.kind === 'combat' && /只规避不还手/.test(e.text))).toBe(true);
  });

  it('PvP 开启且允许反击：被攻击会自动还手并回调播报', () => {
    const onTaskCompleted = vi.fn();
    setMcEventListener({ onTaskCompleted });
    setPvp(true, true);
    sim.hostile = true;
    sim.moveMob(sim.bot.x + 1, sim.bot.z);
    sim.mob.lastAttackAt = -10000;
    for (let i = 0; i < 10; i += 1) sim.tick(100);
    expect(sim.tasks.some((t) => t.kind === 'attack')).toBe(true);
    expect(onTaskCompleted.mock.calls.some(([text]) => /反击/.test(String(text)))).toBe(true);
  });

  it('生命值过低时停止战斗并撤离求援', () => {
    setPvp(true, true);
    sim.hostile = true;
    sim.bot.health = 4;
    sim.moveMob(sim.bot.x + 1, sim.bot.z);
    sim.mob.lastAttackAt = -10000;
    for (let i = 0; i < 10; i += 1) sim.tick(100);
    expect(sim.log.some((e) => e.kind === 'combat' && /撤离|求援/.test(e.text))).toBe(true);
  });
});

describe('MC 事件挂载点', () => {
  it('任务完成回调摘要文本；reset 后挂载点仍在', () => {
    const onTaskCompleted = vi.fn();
    setMcEventListener({ onTaskCompleted });
    sim.bot.inventory[LOG] = 1;
    applyCommand(parseMcCommand('合成木板')!);
    for (let i = 0; i < 40; i += 1) sim.tick(50);
    expect(onTaskCompleted).toHaveBeenCalled();
    expect(String(onTaskCompleted.mock.calls[0]?.[0])).toMatch(/合成木板|木板/);

    // reset 不应覆盖实例级挂载点（B-P-09 的 Object.assign 脆弱点已修）。
    resetSimulation({ seed: 20240919, width: 24, height: 18, depth: 24 });
    onTaskCompleted.mockClear();
    sim.bot.inventory[LOG] = 1;
    applyCommand(parseMcCommand('合成木板')!);
    for (let i = 0; i < 40; i += 1) sim.tick(50);
    expect(onTaskCompleted).toHaveBeenCalled();
  });
});

describe('攻击任务的诚实失败路径', () => {
  it('PvP 开启但目标已被击退时如实失败', () => {
    setPvp(true, false);
    const sim2 = makeSim();
    sim2.setPvp(true, false);
    sim2.mob.alive = false;
    sim2.enqueue({ kind: 'attack', params: { target: 'mob' }, label: '反击' });
    runUntilDone(sim2, 5000);
    expect(sim2.tasks[0].status).toBe('failed');
    expect(sim2.tasks[0].note).toMatch(/没有可攻击的目标/);
  });

  it('PvP 关闭时任务级攻击也如实失败（不静默成功）', () => {
    const sim2 = makeSim();
    sim2.setPvp(false, false);
    sim2.enqueue({ kind: 'attack', params: { target: 'mob' }, label: '反击' });
    runUntilDone(sim2, 5000);
    expect(sim2.tasks[0].status).toBe('failed');
    expect(sim2.tasks[0].note).toMatch(/PvP 已关闭/);
  });
});

describe('世界与空气方块', () => {
  it('预铺蓝图确实填的是实心方块（回归用例前提自检）', () => {
    const sim = makeSim();
    const anchorX = Math.round(sim.bot.x) + 1;
    const anchorZ = Math.round(sim.bot.z);
    const anchorY = sim.world.surfaceY(anchorX, anchorZ) + 1;
    sim.world.set(anchorX, anchorY, anchorZ, PLANKS);
    expect(sim.world.get(anchorX, anchorY, anchorZ)).not.toBe(AIR);
  });
});
