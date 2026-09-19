# VistaVerge 交接文档

更新时间：2026-09-19（AUDIT-01 收口版）。给下一个模型/新会话：读完本文件 + `AGENTS.md` 即可继续开发，不需要回看聊天记录。

---

## 0. AUDIT-01 之后的现状（最新，先看这段）

`0.1.0-beta.1` 测试版已产出可分发安装包并上传 GitHub（含 Issues 入口）。本轮做了三件事：

1. **独立缺陷审查**：两个只读子智能体并行审（前端 TS/Vue；Rust + three.js 场景），
   前台逐项复跑机器门与真浏览器走查，共修 **22 项真实缺陷（含 2 项 P0）**。
   全部清单与证据见 `工程控制/AUDIT-01/SUMMARY.md`。两个 P0：
   - 文本对话 `llmArgs` 硬编码 `apiKey:''` → 真实供应商下全部 401（语音路径自己取密钥所以看起来正常）；
   - CSP 缺 `worker-src 'self' blob:` → 打包版 Draco 解码 worker 被拒 → 3D 笔记本永不渲染。
2. **新交付**：MC 模拟世界（`src/mc/`，真体素世界 + 真 A* + 真挖掘/合成/搭建 + 生命值）、
   感知中心（`src/sensors/perceptionStore.ts` + `ui/PerceptionView.vue`：真实天气/温度/HA/出门提醒），
   以及此前完全没有样式的教师/市场/记忆/工作区/提醒浮层的主题样式。
3. **细节打磨**：工作区任务计划窗、MC 方块图例与响应式地图、切页动效与 hover 手感。

**默认形象裁决（用户 2026-09-19 指定，见 `src/app/avatarDefaults.ts`）**：发行包没有内置
Live2D 模型时**默认视频数字人**，用户在设置里导入模型后自动切到 Live2D；用户显式选过则永远尊重。
导入链路：`<input webkitdirectory>` 逐文件读字节 → 4MB 分块 invoke `import_model_file`
（Rust 校验相对路径后写入 `$APPDATA/live2d/imported/`）→ asset 协议（scope 限定 `$APPDATA/live2d/**`，
Cargo 需 `protocol-asset` feature）加载。Cubism Core 同样禁分发，须用户与模型一起提供。

**门（全部本地复跑过）**：typecheck rc=0；单测 **386 passed**；合同 36 passed；build rc=0；
cargo check rc=0 / cargo test **5 passed**；GUI 走查 **77/77 PASS**（console 零错误，本地构建含模型）；
生产包冒烟 **17/17 PASS**（发行包无模型，默认视频人 + 设置有导入入口）。

**VideoAvatar 素材陷阱**：`src/assets/*.mp4` 同样不入库，VideoAvatar 已改用 `import.meta.glob`
惰性解析——素材缺时诚实显示「缺素材」而不是让新 clone 的构建直接失败。

**新坑（本轮踩到，务必记住）**：
- 本环境**无法递归删除目录**（`rmSync` 报成功但目录仍在），`emptyOutDir` 清不干净 →
  构建产物会残留上一轮文件。需要「干净产物」时用**重命名让开**而不是删除。
- Vite 会把 `publicDir` **连点号目录一起复制**进产物。想把模型临时移出 `public/`，
  暂存目录必须放在 `public/` **之外**，否则换个名字照样进包（曾因此把 Live2D 模型打进发行包）。
- Live2D 模型授权**禁分发**：发行产物必须剔除。`npm run build:beta` 会做「移出 → 构建 → 断言无模型 → 移回」，
  断言不过就不出包。版本号 `0.1.0-beta.1` 即为标记 beta。

---

## 1. 一句话现状

VistaVerge（Windows 优先的 AI 伙伴桌面应用）**EXP-01 执行域已收口，AUDIT-01 审查与打磨已完成**：
Tauri2 + Vue3 主界面（以最初前端 s2s/demo 为基座重构）、Live2D 数字人（模型用户自备）、
流式对话与分支、SQLite 本地记忆、插件/感知/教师骨架、桌上笔记本道具、
**MC 模拟世界**、**感知中心**；机器门与真浏览器走查全绿，beta 安装包已产出。


---

## 2. 建议的下一步（按优先级）

