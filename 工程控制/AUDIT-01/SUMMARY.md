# AUDIT-01 缺陷审查（SUMMARY）

2026-09-19。范围：全仓库代码审查 + 端到端功能验证 + 细节打磨。
执行方式：两个**只读**子智能体并行审查（前端 TS/Vue；Rust 后端 + three.js 场景），
前台逐项复跑机器门与真浏览器走查，修复后重跑全部门。

## 结果概览

| 门 | 结果 |
| --- | --- |
| `vue-tsc --noEmit` | rc=0 |
| `npm run test:unit` | **366 passed**（新增 53 例） |
| `npm run test:contracts` | 36 passed |
| `npm run build:vite` | rc=0 |
| `cargo check` / `cargo test --lib` | rc=0 / 3 passed |
| GUI 走查（Playwright 真浏览器） | **77/77 PASS**，console 零错误 |
| 生产包冒烟（安装包内嵌前端） | **17/17 PASS**，console 零错误 |
| **桌面端到端（真实 Tauri 窗口 + CDP）** | **13/13 PASS**：导入模型 → 自动切 Live2D → 渲染 |

修复的缺陷总数：**22 项**（含 2 项 P0）。P0 分别是：
1. 文本对话从未携带 API Key（真实供应商下全部 401）；
2. CSP 缺 `worker-src blob:`，打包版 Draco 解码 worker 被拒 → 3D 笔记本永不渲染。

## 本轮新增（不是修缺陷，是新交付）

- **MC 模拟世界**（`src/mc/`）：确定性体素世界、真实 A* 寻路、挖掘/合成/搭建状态机、
  生命值与死亡重生、背包容量、中文指令解析；配套 37 例单测与 10 例会话桥接测试。
- **感知中心**（`src/sensors/perceptionStore.ts` + `ui/PerceptionView.vue`）：
  真实 Open-Meteo 天气（含过期语义）、HA 温度实测/设定分离、出门提醒联动对话。
- **教师/市场/记忆/工作区/提醒浮层**的完整主题样式（此前完全没有样式，渲染为裸控件）。
- 设置新增「感知与家居」页签（定位 + HA 地址/令牌/温度实体）。

## 诚实性说明（不得粉饰）

- MC 是**本地模拟**，与真实 Minecraft 服务端**未连接**（BLOCKED：需固定 Java/服务端/账号）。
  界面同时标注 `SIMULATED` 与 `真实 MC 服务端：BLOCKED`。
- 安装包 EXE 的 GUI **未在本机启动**（避免抢占宿主桌面焦点）；前端以真浏览器加载
  同一份生产产物（`dist-beta`）验证。
- 真实语音链路、真实 HA 实例、真实 VRM 仍需外部条件，均保持 BLOCKED。

---

## A. Rust 后端 / three.js 场景（审查子智能体 2）

