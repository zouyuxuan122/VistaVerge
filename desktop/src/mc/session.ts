/**
 * mc/session.ts — MC 模拟的应用级单例与「边玩边聊」桥接。
 *
 * 分工：LLM 负责高层规划（把自然语言变成任务），本地模拟器负责执行与裁决。
 * 这里只做**指令识别 → 入队**，不做逐帧 LLM 调用（DOMAIN_PLUGINS §1.1）。
 *
 * 诚实标注：本会话驱动的是本地模拟世界。真实 Minecraft 服务端连接是外部 BLOCKED
 * （需固定 Java/服务端/Mineflayer 版本与账号），UI 必须同时显示两种标注。
 */

import { reactive } from 'vue';
import { McSimulation, type McEvent, type SimOptions } from './sim';
import { parseMcCommand, type ParsedCommand, type Task } from './tasks';

export const MC_SIMULATED_NOTICE = '本地模拟世界（SIMULATED）：地形/寻路/挖掘/合成/搭建都是真实计算，不播放预设动画。';
export const MC_REAL_SERVER_BLOCKED = '真实 Minecraft 服务端：BLOCKED（需固定 Java/服务端/Mineflayer 版本与受控账号，见 docs/plugins/DOMAIN_PLUGINS.md §1.1）。';

export interface McSessionState {
  running: boolean;
  /** 模拟已推进的总时长（ms）。 */
  elapsedMs: number;
  /** 最近一次指令解析结果说明（让「为什么不执行」可见）。 */
  lastParseNote: string;
  tickHz: number;
  /** 受击开关。放在响应式状态里：模拟器本体不是响应式的，UI 需要一份可订阅的镜像。 */
  hostile: boolean;
  /**
   * UI 重绘计数。模拟器（McSimulation）是普通类实例，不是 reactive 对象，
   * 依赖它的 computed 不会自动重算；面板靠这个计数在每个渲染节拍上刷新。
   */
  revision: number;
}

export const mcSession = reactive<McSessionState>({
  running: true,
  elapsedMs: 0,
  lastParseNote: '',
  tickHz: 30,
  hostile: false,
  revision: 0,
});

export function createSimulation(options: SimOptions = {}): McSimulation {
  return new McSimulation(options);
}

/** 应用共享的模拟实例（面板与聊天共用同一个世界）。 */
export const sim = createSimulation();

/** 重置为同一 seed 的全新世界（验收可复现）。 */
export function resetSimulation(options: SimOptions = {}): void {
  const fresh = createSimulation(options);
  Object.assign(sim, fresh);
  mcSession.elapsedMs = 0;
  mcSession.lastParseNote = '世界已重置（同 seed 可复现）';
}

/**
 * 从聊天文本识别 MC 指令并执行。
 * 返回 true 表示文本被当作 MC 指令处理（上层可据此跳过 LLM 或附一句确认）。
 */
export function maybeHandleMcCommand(text: string): boolean {
  const command = parseMcCommand(text);
  if (!command) {
    mcSession.lastParseNote = '未识别为游戏指令（不猜、不硬派任务）';
    return false;
  }
  if (!mcSession.running) {
    mcSession.lastParseNote = '模拟已暂停，指令未入队';
    return false;
  }
  applyCommand(command);
  return true;
}

/**
 * 面板按钮与聊天共用同一条入队路径。
 * 「停止」是急停而不是一个待办任务：只清空队列，不再往队列里塞一条 stop
 * （否则刚清完的队列里立刻又有一条 queued，与「已停止」自相矛盾）。
 */
export function applyCommand(command: ParsedCommand): Task | null {
  if (command.kind === 'stop') {
    sim.cancelAll();
    mcSession.lastParseNote = `已执行：${command.label}`;
    return null;
  }
  const task = sim.enqueue(command);
  mcSession.lastParseNote = `已入队：${command.label}`;
  return task;
}

/** 推进模拟（由面板的 rAF 或测试调用）。 */
export function advance(dtMs: number): void {
  if (!mcSession.running) return;
  sim.tick(dtMs);
  mcSession.elapsedMs += dtMs;
  // 每个节拍都 bump：面板的 computed 依赖它，才能在界面上看到
  // 任务进度、背包、日志、生命值这些由模拟器内部变化驱动的更新。
  mcSession.revision += 1;
}

export function setRunning(running: boolean): void {
  mcSession.running = running;
  mcSession.lastParseNote = running ? '模拟继续' : '模拟已暂停（世界状态保留）';
}

export function setHostile(enabled: boolean): void {
  sim.hostile = enabled;
  mcSession.hostile = enabled;
  mcSession.lastParseNote = enabled ? '受击开关已开启（每 3 秒受 2 点伤害）' : '受击开关已关闭';
}

export type { McEvent, Task, ParsedCommand };
