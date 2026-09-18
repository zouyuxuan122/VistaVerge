/**
 * sensors/haClient.ts — Home Assistant WebSocket 适配（DOMAIN_PLUGINS §1.2、§3.4/§3.5）。
 *
 * 合同：
 * - 未配置（缺 url/token）→ `status = 'blocked'`，connect 返回 ok=false，
 *   读取返回空/null；**不冒充已连接**。
 * - 已配置 → WebSocket 握手 auth_required → auth → auth_ok/auth_invalid，
 *   之后 get_states / subscribe_events。
 * - 实体不可用（unavailable/unknown）→ `available=false`，禁止生成确定性数值陈述。
 * - setpoint 与 measured 分开字段（`readTemperature`）。
 * - token 不进状态、错误消息与日志（`redactedConfig()` 只回 ***）。
 *
 * 真实 HA 实例与授权的集成验收属外部 BLOCKED；本模块提供可注入 WebSocket 的
 * 协议实现，使握手/读取/订阅在 Node 侧可测。
 */

export type HaStatus = 'blocked' | 'disconnected' | 'connecting' | 'connected' | 'auth-failed';

export const HA_BLOCKED_REASON = 'HA 未配置（缺少 url/token），状态 BLOCKED';

export interface HaConfig {
  url?: string;
  token?: string;
}

export interface HaEntityState {
  entityId: string;
  state: string;
  attributes: Record<string, unknown>;
  observedAt: number;
  available: boolean;
}

