# EXP-01 阶段汇总（SUMMARY）

2026-09-19。执行域：VistaVerge 桌面应用第一批（Tauri2 + Vue3）。状态：**全部 7 任务 PASS**。

## 1. 目标与范围

按文档金字塔（VISTAVERGE_DESIGN → ENGINEERING_SPEC → docs/*）落地：桌面壳、数据层、语音会话服务、三维场景、主界面、插件/感知/教师骨架，并完成端到端集成验收与桌面构建。

## 2. 差距闭合表

| 差距（GAP_AUDIT 登记） | 闭合情况 |
| --- | --- |
| 工程基础（品牌/CSP/依赖锁定） | ✅ EXP-001 |
| SQLite 数据层/记忆/凭据仓 | ✅ EXP-002（sql.js 无 FTS5 → 改用官方 sqlite-wasm vendored） |
| 流式语音/会话六态机/打断 | ✅ EXP-003（真实供应商验收 BLOCKED，见 §4） |
| 三维场景与人物 | ✅ EXP-004（占位形象保留作 VRM 路径；默认形象=Live2D） |
| 主界面 | ✅ EXP-005（二次重构：以最初前端 s2s/demo 为基座，见 §3） |
| 插件/感知/教师/任务 | ✅ EXP-006 |
| 集成/GUI/构建/阻塞清单 | ✅ EXP-007（GUI 23/23；NSIS 构建产出） |

## 3. 主界面最终形态（负责人两轮走查确认）

以项目最初前端（`s2s/demo`，huggingface/speech-to-speech 的改版）为基座重构，而非凭空设计：

- **人物全 bleed 背景层**：贴右全高，左缘 mask 淡入背景（avatar-cloud.js 的构图手法）；默认 Live2D（阿芙洛狄忒，上半身、面向用户、表情/动作可控、音频近似口型已标注）。
- **电脑屏幕**：左侧屏幕面板覆盖至她身前（对话/只读镜像/AI 工作区/当前任务四页签 + 学习/插件模块）。
- **桌上笔记本 = 真实 3D 模型 + 实体桌子**：CC-BY 4.0 "MacBook Pro M3 16-inch 2024"（jackbaeten；William Laverty 改色/拆分；sha256+许可登记在 `desktop/public/models/PROVENANCE.md`，右下角署名标注）。她面向我们、屏幕朝她，我们看到盖子背面；屏幕自发光材质随 sceneState 变色；桌子是 3D 真几何（程序化木纹台面 + 接触软影），漫画主题自动加油墨描边壳；无 WebGL 回退 CSS 版；近平视长焦取景（负责人否过俯视变形/切边版）。
- **统计页**（第 5 页签）：花费卡片 + 30 天 token 曲线 + GitHub 风 26 周热力图 + 最近记录；数据源为本地 `usage_ledger`（迁移 v2，只存计量数字）。LLM 在供应商外壳单点记账，优先真实 usage、缺失按字符估算并标注；单价在设置→高级配置（元/百万 token）。
- **主题双档**：默认**手绘漫画风（亮色）**——纸纹+半调网点、油墨双描线+硬投影、对话框尾巴、MOCK 黄色爆发贴、马克笔高亮、漫画速度线、台面涂鸦簇、空对话涂鸦引导；写实=纯黑电影感。切换不丢状态。
- **底部悬浮椭圆胶囊导航**（对话/学习/任务/插件/设置）+ 底部状态行；顶栏=品牌 ident + 供应商徽标（MOCK 诚实标注）+ 主题切换 + 语音状态 + 对话/设置图标。
- **语音球已按负责人要求移除**；语音入口=输入框「语音」按钮 + 顶栏状态。

## 4. 外部阻塞清单（不得伪造通过，接入路径在册）

| 项 | 状态 | 接入路径 |
| --- | --- | --- |
| 真实 ASR/LLM/TTS 供应商 | BLOCKED（无 Key） | 设置→供应商填 OpenAI 兼容端点 + Key（存 keyring） |
| 真实 VRM 资产 | BLOCKED（无授权素材） | 用户提供授权 VRM → `scene/vrmAvatar.ts` 许可门 |
| Live2D 发行许可 | 未评估 | 模型授权「灵境Sanctuary」免费使用禁二改/售卖 → 模型与 Cubism Core 均不得随发行版分发（已 gitignore），本地开发可用 |
| MC（Mineflayer） | 未实现 | 固定 Java 版本 + 受控服务器 + 账号（docs/plugins/DOMAIN_PLUGINS.md） |
| Computer Use 隔离执行 | 仅演示工作区 | 独立浏览器/VM 原型（docs/plugins/COMPUTER_USE.md；硬约束：不动物理鼠标/焦点） |
| Home Assistant | 适配器就绪、未配置 | 设置填 HA 地址+token（当前 blocked 诚实展示） |
| 天气 | 已接 Open-Meteo（无 Key） | 真实网络未在离线环境验证 |
| QQ/微博 | 仅草稿 | 需合法 API 或隔离环境+授权 |
| 代码签名/自动更新 | 未做 | 需证书（docs/plugins/PLUGIN_PLATFORM_UPDATES.md） |
| 多图生成人物 | 研究线 | docs/roadmap/DELIVERY_PHASES.md ASSET-GENERATION-RD |

## 5. 性能与产物首测（本机实测，非目标值承诺）

| 指标 | 实测 |
| --- | --- |
| 单测 / 合同 / 类型 / 构建 | 313 passed / 36 passed / vue-tsc rc=0 / vite rc=0 |
| GUI 走查（Playwright 真浏览器） | **32/32 PASS**，console 零错误 |
| cargo check / cargo test(keyring) / tauri build | rc=0 / 2 passed / rc=0 |
| NSIS 安装包 | VistaVerge_0.1.0_x64-setup.exe ≈ 36.3 MB |
| vistaverge.exe / dist | ≈ 46.8 MB / ≈ 50 MB（含本地 Live2D 模型） |
| chunk 警告 | 主 chunk ≈1.45MB（three/pixi），后续 manualChunks 分包，不阻塞 |

## 6. 模块状态

- desktop（前端+服务+场景）：**VERIFIED**（机器门+真浏览器走查）
- src-tauri（桌面壳/keyring/原子写）：**VERIFIED**（cargo check/test/build）
- packages/contracts：**VERIFIED**（36 合同测试）
- 插件/感知/教师：**IMPLEMENTED**（真实外部依赖未接入，见 §4）

## 7. 遗留项（下批建议）

1. REALTIME-01：真实供应商接入后做流式语音真机调优（延迟 P50/P95、打断、口型对齐）。
2. mic-capture.test.ts 类型门补齐（TS5.9 lib 演进，2 处 TS2322，运行时正常）。
3. manualChunks 分包消除 1.45MB 主 chunk 警告。
4. 真实体验验证清单（TTS/转文字/MC）等外部条件齐后逐项转真实验收。
5. 统计口径扩展：STT 计量（音频时长）、TTS/STT 单价接入、按模型/供应商分组统计。
