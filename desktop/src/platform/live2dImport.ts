/**
 * platform/live2dImport.ts — 运行时导入 Live2D 模型（用户自备素材）。
 *
 * 背景：Live2D 模型授权禁分发，发行产物不含模型。此前用户只能改源码重新构建；
 * 本模块让安装版用户在设置里直接选一个模型文件夹导入，导入成功后应用改用 Live2D。
 *
 * 工作方式（不新增 Tauri 插件，只用核心能力）：
 * 1. `<input type="file" webkitdirectory>` 选文件夹 —— WebView2 支持且能拿到每个文件的
 *    webkitRelativePath 与内容（File.path 在 WebView2 里拿不到，所以不走路径方案）；
 * 2. 逐文件读成字节，按 4MB 分块经 `import_model_file` 写进 应用数据目录/live2d/imported/；
 *    Rust 侧校验相对路径（拒绝 `..`/绝对路径/Windows 保留名），大文件用 append 续写；
 * 3. 结束后把「模型入口 model3.json 与 Cubism Core 的相对路径」存入 localStorage，
 *    Live2DAvatar 通过 Tauri asset 协议（scope 限定 $APPDATA/live2d/**）从那里加载。
 *
 * 诚实边界：Cubism Core（live2dcubismcore.min.js）授权同样禁分发，必须由用户和模型一起提供；
 * 没提供时导入仍成功，但 Live2DAvatar 会明确提示缺什么，不会假装可用。
 * 浏览器 dev 模式（无 Tauri IPC）导入不可用，明确降级而不是假装成功。
 */

/** 单块 4MB：Tauri IPC 单次载荷留足余量（一张贴图可达 ~29MB）。 */
export const IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;

/** 导入上限：防呆，不是安全边界（安全边界在 Rust 侧路径校验与配额之外）。 */
export const IMPORT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const IMPORT_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const IMPORT_MAX_FILES = 800;

export interface ImportedFileInput {
  /** webkitRelativePath，如 `fense/fense.model3.json`。 */
  relPath: string;
  size: number;
}

export interface ImportPlanIssue {
  code:
    | 'empty'
    | 'no-model3'
    | 'too-many-files'
    | 'file-too-large'
    | 'total-too-large'
    | 'unsafe-path'
    | 'absolute-path';
  detail: string;
}

export interface ImportPlan {
  /** 通过校验的文件（已过滤明确不安全路径）。 */
  files: ImportedFileInput[];
  /** 模型入口相对路径（第一个 *.model3.json）。 */
  modelPath: string;
  /** Cubism Core 相对路径；null = 用户没一起提供，导入后需补。 */
  corePath: string | null;
  totalBytes: number;
  issues: ImportPlanIssue[];
}

const MODEL3_PATTERN = /model3\.json$/i;
const CORE_PATTERN = /live2dcubismcore[^/]*\.js$/i;

/**
 * 路径安全校验（前端预检；Rust 侧仍会再校验一次，两层都要过）。
 * 拒绝：绝对路径、盘符、反斜杠、`..` 段、空段、控制字符、Windows 保留设备名。
 */
export function isSafeImportRelPath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 512) return false;
  if (/[\u0000-\u001f\u007f]/.test(relPath)) return false;
  if (relPath.includes('\\')) return false;
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) return false;
  const segments = relPath.split('/');
  if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) return false;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  return !segments.some((s) => reserved.test(s.replace(/\.[^.]*$/, '')));
}

/**
 * 由用户选择的文件列表生成导入计划。
 * 不做任何 IO；issues 非空时调用方应展示原因并中止（modelPath/corePath 仍给出以便提示）。
 */
