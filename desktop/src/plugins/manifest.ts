/**
 * plugins/manifest.ts — PluginManifest 校验器（PLUGIN_PLATFORM_UPDATES §1、§3）。
 *
 * 权限/凭据/审计/签名属于可信核心，不通过插件免检；因此这里做的是**拒绝式**
 * 校验：任何字段缺失、越界、格式非法、种类不受支持、SDK 不兼容都抛
 * ManifestError（带 code + field），不做“猜测性修复”。
 *
 * 本模块只处理**数据包**（theme / character）。可执行插件（executable/native/
 * tool/agent…）在本期明确不开放，一律以 unsupported-kind 拒绝——这与市场 UI 的
 * “可执行插件未开放”文案一致。
 *
 * 路径校验 `isSafeDataPath` 同时被 registry.ts 复用（安装事务的路径白名单）。
 */

/** 当前宿主 SDK 版本（SemVer）。manifest.sdkRange 必须覆盖它。 */
export const SDK_VERSION = '1.0.0';

/** 本期受支持的插件种类：仅数据包。 */
export const SUPPORTED_KINDS = ['theme', 'character'] as const;
export type ManifestKind = (typeof SUPPORTED_KINDS)[number];

export type ManifestErrorCode =
  | 'not-object'
  | 'missing-field'
  | 'invalid-field'
  | 'invalid-id'
  | 'invalid-version'
  | 'invalid-sdk-range'
  | 'sdk-incompatible'
  | 'unsupported-kind'
  | 'invalid-permission'
  | 'permission-wildcard'
  | 'too-many-permissions'
  | 'invalid-license'
  | 'field-too-long'
  | 'too-large'
  | 'invalid-entry'
  | 'invalid-hash'
  | 'invalid-size';

export class ManifestError extends Error {
  readonly code: ManifestErrorCode;
  readonly field?: string;
  constructor(code: ManifestErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
    this.field = field;
  }
}

/** 字段上限（PLUGIN_PLATFORM_UPDATES §3「manifest 字段超限」防护）。 */
export const MANIFEST_LIMITS = {
  maxBytes: 16 * 1024,
  maxIdLength: 64,
  maxNameLength: 128,
  maxVersionLength: 32,
  maxSdkRangeLength: 64,
  maxPermissionLength: 64,
  maxPermissions: 32,
  maxLicenseLength: 128,
  maxPublisherLength: 128,
  maxDescriptionLength: 512,
  maxEntryLength: 200,
  /** 单个数据包体积上限（字节）。 */
  maxPackageBytes: 5 * 1024 * 1024,
} as const;

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9._-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const WILDCARD_PERMISSIONS = new Set(['*', 'all', 'any', '**']);

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  sdkRange: string;
  kind: ManifestKind;
  permissions: string[];
  license: string;
  publisher?: string;
  description?: string;
  entry?: string;
  sha256?: string;
  size?: number;
  minAppVersion?: string;
  signature?: string;
}

/* ------------------------------------------------------------------ */
/* SemVer 工具（无第三方依赖，仅覆盖 manifest sdkRange 需要的子集）      */
/* ------------------------------------------------------------------ */

type Version = [number, number, number];