1. **REALTIME-01**（建议下批控制包）：真实供应商接入后的流式语音真机调优——延迟 P50/P95、打断、口型对齐；需要先由用户在设置里填 OpenAI 兼容端点 + Key。
2. **Git 首次入库**：仍 0 提交；获授权后按 §3 的 allowlist + 审阅暂存 diff，禁止 `git add .`。
3. 技术债：mic-capture.test.ts 类型门补齐（TS5.9 lib 演进，2 处 TS2322）；manualChunks 分包消 1.45MB chunk 警告。
4. 外部条件（真实 VRM / MC 服务器 / HA token / QQ·微博授权）逐项把 BLOCKED 转真实验收（清单见 `工程控制/EXP-01/SUMMARY.md` §4）。

新控制包制作流程见 `AGENTS.md` 与 control-pack 规范：差距审计 → 写任务 → 交用户批准 → 才执行。

---

## 3. 仓库与 Git 状态

- 远程：`https://github.com/zouyuxuan122/VistaVerge`（私有）。
- 本地：`D:\丰富履历专用文件夹\cybergirl-cloud`，分支 `main`，已随 AUDIT-01 完成首次提交与推送（用户本轮明确授权上传源码与产物）。
- 发行：`v0.1.0-beta.1` 预发布，资产为 `VistaVerge_0.1.0-beta.1_x64-setup.exe`（6.80 MB，
  sha256 `d4577b4d…0aa7aa1`，含模型导入功能）。**该产物已剔除 Live2D 模型**（授权禁分发）。
- 授权边界：Git 写操作仍需用户明确授权；本轮授权不自动延伸到后续公开发布或推送其他敏感工作区。
- `.gitignore` 已排除：依赖、`target/`、`dist/`、密钥、数据库、`deploy-package/`、`s2s/`、`desktop/src/assets/`、`desktop/src-tauri/icons/`、`desktop/public/live2d/`（Live2D 模型与 Cubism Core，授权禁分发）。

---

## 4. 文档金字塔（权威顺序）

1. `VISTAVERGE_DESIGN.md` → 2. `ENGINEERING_SPEC.md` → 3. `AGENTS.md` → 4. `docs/requirements/USER_REQUIREMENTS.md` → 5. `docs/architecture/*` → 6. `docs/product/*` → 7. `docs/plugins/*` → 8. `docs/quality/*` → 9. `docs/research/*` → 10. `docs/roadmap/DELIVERY_PHASES.md` → 11. `工程控制/`（控制包；EXP-01 已收口，含 SUMMARY/ACCEPTANCE）。

**流程铁律**：制作与执行分离；没有用户明确"执行控制包 X"不得执行；子智能体零 Git 写权限；前台独立复跑关键门后才写 PASS；任一必需门 BLOCKED → 整包不得 PASS。

---

## 5. 代码地图（`desktop/`）与主界面形态

### 主界面最终形态（负责人两轮走查确认，别再改回去）

以最初前端（`s2s/demo`，huggingface/speech-to-speech 改版）为基座：

- **人物全 bleed 背景层**（`.avatar-side`，fixed 贴右 50% 宽全高，左缘 mask 淡入背景，装饰层不拦截输入）。
- **电脑屏幕**（ScreenPane）：左侧面板，`margin-right: 50vw` 覆盖至她身前；**五页签**：对话 / 本机只读镜像 / AI 工作区 / 当前任务 / **统计**（+ 学习/插件模块）。
- **桌上笔记本 = 真实 3D 模型 + 实体桌子**（`ui/LaptopModel.vue` + `DeskLaptop.vue`）：CC-BY 4.0 "MacBook Pro M3 16-inch"（jackbaeten，W. Laverty 改色；来源/许可/sha256 在 `desktop/public/models/PROVENANCE.md`，UI 右下角有署名标注）。她面向我们、**屏幕朝她**——我们看到盖子背面；屏幕自发光材质随 `sceneState` 变色；**桌子是 3D 场景里的真几何**（程序化木纹 CanvasTexture 台面 + 接触软影 blob），不是 CSS 贴片；漫画主题自动套油墨描边壳（笔记本+桌子），无 WebGL 回退 CSS 版。相机要近平视长焦且拉远到整机带桌前沿完整入画（俯视压扁或切边都会被否）。Draco 解码器在 `public/draco/`。
- **统计页**（`ui/StatsView.vue` + `data/usage.ts`）：花费卡片（今日/近7天/累计）、30 天 token 曲线（SVG，输入/输出双线）、**GitHub 风 26 周热力图**、最近记录表。数据源是本地 `usage_ledger`（迁移 v2，只存数字不存正文）；LLM 计量在 `store.instrumentProvider` 单一出口记账（对话/重试/语音共用），优先供应商真实 usage（已开 `stream_options.include_usage`），缺失按字符启发式估算并标注；TTS 记字符数；单价在设置→高级填（元/百万 token），未填只显示 token 不显示花费。
- **主题双档**：默认**手绘漫画风（亮色）**——纸纹+半调网点、油墨框+虚线第二笔+硬投影、对话尾巴、MOCK 黄色爆发贴、马克笔高亮、她身后漫画速度线、台面涂鸦簇、空对话涂鸦引导（全部在 app.css 末尾漫画块，关键类名在案）；写实=纯黑电影感。切换不丢状态。
- **底部**：悬浮椭圆胶囊导航（5 入口）+ 状态行。**语音球（VoiceOrb）曾实现又被负责人要求移除**——语音入口=输入框「语音」按钮 + 顶栏状态；不要再加回中央语音球。
- 顶栏：品牌 ident（VistaVerge + 链路行）+ MOCK 徽标 + 主题切换 + 语音状态 + 对话/设置图标。