export function planImport(inputs: readonly ImportedFileInput[]): ImportPlan {
  const issues: ImportPlanIssue[] = [];
  if (inputs.length === 0) {
    return { files: [], modelPath: '', corePath: null, totalBytes: 0, issues: [{ code: 'empty', detail: '没有选择任何文件' }] };
  }

  const unsafe = inputs.filter((f) => !isSafeImportRelPath(f.relPath));
  for (const f of unsafe.slice(0, 3)) {
    issues.push({ code: 'unsafe-path', detail: `跳过不安全路径：${f.relPath}` });
  }
  const safe = inputs.filter((f) => isSafeImportRelPath(f.relPath));

  const totalBytes = safe.reduce((sum, f) => sum + f.size, 0);
  if (safe.length > IMPORT_MAX_FILES) {
    issues.push({ code: 'too-many-files', detail: `文件数 ${safe.length} 超过上限 ${IMPORT_MAX_FILES}` });
  }
  const oversized = safe.find((f) => f.size > IMPORT_MAX_FILE_BYTES);
  if (oversized) {
    issues.push({ code: 'file-too-large', detail: `单文件过大（>${IMPORT_MAX_FILE_BYTES / 1024 / 1024}MB）：${oversized.relPath}` });
  }
  if (totalBytes > IMPORT_MAX_TOTAL_BYTES) {
    issues.push({ code: 'total-too-large', detail: `总大小超过 ${IMPORT_MAX_TOTAL_BYTES / 1024 / 1024}MB 上限` });
  }

  const modelEntry = safe.find((f) => MODEL3_PATTERN.test(f.relPath));
  if (!modelEntry) {
    issues.push({ code: 'no-model3', detail: '所选文件夹里没有找到 *.model3.json（那才是模型的入口文件）' });
  }

  return {
    files: safe,
    modelPath: modelEntry?.relPath ?? '',
    corePath: safe.find((f) => CORE_PATTERN.test(f.relPath))?.relPath ?? null,
    totalBytes,
    issues,
  };
}

/** 把一个文件切成 IPC 分块（首块 append=false 覆盖写，其余 append 续写）。 */
export function chunkFilePlan(relPath: string, size: number): { relPath: string; append: boolean; length: number }[] {
  const chunks: { relPath: string; append: boolean; length: number }[] = [];
  let offset = 0;
  do {
    const length = Math.min(IMPORT_CHUNK_BYTES, size - offset);
    chunks.push({ relPath, append: offset > 0, length });
    offset += length;
  } while (offset < size);
  return chunks;
}

/* ------------------------------------------------------------------ */
/* 运行时执行（Tauri 专用；浏览器 dev 环境明确降级）                    */
/* ------------------------------------------------------------------ */

export function isTauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface ImportProgress {
  fileIndex: number;
  fileCount: number;
  relPath: string;
  bytesSent: number;
  totalBytes: number;
}

export interface ImportResult {
  modelPath: string;
  corePath: string | null;
  fileCount: number;
  totalBytes: number;
}

export const IMPORTED_MANIFEST_KEY = 'vistaverge.live2dImported';

export function saveImportedManifest(result: ImportResult): void {
  try {
    localStorage.setItem(IMPORTED_MANIFEST_KEY, JSON.stringify(result));
  } catch {
    /* 无存储权限时本次会话内仍可用 */
  }
}

