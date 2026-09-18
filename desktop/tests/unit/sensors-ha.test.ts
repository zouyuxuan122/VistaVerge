// EXP-006 Home Assistant WebSocket 适配测试：auth/get_states/subscribe；
// 未配置 → status blocked；不可用实体标 available=false（不猜数值）；
// token 不进状态/描述（脱敏）。
import { describe, expect, it } from 'vitest';
import { HA_BLOCKED_REASON, createHaClient, type WebSocketLike } from '../../src/sensors/haClient';

const NOW = 1_700_000_000_000;
const TOKEN = 'super-secret-token';

type Listener = (ev: { data?: unknown }) => void;

class FakeWebSocket implements WebSocketLike {
  static last: FakeWebSocket | null = null;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  constructor(public url: string) {
    FakeWebSocket.last = this;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit('close', {});
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== fn);
  }
  emit(type: string, ev: { data?: unknown }): void {
    for (const fn of [...(this.listeners[type] ?? [])]) fn(ev);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
  serverSend(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) });
  }
  lastSent(): Record<string, unknown> {
    const raw = this.sent.at(-1);
    if (raw === undefined) throw new Error('no message sent');
    return JSON.parse(raw) as Record<string, unknown>;
  }
  reply(obj: Record<string, unknown>): void {
    this.serverSend({ id: this.lastSent().id, ...obj });
  }
}

const ctor = () => FakeWebSocket as unknown as new (url: string) => WebSocketLike;

function reset(): void {
  FakeWebSocket.last = null;
  FakeWebSocket.instances = [];
}

describe('HA 未配置 → BLOCKED', () => {
  it('缺 url/token 时状态 blocked，connect 返回 ok=false，读取返回空', async () => {
    reset();
    const client = createHaClient({}, { WebSocket: ctor(), now: () => NOW });
    expect(client.status).toBe('blocked');
    expect(client.blockedReason).toBe(HA_BLOCKED_REASON);

    const result = await client.connect();
    expect(result).toMatchObject({ ok: false, status: 'blocked' });
    expect(await client.getStates()).toEqual([]);
    expect(await client.read('sensor.temperature')).toBeNull();
    expect(await client.readTemperature('sensor.temperature')).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);

    const onlyUrl = createHaClient({ url: 'http://ha.local:8123' }, { WebSocket: ctor(), now: () => NOW });
    expect(onlyUrl.status).toBe('blocked');
    const onlyToken = createHaClient({ token: TOKEN }, { WebSocket: ctor(), now: () => NOW });
    expect(onlyToken.status).toBe('blocked');
  });

  it('配置脱敏：描述里不出现 token 明文', () => {
    const client = createHaClient({ url: 'http://ha.local:8123', token: TOKEN }, { WebSocket: ctor(), now: () => NOW });
    const redacted = client.redactedConfig();
    expect(redacted.url).toBe('http://ha.local:8123');
    expect(redacted.token).toBe('***');
    expect(JSON.stringify(redacted)).not.toContain(TOKEN);
  });
});

