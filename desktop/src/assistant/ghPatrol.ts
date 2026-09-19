/**
 * assistant/ghPatrol.ts — GitHub PR/Issue **只读**巡检（F1-ASSIST P0）。
 *
 * 设计合同：
 * - docs/plugins/DOMAIN_PLUGINS.md §1.4（默认只读；定时须用户显式配置；token 最小作用域、
 *   不进日志/报告；写操作需单独授权）、§3.7（github.listPR/listIssue 只读，写接口默认未授予）、
 *   §2 GitHub 行（认证失败/限流：报告并退避，不重试轰炸）、D8（一次巡检零写操作）。
 * - 工程控制/FEATURE-01/GAP_AUDIT.md G-GH-01。
 *
 * 硬性实现约束：
 * 1. 本模块只发 **GET**（`requestMethods` 记录每次实际方法，供零写自证与单测断言）。
 * 2. token 从 platform/credentials 读 `ghToken`，只用于 Authorization 头；
 *    任何返回值/摘要/错误消息都不包含 token 明文。
 * 3. ETag / If-Modified-Since 条件请求；429（及 403 + x-ratelimit-remaining: 0）按
 *    指数退避重试，最多 3 次重试后如实报「限流中」。
 * 4. 网络不可达 / 未配置 token / 仓库不存在 → 诚实状态，绝不编造列表。
 * 5. 定时默认关闭（DOMAIN §6），只有用户显式开启才 setInterval。
 */
import { fetch as pluginFetch } from '@tauri-apps/plugin-http';
import { getSecret } from '../platform/credentials';
import { emitPatrolSummary } from './events';
import { defaultStorage, readJson, writeJson, type StorageLike } from './localStore';

/* ------------------------------------------------------------------ */
/* 常量与类型                                                           */
/* ------------------------------------------------------------------ */

export const GH_API_BASE = 'https://api.github.com';
/** 凭据仓键名（任务书固定：ghToken；作用域应为最小 read）。 */
export const GH_TOKEN_KEY = 'ghToken';
/** 默认定时间隔 30 分钟；默认**不开启**定时（DOMAIN §6「GitHub 巡检频率」可校准）。 */
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
/** 间隔下限，避免用户填 0/负数把定时变成轰炸。 */
export const MIN_INTERVAL_MS = 60 * 1000;
/** 单次请求超时（外部网络调用必须带 timeout，不无限挂起）。 */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** 限流退避基数：500ms → 1s → 2s。 */
export const BACKOFF_BASE_MS = 500;
/** 退避重试次数上限（首次请求之外最多再试 3 次）。 */
export const MAX_RATE_LIMIT_RETRIES = 3;

const CONFIG_KEY = 'vistaverge.assistant.ghConfig';
const SNAPSHOT_KEY = 'vistaverge.assistant.ghSnapshot';

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null } | null;
  json?(): Promise<unknown>;
  text(): Promise<string>;
}

