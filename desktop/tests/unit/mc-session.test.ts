/**
 * MC 会话桥（聊天 → 任务）的回归测试。
 *
 * 合同：只有识别得出的指令才入队；识别不了就明确说「不猜」，绝不硬派任务。
 * 真实服务端连接是 BLOCKED，UI 必须同时显示 SIMULATED 与 BLOCKED 两种标注。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LOG } from '../../src/mc/blocks';
import {
  advance,
  applyCommand,
  maybeHandleMcCommand,
  mcSession,
  MC_REAL_SERVER_BLOCKED,
  MC_SIMULATED_NOTICE,
  resetSimulation,
  setHostile,
  setRunning,
  sim,
} from '../../src/mc/session';
import { parseMcCommand } from '../../src/mc/tasks';

beforeEach(() => {
  resetSimulation({ seed: 20240919, width: 24, height: 18, depth: 24 });
  setRunning(true);
  setHostile(false);
});

describe('诚实标注', () => {
  it('同时给出 SIMULATED 与真实服务端 BLOCKED 两种说明', () => {
    expect(MC_SIMULATED_NOTICE).toMatch(/SIMULATED/);
    expect(MC_REAL_SERVER_BLOCKED).toMatch(/BLOCKED/);
    expect(MC_REAL_SERVER_BLOCKED).toMatch(/Mineflayer/);
  });
});

describe('聊天文本 → 任务', () => {
  it('识别「跟着我」并入队跟随任务', () => {
    expect(maybeHandleMcCommand('跟着我')).toBe(true);
    expect(sim.tasks[0].kind).toBe('follow');
    expect(mcSession.lastParseNote).toMatch(/已入队/);
  });

  it('识别「挖 6 个木头」并把数量带进参数', () => {
    expect(maybeHandleMcCommand('帮我挖 6 个木头')).toBe(true);
    expect(sim.tasks[0].params.block).toBe(LOG);
    expect(sim.tasks[0].params.count).toBe(6);
  });

  it('普通聊天不会被当成游戏指令（不猜意图）', () => {
    const before = sim.tasks.length;
    expect(maybeHandleMcCommand('今天天气怎么样')).toBe(false);
    expect(sim.tasks.length).toBe(before);
    expect(mcSession.lastParseNote).toMatch(/未识别/);
  });

  it('暂停时不入队，并说明原因', () => {
    setRunning(false);
    expect(maybeHandleMcCommand('跟着我')).toBe(false);
    expect(sim.tasks.length).toBe(0);
    expect(mcSession.lastParseNote).toMatch(/暂停/);
  });

  it('「停下」走急停路径：清空队列', () => {
    applyCommand(parseMcCommand('采集 20 个木头')!);
    applyCommand(parseMcCommand('采集 20 个木头')!);
    advance(50);
    expect(maybeHandleMcCommand('别动')).toBe(true);
    expect(sim.tasks.every((t) => t.status !== 'queued' && t.status !== 'running')).toBe(true);
    expect(sim.bot.status).toBe('idle');
  });
});

describe('推进与开关', () => {
  it('advance 真的推进模拟时间与机器人状态', () => {
    applyCommand(parseMcCommand('跟着我')!);
    const before = mcSession.elapsedMs;
    for (let i = 0; i < 40; i += 1) advance(50);
    expect(mcSession.elapsedMs).toBeGreaterThan(before);
    expect(sim.bot.distanceWalked).toBeGreaterThan(0);
  });

  it('暂停后 advance 不再推进世界', () => {
    applyCommand(parseMcCommand('跟着我')!);
    for (let i = 0; i < 20; i += 1) advance(50);
    const walked = sim.bot.distanceWalked;
    const elapsed = mcSession.elapsedMs;
    setRunning(false);
    for (let i = 0; i < 40; i += 1) advance(50);
    expect(sim.bot.distanceWalked).toBe(walked);
    expect(mcSession.elapsedMs).toBe(elapsed);
  });

  it('重置世界回到同一 seed 的可复现初始状态', () => {
    applyCommand(parseMcCommand('采集 3 个木头')!);
    for (let i = 0; i < 200; i += 1) advance(50);
    expect(sim.bot.blocksMined).toBeGreaterThan(0);
    resetSimulation({ seed: 20240919, width: 24, height: 18, depth: 24 });
    expect(sim.bot.blocksMined).toBe(0);
    expect(sim.tasks.length).toBe(0);
    expect(mcSession.elapsedMs).toBe(0);
  });

  it('受击开关切换会反映到模拟器', () => {
    setHostile(true);
    expect(sim.hostile).toBe(true);
    setHostile(false);
    expect(sim.hostile).toBe(false);
  });
});
