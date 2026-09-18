// EXP-006 manifest 校验测试（PLUGIN_PLATFORM_UPDATES §1）。
// 校验 id/version/sdkRange/kind/permissions/license；非法拒绝并给字段与原因。
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_LIMITS,
  ManifestError,
  SDK_VERSION,
  parseManifest,
  satisfiesSdkRange,
  type ManifestErrorCode,
} from '../../src/plugins/manifest';

const base = {
  id: 'com.example.sakura',
  name: '樱花主题',
  version: '1.2.0',
  sdkRange: '>=1.0.0 <2.0.0',
  kind: 'theme',
  permissions: ['memory:read'],
  license: 'MIT',
};

function expectCode(fn: () => unknown, code: ManifestErrorCode, field?: string): ManifestError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected ManifestError(${code})`).toBeInstanceOf(ManifestError);
  const error = caught as ManifestError;
  expect(error.code).toBe(code);
  if (field) expect(error.field).toBe(field);
  return error;
}

describe('parseManifest 合法输入', () => {
  it('接受对象与 JSON 字符串，权限去重，缺省字段补默认', () => {
    const fromObject = parseManifest(base);
    expect(fromObject).toMatchObject({
      id: 'com.example.sakura',
      version: '1.2.0',
      kind: 'theme',
      sdkRange: '>=1.0.0 <2.0.0',
      license: 'MIT',
    });
    expect(fromObject.permissions).toEqual(['memory:read']);

    const fromString = parseManifest(JSON.stringify({ ...base, permissions: ['memory:read', 'memory:read'] }));
    expect(fromString.permissions).toEqual(['memory:read']);

    const character = parseManifest({ ...base, id: 'com.example.card', kind: 'character' });
    expect(character.kind).toBe('character');
  });

  it('sdkRange 必须覆盖当前 SDK 版本', () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(parseManifest({ ...base, sdkRange: `^${SDK_VERSION}` }).sdkRange).toBe(`^${SDK_VERSION}`);
  });
});

describe('parseManifest 非法输入', () => {
  it('非 JSON / 非对象 / 数组被拒绝', () => {
    expectCode(() => parseManifest('{not json'), 'not-object');
    expectCode(() => parseManifest(42), 'not-object');
    expectCode(() => parseManifest([base]), 'not-object');
    expectCode(() => parseManifest(null), 'not-object');
  });

  it('必填字段缺失', () => {
    for (const field of ['id', 'version', 'sdkRange', 'kind', 'permissions', 'license']) {
      const copy: Record<string, unknown> = { ...base };
      delete copy[field];
      expectCode(() => parseManifest(copy), 'missing-field', field);
    }
  });

  it('id 非法：大写、空格、过长、路径字符', () => {
    for (const id of ['Com.Example', 'com example', 'com/example', 'com\\example', 'a'.repeat(80), '-abc']) {
      expectCode(() => parseManifest({ ...base, id }), 'invalid-id', 'id');
    }
  });

  it('version 非法：非 semver', () => {
    for (const version of ['1.2', 'v1.2.3', '1.2.3.4', 'latest', '']) {
      expectCode(() => parseManifest({ ...base, version }), 'invalid-version', 'version');
    }
  });

  it('sdkRange 语法非法或与 SDK 不兼容', () => {
    expectCode(() => parseManifest({ ...base, sdkRange: 'garbage range' }), 'invalid-sdk-range', 'sdkRange');
    expectCode(() => parseManifest({ ...base, sdkRange: '' }), 'invalid-sdk-range', 'sdkRange');
    expectCode(() => parseManifest({ ...base, sdkRange: '>=2.0.0 <3.0.0' }), 'sdk-incompatible', 'sdkRange');
  });

  it('kind 非受支持数据包种类被拒绝（可执行插件未开放）', () => {
    for (const kind of ['executable', 'native', 'tool', 'agent', 'game', 'data-pack', '']) {
      expectCode(() => parseManifest({ ...base, kind }), 'unsupported-kind', 'kind');
    }
  });

  it('permissions 非法：非数组、通配符、格式错误、超量', () => {
    expectCode(() => parseManifest({ ...base, permissions: 'memory:read' }), 'invalid-permission', 'permissions');
    expectCode(() => parseManifest({ ...base, permissions: [1] }), 'invalid-permission', 'permissions');
    for (const permission of ['*', 'all', 'memory:*', 'ns:**']) {
      expectCode(() => parseManifest({ ...base, permissions: [permission] }), 'permission-wildcard', 'permissions');
    }
    for (const permission of ['memory.read', 'Memory:read', ':read', 'read']) {
      expectCode(() => parseManifest({ ...base, permissions: [permission] }), 'invalid-permission', 'permissions');
    }
    const many = Array.from({ length: MANIFEST_LIMITS.maxPermissions + 1 }, (_, i) => `ns:act${i}`);
    expectCode(() => parseManifest({ ...base, permissions: many }), 'too-many-permissions', 'permissions');
    expectCode(
      () => parseManifest({ ...base, permissions: [`ns:${'a'.repeat(MANIFEST_LIMITS.maxPermissionLength)}`] }),
      'invalid-permission',
      'permissions',
    );
  });

  it('license 非法：空串 / 非字符串', () => {
    expectCode(() => parseManifest({ ...base, license: '   ' }), 'invalid-license', 'license');
    expectCode(() => parseManifest({ ...base, license: 7 }), 'invalid-license', 'license');
  });

  it('字段超限被拒绝', () => {
    expectCode(() => parseManifest({ ...base, name: 'x'.repeat(MANIFEST_LIMITS.maxNameLength + 1) }), 'field-too-long', 'name');
    expectCode(
      () => parseManifest({ ...base, description: 'x'.repeat(MANIFEST_LIMITS.maxDescriptionLength + 1) }),
      'field-too-long',
      'description',
    );
    expectCode(() => parseManifest('x'.repeat(MANIFEST_LIMITS.maxBytes + 1)), 'too-large');
  });

  it('可选字段非法：sha256 / size / entry', () => {
    expectCode(() => parseManifest({ ...base, sha256: 'ZZZ' }), 'invalid-hash', 'sha256');
    expectCode(() => parseManifest({ ...base, size: -1 }), 'invalid-size', 'size');
    expectCode(() => parseManifest({ ...base, size: '1024' }), 'invalid-size', 'size');
    expectCode(() => parseManifest({ ...base, entry: '../evil.json' }), 'invalid-entry', 'entry');
    expectCode(() => parseManifest({ ...base, entry: 'C:/abs.json' }), 'invalid-entry', 'entry');
    expectCode(() => parseManifest({ ...base, entry: 'x.js' }), 'invalid-entry', 'entry');
  });
});

describe('satisfiesSdkRange', () => {
  it('支持比较符、插入号与波浪号', () => {
    expect(satisfiesSdkRange('>=1.0.0 <2.0.0', '1.0.0')).toBe(true);
    expect(satisfiesSdkRange('>=1.0.0 <2.0.0', '1.9.9')).toBe(true);
    expect(satisfiesSdkRange('>=1.0.0 <2.0.0', '2.0.0')).toBe(false);
    expect(satisfiesSdkRange('^1.0.0', '1.5.0')).toBe(true);
    expect(satisfiesSdkRange('^1.0.0', '2.0.0')).toBe(false);
    expect(satisfiesSdkRange('~1.2.0', '1.2.9')).toBe(true);
    expect(satisfiesSdkRange('~1.2.0', '1.3.0')).toBe(false);
    expect(satisfiesSdkRange('1.0.0', '1.0.0')).toBe(true);
    expect(satisfiesSdkRange('>1.0.0', '1.0.0')).toBe(false);
    expect(satisfiesSdkRange('*', '9.9.9')).toBe(true);
  });

  it('非法 range 或非法版本返回 false', () => {
    expect(satisfiesSdkRange('garbage', '1.0.0')).toBe(false);
    expect(satisfiesSdkRange('', '1.0.0')).toBe(false);
    expect(satisfiesSdkRange('>=1.0.0', 'x.y.z')).toBe(false);
  });
});
