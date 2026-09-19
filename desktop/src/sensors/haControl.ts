/**
 * sensors/haControl.ts — 家居控制授权门（G-SENSE-03；DOMAIN_PLUGINS §1.2.4、§3.4）。
 *
 * 控制是**副作用动作**，必须同时满足：
 *   1) 授权门开启（`haControlEnabled`，默认关）；
 *   2) 每次控制都有显式确认回调，且用户确认通过。
 * 任一不满足即拒绝，并且**不调用 callService**（零写操作）。真实执行结果如实返回，
 * 不把「接口调用返回」当成「设备已执行」。
 *
 * 抽成纯函数以便无 HA 实例时用注入 fake 验证逻辑（不伪造真实 HA 验收）。
 */

export type HaControlAction = 'turn_on' | 'turn_off' | 'toggle';

export interface HaControlRequest {
  entityId: string;
  action: HaControlAction;
  /** 面向用户的动作描述（确认与结果文案用）。 */
  label: string;
}

export type HaControlErrorCode =
  | 'control-disabled'
  | 'not-connected'
  | 'confirmation-required'
  | 'not-confirmed'
  | 'service-error';

export interface HaControlResult {
  ok: boolean;
  error?: HaControlErrorCode;
  reason?: string;
  executedAt?: number;
}

export type HaControlConfirm = (request: HaControlRequest) => boolean | Promise<boolean>;

export interface HaControlGateDeps {
  controlEnabled: boolean;
  connected: boolean;
  /** 每次控制的显式确认回调；缺失即拒绝（confirmation-required）。 */
  confirm?: HaControlConfirm | null;
  /** 实际下发通道（HA WebSocket call_service）。 */
  callService: (
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string }>;
  now?: () => number;
}

export async function authorizeHaControl(
  request: HaControlRequest,
  deps: HaControlGateDeps,
): Promise<HaControlResult> {
  if (!deps.controlEnabled) {
    return { ok: false, error: 'control-disabled', reason: 'HA 控制默认关闭（授权门未开启）：未执行任何控制' };
  }
  if (!deps.connected) {
    return { ok: false, error: 'not-connected', reason: 'HA 未连接：控制未执行' };
  }
  if (!deps.confirm) {
    return { ok: false, error: 'confirmation-required', reason: '缺少每次控制的显式确认回调：未执行' };
  }
  let approved = false;
  try {
    approved = await deps.confirm(request);
  } catch {
    approved = false;
  }
  if (!approved) {
    return { ok: false, error: 'not-confirmed', reason: '用户未确认：未执行' };
  }
  const domain = request.entityId.split('.')[0] ?? '';
  const result = await deps.callService(domain, request.action, { entity_id: request.entityId });
  if (!result.ok) {
    return { ok: false, error: 'service-error', reason: `控制失败：${result.error ?? '未知原因'}` };
  }
  return { ok: true, executedAt: (deps.now ?? Date.now)() };
}