| # | 级别 | 位置 | 问题 | 状态 |
| --- | --- | --- | --- | --- |
| A1 | **P0** | `src-tauri/tauri.conf.json:26` + `ui/LaptopModel.vue:8,149` | CSP `script-src 'self' 'wasm-unsafe-eval'` 无 `worker-src`/`blob:`。three.js DRACOLoader 用 `new Worker(blob:…)` 建解码 worker，Chromium 在 `script-src 'self'` 下拒绝 → GLB 解码失败 → 打包版永远走 CSS 回退，3D 笔记本不渲染（`vite` 预览无 CSP，掩盖此问题） | ✅ 已修：CSP 增加 `worker-src 'self' blob:` |
| A2 | P1 | `ui/Live2DAvatar.vue:24,79-81,125-143`、`services/session/voiceSession.ts`、`app/store.ts:127` | 口型同步是死代码：`setMouth` 从未被调用、不在 controller 接口里；`store.mouthLevel` 无写入方；`VoiceSession` 不产出 `output-level` 事件；`AvatarScene.setAudioClock` 无调用方。嘴部是固定 0.35 振幅正弦，与实际音量无关 | ✅ 已修：controller 增加 `setMouth`，`VoiceSession` 增加分析器产出 `output-level`，store 转发到 avatarBridge |
| A3 | P1 | `scene/avatar.ts:310-334` + `app/expressionProtocol.ts:12` | `ACT_VALUES` 允许 `happy/angry/surprised/sleepy`，但 `DUR` 表只有 `nod/shake/tilt/wave` → `phase = NaN`，`rotation.z/x` 永久 NaN 且 action 永不清除（模型手臂矩阵被污染）。另 `wave` 结束后未还原手臂角度，手臂永久抬起 | ✅ 已修：未知动作直接忽略；动作结束还原静止姿态 |
| A4 | P1 | `ui/LaptopModel.vue:220-222` | `onBeforeUnmount(() => ro.disconnect())` 写在 `onMounted(async …)` 内、且在 `await` 之后 → Vue 的 `currentInstance` 已重置，钩子从未注册 → ResizeObserver 泄漏 | ✅ 已修：`ro` 提升到模块级并在顶层 unmount 断开 |
| A5 | P1 | `src-tauri/src/lib.rs:38,45,56,67,77` | 5 个命令都是同步 `fn` → Tauri 在主线程执行；keyring/DPAPI 与整库读写会阻塞 webview 事件循环 | ✅ 已修：改为 `async fn` |
| A6 | P1 | `src-tauri/src/lib.rs:82-84` | `db_write_file` 先 `fs::write` 再 `rename`，无 `sync_all` → 掉电可能得到零长度/截断的 SQLite 主库；rename 失败还会残留 `.tmp` | ✅ 已修：`File::create`+`write_all`+`sync_all`+`rename`，失败清理临时文件 |
| A7 | P1 | `scene/AvatarScene.ts:224-247` | 换 VRM 时旧的非占位 avatar 只 `scene.remove` 不 `dispose` → 几何/材质/贴图泄漏；`await` 后无 `disposedFlag` 检查 → 卸载后仍 `scene.add` 并派发事件 | ✅ 已修：无条件 dispose 旧 avatar；await 后检查 disposed 并释放新对象 |
| A8 | P1 | `ui/LaptopModel.vue:151-162` vs `:238-253` | 卸载早于 GLB 加载完成时，续体对 `null` 场景 `scene.add` → TypeError，且已加载模型不释放 | ✅ 已修：`unmounted` 标志 + await 后检查并释放 |
| A9 | P2 | `src-tauri/src/lib.rs:15-23` | 文件名白名单允许 Windows 保留设备名（`CON`/`NUL`/`COM1`）与结尾点号（`foo.` 与 `foo` 冲突） | ✅ 已修：拒绝保留名与结尾 `.`/空格 |
| A10 | P2 | `src-tauri/src/lib.rs:82` | `with_extension("tmp")` 使 `a.db` 与 `a.txt` 共用同一临时名；名为 `x.tmp` 时临时文件即目标本身（rename 变空操作） | ✅ 已修：唯一临时名（pid+计数器） |
| A11 | P2 | `scene/lights.ts:60-64`、`scene/AvatarScene.ts:211-217` | 首帧后改 `shadow.mapSize` 无效（three 只在 `shadow.map === null` 时分配）→ 低→高质量切换不生效 | ✅ 已修：尺寸变化时 dispose 旧 shadow map |
| A12 | P2 | `services/llm/openaiCompat.ts:104-130` 等 | 供应商 JSON 只做类型断言：`usage.prompt_tokens` 为非数字会写入 `NaN` 台账；STT `text` 非字符串会让后续 `.trim()` 抛错。唯一运行时校验器 `parseEnvelope` 从未接入 | ✅ 已修：usage/text 数值与类型归一化校验 |
| A13 | P2 | `ui/LaptopModel.vue:136-139` | PMREM 环境贴图的 render target 从未释放（`pmrem.dispose()` 不释放返回值） | ✅ 已修：持有 target 并在 unmount 释放 |
| A14 | P2 | `ui/Live2DAvatar.vue:95,161-168` | `app.destroy(true,{texture:false})` 跳过贴图释放；卸载早于 `Live2DModel.from` 完成时 `model` 仍为 null，续体直接 return → model/app 泄漏 | ✅ 已修：disposed 分支释放新建 model/app；catch 分支销毁 app |
| A15 | P2 | `scene/AvatarScene.ts:48-62`、`ui/LaptopModel.vue:128` | 无 `webglcontextlost` 处理，驱动重置后静默停更 | ✅ 已修：监听 contextlost 并给出可见降级提示 |

**已验证干净**：`invoke` 名与 `#[tauri::command]` 注册完全对应；capabilities 权限齐备；Rust 无用户输入 `unwrap`；`DisposableGroup`/`disposeObject3DDeep` 释放机制正确；VRM 许可门与 `[gaze]` 解析有真实校验；VideoAvatar 无泄漏；`GenerationGate` 已接入 VoiceSession。

---

## B. 前端 TS/Vue（审查子智能体 1）