describe('HA WebSocket 握手与读取', () => {
  it('url 转换为 ws(s) 并追加 /api/websocket；auth_required → auth → auth_ok', async () => {
    reset();
    const client = createHaClient(
      { url: 'https://ha.local:8123/', token: TOKEN },
      { WebSocket: ctor(), now: () => NOW },
    );
    const pending = client.connect();
    const ws = FakeWebSocket.last;
    expect(ws?.url).toBe('wss://ha.local:8123/api/websocket');
    ws?.open();
    ws?.serverSend({ type: 'auth_required', ha_version: '2026.1' });
    expect(ws?.lastSent()).toMatchObject({ type: 'auth', access_token: TOKEN });
    ws?.serverSend({ type: 'auth_ok', ha_version: '2026.1' });
    await expect(pending).resolves.toMatchObject({ ok: true, status: 'connected' });
    expect(client.status).toBe('connected');
  });

  it('auth_invalid → auth-failed，不冒充已连接', async () => {
    reset();
    const client = createHaClient({ url: 'http://ha.local:8123', token: TOKEN }, { WebSocket: ctor(), now: () => NOW });
    const pending = client.connect();
    FakeWebSocket.last?.open();
    FakeWebSocket.last?.serverSend({ type: 'auth_invalid', message: 'bad token' });
    await expect(pending).resolves.toMatchObject({ ok: false, status: 'auth-failed' });
    expect(client.status).toBe('auth-failed');
  });

  it('get_states 返回实体，不可用实体 available=false', async () => {
    reset();
    const client = createHaClient({ url: 'http://ha.local:8123', token: TOKEN }, { WebSocket: ctor(), now: () => NOW });
    const pending = client.connect();
    FakeWebSocket.last?.open();
    FakeWebSocket.last?.serverSend({ type: 'auth_ok' });
    await pending;

    const ws = FakeWebSocket.last as FakeWebSocket;
    const statesPromise = client.getStates();
    ws.reply({
      type: 'result',
      success: true,
      result: [
        {
          entity_id: 'sensor.living_room_temperature',
          state: '18.5',
          attributes: { unit_of_measurement: '°C', current_temperature: 18.5 },
          last_updated: '2023-11-14T22:13:20Z',
        },
        { entity_id: 'sensor.offline', state: 'unavailable', attributes: {}, last_updated: '2023-11-14T22:13:20Z' },
      ],
    });
    const states = await statesPromise;
    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({ entityId: 'sensor.living_room_temperature', available: true });
    expect(states[0]?.observedAt).toBe(Date.parse('2023-11-14T22:13:20Z'));
    expect(states[1]).toMatchObject({ entityId: 'sensor.offline', available: false });
    expect(await client.read('sensor.offline')).toMatchObject({ available: false });
    expect(await client.read('sensor.missing')).toBeNull();
  });

  it('readTemperature 区分 setpoint 与 measured，不可用时均为 null', async () => {
    reset();
    const client = createHaClient({ url: 'http://ha.local:8123', token: TOKEN }, { WebSocket: ctor(), now: () => NOW });
    const pending = client.connect();
    FakeWebSocket.last?.open();
    FakeWebSocket.last?.serverSend({ type: 'auth_ok' });
    await pending;

    const ws = FakeWebSocket.last as FakeWebSocket;
    const statesPromise = client.getStates();
    ws.reply({
      type: 'result',
      success: true,
      result: [
        {
          entity_id: 'climate.room',
          state: 'heat',
          attributes: { current_temperature: 18.5, temperature: 16 },
          last_updated: '2023-11-14T22:13:20Z',
        },
        { entity_id: 'climate.gone', state: 'unavailable', attributes: { temperature: 22 }, last_updated: '2023-11-14T22:13:20Z' },
      ],
    });
    await statesPromise;

    expect(await client.readTemperature('climate.room')).toMatchObject({
      measuredC: 18.5,
      setpointC: 16,
      available: true,
    });
    expect(await client.readTemperature('climate.gone')).toMatchObject({
      measuredC: null,
      setpointC: null,
      available: false,
    });
  });

  it('subscribe 收到 state_changed 事件并回调', async () => {
    reset();
    const client = createHaClient({ url: 'http://ha.local:8123', token: TOKEN }, { WebSocket: ctor(), now: () => NOW });
    const pending = client.connect();
    FakeWebSocket.last?.open();
    FakeWebSocket.last?.serverSend({ type: 'auth_ok' });
    await pending;

    const ws = FakeWebSocket.last as FakeWebSocket;
    const seen: string[] = [];
    const subPromise = client.subscribe((state) => seen.push(`${state.entityId}:${state.state}`));
    ws.reply({ type: 'result', success: true, result: null });
    const unsubscribe = await subPromise;
    expect(ws.lastSent()).toMatchObject({ type: 'subscribe_events', event_type: 'state_changed' });

    ws.serverSend({
      type: 'event',
      event: {
        event_type: 'state_changed',
        data: {
          entity_id: 'sensor.room',
          new_state: { entity_id: 'sensor.room', state: '19.1', attributes: {}, last_updated: '2023-11-14T22:13:20Z' },
        },
      },
    });
    expect(seen).toEqual(['sensor.room:19.1']);
    unsubscribe();
    expect(ws.lastSent()).toMatchObject({ type: 'unsubscribe_events' });
  });
});
