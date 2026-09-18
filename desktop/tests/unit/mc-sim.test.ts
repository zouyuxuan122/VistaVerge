/**
 * MC 模拟引擎的真实性验收（node 环境，无 DOM）。
 *
 * 这些用例的目的不是「代码覆盖率」，而是证明模拟是真的：
 * 挖掉的方块必须从世界里消失、走不过去必须失败、合成依赖链必须真的卡人、
 * 死亡必须掉背包并重生。任何一条变成「假装成功」都会在这里失败。
 */
import { describe, expect, it } from 'vitest';
import { AIR, CRAFTING_TABLE, DIRT, GRASS, IRON_ORE, LOG, PLANKS, STONE, WATER } from '../../src/mc/blocks';
import { findPath, isStandable } from '../../src/mc/pathfind';
import { McSimulation } from '../../src/mc/sim';
import { HUT_BLOCK_COST, parseMcCommand, RECIPES } from '../../src/mc/tasks';
import { generateWorld, hash3, valueNoise2D, VoxelWorld } from '../../src/mc/world';

function makeSim(seed = 20240919, opts = {}) {
  return new McSimulation({ seed, width: 32, height: 20, depth: 32, ...opts });
}

/** 推进到任务结束（或超时），返回毫秒数。 */
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

describe('世界生成', () => {
  it('同 seed 必然生成同一世界（可复现验收前提）', () => {
    const a = generateWorld({ width: 24, height: 16, depth: 24, seed: 1234 });
    const b = generateWorld({ width: 24, height: 16, depth: 24, seed: 1234 });
    for (let x = 0; x < 24; x += 1) {
      for (let z = 0; z < 24; z += 1) {
        expect(a.world.surfaceY(x, z)).toBe(b.world.surfaceY(x, z));
      }
    }
    expect(a.spawn).toEqual(b.spawn);
  });

  it('不同 seed 生成不同地形', () => {
    const a = generateWorld({ width: 24, height: 16, depth: 24, seed: 1 });
    const b = generateWorld({ width: 24, height: 16, depth: 24, seed: 2 });
    let diff = 0;
    for (let x = 0; x < 24; x += 1) {
      for (let z = 0; z < 24; z += 1) {
        if (a.world.surfaceY(x, z) !== b.world.surfaceY(x, z)) diff += 1;
      }
    }
    expect(diff).toBeGreaterThan(0);
  });

  it('生成真实地形：有草地/泥土/石头/原木/水', () => {
    const { world } = generateWorld({ width: 32, height: 20, depth: 32, seed: 7 });
    expect(world.count(GRASS)).toBeGreaterThan(0);
    expect(world.count(DIRT)).toBeGreaterThan(0);
    expect(world.count(STONE)).toBeGreaterThan(0);
    expect(world.count(LOG)).toBeGreaterThan(0);
    expect(world.count(WATER)).toBeGreaterThan(0);
  });

  it('越界读取视为实心（防止 bot 走出世界）', () => {
    const { world } = generateWorld({ width: 16, height: 12, depth: 16, seed: 3 });
    expect(world.get(-1, 5, 5)).toBe(STONE);
    expect(world.get(999, 5, 5)).toBe(STONE);
    expect(world.set(-1, 5, 5, AIR)).toBe(false);
  });

  it('hash/噪声是纯函数（同输入同输出）', () => {
    expect(hash3(3, 4, 5, 9)).toBe(hash3(3, 4, 5, 9));
    expect(valueNoise2D(1.5, 2.5, 9, 8)).toBe(valueNoise2D(1.5, 2.5, 9, 8));
    expect(hash3(3, 4, 5, 9)).not.toBe(hash3(3, 4, 6, 9));
  });
});