### 目录与关键接口

```
src/app/           App.vue（基座布局）、main.ts（booting 首帧禁动画）、store.ts、avatarBridge.ts、expressionProtocol.ts
src/ui/            ScreenPane/ChatView/Live2DAvatar/VideoAvatar/SceneCanvas/DeskLaptop/MirrorView/WorkspaceView/
                   TaskView/SettingsModal/ThemeSwitch/NavPill/TeacherView/MarketView/MemoryView/ReminderToast
src/data/          db.ts（sqlite-wasm OO1）、memory.ts（FTS5+标签+遗忘）、conversations.ts（分支）、vendor/
src/platform/      credentials.ts（Tauri keyring，浏览器降级 dev-only）、persistence.ts
src/services/      llm/、session/voiceSession.ts（六态机+打断）、speech/、stt/、tts/
src/scene/         AvatarScene、avatar.ts、computer.ts、vrmAvatar.ts（VRM 许可门）、lights/screen/dispose/types
src/plugins/       manifest、tools、registry、taskService、views/
src/sensors/       weather、haClient、reminders、views/
src/teacher/       study、review、teacherStore、views/
src-tauri/         lib.rs（keyring 命令、db_read/write_file 原子写）、tauri.conf.json
packages/contracts/ envelope.ts、generation.ts
```

- store/avatarBridge/expressionProtocol/memory/conversations 接口签名见 `工程控制/EXP-01/SUMMARY.md` 与源码注释；改签名要同步调用方。
- 形象三档：`live2d`（默认）· `video` · `scene3d`（三维占位保留作 VRM 路径，别删）。

---

## 6. 已验证交付（含证据）

证据目录：`.vistaverge/evidence/`（FOUNDATION-01、EXP-01）。

| 门 | 结果 | 日志 |
| --- | --- | --- |
| `npm --prefix desktop run test:unit` | **313 passed** | verify-007h-stats.log |
| `npm --prefix desktop run test:contracts` | **36 passed** | verify-007h-stats.log |
| `npm --prefix desktop run typecheck` | rc=0 | verify-007h-stats.log |
| `npm --prefix desktop run build:vite` | rc=0（chunk 警告不阻塞） | verify-007h-stats.log |
| GUI 走查（Playwright 真浏览器） | **32/32 PASS**，console 零错误 | `EXP-01/gui/gui-results.json`、截图 01–16 |
| `cargo check` / `cargo test --lib`（keyring 2 例） | rc=0 | verify-007c-cargo-check.log |
| `npm run build`（tauri build） | rc=0，NSIS 已产出 | verify-007c-tauri-build.log |

产物：`desktop/src-tauri/target/release/bundle/nsis/VistaVerge_0.1.0_x64-setup.exe`（≈36.3MB）、`vistaverge.exe`（≈46.8MB）。

GUI 新增已实测项：桌上笔记本道具存在（盖背对我们+Logo 灯+台面）、窄窗笔记本隐藏、工作态屏幕氛围切换（MutationObserver 取证）、形象诚实标注、1280×720 胶囊不遮输入。

---

## 7. 未完成 / 阻塞清单（不得伪造通过）

全部登记在 `工程控制/EXP-01/SUMMARY.md` §4：真实供应商 Key、真实 VRM、Live2D 发行许可、MC、Computer Use 隔离执行、HA 配置、天气真实网络、QQ/微博、代码签名/自动更新、多图生成人物研究线。技术债：mic-capture.test.ts 类型门（2 处 TS2322）、manualChunks 分包。

