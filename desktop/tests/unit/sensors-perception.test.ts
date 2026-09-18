/**
 * 感知层新增行为（AUDIT-01 修复项）的回归测试。
 *
 * 覆盖两件事：
 * 1. HA 握手必须有超时——服务端接受连接却不发 auth_required 时，
 *    之前 Promise 永不 settle，UI 会永久停在「连接中」。
 * 2. 温度读数严格区分 measured（current_temperature）与 setpoint（temperature），
 *    实体不可用时不得编造数值。
 */
import { describe, expect, it, vi } from 'vitest';
import { createHaClient, HA_BLOCKED_REASON, type WebSocketLike } from '../../src/sensors/haClient';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();

  constructor(public url: string, private mode: 'auth-ok' | 'silent' | 'auth-invalid' = 'auth-ok') {
    // 真实 HA 在连接建立后主动推 auth_required。放微任务里发，
    // 这样客户端已同步注册好 message 监听器。
    if (mode !== 'silent') queueMicrotask(() => this.emit('message', { type: 'auth_required' }));
  }

  send(data: string): void {
    this.sent.push(data);
    const parsed = JSON.parse(data) as { type?: string; id?: number };
    if (parsed.type === 'auth') {
      if (this.mode === 'auth-ok') this.emit('message', { type: 'auth_ok' });
      if (this.mode === 'auth-invalid') this.emit('message', { type: 'auth_invalid', message: 'invalid token' });
    }
    if (parsed.type === 'get_states') {
      this.emit('message', {
        id: parsed.id,
        type: 'result',
        success: true,
        result: [
          {
            entity_id: 'climate.living_room',
            state: 'heat',
            attributes: { current_temperature: 21.5, temperature: 24 },
            last_updated: new Date(1_700_000_000_000).toISOString(),
          },
          {
            entity_id: 'climate.offline_room',
            state: 'unavailable',
            attributes: { current_temperature: 30, temperature: 30 },
            last_updated: new Date(1_700_000_000_000).toISOString(),
          },
        ],
      });
    }
  }

  close(): void {
    this.emit('close', {});
  }

  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l !== listener),
    );
  }

  emit(type: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(payload) });
  }
}

describe('HA 握手超时', () => {
  it('服务端不发 auth_required 时在超时后 settle 为失败（不再永久挂起）', async () => {
    vi.useFakeTimers();
    try {
      const client = createHaClient(
        { url: 'http://ha.local:8123', token: 't' },
        {
          connectTimeoutMs: 500,
          // 'silent' 模式：只建立连接，什么都不推
          WebSocket: class extends FakeSocket {
            constructor(url: string) {
              super(url, 'silent');
            }
          } as unknown as new (url: string) => WebSocketLike,
        },
      );
      const pending = client.connect();
      await vi.advanceTimersByTimeAsync(600);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.status).toBe('disconnected');
      expect(result.error).toMatch(/超时/);
      expect(client.status).toBe('disconnected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('正常握手仍然成功（超时逻辑不误伤）', async () => {
    const client = createHaClient(
      { url: 'https://ha.example.com', token: 'secret' },
      { connectTimeoutMs: 5000, WebSocket: FakeSocket as unknown as new (url: string) => WebSocketLike },
    );
    const result = await client.connect();
    expect(result.ok).toBe(true);
    expect(result.status).toBe('connected');
  });

  it('鉴权失败时返回 auth-failed 且不回显 token', async () => {
    const client = createHaClient(
      { url: 'http://ha.local:8123', token: 'super-secret-token' },
      {
        connectTimeoutMs: 5000,
        WebSocket: class extends FakeSocket {
          constructor(url: string) {
            super(url, 'auth-invalid');
          }
        } as unknown as new (url: string) => WebSocketLike,
      },
    );
    const result = await client.connect();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('auth-failed');
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
    expect(client.redactedConfig().token).toBe('***');
  });
});

describe('温度读数语义', () => {
  it('实测值与设定值分开，绝不把设定值当实际温度', async () => {
    const client = createHaClient(
      { url: 'http://ha.local:8123', token: 't' },
      { WebSocket: FakeSocket as unknown as new (url: string) => WebSocketLike },
    );
    await client.connect();
    await client.getStates();
    const reading = await client.readTemperature('climate.living_room');
    expect(reading).not.toBeNull();
    expect(reading?.measuredC).toBe(21.5);
    expect(reading?.setpointC).toBe(24);
    expect(reading?.measuredC).not.toBe(reading?.setpointC);
    expect(reading?.available).toBe(true);
  });

  it('实体 unavailable 时 available=false 且不给出任何数值', async () => {
    const client = createHaClient(
      { url: 'http://ha.local:8123', token: 't' },
      { WebSocket: FakeSocket as unknown as new (url: string) => WebSocketLike },
    );
    await client.connect();
    await client.getStates();
    const reading = await client.readTemperature('climate.offline_room');
    expect(reading?.available).toBe(false);
    expect(reading?.measuredC).toBeNull();
    expect(reading?.setpointC).toBeNull();
  });

  it('未配置时 connect 明确返回 blocked 并带原因', async () => {
    const client = createHaClient({}, { WebSocket: FakeSocket as unknown as new (url: string) => WebSocketLike });
    const result = await client.connect();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(client.blockedReason).toBe(HA_BLOCKED_REASON);
    expect(await client.getStates()).toEqual([]);
    expect(await client.readTemperature('climate.x')).toBeNull();
  });
});
