// EXP-006 Open-Meteo 天气测试：无 key 请求、observedAt/expiresAt 过期语义、
// 离线/HTTP/格式错误均报错不伪造；过期时文案必须说明不确定。
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FRESHNESS_MS,
  WeatherError,
  buildForecastUrl,
  fetchWeather,
  isFresh,
  unavailableWeather,
  weatherCodeToText,
  weatherSummary,
  type FetchLike,
  type WeatherSnapshot,
} from '../../src/sensors/weather';

const NOW = 1_700_000_000_000;
const LOC = { latitude: 31.2304, longitude: 121.4737, label: '上海' };

const BODY = JSON.stringify({
  latitude: 31.25,
  longitude: 121.5,
  current: {
    time: '2023-11-14T22:13:20Z',
    temperature_2m: 21.5,
    apparent_temperature: 20.1,
    weather_code: 3,
    wind_speed_10m: 8.4,
    is_day: 1,
  },
});

function okFetch(body = BODY): FetchLike {
  return async () => ({ ok: true, status: 200, text: async () => body });
}

describe('buildForecastUrl', () => {
  it('无 key、含经纬度与 current 字段', () => {
    const url = buildForecastUrl(LOC);
    expect(url).toContain('https://api.open-meteo.com/v1/forecast');
    expect(url).toContain('latitude=31.2304');
    expect(url).toContain('longitude=121.4737');
    expect(url).toContain('temperature_2m');
    expect(url).not.toMatch(/api[_-]?key|apikey|token/i);
  });

  it('经纬度非法时抛 no-location', () => {
    expect(() => buildForecastUrl({ latitude: Number.NaN, longitude: 1 })).toThrow(WeatherError);
    expect(() => buildForecastUrl({ latitude: 100, longitude: 1 })).toThrow(WeatherError);
    expect(() => buildForecastUrl({ latitude: 1, longitude: 200 })).toThrow(WeatherError);
  });
});

describe('weatherCodeToText', () => {
  it('常见天气码映射为中文描述，未知码不猜', () => {
    expect(weatherCodeToText(0)).toBe('晴');
    expect(weatherCodeToText(3)).toBe('阴');
    expect(weatherCodeToText(61)).toContain('雨');
    expect(weatherCodeToText(95)).toContain('雷');
    expect(weatherCodeToText(1234)).toBe('未知天气');
  });
});

describe('fetchWeather', () => {
  it('正常路径：observedAt 取观测时间，expiresAt = observedAt + 新鲜度窗口', async () => {
    const snapshot = await fetchWeather(LOC, { fetch: okFetch(), now: () => NOW });
    const observed = Date.parse('2023-11-14T22:13:20Z');
    expect(snapshot.observedAt).toBe(observed);
    expect(snapshot.expiresAt).toBe(observed + DEFAULT_FRESHNESS_MS);
    expect(snapshot.confidence).toBe('high');
    expect(snapshot.source).toBe('open-meteo');
    expect(snapshot.data).toMatchObject({ temperatureC: 21.5, weatherCode: 3, description: '阴', isDay: true });
    // NOW 恰好等于观测时间 → 新鲜窗口内
    expect(snapshot.stale).toBe(false);
  });

  it('自定义新鲜度窗口生效，且新鲜时 stale=false', async () => {
    const observed = Date.parse('2023-11-14T22:13:20Z');
    const snapshot = await fetchWeather(LOC, {
      fetch: okFetch(),
      now: () => observed + 60_000,
      freshnessMs: 120_000,
    });
    expect(snapshot.expiresAt).toBe(observed + 120_000);
    expect(snapshot.stale).toBe(false);
    expect(isFresh(snapshot, observed + 119_000)).toBe(true);
    expect(isFresh(snapshot, observed + 120_000)).toBe(false);
  });

  it('离线（fetch 抛错）报 offline，不返回任何数据', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    let caught: unknown;
    try {
      await fetchWeather(LOC, { fetch: fetchImpl, now: () => NOW });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WeatherError);
    expect((caught as WeatherError).code).toBe('offline');
  });

  it('HTTP 错误报 http，响应体非 JSON / 缺 current 报 malformed', async () => {
    const bad: FetchLike = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' });
    await expect(fetchWeather(LOC, { fetch: bad, now: () => NOW })).rejects.toMatchObject({ code: 'http' });

    await expect(
      fetchWeather(LOC, { fetch: async () => ({ ok: true, status: 200, text: async () => 'not json' }), now: () => NOW }),
    ).rejects.toMatchObject({ code: 'malformed' });

    await expect(
      fetchWeather(LOC, {
        fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ current: {} }) }),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'malformed' });
  });

  it('超时中止请求并报 timeout，不挂死', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(fetchWeather(LOC, { fetch: fetchImpl, now: () => NOW, timeoutMs: 20 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('无定位（缺经纬度）直接报 no-location，且不发起请求', async () => {
    const fetchImpl = vi.fn(okFetch());
    await expect(fetchWeather({ latitude: Number.NaN, longitude: 0 }, { fetch: fetchImpl, now: () => NOW })).rejects.toMatchObject(
      { code: 'no-location' },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('weatherSummary 过期语义', () => {
  const fresh: WeatherSnapshot = {
    data: { temperatureC: 21.5, apparentC: 20.1, weatherCode: 3, windKph: 8.4, isDay: true, description: '阴' },
    observedAt: NOW,
    expiresAt: NOW + 60_000,
    confidence: 'high',
    source: 'open-meteo',
    location: LOC,
    stale: false,
  };

  it('新鲜数据给出温度与描述，uncertain=false', () => {
    const summary = weatherSummary(fresh, NOW + 1000);
    expect(summary.uncertain).toBe(false);
    expect(summary.text).toContain('21.5');
    expect(summary.text).toContain('阴');
  });

  it('过期数据 uncertain=true，文案明确说明不确定且不给实时温度', () => {
    const summary = weatherSummary(fresh, NOW + 60_000);
    expect(summary.uncertain).toBe(true);
    expect(summary.text).toMatch(/不确定|过期|无法确认/);
    expect(summary.text).not.toContain('21.5');
  });

  it('unavailableWeather 明确无数据，summary 不确定', () => {
    const snapshot = unavailableWeather('offline');
    expect(snapshot.data).toBeNull();
    expect(snapshot.confidence).toBe('none');
    expect(snapshot.stale).toBe(true);
    expect(isFresh(snapshot, NOW)).toBe(false);
    const summary = weatherSummary(snapshot, NOW);
    expect(summary.uncertain).toBe(true);
    expect(summary.text).toMatch(/不确定|无法确认|不可用/);
  });
});
