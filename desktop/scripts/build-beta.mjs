/**
 * build-beta.mjs — 产出**可合法分发**的 beta 产物。
 *
 * 为什么需要这个脚本：`desktop/public/live2d/`（Live2D 模型「阿芙洛狄忒」+ Cubism Core）
 * 的授权是「免费使用，严禁二次修改、销售或出租」，本项目把它当用户自备素材处理——
 * 本地开发可用，**发行产物必须剔除**。应用缺少模型时会诚实回退到
 * 「Live2D 模型不可用：把 fense 模型放入 desktop/public/live2d/ 后重启」。
 *
 * 两个必须遵守的实现约束（都是踩过的坑）：
 * 1. 暂存目录必须放在 `public/` **之外**。Vite 会把 publicDir 整个复制进产物，
 *    连点号开头的目录也照抄；把模型改名成 `public/.live2d-hold` 只会让它换个名字进包。
 * 2. 输出目录必须是**全新的**。部分 Windows 环境下递归删除目录会静默失败
 *    （rmSync 报成功但目录还在），Vite 的 emptyOutDir 清不干净，
 *    上一轮的 live2d 会留在产物里被一起打包。所以每次构建前把旧产物重命名让开。
 *
 * 用法：npm run build:beta
 * 产物：desktop/src-tauri/target/release/bundle/nsis/VistaVerge_<version>_x64-setup.exe
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const publicLive2D = fileURLToPath(new URL('../public/live2d', import.meta.url));
// 暂存区在 public/ 之外：放进 public/ 会被 Vite 原样复制进产物。
const heldLive2D = fileURLToPath(new URL('../.live2d-hold', import.meta.url));
const outDir = fileURLToPath(new URL('../dist-beta', import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`命令失败（exit ${result.status}）：${command} ${args.join(' ')}`);
  }
}

/** 递归收集产物里的所有文件（相对路径）。 */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

/** 产物里出现任何 Live2D 模型/Core 痕迹都直接判失败，拒绝出包。 */
function assertNoLive2D(distDir) {
  const files = walk(distDir);
  const offenders = files.filter((f) => {
    const lower = f.toLowerCase();
    return (
      lower.includes('live2d') ||
      lower.endsWith('.moc3') ||
      lower.endsWith('.model3.json') ||
      lower.endsWith('.physics3.json') ||
      lower.endsWith('.cdi3.json')
    );
  });
  if (offenders.length > 0) {
    throw new Error(
      `构建产物里仍有 Live2D 资产，拒绝出包：\n  ${offenders.slice(0, 10).join('\n  ')}`,
    );
  }
  console.log(`[beta] 已确认产物不含 Live2D 资产（共检查 ${files.length} 个文件）`);
}

let moved = false;
try {
  if (existsSync(heldLive2D)) {
    throw new Error(`暂存目录已存在：${heldLive2D}（上次构建异常退出？请手动处理）`);
  }
  if (existsSync(publicLive2D)) {
    renameSync(publicLive2D, heldLive2D);
    moved = true;
    console.log('[beta] 已把 public/live2d 移出 public/（授权禁分发）');
  } else {
    console.log('[beta] public/live2d 不存在，直接构建');
  }

  // 让开旧产物：emptyOutDir 在本环境删不掉目录，残留的 live2d 会被一起打包。
  if (existsSync(outDir)) {
    const parked = `${outDir}-parked-${Date.now()}`;
    renameSync(outDir, parked);
    console.log(`[beta] 旧产物已让开 → ${parked.slice(desktopRoot.length)}（本环境无法删除目录）`);
  }

  console.log('[beta] 构建前端到 dist-beta …');
  run('npx', ['vite', 'build', '--outDir', 'dist-beta', '--emptyOutDir']);

  assertNoLive2D(outDir);
} finally {
  if (moved && existsSync(heldLive2D)) {
    renameSync(heldLive2D, publicLive2D);
    console.log('[beta] 已还原 public/live2d（本地开发继续可用）');
  }
}

console.log('[beta] 打包 Tauri 安装包 …');
run('npx', ['tauri', 'build', '--config', 'src-tauri/tauri.beta.conf.json']);
console.log('[beta] 完成。安装包在 src-tauri/target/release/bundle/nsis/');
