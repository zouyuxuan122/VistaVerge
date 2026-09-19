// F1-ASSIST 单测：GitHub 只读巡检（ghPatrol）。
// 覆盖：正常列表解析、ETag/304 复用、429/403 指数退避与上限、离线诚实态、
// 未配置仓库/token 零请求、401 不重试、新增/更新对比、定时默认关闭、
// 配置与快照持久化、事件回调、**零写操作断言（fetch 只收到 GET）**。
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_BASE_MS,
  DEFAULT_INTERVAL_MS,
  MAX_RATE_LIMIT_RETRIES,
  createGhPatrolService,
  loadGhConfig,
  parseRepos,
  runGhPatrol,
  summarizePatrol,
  type HttpResponseLike,
  type PatrolFetchInit,
  type PatrolFetchLike,
} from '../../src/assistant/ghPatrol';
import { setAssistantEventListener } from '../../src/assistant/events';
import type { StorageLike } from '../../src/assistant/localStore';

const NOW = 1_756_000_000_000;
const TOKEN = 'ghp_super-secret-token';
const REPO = 'octocat/Hello-World';

/* ------------------------------ 测试替身 ------------------------------ */

function memStorage(): StorageLike & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

interface RecordedCall {
  url: string;
  init: PatrolFetchInit;
}

function makeFetch(
  handler: (url: string, init: PatrolFetchInit, call: number) => HttpResponseLike | Error,
): { fn: PatrolFetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn: PatrolFetchLike = async (url, init) => {
    calls.push({ url, init });
    const out = handler(url, init, calls.length - 1);
    if (out instanceof Error) throw out;
    return out;
  };
  return { fn, calls };
}

function res(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponseLike {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function prPayload(
  number: number,
  overrides: { title?: string; author?: string; updated?: string; draft?: boolean; labels?: string[] } = {},
): Record<string, unknown> {
  return {
    number,
    title: overrides.title ?? `PR ${number}`,
    user: { login: overrides.author ?? 'octocat' },
    updated_at: overrides.updated ?? '2026-09-19T00:00:00Z',
    draft: overrides.draft ?? false,
    labels: (overrides.labels ?? []).map((name) => ({ name })),
    html_url: `https://github.com/${REPO}/pull/${number}`,
  };
}

function issuePayload(
  number: number,
  overrides: { title?: string; author?: string; updated?: string; labels?: string[] } = {},
): Record<string, unknown> {
  return {
    number,
    title: overrides.title ?? `Issue ${number}`,
    user: { login: overrides.author ?? 'octocat' },
    updated_at: overrides.updated ?? '2026-09-19T00:00:00Z',
    labels: (overrides.labels ?? []).map((name) => ({ name })),
    html_url: `https://github.com/${REPO}/issues/${number}`,
  };
}

function isPulls(url: string): boolean {
  return url.includes('/pulls');
}

/* ------------------------------ 用例 ------------------------------ */

describe('ghPatrol 正常路径', () => {
  it('只发 GET，解析 PR/issue，摘要含待评审分布，token 不进结果', async () => {
    const { fn, calls } = makeFetch((url) => {
      if (isPulls(url)) {
        return res(200, [prPayload(1), prPayload(2, { draft: true, labels: ['bug'] })], {
          etag: 'W/"pulls-1"',
          'last-modified': 'Fri, 19 Sep 2026 00:00:00 GMT',
        });
      }
      // issues 端点会带 PR 回来（带 pull_request 字段）→ 必须排除
      return res(200, [issuePayload(7), { ...prPayload(3), pull_request: { url: 'x' } }], {
        etag: 'W/"issues-1"',
      });
    });
    const storage = memStorage();
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage,
    });
    service.setRepos(REPO);
    const run = await service.run();

    expect(run.status).toBe('ok');
    expect(run.observedAt).toBe(NOW);
    expect(run.baseline).toBe(true);
    const repo = run.repos[0];
    expect(repo.repo).toBe(REPO);
    expect(repo.openPrs).toBe(2);
    expect(repo.draftPrs).toBe(1);
    expect(repo.awaitingReview).toBe(1);
    expect(repo.openIssues).toBe(1);
    expect(repo.items.map((item) => `${item.kind}#${item.number}`)).toEqual(['pr#1', 'pr#2', 'issue#7']);
    expect(repo.items[1].labels).toEqual(['bug']);

    // 零写操作（D8）：请求方法恒为 GET
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.init.method === 'GET')).toBe(true);
    expect(calls.every((call) => call.url.includes('state=open'))).toBe(true);
    expect(run.requestMethods).toEqual(['GET', 'GET']);
    expect(run.requestMethods).not.toContain('POST');
    expect(run.requestMethods).not.toContain('PATCH');
    expect(run.requestMethods).not.toContain('DELETE');

    // 凭据脱敏：token 只出现在 Authorization 头，不进结果/摘要
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(JSON.stringify(storage.dump())).not.toContain(TOKEN);

    expect(run.summary).toContain('GitHub 巡检');
    expect(run.summary).toContain('待评审 1');
    expect(run.summary).toContain('草稿 1');
    expect(run.summary).toContain('首次巡检');
  });

  it('第二次巡检对比出新增/更新', async () => {
    let phase = 1;
    const { fn } = makeFetch((url) => {
      if (phase === 1) {
        return isPulls(url)
          ? res(200, [prPayload(1, { updated: 'A' })])
          : res(200, [issuePayload(2, { updated: 'A' })]);
      }
      return isPulls(url)
        ? res(200, [prPayload(1, { updated: 'B' }), prPayload(4, { updated: 'A' })])
        : res(200, [issuePayload(2, { updated: 'A' })]);
    });
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage: memStorage(),
    });
    service.setRepos(REPO);
    const first = await service.run();
    expect(first.baseline).toBe(true);
    expect(first.repos[0].newItems).toBe(0);

    phase = 2;
    const second = await service.run();
    expect(second.baseline).toBe(false);
    expect(second.repos[0].newItems).toBe(1);
    expect(second.repos[0].updatedItems).toBe(1);
    expect(second.summary).toContain('新增 1');
    expect(second.summary).toContain('更新 1');
  });

  it('条件请求：304 沿用上次结果并标注 notModified', async () => {
    let phase = 1;
    const { fn, calls } = makeFetch((url) => {
      if (phase === 1) {
        return isPulls(url) ? res(200, [prPayload(1)], { etag: 'W/"pulls"' }) : res(200, [issuePayload(2)], { etag: 'W/"issues"' });
      }
      return res(304, null);
    });
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage: memStorage(),
    });
    service.setRepos(REPO);
    await service.run();
    phase = 2;
    const second = await service.run();

    expect(second.repos[0].status).toBe('ok');
    expect(second.repos[0].notModified).toBe(true);
    expect(second.repos[0].items.map((item) => item.number)).toEqual([1, 2]);
    expect(second.repos[0].openPrs).toBe(1);
    expect(second.summary).toContain('未变更（304）');

    const secondCalls = calls.slice(2);
    expect(secondCalls).toHaveLength(2);
    expect(secondCalls.every((call) => call.init.headers['If-None-Match'] !== undefined)).toBe(true);
    expect(secondCalls.every((call) => call.init.method === 'GET')).toBe(true);
  });
});