---

## 8. 环境与命令速查

- Windows 11 / Git Bash；Node v24.11.1、npm 11.6.2、cargo 1.98.0；Vite 6.4.3、TS 5.9.3、Vitest 3.2.7、vue-tsc 3.3.11。
- 关键依赖锁定：vue 3.5.43、three 0.186.0、@sqlite.org/sqlite-wasm 3.53.4（vendored）、pixi.js **7.2.4**、pixi-live2d-display **0.4.0**。
- 开发服务器：`cd desktop && npm run dev:vite`（5173）。全量门：`typecheck && test:unit && test:contracts && build:vite`（前缀 `npm --prefix desktop run`）。
- GUI 走查：先起 dev server，再 `python .vistaverge/evidence/EXP-01/gui/gui-check.py`（证据写同目录）。
- cargo：`cargo check/test --manifest-path desktop/src-tauri/Cargo.toml`（本机 crates 缓存已暖；新机器需 rsproxy 镜像）。
- 外部命令务必带 timeout 并保存 stdout/stderr/rc 到 `.vistaverge/evidence/`。

---

## 9. 已知坑与关键裁决

1. sql.js 官方包无 FTS5 → 数据层用官方 sqlite-wasm vendored（含 PROVENANCE + sha256）。
2. CSP 含 `'wasm-unsafe-eval'`：sqlite-wasm 必需，去掉白屏。
3. 测试环境分流：数据相关在 **node** 环境，组件挂载用 jsdom。
4. mic-capture.test.ts 暂被 tsconfig exclude（TS5.9 lib 演进，2 处 TS2322，技术债）。
5. pixi-live2d-display/cubism4 必须动态导入（先注入 live2dcubismcore.min.js）。
6. **pixi v6/v7 原型混血**：pixi-live2d-display@0.4.0 内嵌 @pixi/display@6.5.10；v7 EventBoundary 遍历到模型会调 v7 才有的 `isInteractive()` 抛 TypeError。修法=挂载后 `model.eventMode='none'` + `interactiveChildren=false`（Live2DAvatar.vue，注释在案）。
7. 三维占位形象被否，默认 Live2D 上半身；表情只写 lidBaseline，别直接写 lid.scale.y。
8. 面向策略：默认面向用户；`[gaze:x,y]` 指令协议可随时覆盖 sceneState 联动。
9. `window.__vvAvatar` 是开发期验证钩子，非产品 API。
10. 主 chunk 1.45MB 警告，后续 manualChunks，不阻塞。
11. 并发上限 **2 个后台子智能体**；同工作区写入串行，并行只用于只读调研/审阅。
12. mock 供应商流式近瞬时：瞬态 UI 断言用 MutationObserver 取证，别用 sleep 碰运气（gui-check.py 在案）。
13. **three.js 反向外扩描边壳**：`model.traverse` 回调里给网格 add 子壳会无限递归（traverse 会访问新子节点）→ 先收集网格再统一加壳，并打 `userData.isOutline` 标记（LaptopModel.vue，GUI 曾报 Maximum call stack）。
14. **GLB 自发光筛选**：不能用 `emissiveIntensity>0`（three 默认 1，会染所有材质）→ 只看 `emissiveMap || emissive.getHex()>0`；亮色铝壳按 HSL 亮度压暗成深空灰。
15. GLB 素材只收许可清晰者（CC0/CC-BY），sha256+来源+许可进 PROVENANCE；CC-BY 必须在 UI 里署名（`.laptop-credit`）。
16. **计量记账必须放 finally**：调用方拿到 done 就 break → 迭代器 return()，循环后的代码不执行（曾因此漏记全部用量）。
17. `usage_ledger` 是迁移 v2；`schema_version` 断言在 data-db.test.ts（加迁移要同步）。估算条目必须带 `estimated=1` 并在 UI 标注，未设单价不得显示花费。

---

## 10. 给下一个模型的一句话提醒

用户最在意三件事：**形象与观感（Live2D 已达标，别再退回粗糙三维；笔记本方向=屏幕朝她，别再做反）**、**延迟与真实体验（要真机实测，不要只报"接口返回 200"）**、**不干扰本机（大光标只在映射面内，绝不动宿主鼠标/焦点）**。功能没实测就不要写成完成；外部条件缺失就如实标 BLOCKED 并给接入路径。主界面基座是最初前端 s2s/demo，负责人明确：不要中央语音球。