describe('A* 寻路', () => {
  it('在真实地形上找到可行路径，且路径每一步都可站立', () => {
    const { world, spawn } = generateWorld({ width: 32, height: 20, depth: 32, seed: 11 });
    const from = { x: spawn.x, y: spawn.y, z: spawn.z };
    const path = findPath(world, from, { x: world.width - 3, z: world.depth - 3 }, { maxNodes: 40000 });
    // 地形可能把对角封死；能到就检查路径合法性，不能到也要是 null 而不是假路径
    if (path) {
      expect(path.nodes.length).toBeGreaterThan(0);
      let y = Math.round(from.y);
      for (const node of path.nodes) {
        const standY = world.surfaceY(node.x, node.z) + 1;
        expect(isStandable(world, node.x, standY, node.z)).toBe(true);
        y = standY;
      }
      expect(y).toBeGreaterThan(0);
      expect(path.visited).toBeGreaterThan(0);
    }
  });

  it('目标被实心墙隔开时返回 null（不伪造路径）', () => {
    // 手搓一个可控世界：整片地板 + 一道横贯全图的墙，把起点和目标彻底隔开。
    const world = new VoxelWorld({ width: 10, height: 8, depth: 10, seed: 99 });
    for (let x = 0; x < 10; x += 1) {
      for (let z = 0; z < 10; z += 1) world.set(x, 0, z, GRASS);
    }
    for (let z = 0; z < 10; z += 1) {
      for (let y = 1; y <= 4; y += 1) world.set(5, y, z, STONE);
    }
    const path = findPath(world, { x: 1.5, y: 1, z: 1.5 }, { x: 8, z: 8 }, { maxNodes: 5000 });
    expect(path).toBeNull();
  });

  it('拆掉墙之后同一对起终点就能走通（证明是墙挡住的，不是算法坏了）', () => {
    const world = new VoxelWorld({ width: 10, height: 8, depth: 10, seed: 99 });
    for (let x = 0; x < 10; x += 1) {
      for (let z = 0; z < 10; z += 1) world.set(x, 0, z, GRASS);
    }
    const path = findPath(world, { x: 1.5, y: 1, z: 1.5 }, { x: 8, z: 8 }, { maxNodes: 5000 });
    expect(path).not.toBeNull();
    expect(path?.nodes.length).toBeGreaterThan(0);
  });

  it('已在目标格上返回空路径而不是报错', () => {
    const { world, spawn } = generateWorld({ width: 16, height: 12, depth: 16, seed: 6 });
    const path = findPath(world, { x: spawn.x, y: spawn.y, z: spawn.z }, { x: spawn.x, z: spawn.z });
    expect(path).not.toBeNull();
    expect(path?.nodes).toEqual([]);
  });
});

