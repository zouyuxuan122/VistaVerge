// @vitest-environment jsdom
/**
 * 数字人默认形象裁决 + Live2D 模型导入计划的回归测试。
 *
 * 裁决规则（用户 2026-09-19 指定）：发行包没有内置 Live2D 模型时默认视频数字人，
 * 用户显式选过则永远尊重；导入模型后应用才切到 Live2D。
 */
import { describe, expect, it } from 'vitest';
import {
  resolveDefaultAvatarMode,
  avatarOptionLabel,
  AVATAR_MODES,
  LIVE2D_MODEL_BUNDLED,
} from '../../src/app/avatarDefaults';
import {
  chunkFilePlan,
  IMPORT_CHUNK_BYTES,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_TOTAL_BYTES,
  isSafeImportRelPath,
  loadImportedManifest,
  planImport,
  saveImportedManifest,
  type ImportedFileInput,
} from '../../src/platform/live2dImport';

describe('默认形象裁决', () => {
  it('构建内置模型 → 默认 Live2D', () => {
    expect(resolveDefaultAvatarMode(true, null)).toBe('live2d');
  });

  it('未内置模型（发行包）→ 默认视频数字人', () => {
    expect(resolveDefaultAvatarMode(false, null)).toBe('video');
  });

  it('用户显式选过 → 永远尊重，即使与默认相反', () => {
    expect(resolveDefaultAvatarMode(true, 'video')).toBe('video');
    expect(resolveDefaultAvatarMode(false, 'live2d')).toBe('live2d');
    expect(resolveDefaultAvatarMode(false, 'scene3d')).toBe('scene3d');
  });

  it('保存值非法（被篡改/过期）时按默认裁决，不崩溃', () => {
    expect(resolveDefaultAvatarMode(false, 'vrm')).toBe('video');
    expect(resolveDefaultAvatarMode(true, '')).toBe('live2d');
    expect(resolveDefaultAvatarMode(true, 'undefined')).toBe('live2d');
  });

  it('三个模式值齐全且合法', () => {
    expect(AVATAR_MODES).toEqual(['live2d', 'video', 'scene3d']);
  });

  it('未内置模型时选项文案必须说清「需导入」，内置时不用', () => {
    expect(avatarOptionLabel('live2d')).toMatch(LIVE2D_MODEL_BUNDLED ? /阿芙洛狄忒/ : /需先导入/);
    expect(avatarOptionLabel('video')).toMatch(/视频数字人/);
  });
});

describe('导入路径安全校验（前端预检层，与 Rust 侧同规则）', () => {
  it('接受嵌套相对路径与非 ASCII', () => {
    expect(isSafeImportRelPath('fense/fense.model3.json')).toBe(true);
    expect(isSafeImportRelPath('fense/fense.8192/texture_00.png')).toBe(true);
    expect(isSafeImportRelPath('模型文件夹/moc3/file.moc3')).toBe(true);
  });

  it('拒绝逃逸、绝对路径、盘符与反斜杠', () => {
    expect(isSafeImportRelPath('../escape.moc3')).toBe(false);
    expect(isSafeImportRelPath('a/../../b.moc3')).toBe(false);
    expect(isSafeImportRelPath('/abs/x.moc3')).toBe(false);
    expect(isSafeImportRelPath('C:/x.moc3')).toBe(false);
    expect(isSafeImportRelPath('a\\b.moc3')).toBe(false);
  });

  it('拒绝空段、点段、保留设备名、控制字符与超长', () => {
    expect(isSafeImportRelPath('a//b.moc3')).toBe(false);
    expect(isSafeImportRelPath('./x.moc3')).toBe(false);
    expect(isSafeImportRelPath('NUL')).toBe(false);
    expect(isSafeImportRelPath('a/COM1.moc3')).toBe(false);
    expect(isSafeImportRelPath('a/x\u0000y')).toBe(false);
    expect(isSafeImportRelPath('')).toBe(false);
    expect(isSafeImportRelPath('a'.repeat(513))).toBe(false);
  });
});

