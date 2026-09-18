# EXP-01 任务总表

依赖图：EXP-001 →（EXP-002 ∥ EXP-003 ∥ EXP-004）→ EXP-005 → EXP-006 → EXP-007。

| 任务 | 目标 | 允许文件域 |
| --- | --- | --- |
| EXP-001 | 依赖/品牌/CSP/构建基础 | desktop/package*.json、tsconfig*.json、vite.config.ts、src-tauri/tauri.conf.json、Cargo.toml、Cargo.lock、src-tauri/src/*、index.html |
| EXP-002 | SQLite数据层/记忆/凭据 | desktop/src/data/**、src/platform/**、src-tauri/src/lib.rs、Cargo.toml/lock、tests/unit/data-*.test.ts |
| EXP-003 | 流式语音/会话服务 | desktop/src/services/**、tests/unit/services-*.test.ts |
| EXP-004 | 三维场景与人物 | desktop/src/scene/**、tests/unit/scene-*.test.ts |
| EXP-005 | 主界面重构 | desktop/index.html、src/app/**、src/ui/**、src/styles/**；删除 src/main.js、avatar-cloud.js、style.css |
| EXP-006 | 插件/感知/教师/任务 | desktop/src/plugins/**、sensors/**、ui 增量、tests/unit/plugins-*、sensors-* |
| EXP-007 | 集成/GUI/构建/阻塞清单 | 允许修上述任意文件修集成缺陷；新增 tests/e2e 证据与工程控制记录 |

每任务验门（除注明年份外）：`npm --prefix desktop run test:unit`、`test:contracts`、`typecheck`、`build:vite` 全部 rc=0；新增模块必须有真实行为测试。EXP-007 追加 GUI 证据与 `cargo check`/tauri build。