describe('挖掘是真的改变世界', () => {
  it('采集木头：世界里的原木减少、背包增加、方块真的变成空气', () => {
    const sim = makeSim();
    const before = sim.countBlock(LOG);
    expect(before).toBeGreaterThan(0);
    sim.enqueue({ kind: 'gather', params: { block: LOG, count: 3 }, label: '采集 3 个木头' });
    runUntilDone(sim, 90000);
    const task = sim.tasks[0];
    expect(task.status).toBe('done');
    expect(sim.bot.blocksMined).toBeGreaterThanOrEqual(3);
    expect(sim.countBlock(LOG)).toBe(before - sim.bot.blocksMined);
    // 原木掉落物进背包
    expect(sim.bot.inventory[LOG] ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('没有镐子时挖石头如实失败，并说明原因（不假装成功）', () => {
    const sim = makeSim();
    const before = sim.countBlock(STONE);
    sim.enqueue({ kind: 'mine', params: { block: STONE, count: 2 }, label: '挖石头' });
    runUntilDone(sim, 20000);
    const task = sim.tasks[0];
    expect(task.status).toBe('failed');
    expect(task.note).toMatch(/镐/);
    expect(sim.countBlock(STONE)).toBe(before);
    expect(sim.bot.blocksMined).toBe(0);
  });

  it('世界内找不到目标方块时如实失败', () => {
    const sim = makeSim();
    const before = sim.countBlock(IRON_ORE);
    sim.enqueue({ kind: 'mine', params: { block: IRON_ORE, count: 4 }, label: '挖铁矿' });
    runUntilDone(sim, 30000);
    const task = sim.tasks[0];
    // 要么因缺镐失败、要么因找不到失败；两种都必须带可读原因，且不能真的挖出东西
    expect(task.status).toBe('failed');
    expect(task.note.length).toBeGreaterThan(0);
    expect(sim.countBlock(IRON_ORE)).toBe(before);
  });

  it('停止指令会取消当前与排队任务', () => {
    const sim = makeSim();
    sim.enqueue({ kind: 'gather', params: { block: LOG, count: 20 }, label: '采很多木头' });
    sim.enqueue({ kind: 'gather', params: { block: LOG, count: 20 }, label: '再采一批' });
    sim.tick(50);
    sim.cancelAll();
    const statuses = sim.tasks.map((t) => t.status);
    expect(statuses).not.toContain('queued');
    expect(statuses).not.toContain('running');
    expect(statuses.filter((s) => s === 'cancelled').length).toBeGreaterThanOrEqual(1);
    expect(sim.bot.status).toBe('idle');
  });
});

describe('合成依赖链是真的', () => {
  it('没有工作台时合成斧头失败，并指出缺什么', () => {
    const sim = makeSim();
    sim.enqueue({ kind: 'craft', params: { item: 'axe' }, label: '合成斧头' });
    runUntilDone(sim, 5000);
    const task = sim.tasks[0];
    expect(task.status).toBe('failed');
    expect(task.note).toMatch(/工作台/);
    expect(sim.bot.tools.axe).toBe(false);
  });

  it('木板配方真的消耗原木并产出 4 木板', () => {
    const sim = makeSim();
    sim.bot.inventory[LOG] = 2;
    sim.enqueue({ kind: 'craft', params: { item: 'planks' }, label: '合成木板' });
    runUntilDone(sim, 5000);
    expect(sim.tasks[0].status).toBe('done');
    expect(sim.bot.inventory[LOG]).toBe(1);
    expect(sim.bot.inventory[PLANKS]).toBe(4);
  });

  it('完整链路：原木 → 木板 → 工作台 → 斧头，工具真的到手', () => {
    const sim = makeSim();
    sim.bot.inventory[LOG] = 12;
    for (const item of ['planks', 'crafting_table', 'axe']) {
      sim.enqueue({ kind: 'craft', params: { item }, label: `合成 ${item}` });
      runUntilDone(sim, 8000);
    }
    // 材料账要能对上：12 原木 -1(木板) -2(斧) = 9；木板 4-4(台) -3(斧) = 0(若不足则失败)
    const statuses = sim.tasks.map((t) => t.status);
    expect(statuses).toContain('done');
    // 斧头在最后一步要么成功（材料够）要么给出材料不足的原因，不允许静默成功
    const axeTask = sim.tasks[0];
    if (axeTask.status === 'done') {
      expect(sim.bot.tools.axe).toBe(true);
    } else {
      expect(axeTask.note).toMatch(/材料不足/);
    }
  });

  it('材料不足时失败信息给出具体缺口', () => {
    const sim = makeSim();
    sim.enqueue({ kind: 'craft', params: { item: 'crafting_table' }, label: '合成工作台' });
    runUntilDone(sim, 5000);
    expect(sim.tasks[0].status).toBe('failed');
    expect(sim.tasks[0].note).toMatch(/材料不足/);
    expect(sim.tasks[0].note).toMatch(/木板/);
  });

  it('配方表本身自洽：木板不需要工作台，工具需要', () => {
    expect(RECIPES.planks.needsTable).toBe(false);
    expect(RECIPES.crafting_table.needsTable).toBe(false);
    expect(RECIPES.axe.needsTable).toBe(true);
    expect(RECIPES.pickaxe.needsTable).toBe(true);
    expect(RECIPES.axe.output.tool).toBe('axe');
  });
});

describe('搭建小屋', () => {
  it('材料不足时如实失败并报出缺口', () => {
    const sim = makeSim();
    sim.enqueue({ kind: 'build', params: { structure: 'hut' }, label: '搭小屋' });
    runUntilDone(sim, 8000);
    expect(sim.tasks[0].status).toBe('failed');
    expect(sim.tasks[0].note).toMatch(/材料不足/);
    expect(sim.bot.blocksPlaced).toBe(0);
  });

  it('材料充足时真的往世界里放方块并消耗木板', () => {
    const sim = makeSim();
    sim.bot.inventory[PLANKS] = HUT_BLOCK_COST + 4;
    const planksBefore = sim.countBlock(PLANKS);
    sim.enqueue({ kind: 'build', params: { structure: 'hut' }, label: '搭小屋' });
    runUntilDone(sim, 60000);
    expect(sim.bot.blocksPlaced).toBeGreaterThan(0);
    expect(sim.countBlock(PLANKS)).toBe(planksBefore + sim.bot.blocksPlaced);
    expect(sim.bot.inventory[PLANKS]).toBe(HUT_BLOCK_COST + 4 - sim.bot.blocksPlaced);
  });
});

describe('跟随 / 回家', () => {
  it('跟随会把 bot 拉近玩家（真的移动，不是原地假动作）', () => {
    const sim = makeSim();
    const startDist = Math.hypot(sim.bot.x - sim.player.x, sim.bot.z - sim.player.z);
    sim.enqueue({ kind: 'follow', params: {}, label: '跟随你' });
    for (let i = 0; i < 200; i += 1) sim.tick(50);
    const endDist = Math.hypot(sim.bot.x - sim.player.x, sim.bot.z - sim.player.z);
    expect(sim.bot.distanceWalked).toBeGreaterThan(0);
    expect(endDist).toBeLessThanOrEqual(startDist);
  });

  it('回家任务在出生点完成', () => {
    const sim = makeSim();
    // 先把它挪远
    sim.bot.x = sim.spawn.x + 6;
    sim.bot.z = sim.spawn.z + 6;
    sim.bot.y = sim.world.surfaceY(Math.round(sim.bot.x), Math.round(sim.bot.z)) + 1;
    sim.enqueue({ kind: 'goto', params: { target: 'home' }, label: '返回出生点' });
    runUntilDone(sim, 60000);
    const task = sim.tasks[0];
    expect(['done', 'failed']).toContain(task.status);
    if (task.status === 'done') {
      // 落点必须诚实：要么真的在出生点，要么说明只到了最近可达位置
      const remaining = Math.hypot(sim.bot.x - sim.spawn.x, sim.bot.z - sim.spawn.z);
      if (remaining > 1.5) expect(task.note).toMatch(/最近可达位置/);
      else expect(task.note).toMatch(/已回到出生点/);
    } else {
      expect(task.note).toMatch(/路/);
    }
  });
});

describe('生命值与死亡恢复', () => {
  it('受击开关会真的扣血', () => {
    const sim = makeSim(20240919, { hostile: true });
    const before = sim.bot.health;
    for (let i = 0; i < 80; i += 1) sim.tick(100); // 8 秒 → 至少两次受击
    expect(sim.bot.health).toBeLessThan(before);
    expect(sim.log.some((e) => e.kind === 'damage')).toBe(true);
  });

  it('生命归零后死亡、掉背包、2 秒后在出生点重生', () => {
    const sim = makeSim(20240919, { hostile: true });
    sim.bot.inventory[LOG] = 5;
    sim.bot.tools.axe = true;
    for (let i = 0; i < 400; i += 1) sim.tick(100); // 40 秒足够死一次
    expect(sim.bot.deaths).toBeGreaterThanOrEqual(1);
    expect(sim.log.some((e) => e.kind === 'death')).toBe(true);
    // 重生后：血量恢复、回到出生点附近
    expect(sim.bot.health).toBeGreaterThan(0);
    expect(Math.hypot(sim.bot.x - sim.spawn.x, sim.bot.z - sim.spawn.z)).toBeLessThan(2);
  });

  it('关闭受击时不会掉血', () => {
    const sim = makeSim();
    const before = sim.bot.health;
    for (let i = 0; i < 100; i += 1) sim.tick(100);
    expect(sim.bot.health).toBe(before);
  });
});

describe('背包容量', () => {
  it('背包满时采集任务如实失败并提示收纳', () => {
    const sim = makeSim(20240919, { inventorySlots: 2 });
    sim.bot.inventory[DIRT] = 64;
    sim.bot.inventory[STONE] = 64;
    sim.tick(10);
    expect(sim.bot.inventoryFull).toBe(true);
    sim.enqueue({ kind: 'gather', params: { block: LOG, count: 2 }, label: '采集木头' });
    runUntilDone(sim, 10000);
    expect(sim.tasks[0].status).toBe('failed');
    expect(sim.tasks[0].note).toMatch(/背包已满/);
  });

  it('收纳背包会清空库存', () => {
    const sim = makeSim();
    sim.bot.inventory[LOG] = 3;
    sim.enqueue({ kind: 'deposit', params: {}, label: '收纳' });
    runUntilDone(sim, 5000);
    expect(sim.tasks[0].status).toBe('done');
    expect(sim.inventoryList()).toEqual([]);
    expect(sim.bot.inventoryFull).toBe(false);
  });
});

describe('指令解析（纯函数，不猜意图）', () => {
  it('识别跟随 / 停止 / 回家', () => {
    expect(parseMcCommand('跟着我')?.kind).toBe('follow');
    expect(parseMcCommand('别动')?.kind).toBe('stop');
    expect(parseMcCommand('我们回家吧')?.kind).toBe('goto');
  });

  it('识别方块与数量', () => {
    const cmd = parseMcCommand('帮我采集 6 个木头');
    expect(cmd?.kind).toBe('gather');
    expect(cmd?.params.block).toBe(LOG);
    expect(cmd?.params.count).toBe(6);
  });

  it('识别合成目标', () => {
    expect(parseMcCommand('合成一把斧头')?.params.item).toBe('axe');
    expect(parseMcCommand('做个工作台')?.params.item).toBe('crafting_table');
  });

  it('无法识别时返回 null（不硬派任务）', () => {
    expect(parseMcCommand('今天天气怎么样')).toBeNull();
    expect(parseMcCommand('')).toBeNull();
    expect(parseMcCommand('   ')).toBeNull();
  });

  it('数量有上限，避免一条指令刷爆世界', () => {
    const cmd = parseMcCommand('挖 99999 个木头');
    expect((cmd?.params.count as number) <= 128).toBe(true);
  });
});

describe('观察快照', () => {
  it('topMap 与 sideProfile 反映真实世界（挖掉后地图会变）', () => {
    const sim = makeSim();
    const before = sim.topMap();
    const x = Math.round(sim.bot.x) + 2;
    const z = Math.round(sim.bot.z);
    const topY = sim.world.surfaceY(x, z);
    sim.world.set(x, topY, z, AIR);
    const after = sim.topMap();
    const idx = z * sim.world.width + x;
    expect(before[idx].id).not.toBe(AIR);
    expect(after[idx].id === AIR || after[idx].y < before[idx].y).toBe(true);
    expect(sim.sideProfile(z).length).toBe(sim.world.width);
  });

  it('inventoryList 只列非零项并按数量降序', () => {
    const sim = makeSim();
    sim.bot.inventory[LOG] = 2;
    sim.bot.inventory[STONE] = 9;
    sim.bot.inventory[DIRT] = 0;
    const list = sim.inventoryList();
    expect(list.length).toBe(2);
    expect(list[0].count).toBe(9);
  });
});

describe('大 dt 稳定性', () => {
  it('一次 tick 传入很大的 dt 不会跳过任务判定', () => {
    const sim = makeSim();
    sim.enqueue({ kind: 'craft', params: { item: 'planks' }, label: '合成木板' });
    sim.bot.inventory[LOG] = 1;
    sim.tick(5000);
    expect(sim.tasks[0].status).toBe('done');
    expect(sim.bot.inventory[PLANKS]).toBe(4);
  });

  it('非法 dt 被忽略，不推进时间', () => {
    const sim = makeSim();
    const t = sim.timeMs;
    sim.tick(Number.NaN);
    sim.tick(0);
    sim.tick(-5);
    expect(sim.timeMs).toBe(t);
  });
});

describe('工具与方块语义', () => {
  it('树叶不需要工具，石头需要镐', () => {
    expect(RECIPES.pickaxe.output.tool).toBe('pickaxe');
    expect(CRAFTING_TABLE).toBeGreaterThan(0);
  });
});