describe('ghPatrol 限流与失败诚实态', () => {
  it('429 指数退避后成功，退避序列 500/1000/2000', async () => {
    const sleeps: number[] = [];
    let call = 0;
    const { fn } = makeFetch((url) => {
      call += 1;
      if (call === 1) return res(429, { message: 'rate limited' });
      return isPulls(url) ? res(200, [prPayload(1)]) : res(200, [issuePayload(2)]);
    });
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage: memStorage(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    service.setRepos(REPO);
    const run = await service.run();

    expect(run.status).toBe('ok');
    expect(sleeps).toEqual([BACKOFF_BASE_MS]);
    expect(run.repos[0].attempts).toBe(3); // pulls 重试 1 次 + issues 1 次
  });

  it('持续 429 → rate-limited，重试到上限后停止，不编造列表', async () => {
    const sleeps: number[] = [];
    const { fn, calls } = makeFetch(() => res(429, { message: 'rate limited' }));
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage: memStorage(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    service.setRepos(REPO);
    const run = await service.run();

    expect(run.status).toBe('rate-limited');
    expect(run.repos[0].status).toBe('rate-limited');
    expect(run.repos[0].items).toEqual([]);
    expect(run.repos[0].attempts).toBe((MAX_RATE_LIMIT_RETRIES + 1) * 2);
    // pulls / issues 两个端点并发退避，所以退避序列按端点交错，但整体是 500→1000→2000 指数增长。
    expect(sleeps).toEqual([500, 500, 1000, 1000, 2000, 2000]);
    expect(sleeps).toHaveLength(MAX_RATE_LIMIT_RETRIES * 2);
    expect(run.repos[0].message).toContain('限流');
    expect(run.summary).toContain('限流中');
    expect(run.summary).toContain('未取得数据');
    expect(calls.every((entry) => entry.init.method === 'GET')).toBe(true);
  });

  it('403 + x-ratelimit-remaining: 0 同样按限流退避', async () => {
    const sleeps: number[] = [];
    let call = 0;
    const { fn } = makeFetch((url) => {
      call += 1;
      if (call === 1) return res(403, { message: 'forbidden' }, { 'x-ratelimit-remaining': '0' });
      return isPulls(url) ? res(200, [prPayload(1)]) : res(200, [issuePayload(2)]);
    });
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage: memStorage(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    service.setRepos(REPO);
    const run = await service.run();
    expect(run.status).toBe('ok');
    expect(sleeps).toEqual([500]);
  });

  it('网络不可达 → offline 诚实态，零列表', async () => {
    const sleeps: number[] = [];
    const { fn } = makeFetch(() => new Error('network down'));
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage: memStorage(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    service.setRepos(REPO);
    const run = await service.run();

    expect(run.status).toBe('offline');
    expect(run.repos[0].items).toEqual([]);
    expect(run.repos[0].message).toContain('网络不可达或超时');
    expect(run.summary).toContain('离线');
    expect(run.summary).toContain('不编造列表');
    expect(sleeps).toEqual([500, 500, 1000, 1000, 2000, 2000]);
  });

  it('401 → auth-failed，不重试', async () => {
    const sleeps: number[] = [];
    const { fn, calls } = makeFetch(() => res(401, { message: 'Bad credentials' }));
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage: memStorage(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    service.setRepos(REPO);
    const run = await service.run();

    expect(run.status).toBe('auth-failed');
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
    expect(run.summary).toContain('认证失败');
  });

  it('404 → not-found（仓库不可访问）', async () => {
    const { fn } = makeFetch(() => res(404, { message: 'Not Found' }));
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage: memStorage(),
      sleep: async () => {},
    });
    service.setRepos(REPO);
    const run = await service.run();
    expect(run.status).toBe('not-found');
    expect(run.summary).toContain('仓库不可访问');
  });

  it('多仓库时汇总状态取第一个失败仓库，不被前面成功的掩盖', async () => {
    const { fn } = makeFetch((url) => {
      if (url.includes('/repos/broken/')) return res(404, { message: 'Not Found' });
      return isPulls(url) ? res(200, [prPayload(1)]) : res(200, [issuePayload(2)]);
    });
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage: memStorage(),
      sleep: async () => {},
    });
    service.setRepos('ok/repo\nbroken/repo');
    const run = await service.run();
    expect(run.repos.map((repo) => repo.status)).toEqual(['ok', 'not-found']);
    expect(run.status).toBe('not-found');
    expect(run.summary).toContain('ok/repo');
    expect(run.summary).toContain('仓库不可访问');
  });
});

describe('ghPatrol 未配置与零请求', () => {
  it('未配置仓库 → not-configured，零 HTTP 请求', async () => {
    const { fn, calls } = makeFetch(() => res(200, []));
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage: memStorage(),
    });
    const run = await service.run();
    expect(run.status).toBe('not-configured');
    expect(run.message).toContain('未配置仓库');
    expect(run.requestMethods).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(run.summary).toContain('未配置仓库');
  });

  it('未配置 token → not-configured，零 HTTP 请求，tokenPresent=false', async () => {
    const { fn, calls } = makeFetch(() => res(200, []));
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => null,
      now: () => NOW,
      storage: memStorage(),
    });
    service.setRepos(REPO);
    expect(await service.tokenPresent()).toBe(false);
    const run = await service.run();
    expect(run.status).toBe('not-configured');
    expect(run.message).toContain('未配置 token');
    expect(calls).toHaveLength(0);
  });

  it('tokenPresent 只返回布尔，不回显明文', async () => {
    const service = createGhPatrolService({ getToken: async () => TOKEN, storage: memStorage() });
    const present = await service.tokenPresent();
    expect(present).toBe(true);
    expect(JSON.stringify(present)).not.toContain(TOKEN);
  });
});

