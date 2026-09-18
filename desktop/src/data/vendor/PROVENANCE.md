# Vendored SQLite WASM — 来源与许可

## 为什么 vendor

- 任务书 `工程控制/EXP-01/tasks/EXP-002.md` 步骤 2/4 要求 FTS5 trigram external-content 与 FTS delete/rebuild 语义。
- 已安装的 sql.js 1.14.2 全部 wasm 构建（sql-wasm / sql-wasm-browser / sql-wasm-debug）实测
  `ENABLE_FTS5=0`（`no such module: fts5`），无法满足。
- 用户裁决（2026-09-18，AskUserQuestion）：vendor 官方 `@sqlite.org/sqlite-wasm` 到本目录，
  数据层改用官方 SQLite；sql.js 保持在 package.json（文件域限制，未改动），但数据层不再使用。
- 逐字保留任务书的 FTS5 trigram / external-content / FTS delete（旧值精确）/ rebuild 语义。

## 来源

- 包：`@sqlite.org/sqlite-wasm` 3.53.4-build1（npm pack 原样取出，未修改任何字节）。
- 官方仓库：https://sqlite.org/wasm（SQLite 项目自发布 wasm，非第三方 fork）。

## 文件与 sha256

| 文件 | 原名（包内路径） | sha256 |
| --- | --- | --- |
| sqlite3.wasm | package/dist/sqlite3.wasm | 2ee8f3dab694532afc8840e07703127287662d08b74e6ff50491ce63f00d5752 |
| sqlite3-node.mjs | package/dist/node.mjs | e474cb70f112cbc8d12082c9aef82076392b5e7874f856b7c2fd482e7bed6e54 |
| sqlite3-bundler-friendly.mjs | package/dist/index.mjs | a6d3fe46aa3f924e7686329f97b0564549ef1f787e0c19924179aef7f72bcc01 |
| LICENSE.sqlite3-wasm.txt | package/LICENSE | 9e2b6de1619a3547c013d5469d54f29d419c6bd8cc299f4d993c7a423a5fd2f3 |

## 许可

SQLite 本体为公有领域（public domain）；JS glue（emscripten 产物与 sqlite3 JS API）许可见
同目录 `LICENSE.sqlite3-wasm.txt`（MIT / NCSA / SQLite blessing 条款）。SQLite 引擎版本
3.53.4，`sqlite3_compileoption_used('ENABLE_FTS5')=1`（实施前复核项，见 MEMORY_PERCEPTION §9）。

## 用法

- Node（vitest）：`data/db.ts` 动态加载 `sqlite3-node.mjs`（变量 specifier + @vite-ignore，
  防止进入浏览器 bundle），wasm 按相邻文件定位。
- 浏览器/ webview：静态可分析的 `import('./sqlite3-bundler-friendly.mjs')`，其中
  `new URL('sqlite3.wasm', import.meta.url)` 由 Vite 改写为构建产物资产 URL
  （webview 需 CSP `wasm-unsafe-eval`，EXP-001 已就位）。


## 补录（EXP-005 集成修复）
- `sqlite3-worker1.mjs`：同包 dist 版本 3.53.4-build1，EXP-005 构建发现 bundler-friendly 入口缺该相邻文件，从前台补齐（来源与 LICENSE 同包）。
