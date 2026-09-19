/**
 * make-latest-json.mjs — 生成 Tauri updater 的 `latest.json` 清单。
 *
 * 为什么需要它：Tauri CLI（本机 2.x）只产出安装包与其 `.sig` 签名，**不会**生成
 * `latest.json`（CLI 二进制里没有该字符串）。而上游更新端点固定读
 * `https://github.com/zouyuxuan122/VistaVerge/releases/latest/download/latest.json`，
 * 所以发布前必须自己把「版本 + 平台签名 + 资产 URL」拼成清单。
 *
 * 产物：`desktop/src-tauri/target/release/bundle/nsis/latest.json`
 * 发布方式：把 `*-setup.exe`、`*-setup.exe.sig`、`latest.json` 三个文件一起作为
 * GitHub Release 资产上传（latest.json 走 latest/download 通道）。
 *
 * 用法：node desktop/scripts/make-latest-json.mjs
 * 可覆盖：
 *   VV_RELEASE_BASE_URL  资产基址，默认 GitHub latest/download
 *   VV_RELEASE_NOTES     更新说明文本
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const nsisDir = fileURLToPath(new URL('../src-tauri/target/release/bundle/nsis', import.meta.url));
const confPath = fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url));

const DEFAULT_BASE_URL =
  'https://github.com/zouyuxuan122/VistaVerge/releases/latest/download';

const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const version = conf.version;
if (!version) throw new Error('tauri.conf.json 缺少 version');

if (!existsSync(nsisDir)) {
  throw new Error(`找不到 NSIS 产物目录：${nsisDir}（先跑 npm run build:beta）`);
}

const files = readdirSync(nsisDir);
// 优先挑与当前版本匹配的 setup，回退到任意 setup。
const setup =
  files.find((f) => f.endsWith('-setup.exe') && f.includes(version)) ??
  files.find((f) => f.endsWith('-setup.exe'));
if (!setup) {
  throw new Error(`目录里没有 *-setup.exe：${nsisDir}`);
}
const sigName = `${setup}.sig`;
if (!files.includes(sigName)) {
  throw new Error(`缺少签名文件 ${sigName}（beta 构建需带 TAURI_SIGNING_PRIVATE_KEY_PATH）`);
}

const signature = readFileSync(`${nsisDir}/${sigName}`, 'utf8').trim();
if (!signature) throw new Error(`签名文件为空：${sigName}`);

const baseUrl = (process.env.VV_RELEASE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const notes = process.env.VV_RELEASE_NOTES || `VistaVerge ${version}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `${baseUrl}/${setup}`,
    },
  },
};

const outPath = `${nsisDir}/latest.json`;
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[latest] 已生成 ${outPath}`);
console.log(`[latest] version=${version} asset=${setup} url=${manifest.platforms['windows-x86_64'].url}`);