export interface PatrolFetchInit {
  method: 'GET';
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export type PatrolFetchLike = (url: string, init: PatrolFetchInit) => Promise<HttpResponseLike>;

export type PatrolRepoStatus =
  | 'ok'
  | 'not-configured'
  | 'auth-failed'
  | 'rate-limited'
  | 'offline'
  | 'not-found'
  | 'error';

export const PATROL_STATUS_LABEL: Record<PatrolRepoStatus, string> = {
  ok: '正常',
  'not-configured': '未配置',
  'auth-failed': '认证失败',
  'rate-limited': '限流中',
  offline: '离线',
  'not-found': '仓库不可访问',
  error: '请求失败',
};

export interface GhPatrolConfig {
  /** `owner/repo` 列表。 */
  repos: string[];
  /** 定时间隔（ms）。 */
  intervalMs: number;
  /** 定时巡检开关；默认 false，必须用户显式开启。 */
  scheduledEnabled: boolean;
}

export const DEFAULT_GH_PATROL_CONFIG: GhPatrolConfig = {
  repos: [],
  intervalMs: DEFAULT_INTERVAL_MS,
  scheduledEnabled: false,
};

export interface PatrolItem {
  kind: 'pr' | 'issue';
  number: number;
  title: string;
  author: string;
  /** GitHub 原始 updated_at（ISO 字符串）。 */
  updatedAt: string;
  /** 仅 PR 有意义；issue 恒为 false。 */
  draft: boolean;
  labels: string[];
  url: string;
}

export interface RepoPatrolResult {
  repo: string;
  status: PatrolRepoStatus;
  items: PatrolItem[];
  openPrs: number;
  draftPrs: number;
  /** 待评审分布：open 且非草稿的 PR（草稿不进入待评审）。 */
  awaitingReview: number;
  openIssues: number;
  /** 相对上次巡检的新增条目数（首次巡检无基线时恒 0，见 baseline）。 */
  newItems: number;
  /** 相对上次巡检 updated_at 变化的条目数。 */
  updatedItems: number;
  /** 条件请求命中 304。 */
  notModified: boolean;
  /** 实际 HTTP 请求次数（含退避重试）。 */
  attempts: number;
  message: string;
}

export interface PatrolRunResult {
  observedAt: number;
  /** true = 首次巡检（无历史基线，新增/更新不可比，不虚报数字）。 */
  baseline: boolean;
  status: PatrolRepoStatus;
  repos: RepoPatrolResult[];
  summary: string;
  message: string;
  /** 本次巡检实际发出的 HTTP 方法序列，恒为 'GET'（D8 零写自证）。 */
  requestMethods: string[];
}

/** 上次巡检的本地快照：条件请求头 + 条目索引（用于新增/更新对比）。 */
export interface PatrolSnapshot {
  observedAt: number;
  endpoints: Record<string, { etag?: string; lastModified?: string; items: PatrolItem[] }>;
  index: Record<string, { kind: 'pr' | 'issue'; updatedAt: string }>;
}

/* ------------------------------------------------------------------ */
/* 纯函数：仓库解析 / 摘要                                              */
/* ------------------------------------------------------------------ */

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** 解析用户输入的仓库列表（逗号/换行/空格分隔），返回合法与非法两拨，不静默吞掉非法项。 */
export function parseRepos(input: string | string[]): { repos: string[]; invalid: string[] } {
  const raw = Array.isArray(input) ? input : input.split(/[\s,，、;；]+/);
  const repos: string[] = [];
  const invalid: string[] = [];
  for (const item of raw) {
    const value = item.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    if (value === '') continue;
    if (!REPO_PATTERN.test(value)) {
      invalid.push(value);
      continue;
    }
    if (!repos.includes(value)) repos.push(value);
  }
  return { repos, invalid };
}

function formatStamp(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

/**
 * `summarize(patrolResult)`：产出中文摘要文本（新增/更新/待评审分布）。
 * 失败态只报状态，不编造列表。
 */
export function summarizePatrol(run: PatrolRunResult): string {
  const stamp = formatStamp(run.observedAt);
  if (run.repos.length === 0) {
    return `GitHub 巡检（${stamp}）：${run.message || '未配置仓库，未发起任何请求'}`;
  }
  const lines: string[] = [];
  const baselineNote = run.baseline ? '（首次巡检，无历史基线）' : '';
  lines.push(`GitHub 巡检（${stamp}）：${run.repos.length} 个仓库${baselineNote}`);
  for (const repo of run.repos) {
    if (repo.status !== 'ok') {
      lines.push(`- ${repo.repo}：${PATROL_STATUS_LABEL[repo.status]}，本次未取得数据（不编造列表）`);
      continue;
    }
    const parts = [
      `open PR ${repo.openPrs}（草稿 ${repo.draftPrs}，待评审 ${repo.awaitingReview}）`,
      `open issue ${repo.openIssues}`,
    ];
    if (!run.baseline) parts.push(`新增 ${repo.newItems}`, `更新 ${repo.updatedItems}`);
    if (repo.notModified) parts.push('未变更（304）');
    lines.push(`- ${repo.repo}：${parts.join(' · ')}`);
  }
  const ok = run.repos.filter((repo) => repo.status === 'ok');
  const totals = [`PR ${sum(ok.map((r) => r.openPrs))} / issue ${sum(ok.map((r) => r.openIssues))}`];
  if (!run.baseline) {
    totals.push(`新增 ${sum(ok.map((r) => r.newItems))}`, `更新 ${sum(ok.map((r) => r.updatedItems))}`);
  }
  lines.push(`合计：${totals.join('，')}。`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 配置与快照持久化                                                     */
/* ------------------------------------------------------------------ */

function sanitizeInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.floor(value));
}

export function loadGhConfig(storage: StorageLike | null = defaultStorage()): GhPatrolConfig {
  const raw = readJson<Partial<GhPatrolConfig>>(storage, CONFIG_KEY);
  if (!raw) return { ...DEFAULT_GH_PATROL_CONFIG };
  const parsed = parseRepos(Array.isArray(raw.repos) ? raw.repos : []);
  return {
    repos: parsed.repos,
    intervalMs: sanitizeInterval(raw.intervalMs),
    // 定时开关只有显式 true 才算开启（缺省/损坏一律关闭）。
    scheduledEnabled: raw.scheduledEnabled === true,
  };
}

export function saveGhConfig(
  config: GhPatrolConfig,
  storage: StorageLike | null = defaultStorage(),
): void {
  writeJson(storage, CONFIG_KEY, config);
}

export function loadPatrolSnapshot(
  storage: StorageLike | null = defaultStorage(),
): PatrolSnapshot | null {
  const raw = readJson<PatrolSnapshot>(storage, SNAPSHOT_KEY);
  if (!raw || typeof raw.observedAt !== 'number') return null;
  return {
    observedAt: raw.observedAt,
    endpoints: raw.endpoints ?? {},
    index: raw.index ?? {},
  };
}

export function savePatrolSnapshot(
  snapshot: PatrolSnapshot,
  storage: StorageLike | null = defaultStorage(),
): void {
  writeJson(storage, SNAPSHOT_KEY, snapshot);
}

/* ------------------------------------------------------------------ */
/* 巡检核心                                                             */
/* ------------------------------------------------------------------ */

export interface GhPatrolDeps {
  fetch?: PatrolFetchLike;
  /** 读凭据仓的 token；默认 platform/credentials 的 getSecret('ghToken')。 */
  getToken?: () => Promise<string | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  storage?: StorageLike | null;
  timeoutMs?: number;
}

export interface RunGhPatrolOptions extends GhPatrolDeps {
  config: GhPatrolConfig;
  previous?: PatrolSnapshot | null;
}

const defaultFetch: PatrolFetchLike = (url, init) =>
  pluginFetch(url, init as unknown as RequestInit) as unknown as Promise<HttpResponseLike>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function defaultGetToken(): Promise<string | null> {
  const value = await getSecret(GH_TOKEN_KEY);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function backoffDelay(retry: number): number {
  return BACKOFF_BASE_MS * 2 ** retry;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw === 'string' && raw) out.push(raw);
    else if (raw && typeof raw === 'object') {
      const name = asString((raw as { name?: unknown }).name);
      if (name) out.push(name);
    }
  }
  return out;
}

/** 解析 GitHub 列表响应为 PatrolItem[]；形状不对的条目跳过（不伪造字段）。 */
export function parsePatrolItems(kind: 'pr' | 'issue', payload: unknown): PatrolItem[] {
  if (!Array.isArray(payload)) return [];
  const items: PatrolItem[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const number = asNumber(obj.number);
    const title = asString(obj.title);
    if (number === null || !title) continue;
    // issues 端点会把 PR 也带回来（带 pull_request 字段），巡检 issue 时排除。
    if (kind === 'issue' && obj.pull_request) continue;
    const user = obj.user as { login?: unknown } | undefined;
    items.push({
      kind,
      number,
      title,
      author: asString(user?.login) || '未知',
      updatedAt: asString(obj.updated_at),
      draft: obj.draft === true,
      labels: asLabels(obj.labels),
      url: asString(obj.html_url),
    });
  }
  return items;
}

interface EndpointFetchResult {
  status: PatrolRepoStatus;
  items: PatrolItem[];
  notModified: boolean;
  attempts: number;
  etag?: string;
  lastModified?: string;
  message: string;
}

async function fetchEndpoint(
  kind: 'pr' | 'issue',
  repo: string,
  options: RunGhPatrolOptions,
  token: string,
  fetchFn: PatrolFetchLike,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
  requestMethods: string[],
): Promise<EndpointFetchResult> {
  const path = kind === 'pr' ? 'pulls' : 'issues';
  const url = `${GH_API_BASE}/repos/${repo}/${path}?state=open&per_page=50&sort=updated&direction=desc`;
  const cached = options.previous?.endpoints[`${repo}#${kind}`];
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // token 只出现在这里，绝不进返回值/摘要/日志。
    Authorization: `Bearer ${token}`,
  };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  let attempts = 0;
  for (let retry = 0; ; retry += 1) {
    attempts += 1;
    let response: HttpResponseLike;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        requestMethods.push('GET');
        response = await fetchFn(url, { method: 'GET', headers, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (retry < MAX_RATE_LIMIT_RETRIES) {
        await sleep(backoffDelay(retry));
        continue;
      }
      return {
        status: 'offline',
        items: [],
        notModified: false,
        attempts,
        message: `网络不可达或超时：${errorMessage(err)}（本次未取得数据，不编造列表）`,
      };
    }

    if (response.status === 304) {
      return {
        status: 'ok',
        items: cached?.items ?? [],
        notModified: true,
        attempts,
        etag: cached?.etag,
        lastModified: cached?.lastModified,
        message: '条件请求命中 304，沿用上次结果',
      };
    }

    const remaining = response.headers?.get('x-ratelimit-remaining');
    const rateLimited = response.status === 429 || (response.status === 403 && remaining === '0');
    if (rateLimited) {
      if (retry < MAX_RATE_LIMIT_RETRIES) {
        await sleep(backoffDelay(retry));
        continue;
      }
      return {
        status: 'rate-limited',
        items: [],
        notModified: false,
        attempts,
        message: `GitHub 限流，指数退避重试 ${MAX_RATE_LIMIT_RETRIES} 次后仍失败（不重试轰炸）`,
      };
    }

    if (response.status === 401) {
      return {
        status: 'auth-failed',
        items: [],
        notModified: false,
        attempts,
        message: 'token 无效或已过期（401，不重试）',
      };
    }
    if (response.status === 404) {
      return {
        status: 'not-found',
        items: [],
        notModified: false,
        attempts,
        message: '仓库不存在或 token 无权访问（404）',
      };
    }
    if (!response.ok) {
      return {
        status: 'error',
        items: [],
        notModified: false,
        attempts,
        message: `GitHub HTTP ${response.status}`,
      };
    }

    let payload: unknown;
    try {
      payload = response.json ? await response.json() : JSON.parse(await response.text());
    } catch (err) {
      return {
        status: 'error',
        items: [],
        notModified: false,
        attempts,
        message: `响应不是合法 JSON：${errorMessage(err)}`,
      };
    }

    return {
      status: 'ok',
      items: parsePatrolItems(kind, payload),
      notModified: false,
      attempts,
      etag: response.headers?.get('etag') ?? undefined,
      lastModified: response.headers?.get('last-modified') ?? undefined,
      message: '',
    };
  }
}

/**
 * 执行一次只读巡检（不落盘、不 emit；由 createGhPatrolService.run 负责持久化与回调）。
 * 未配置仓库/token 时直接返回诚实状态，**不发起任何请求**。
 */
export async function runGhPatrol(options: RunGhPatrolOptions): Promise<{
  run: PatrolRunResult;
  snapshot: PatrolSnapshot;
}> {
  const now = options.now ?? (() => Date.now());
  const fetchFn = options.fetch ?? defaultFetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const getTokenFn = options.getToken ?? defaultGetToken;
  const observedAt = now();
  const requestMethods: string[] = [];
  const previous = options.previous ?? null;

  const notConfigured = (message: string): { run: PatrolRunResult; snapshot: PatrolSnapshot } => {
    const run: PatrolRunResult = {
      observedAt,
      baseline: previous === null,
      status: 'not-configured',
      repos: [],
      message,
      summary: '',
      requestMethods,
    };
    run.summary = summarizePatrol(run);
    return { run, snapshot: previous ?? { observedAt, endpoints: {}, index: {} } };
  };

  const repos = parseRepos(options.config.repos).repos;
  if (repos.length === 0) {
    return notConfigured('未配置仓库：请在「GitHub 巡检」里填入 owner/repo');
  }

  const token = await getTokenFn();
  if (!token) {
    return notConfigured('未配置 token：请先把只读 GitHub token 存进凭据仓（键名 ghToken）');
  }

  const endpoints: PatrolSnapshot['endpoints'] = {};
  const results: RepoPatrolResult[] = [];

  for (const repo of repos) {
    const [prFetch, issueFetch] = await Promise.all([
      fetchEndpoint('pr', repo, options, token, fetchFn, sleep, timeoutMs, requestMethods),
      fetchEndpoint('issue', repo, options, token, fetchFn, sleep, timeoutMs, requestMethods),
    ]);
    endpoints[`${repo}#pr`] = {
      etag: prFetch.etag,
      lastModified: prFetch.lastModified,
      items: prFetch.items,
    };
    endpoints[`${repo}#issue`] = {
      etag: issueFetch.etag,
      lastModified: issueFetch.lastModified,
      items: issueFetch.items,
    };

    const items = [...prFetch.items, ...issueFetch.items];
    const failures = [prFetch, issueFetch].filter((entry) => entry.status !== 'ok');
    const status: PatrolRepoStatus = failures[0]?.status ?? 'ok';
    const messages = failures.map((entry) => entry.message).filter(Boolean);

    const previousIndex = previous?.index ?? {};
    let newItems = 0;
    let updatedItems = 0;
    for (const item of items) {
      const key = `${item.kind}#${item.number}`;
      const before = previousIndex[key];
      if (!before) newItems += 1;
      else if (before.updatedAt !== item.updatedAt) updatedItems += 1;
    }

    const prs = items.filter((item) => item.kind === 'pr');
    results.push({
      repo,
      status,
      items,
      openPrs: prs.length,
      draftPrs: prs.filter((item) => item.draft).length,
      awaitingReview: prs.filter((item) => !item.draft).length,
      openIssues: items.filter((item) => item.kind === 'issue').length,
      newItems: previous === null ? 0 : newItems,
      updatedItems: previous === null ? 0 : updatedItems,
      notModified: prFetch.notModified && issueFetch.notModified,
      attempts: prFetch.attempts + issueFetch.attempts,
      message: messages.join('；'),
    });
  }

  const index: PatrolSnapshot['index'] = {};
  for (const repo of results) {
    for (const item of repo.items) {
      index[`${item.kind}#${item.number}`] = { kind: item.kind, updatedAt: item.updatedAt };
    }
  }

  const firstFailure = results.find((repo) => repo.status !== 'ok');
  const run: PatrolRunResult = {
    observedAt,
    baseline: previous === null,
    // 汇总状态取**第一个非 ok** 的仓库，不能被前面 ok 的仓库掩盖（诚实优先）。
    status: firstFailure ? firstFailure.status : 'ok',
    repos: results,
    message: '',
    summary: '',
    requestMethods,
  };
  run.summary = summarizePatrol(run);
  return { run, snapshot: { observedAt, endpoints, index } };
}

/* ------------------------------------------------------------------ */
/* 服务封装（定时 + 持久化 + 事件出口）                                  */
/* ------------------------------------------------------------------ */

export interface GhPatrolService {
  getConfig(): GhPatrolConfig;
  /** 更新配置（仓库/间隔/定时开关），返回新配置。 */
  setConfig(patch: Partial<GhPatrolConfig>): GhPatrolConfig;
  /** 解析并保存仓库输入；非法项原样返回给 UI 提示。 */
  setRepos(input: string): { repos: string[]; invalid: string[] };
  /** 只返回「已配/未配」，绝不回显 token 明文。 */
  tokenPresent(): Promise<boolean>;
  run(): Promise<PatrolRunResult>;
  lastResult(): PatrolRunResult | null;
  scheduledActive(): boolean;
  /** 按当前配置启停定时器（默认关闭 → 不创建定时器）。 */
  syncSchedule(): void;
  dispose(): void;
}

export interface GhPatrolServiceDeps extends GhPatrolDeps {
  storage?: StorageLike | null;
}

/** 创建助手巡检服务：配置与快照落本地，定时默认关闭。 */
export function createGhPatrolService(deps: GhPatrolServiceDeps = {}): GhPatrolService {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  let config = loadGhConfig(storage);
  let last: PatrolRunResult | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const service: GhPatrolService = {
    getConfig(): GhPatrolConfig {
      return { ...config, repos: [...config.repos] };
    },
    setConfig(patch: Partial<GhPatrolConfig>): GhPatrolConfig {
      config = {
        repos: patch.repos ? parseRepos(patch.repos).repos : config.repos,
        intervalMs: patch.intervalMs === undefined ? config.intervalMs : sanitizeInterval(patch.intervalMs),
        scheduledEnabled:
          patch.scheduledEnabled === undefined ? config.scheduledEnabled : patch.scheduledEnabled === true,
      };
      saveGhConfig(config, storage);
      service.syncSchedule();
      return service.getConfig();
    },
    setRepos(input: string) {
      const parsed = parseRepos(input);
      config = { ...config, repos: parsed.repos };
      saveGhConfig(config, storage);
      service.syncSchedule();
      return parsed;
    },
    async tokenPresent(): Promise<boolean> {
      const value = await (deps.getToken ?? defaultGetToken)();
      return typeof value === 'string' && value.length > 0;
    },
    async run(): Promise<PatrolRunResult> {
      const previous = loadPatrolSnapshot(storage);
      const { run, snapshot } = await runGhPatrol({
        fetch: deps.fetch,
        getToken: deps.getToken,
        now: deps.now,
        sleep: deps.sleep,
        timeoutMs: deps.timeoutMs,
        config,
        previous,
      });
      savePatrolSnapshot(snapshot, storage);
      last = run;
      emitPatrolSummary(run.summary, run);
      return run;
    },
    lastResult(): PatrolRunResult | null {
      return last;
    },
    scheduledActive(): boolean {
      return timer !== null;
    },
    syncSchedule(): void {
      clearTimer();
      if (!config.scheduledEnabled || config.repos.length === 0) return;
      timer = setInterval(() => {
        void service.run();
      }, config.intervalMs);
    },
    dispose(): void {
      clearTimer();
    },
  };

  service.syncSchedule();
  return service;
}