describe('导入计划', () => {
  const model: ImportedFileInput = { relPath: 'fense/fense.model3.json', size: 1128 };
  const moc: ImportedFileInput = { relPath: 'fense/fense.moc3', size: 2_329_408 };
  const core: ImportedFileInput = { relPath: 'live2dcubismcore.min.js', size: 207_155 };
  const texture: ImportedFileInput = { relPath: 'fense/fense.8192/texture_00.png', size: 28_897_539 };

  it('完整素材：找到 model3.json 与 Cubism Core，无 issue', () => {
    const plan = planImport([model, moc, core, texture]);
    expect(plan.issues).toEqual([]);
    expect(plan.modelPath).toBe('fense/fense.model3.json');
    expect(plan.corePath).toBe('live2dcubismcore.min.js');
    expect(plan.files.length).toBe(4);
    expect(plan.totalBytes).toBe(1128 + 2_329_408 + 207_155 + 28_897_539);
  });

  it('缺 Cubism Core 不阻塞导入，但 corePath 为 null（导入后提示补）', () => {
    const plan = planImport([model, moc, texture]);
    expect(plan.issues).toEqual([]);
    expect(plan.corePath).toBeNull();
  });

  it('没有 model3.json 时给出明确原因（那才是模型入口）', () => {
    const plan = planImport([moc, texture]);
    expect(plan.issues.map((i) => i.code)).toContain('no-model3');
    expect(plan.modelPath).toBe('');
    expect(plan.issues[0].detail).toMatch(/model3\.json/);
  });

  it('不安全路径被剔除并逐条说明', () => {
    const plan = planImport([model, { relPath: '../evil.moc3', size: 1 }, { relPath: 'C:/x', size: 1 }]);
    expect(plan.issues.filter((i) => i.code === 'unsafe-path').length).toBe(2);
    expect(plan.files.map((f) => f.relPath)).toEqual(['fense/fense.model3.json']);
  });

  it('单文件超限与总量超限都会被拒绝', () => {
    const big: ImportedFileInput = { relPath: 'fense/huge.png', size: IMPORT_MAX_FILE_BYTES + 1 };
    expect(planImport([model, big]).issues.map((i) => i.code)).toContain('file-too-large');
    const many: ImportedFileInput[] = Array.from({ length: 3 }, (_, i) => ({
      relPath: `a/${i}.moc3`,
      size: IMPORT_MAX_TOTAL_BYTES,
    }));
    expect(planImport(many).issues.map((i) => i.code)).toContain('total-too-large');
  });

  it('空选择给出 empty 而不是崩溃', () => {
    const plan = planImport([]);
    expect(plan.issues[0].code).toBe('empty');
    expect(plan.files).toEqual([]);
  });
});

describe('分块计划', () => {
  it('小于一块的文件只有一块且 append=false', () => {
    const chunks = chunkFilePlan('a/model3.json', 1128);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toEqual({ relPath: 'a/model3.json', append: false, length: 1128 });
  });

  it('大贴图切成多块：首块覆盖、其余续写、总长守恒', () => {
    const size = IMPORT_CHUNK_BYTES * 7 + 12345;
    const chunks = chunkFilePlan('t/texture_00.png', size);
    expect(chunks.length).toBe(8);
    expect(chunks[0].append).toBe(false);
    expect(chunks.slice(1).every((c) => c.append)).toBe(true);
    expect(chunks.reduce((sum, c) => sum + c.length, 0)).toBe(size);
    expect(chunks.at(-1)?.length).toBe(12345);
  });

  it('零字节文件产生一个空覆盖块（保持文件存在，调用方不必特判）', () => {
    const chunks = chunkFilePlan('empty', 0);
    expect(chunks).toEqual([{ relPath: 'empty', append: false, length: 0 }]);
  });
});

describe('导入清单持久化', () => {
  it('保存后能原样读回', () => {
    saveImportedManifest({ modelPath: 'fense/fense.model3.json', corePath: 'core.js', fileCount: 4, totalBytes: 100 });
    expect(loadImportedManifest()).toEqual({
      modelPath: 'fense/fense.model3.json',
      corePath: 'core.js',
      fileCount: 4,
      totalBytes: 100,
    });
  });

  it('没导入过 / 清单损坏时返回 null（不抛错）', () => {
    localStorage.removeItem('vistaverge.live2dImported');
    expect(loadImportedManifest()).toBeNull();
    localStorage.setItem('vistaverge.live2dImported', '{not json');
    expect(loadImportedManifest()).toBeNull();
    localStorage.setItem('vistaverge.live2dImported', JSON.stringify({ foo: 1 }));
    expect(loadImportedManifest()).toBeNull();
  });
});