describe('ghPatrol 配置、定时与事件', () => {
  it('定时默认关闭；显式开启且配置仓库后才创建定时器', () => {
    const service = createGhPatrolService({
      fetch: async () => res(200, []),
      getToken: async () => TOKEN,
      storage: memStorage(),
    });
    expect(service.getConfig().scheduledEnabled).toBe(false);
    expect(service.getConfig().intervalMs).toBe(DEFAULT_INTERVAL_MS);
    expect(service.scheduledActive()).toBe(false);

    service.setRepos(REPO);
    expect(service.scheduledActive()).toBe(false);

    service.setConfig({ scheduledEnabled: true });
    expect(service.scheduledActive()).toBe(true);

    service.setConfig({ scheduledEnabled: false });
    expect(service.scheduledActive()).toBe(false);

    service.setConfig({ scheduledEnabled: true });
    service.dispose();
    expect(service.scheduledActive()).toBe(false);
  });

  it('开启定时但未配置仓库 → 不创建定时器（不空跑）', () => {
    const service = createGhPatrolService({ storage: memStorage(), getToken: async () => null });
    service.setConfig({ scheduledEnabled: true });
    expect(service.scheduledActive()).toBe(false);
    service.dispose();
  });

  it('间隔下限保护与仓库解析', () => {
    const service = createGhPatrolService({ storage: memStorage() });
    expect(service.setConfig({ intervalMs: 1000 }).intervalMs).toBe(60_000);
    const parsed = service.setRepos('https://github.com/octocat/Hello-World\nnot-a-repo, foo/bar\nfoo/bar');
    expect(parsed.repos).toEqual(['octocat/Hello-World', 'foo/bar']);
    expect(parsed.invalid).toEqual(['not-a-repo']);
    service.dispose();
  });

  it('配置与快照持久化到注入的存储', async () => {
    const storage = memStorage();
    const { fn } = makeFetch((url) =>
      isPulls(url) ? res(200, [prPayload(1)], { etag: 'W/"p"' }) : res(200, [issuePayload(2)]),
    );
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage,
    });
    service.setRepos(REPO);
    await service.run();

    expect(loadGhConfig(storage).repos).toEqual([REPO]);
    expect(Object.keys(storage.dump())).toEqual([
      'vistaverge.assistant.ghConfig',
      'vistaverge.assistant.ghSnapshot',
    ]);
    // 快照里存了 ETag，供下次条件请求（If-None-Match）
    const snapshot = JSON.parse(storage.dump()['vistaverge.assistant.ghSnapshot'] as string) as {
      observedAt: number;
      endpoints: Record<string, { etag?: string; items: unknown[] }>;
    };
    expect(snapshot.observedAt).toBe(NOW);
    expect(snapshot.endpoints[`${REPO}#pr`].etag).toBe('W/"p"');
    expect(snapshot.endpoints[`${REPO}#pr`].items).toHaveLength(1);
    // 凭据不进快照/配置
    expect(JSON.stringify(storage.dump())).not.toContain(TOKEN);
  });

  it('巡检出摘要时回调 setAssistantEventListener.onPatrolSummary', async () => {
    const { fn } = makeFetch((url) => (isPulls(url) ? res(200, [prPayload(1)]) : res(200, [issuePayload(2)])));
    const service = createGhPatrolService({
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      storage: memStorage(),
    });
    service.setRepos(REPO);
    const seen: string[] = [];
    setAssistantEventListener({ onPatrolSummary: (summary) => seen.push(summary) });
    try {
      const run = await service.run();
      expect(seen).toEqual([run.summary]);
      expect(seen[0]).toContain('GitHub 巡检');
    } finally {
      setAssistantEventListener(null);
    }
  });

  it('未配置时也会回调（诚实失败态同样要能主动告知）', async () => {
    const service = createGhPatrolService({ storage: memStorage(), getToken: async () => null });
    service.setRepos(REPO);
    const seen: string[] = [];
    setAssistantEventListener({ onPatrolSummary: (summary) => seen.push(summary) });
    try {
      await service.run();
    } finally {
      setAssistantEventListener(null);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('未配置 token');
  });
});

describe('parseRepos / summarizePatrol 纯函数', () => {
  it('解析多种分隔符、去重、剥掉 URL 前缀，非法项如实返回', () => {
    expect(parseRepos('a/b, c/d\ne/f; g/h、i/j')).toEqual({
      repos: ['a/b', 'c/d', 'e/f', 'g/h', 'i/j'],
      invalid: [],
    });
    expect(parseRepos(['https://github.com/a/b/', 'nope'])).toEqual({ repos: ['a/b'], invalid: ['nope'] });
    expect(parseRepos('   ')).toEqual({ repos: [], invalid: [] });
  });

  it('摘要对失败仓库只报状态，不编造列表', async () => {
    const { fn } = makeFetch(() => new Error('down'));
    const { run } = await runGhPatrol({
      config: { repos: [REPO], intervalMs: DEFAULT_INTERVAL_MS, scheduledEnabled: false },
      fetch: fn,
      getToken: async () => TOKEN,
      now: () => NOW,
      sleep: async () => {},
      previous: null,
    });
    const summary = summarizePatrol(run);
    expect(summary).toContain('离线');
    expect(summary).not.toContain('open PR 0');
  });
});