export function parseVersion(value: unknown): Version | null {
  if (typeof value !== 'string') return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function caretUpper(v: Version): Version {
  if (v[0] > 0) return [v[0] + 1, 0, 0];
  if (v[1] > 0) return [0, v[1] + 1, 0];
  return [0, 0, v[2] + 1];
}

function tildeUpper(v: Version): Version {
  return [v[0], v[1] + 1, 0];
}

/**
 * 判断 `range` 是否覆盖 `version`（默认当前 SDK_VERSION）。
 * 支持 `*`、`x.y.z`、`>=x.y.z`、`>x.y.z`、`<=x.y.z`、`<x.y.z`、`=x.y.z`、
 * `^x.y.z`、`~x.y.z`，以空格分隔的多个条件是**与**关系。
 * 语法非法、版本非法或空 range 一律返回 false（调用方据此拒绝）。
 */
export function satisfiesSdkRange(range: string, version: string = SDK_VERSION): boolean {
  const target = parseVersion(version);
  if (!target || typeof range !== 'string') return false;
  const tokens = range.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return false;

  for (const token of tokens) {
    if (token === '*' || token === 'x' || token === 'X') continue;

    const tryComparator = (op: string): boolean | null => {
      if (!token.startsWith(op)) return null;
      const operand = parseVersion(token.slice(op.length));
      if (!operand) return false;
      const cmp = compareVersion(target, operand);
      switch (op) {
        case '>=':
          return cmp >= 0;
        case '<=':
          return cmp <= 0;
        case '>':
          return cmp > 0;
        case '<':
          return cmp < 0;
        case '=':
          return cmp === 0;
        default:
          return false;
      }
    };

    // 顺序敏感：先匹配双字符比较符。
    for (const op of ['>=', '<=', '>', '<', '=']) {
      const verdict = tryComparator(op);
      if (verdict !== null) {
        if (!verdict) return false;
        break;
      }
    }
    if (['>=', '<=', '>', '<', '='].some((op) => token.startsWith(op))) continue;

    if (token.startsWith('^')) {
      const operand = parseVersion(token.slice(1));
      if (!operand) return false;
      if (compareVersion(target, operand) < 0) return false;
      if (compareVersion(target, caretUpper(operand)) >= 0) return false;
      continue;
    }
    if (token.startsWith('~')) {
      const operand = parseVersion(token.slice(1));
      if (!operand) return false;
      if (compareVersion(target, operand) < 0) return false;
      if (compareVersion(target, tildeUpper(operand)) >= 0) return false;
      continue;
    }

    const exact = parseVersion(token);
    if (!exact || compareVersion(target, exact) !== 0) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 路径白名单（registry 安装事务复用）                                  */
/* ------------------------------------------------------------------ */

/**
 * 数据包入口路径白名单：仅允许相对 POSIX 路径 + `.json` 后缀。
 * 明确拒绝绝对路径、盘符、反斜杠、`..`/`.` 段、空段、URL 与百分号编码。
 */
export function isSafeDataPath(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  const value = path.trim();
  if (value.length === 0 || value.length > MANIFEST_LIMITS.maxEntryLength) return false;
  if (value.includes('\\')) return false;
  if (value.includes('://')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('.')) return false;
  if (/%2e|%2f|%5c|%00/i.test(value)) return false;
  if (!value.endsWith('.json')) return false;
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return false;
    if (segment === '.' || segment === '..') return false;
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  source: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  if (!(field in source) || source[field] === undefined) {
    throw new ManifestError('missing-field', `manifest 缺少必填字段：${field}`, field);
  }
  const value = source[field];
  if (typeof value !== 'string') {
    // B-P-08：类型错误用通用 invalid-field，并按 field 区分；
    // 之前一律抛 invalid-license，会把 id/version 的类型错误误导成许可证问题。
    throw new ManifestError('invalid-field', `manifest.${field} 必须是字符串`, field);
  }
  if (value.length > maxLength) {
    throw new ManifestError('field-too-long', `manifest.${field} 超出长度上限 ${maxLength}`, field);
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  const value = source[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ManifestError('invalid-field', `manifest.${field} 必须是字符串`, field);
  }
  if (value.length > maxLength) {
    throw new ManifestError('field-too-long', `manifest.${field} 超出长度上限 ${maxLength}`, field);
  }
  return value;
}

/** 校验权限列表：非数组/格式错误/通配符/超量均拒绝；返回去重后的列表。 */
export function validatePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ManifestError('invalid-permission', 'manifest.permissions 必须是数组', 'permissions');
  }
  if (input.length > MANIFEST_LIMITS.maxPermissions) {
    throw new ManifestError(
      'too-many-permissions',
      `manifest.permissions 超出上限 ${MANIFEST_LIMITS.maxPermissions}`,
      'permissions',
    );
  }
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') {
      throw new ManifestError('invalid-permission', 'manifest.permissions 元素必须是字符串', 'permissions');
    }
    const permission = raw.trim();
    if (WILDCARD_PERMISSIONS.has(permission) || permission.includes('*')) {
      // 不提供“允许访问电脑”式的全权开关（PLUGIN_PLATFORM_UPDATES §1）。
      throw new ManifestError(
        'permission-wildcard',
        `manifest.permissions 不允许通配符/全权权限：${permission}`,
        'permissions',
      );
    }
    if (permission.length > MANIFEST_LIMITS.maxPermissionLength || !PERMISSION_PATTERN.test(permission)) {
      throw new ManifestError(
        'invalid-permission',
        `manifest.permissions 格式非法（需 namespace:action）：${permission}`,
        'permissions',
      );
    }
    seen.add(permission);
  }
  return [...seen];
}

/**
 * 解析并校验 manifest。输入可为 JSON 字符串或已解析对象。
 * 任何非法项都抛 ManifestError；成功返回规范化的 PluginManifest。
 */