| # | 级别 | 位置 | 问题 | 状态 |
| --- | --- | --- | --- | --- |
| B1 | **P1** | `ui/ReminderToast.vue` + `styles/app.css` | `.reminder-toast-root` **没有任何样式** → 它是 `.app-shell`（flex column）里的静态块，占 111px 高度，把 `.stage` 从 774px 压到 663px，并以裸文本形式叠在左下角 | ✅ 已修：改为 fixed 定位的漫画风 toast 栈 |
| B2 | P1 | `ui/TeacherView.vue`、`MarketView`、`MemoryView` | 三个面板的类名（`teacher-view`/`market-view`/`memory-view` 等）在 app.css 里**完全没有样式** → 渲染为裸 input/button/textarea，看起来像坏掉 | ✅ 已修：补齐两套主题下的完整样式 |
| B3 | P1 | `ui/WorkspaceView.vue` + `app.css` | 演示工作区只有灰色空矩形 + emoji 方块，无窗口框架、无日志样式、观感与漫画主题脱节 | ✅ 已修：重做工作区视觉（窗口框/任务栏/图标网格/事件流） |
| B4 | P2 | `plugins/tools.ts:234` | `registerBuiltinTools` **从未在应用中被调用**（只有测试调用）→ 运行时工具注册表为空，四件套（记忆检索/天气/时间/提醒）对 LLM 不可用 | ✅ 已修：`initStore` 时注册，并注入真实天气与记忆检索 |
| B5 | P2 | `sensors/*` | 天气/温湿度/HA/提醒四个模块有实现有测试，但**没有任何 UI 入口** → 用户点不到，「感知温度/智能家居」在应用里不存在 | ✅ 已修：新增「感知」页签 + 设置内 HA/定位配置 |
| B6 | P2 | `engine.ts`（18KB） | 全云端语音引擎为死代码：无任何模块 import（仅测试引用），已被 `services/session/voiceSession.ts` 取代 | ✅ 已标注为历史实现（测试仍引用 engine-abort.test.ts） |
| B7 | P2 | `index.html` | 硬编码 `data-theme="realistic"`，而默认主题是 `handdrawn` → 首帧主题闪变 | ✅ 已修：改为 handdrawn，并在挂载前同步已保存主题 |

（完整前端报告由子智能体交回，本节按修复优先级摘录；P2 及以下细节见其原始结论。）

---

## C. 前台实测发现（Playwright 真浏览器）

| # | 级别 | 证据 | 问题 | 状态 |
| --- | --- | --- | --- | --- |
| C1 | P1 | 布局量测 | `.reminder-toast-root` `position: static`、`h=111px`，`.stage` 被压到 663px（应为 774px） | 同 B1 |
| C2 | P1 | 截图 `base-01..04` | 学习/插件页签为裸控件；统计页正常 | 同 B2 |
| C3 | P1 | 截图 `base-02-workspace` | 工作区大面积灰色空白 | 同 B3 |
| C4 | P2 | 截图 `base-01-chat` | 笔记本 CC-BY 署名压在人物身上，可读性差 | ✅ 已修：署名加纸底与描边 |


---

## D. 真实桌面窗口验证（AUDIT-01 续）

用户要求「依赖真实桌面窗口那就加上呗」后，启动打包好的 EXE，用 CDP（DevTools 协议）
驱动应用自己的 WebView 走完整链路（不注入宿主鼠标/键盘）。结果 13/13 PASS，
并暴露出 **4 个只在打包版存在、dev 服务器永远测不到**的缺陷（dev 不注入 CSP）：

| # | 级别 | 现象 | 根因 | 修法 |
| --- | --- | --- | --- | --- |
| D1 | P0 | Live2D 在安装版永远起不来，报「Current environment does not allow unsafe-eval」 | pixi v7 `ShaderSystem.systemCheck()` 在无 `'unsafe-eval'` 的 CSP 下直接抛错 | 内联 `@pixi/unsafe-eval@7.2.4` 等价补丁（`ui/pixiUnsafeEvalPatch.ts`）。**不能装该包**：它与 live2d-display 拉的 `@pixi/*@6.5.10` peer 冲突，装下去会重排依赖树并弄崩类型 |
| D2 | P1 | 3D 笔记本贴图静默丢失（画布在、模型在，就是没贴图） | three 新版用 `fetch` 加载贴图，`connect-src` 缺 `blob:` | CSP `connect-src` 增加 `blob: data:` |
| D3 | P1 | 导入模型后贴图 403，模型加载失败 | `convertFileSrc` 把整条 Windows 路径编码成**单个** URL 段，pixi 用 `new URL(相对路径, 模型URL)` 解析贴图时目录算错，请求落到 scope 外 | 改用自定义协议 `vvmodel://`（真实斜杠，相对解析天然正确；Rust 侧自带路径校验与 CORS 头），弃用 assetProtocol |
| D4 | P1 | 导入必失败：`落盘确认 xxx 失败：拒绝访问 (os error 5)` | Windows 上 `File::open`（只读句柄）调 `sync_all` 即返回 ACCESS_DENIED | 落盘确认改用写句柄 `OpenOptions::new().write(true)` |

另外两个只有真实窗口才暴露的时序/状态问题：
- 模型加载成功后未清除初始提示（`loadError` 初值非空）→ canvas 的 `v-if` 永不成立（已修）；
- canvas 用 `v-if` 在异步流程里换 DOM 会踩 Vue 补丁期 `insertBefore null`（已改为 canvas 常驻 + 提示覆盖层）。

**结论**：dev 服务器走查 + 生产包冒烟都不足以代表「打包版可用」；涉及 CSP、协议、
Windows 句柄语义的改动必须在真实窗口里复验一次。已把这条写进 HANDOFF 的踩坑清单。