export function loadImportedManifest(): ImportResult | null {
  try {
    const raw = localStorage.getItem(IMPORTED_MANIFEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ImportResult>;
    if (typeof parsed.modelPath !== 'string' || parsed.modelPath.length === 0) return null;
    return {
      modelPath: parsed.modelPath,
      corePath: typeof parsed.corePath === 'string' ? parsed.corePath : null,
      fileCount: typeof parsed.fileCount === 'number' ? parsed.fileCount : 0,
      totalBytes: typeof parsed.totalBytes === 'number' ? parsed.totalBytes : 0,
    };
  } catch {
    return null;
  }
}

/** 读取一个 File 的字节并按分块上传。内部函数抽出来便于注入测试。 */
async function uploadFile(
  file: File,
  relPath: string,
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const plan = chunkFilePlan(relPath, bytes.byteLength);
  let offset = 0;
  for (const chunk of plan) {
    const slice = bytes.subarray(offset, offset + chunk.length);
    // ArrayBuffer 越过 IPC 边界会被转移，必须给每个分块拷贝一份。
    await invoke('import_model_file', {
      relPath,
      data: new Uint8Array(slice),
      append: chunk.append,
    });
    offset += chunk.length;
  }
}

type DirInput = { files: FileList | File[] };

/**
 * 打开文件夹选择器并执行导入。
 * @returns null = 用户取消了选择；ImportResult = 导入成功
 * @throws 携带可读原因（校验失败 / 无 Tauri / IPC 失败）
 */
export async function importLive2dModel(
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportResult | null> {
  if (!isTauriAvailable()) {
    throw new Error('模型导入需要在桌面应用中使用（浏览器开发模式没有本机文件通道）');
  }
  const picked = await pickDirectory();
  if (picked === null) return null;

  const inputs: ImportedFileInput[] = [...picked.files].map((f) => ({
    relPath: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
    size: f.size,
  }));
  const plan = planImport(inputs);
  if (plan.issues.some((i) => i.code === 'no-model3' || i.code === 'total-too-large' || i.code === 'too-many-files' || i.code === 'file-too-large')) {
    const detail = plan.issues.map((i) => i.detail).join('；');
    throw new Error(`导入已取消：${detail}`);
  }
  if (plan.files.length === 0) {
    throw new Error('导入已取消：所选文件夹里没有可导入的文件');
  }

  const byRelPath = new Map<string, File>();
  for (const f of picked.files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (isSafeImportRelPath(rel)) byRelPath.set(rel, f);
  }

  const { invoke } = await import('@tauri-apps/api/core');
  let sentBytes = 0;
  let fileIndex = 0;
  for (const entry of plan.files) {
    const file = byRelPath.get(entry.relPath);
    if (!file) continue;
    await uploadFile(file, entry.relPath, invoke as never);
    sentBytes += entry.size;
    fileIndex += 1;
    onProgress?.({
      fileIndex,
      fileCount: plan.files.length,
      relPath: entry.relPath,
      bytesSent: sentBytes,
      totalBytes: plan.totalBytes,
    });
  }

  const result: ImportResult = {
    modelPath: plan.modelPath,
    corePath: plan.corePath,
    fileCount: plan.files.length,
    totalBytes: sentBytes,
  };
  saveImportedManifest(result);
  return result;
}

/** 打开 webkitdirectory 文件夹选择器；取消返回 null。 */
function pickDirectory(): Promise<DirInput | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.multiple = true;
    input.style.display = 'none';
    let settled = false;
    const done = (value: DirInput | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => done(input.files && input.files.length > 0 ? { files: input.files } : null));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

/* ------------------------------------------------------------------ */
/* 通道二：按路径整目录导入                                            */
/* ------------------------------------------------------------------ */

interface ImportedModelSummary {
  model_path: string | null;
  core_path: string | null;
  file_count: number;
  total_bytes: number;
  skipped: string[];
}

/**
 * 直接按文件夹路径导入（Rust 端遍历拷贝，无大 payload 过 IPC）。
 *
 * 与文件夹选择器互为两条通道：这条可在设置页粘贴路径，也是自动化验证的入口。
 * 成功后同样写入清单并在调用方切换到 Live2D。
 */
export async function importModelFromPath(source: string): Promise<ImportResult> {
  if (!isTauriAvailable()) {
    throw new Error('模型导入需要在桌面应用中使用（浏览器开发模式没有本机文件通道）');
  }
  const trimmed = source.trim().replace(/^["']|["']$/g, '');
  if (trimmed.length === 0) throw new Error('请先粘贴模型文件夹路径');
  const { invoke } = await import('@tauri-apps/api/core');
  const summary = (await invoke('import_model_from_dir', { source: trimmed })) as ImportedModelSummary;
  if (!summary.model_path) throw new Error('导入失败：没有找到 *.model3.json');
  const result: ImportResult = {
    modelPath: summary.model_path,
    corePath: summary.core_path,
    fileCount: summary.file_count,
    totalBytes: summary.total_bytes,
  };
  saveImportedManifest(result);
  return result;
}