export function parseManifest(input: string | unknown): PluginManifest {
  let raw: unknown = input;
  if (typeof input === 'string') {
    if (input.length > MANIFEST_LIMITS.maxBytes) {
      throw new ManifestError('too-large', `manifest 超出体积上限 ${MANIFEST_LIMITS.maxBytes} 字节`);
    }
    try {
      raw = JSON.parse(input);
    } catch {
      throw new ManifestError('not-object', 'manifest 不是合法 JSON');
    }
  }
  if (!isPlainObject(raw)) {
    throw new ManifestError('not-object', 'manifest 必须是 JSON 对象');
  }

  // id 长度由 ID_PATTERN 自身限定（{0,62}）；这里放宽读取上限，让超长 id 走
  // invalid-id 而不是 field-too-long，便于定位。
  const id = requireString(raw, 'id', 4096);
  if (!ID_PATTERN.test(id)) {
    throw new ManifestError('invalid-id', `manifest.id 非法（需小写反向域名风格）：${id}`, 'id');
  }

  const version = requireString(raw, 'version', MANIFEST_LIMITS.maxVersionLength);
  if (!VERSION_PATTERN.test(version)) {
    throw new ManifestError('invalid-version', `manifest.version 必须是 x.y.z：${version}`, 'version');
  }

  const sdkRange = requireString(raw, 'sdkRange', MANIFEST_LIMITS.maxSdkRangeLength);
  if (!isRangeSyntaxValid(sdkRange)) {
    throw new ManifestError('invalid-sdk-range', `manifest.sdkRange 语法非法：${sdkRange}`, 'sdkRange');
  }
  if (!satisfiesSdkRange(sdkRange)) {
    throw new ManifestError(
      'sdk-incompatible',
      `manifest.sdkRange 不兼容当前 SDK ${SDK_VERSION}：${sdkRange}`,
      'sdkRange',
    );
  }

  const kindRaw = requireString(raw, 'kind', 32);
  if (!(SUPPORTED_KINDS as readonly string[]).includes(kindRaw)) {
    throw new ManifestError(
      'unsupported-kind',
      `manifest.kind 不受支持（本期仅数据包 ${SUPPORTED_KINDS.join('/')}，可执行插件未开放）：${kindRaw}`,
      'kind',
    );
  }
  const kind = kindRaw as ManifestKind;

  if (!('permissions' in raw) || raw.permissions === undefined) {
    throw new ManifestError('missing-field', 'manifest 缺少必填字段：permissions', 'permissions');
  }
  const permissions = validatePermissions(raw.permissions);

  const license = requireString(raw, 'license', MANIFEST_LIMITS.maxLicenseLength);
  if (license.trim().length === 0) {
    throw new ManifestError('invalid-license', 'manifest.license 不能为空', 'license');
  }

  const name = optionalString(raw, 'name', MANIFEST_LIMITS.maxNameLength) ?? id;
  const publisher = optionalString(raw, 'publisher', MANIFEST_LIMITS.maxPublisherLength);
  const description = optionalString(raw, 'description', MANIFEST_LIMITS.maxDescriptionLength);
  const minAppVersion = optionalString(raw, 'minAppVersion', MANIFEST_LIMITS.maxVersionLength);
  if (minAppVersion !== undefined && !VERSION_PATTERN.test(minAppVersion)) {
    throw new ManifestError('invalid-version', `manifest.minAppVersion 必须是 x.y.z：${minAppVersion}`, 'minAppVersion');
  }
  const signature = optionalString(raw, 'signature', 512);

  const entry = optionalString(raw, 'entry', MANIFEST_LIMITS.maxEntryLength);
  if (entry !== undefined && !isSafeDataPath(entry)) {
    throw new ManifestError('invalid-entry', `manifest.entry 路径非法：${entry}`, 'entry');
  }

  const sha256 = optionalString(raw, 'sha256', 64);
  if (sha256 !== undefined && !SHA256_PATTERN.test(sha256)) {
    throw new ManifestError('invalid-hash', 'manifest.sha256 必须是 64 位十六进制', 'sha256');
  }

  const sizeRaw = raw.size;
  let size: number | undefined;
  if (sizeRaw !== undefined && sizeRaw !== null) {
    if (typeof sizeRaw !== 'number' || !Number.isInteger(sizeRaw) || sizeRaw < 0) {
      throw new ManifestError('invalid-size', 'manifest.size 必须是非负整数', 'size');
    }
    if (sizeRaw > MANIFEST_LIMITS.maxPackageBytes) {
      throw new ManifestError('invalid-size', `manifest.size 超出体积上限 ${MANIFEST_LIMITS.maxPackageBytes}`, 'size');
    }
    size = sizeRaw;
  }

  const manifest: PluginManifest = {
    id,
    name,
    version,
    sdkRange,
    kind,
    permissions,
    license,
  };
  if (publisher !== undefined) manifest.publisher = publisher;
  if (description !== undefined) manifest.description = description;
  if (entry !== undefined) manifest.entry = entry;
  if (sha256 !== undefined) manifest.sha256 = sha256;
  if (size !== undefined) manifest.size = size;
  if (minAppVersion !== undefined) manifest.minAppVersion = minAppVersion;
  if (signature !== undefined) manifest.signature = signature;
  return manifest;
}

/** 仅校验 range 语法（不判断是否覆盖当前 SDK）。 */
function isRangeSyntaxValid(range: string): boolean {
  const tokens = range.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return false;
  return tokens.every((token) => {
    if (token === '*' || token === 'x' || token === 'X') return true;
    for (const op of ['>=', '<=', '>', '<', '=']) {
      if (token.startsWith(op)) return parseVersion(token.slice(op.length)) !== null;
    }
    if (token.startsWith('^') || token.startsWith('~')) return parseVersion(token.slice(1)) !== null;
    return parseVersion(token) !== null;
  });
}