export interface HaTemperatureReading {
  measuredC: number | null;
  setpointC: number | null;
  available: boolean;
  observedAt: number;
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  removeEventListener?(type: string, listener: (event: { data?: unknown }) => void): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface HaClientDeps {
  WebSocket?: WebSocketCtor;
  now?: () => number;
  /** 握手超时（毫秒）。服务端接受连接但不发 auth_required 时必须有上限。 */
  connectTimeoutMs?: number;
}

export interface HaClient {
  readonly status: HaStatus;
  readonly blockedReason: string | null;
  redactedConfig(): { url: string | null; token: string | null };
  connect(): Promise<{ ok: boolean; status: HaStatus; error?: string }>;
  close(): void;
  getStates(): Promise<HaEntityState[]>;
  read(entityId: string): Promise<HaEntityState | null>;
  readTemperature(entityId: string): Promise<HaTemperatureReading | null>;
  subscribe(listener: (state: HaEntityState) => void): Promise<() => void>;
}

interface RawState {
  entity_id?: unknown;
  state?: unknown;
  attributes?: unknown;
  last_updated?: unknown;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isAvailable(state: string): boolean {
  return state !== 'unavailable' && state !== 'unknown' && state !== '';
}

export function createHaClient(config: HaConfig, deps: HaClientDeps = {}): HaClient {
  const now = deps.now ?? (() => Date.now());
  const connectTimeoutMs = deps.connectTimeoutMs ?? 8000;
  const url = typeof config.url === 'string' && config.url.trim().length > 0 ? config.url.trim() : null;
  const token = typeof config.token === 'string' && config.token.trim().length > 0 ? config.token.trim() : null;
  const configured = url !== null && token !== null;

  let status: HaStatus = configured ? 'disconnected' : 'blocked';
  let socket: WebSocketLike | null = null;
  let nextId = 1;
  let authSettle: ((result: { ok: boolean; status: HaStatus; error?: string }) => void) | null = null;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const stateCache = new Map<string, HaEntityState>();
  const listeners = new Set<(state: HaEntityState) => void>();

  function websocketUrl(): string {
    const base = (url as string).replace(/\/+$/, '');
    if (base.startsWith('https://')) return `wss://${base.slice('https://'.length)}/api/websocket`;
    if (base.startsWith('http://')) return `ws://${base.slice('http://'.length)}/api/websocket`;
    return `${base}/api/websocket`;
  }

  function send(message: Record<string, unknown>): void {
    socket?.send(JSON.stringify(message));
  }

  function request(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const id = nextId;
    nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ id, type, ...payload });
    });
  }

  function toEntity(raw: RawState): HaEntityState {
    const entityId = String(raw.entity_id ?? '');
    const state = String(raw.state ?? 'unknown');
    const attributes =
      typeof raw.attributes === 'object' && raw.attributes !== null
        ? (raw.attributes as Record<string, unknown>)
        : {};
    const parsed = typeof raw.last_updated === 'string' ? Date.parse(raw.last_updated) : Number.NaN;
    return {
      entityId,
      state,
      attributes,
      observedAt: Number.isFinite(parsed) ? parsed : now(),
      available: isAvailable(state),
    };
  }

  function handleEvent(event: unknown): void {
    const data = (event as { data?: Record<string, unknown> } | null)?.data;
    if (!data) return;
    const newState = data.new_state as RawState | undefined;
    if (!newState) return;
    const entity = toEntity(newState);
    stateCache.set(entity.entityId, entity);
    for (const listener of [...listeners]) listener(entity);
  }

  function handleMessage(event: { data?: unknown }): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = message.type;
    if (type === 'auth_required') {
      // token 只在此处随鉴权帧发送；不写入状态/错误消息/日志。
      send({ type: 'auth', access_token: token });
      return;
    }
    if (type === 'auth_ok') {
      status = 'connected';
      authSettle?.({ ok: true, status: 'connected' });
      authSettle = null;
      return;
    }
    if (type === 'auth_invalid') {
      status = 'auth-failed';
      const detail = typeof message.message === 'string' ? message.message : '鉴权失败';
      authSettle?.({ ok: false, status: 'auth-failed', error: detail });
      authSettle = null;
      return;
    }
    if (type === 'result') {
      const id = Number(message.id);
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (message.success === false) {
        const detail = (message.error as { message?: unknown } | undefined)?.message;
        waiter.reject(new Error(typeof detail === 'string' ? detail : 'HA 请求失败'));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (type === 'event') {
      handleEvent(message.event);
    }
  }

  function clearPending(error: Error): void {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }

  return {
    get status() {
      return status;
    },
    get blockedReason() {
      return configured ? null : HA_BLOCKED_REASON;
    },

    redactedConfig() {
      return { url, token: token === null ? null : '***' };
    },

    connect() {
      if (!configured) {
        status = 'blocked';
        return Promise.resolve({ ok: false, status, error: HA_BLOCKED_REASON });
      }
      const Ctor = deps.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor | undefined);
      if (typeof Ctor !== 'function') {
        status = 'blocked';
        return Promise.resolve({ ok: false, status, error: '当前环境没有可用的 WebSocket' });
      }
      status = 'connecting';
      return new Promise((resolve) => {
        let settled = false;
        // 握手超时：服务端接受 socket 但从不发 auth_required 时，
        // 之前这个 Promise 永远不会 settle，UI 会永久停在「连接中」。
        let timer: ReturnType<typeof setTimeout> | null = null;
        const settle = (result: { ok: boolean; status: HaStatus; error?: string }) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          authSettle = null;
          resolve(result);
        };
        authSettle = settle;
        timer = setTimeout(() => {
          status = 'disconnected';
          clearPending(new Error('HA 握手超时'));
          // 先以「超时」为原因 settle，再关 socket：
          // 关 socket 会同步触发 close 事件，若先关，失败原因会被
          // 「已断开」覆盖掉，排查时看不到真正原因是握手超时。
          settle({ ok: false, status: 'disconnected', error: `HA 握手超时（${connectTimeoutMs}ms）` });
          try {
            socket?.close();
          } catch {
            /* 已关闭 */
          }
          socket = null;
        }, connectTimeoutMs);

        const ws = new Ctor(websocketUrl());
        socket = ws;
        ws.addEventListener('open', () => {});
        ws.addEventListener('message', handleMessage);
        ws.addEventListener('error', () => {
          status = 'disconnected';
          clearPending(new Error('HA WebSocket 错误'));
          settle({ ok: false, status: 'disconnected', error: 'HA WebSocket 错误' });
        });
        ws.addEventListener('close', () => {
          if (status === 'connecting' || status === 'connected') status = 'disconnected';
          clearPending(new Error('HA WebSocket 已断开'));
          settle({ ok: false, status, error: 'HA WebSocket 已断开' });
        });
      });
    },

    close() {
      socket?.close();
      socket = null;
      clearPending(new Error('HA 客户端已关闭'));
      if (status === 'connected' || status === 'connecting') status = 'disconnected';
    },

    async getStates() {
      if (!configured || status !== 'connected') return [];
      const result = await request('get_states');
      if (!Array.isArray(result)) return [];
      const states = result.map((raw) => toEntity(raw as RawState));
      for (const state of states) stateCache.set(state.entityId, state);
      return states;
    },

    async read(entityId: string) {
      // 只读缓存：get_states 的结果；不因单实体读取重复请求。
      return stateCache.get(entityId) ?? null;
    },

    async readTemperature(entityId: string) {
      const state = stateCache.get(entityId);
      if (!state) return null;
      if (!state.available) {
        return { measuredC: null, setpointC: null, available: false, observedAt: state.observedAt };
      }
      return {
        // setpoint 与 measured 分开字段：有实际值就用实际值，不得把设定值说成实际温度。
        measuredC: numberOrNull(state.attributes.current_temperature),
        setpointC: numberOrNull(state.attributes.temperature),
        available: true,
        observedAt: state.observedAt,
      };
    },

    async subscribe(listener: (state: HaEntityState) => void) {
      if (!configured || status !== 'connected') {
        return () => {};
      }
      const subscription = await request('subscribe_events', { event_type: 'state_changed' });
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        send({ id: nextId++, type: 'unsubscribe_events', subscription: subscription ?? undefined });
      };
    },
  };
}
