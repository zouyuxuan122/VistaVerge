# EXP-01 验收记录（随执行滚动更新）

2026-09-19 收口。PASS 仅由前台独立复跑后写入。

| 任务 | 状态 | 机器门 | 独立证据 | 前台结论 |
| --- | --- | --- | --- | --- |
| EXP-001 | PASS | 58旧测试零回归+构建/JSON/cargo metadata | verify-001-*.log | 品牌/CSP/依赖就位；裁决：CSP +wasm-unsafe-eval；mic-capture.test.ts 暂 exclude（TS5.9 lib 演进，技术债登记） |
| EXP-002 | PASS | 数据层/记忆/凭据测试全绿；keyring 2 个 Rust 单测随 cargo 套件 | verify-007b-*.log、verify-007c-cargo-check.log | SQLite-wasm FTS5+标签+遗忘、会话分支、Tauri keyring 命令（浏览器降级标 dev-only）均实测通过 |
| EXP-003 | PASS | 76服务测试；四门全绿 | verify-003-*.log、verify-004fix-*.log、EXP-003-report.md | 两次平台中断由前台盘点接管；实现与验门完整；真实供应商 BLOCKED |
| EXP-004 | PASS | 35场景测试；修复轮后四门全绿 | logs-EXP004-*、EXP-004-report.md | 修复轮清零13类型错误；三维占位非最终形象（Live2D 为默认）；真VRM资产 BLOCKED |
| EXP-005 | PASS | 307 单测 + 36 合同 + typecheck + build 全绿 | verify-007d-gates.log、verify-007e-final-gates.log | 主界面二次重构：以最初前端（s2s/demo，HF speech-to-speech 改版）为基座——人物全 bleed 背景层贴右+左缘 mask 淡入、电脑屏幕覆盖左侧至她身前、底部胶囊导航、桌上笔记本（盖背对我们，Logo 灯随状态变色）；语音球按负责人要求移除 |
| EXP-006 | PASS | 插件/感知/教师/任务测试随 307 单测全绿 | verify-007d-gates.log（plugins-*/sensors-*/teacher-* 用例） | 插件 manifest 拒绝式校验、注册表 sha256/路径白名单、任务租约、天气/HA/提醒、教师闭环均实测 |
| EXP-007 | PASS | 四门 rc=0；GUI 走查 **23/23**；`cargo check` rc=0；`tauri build` rc=0 产出 NSIS | gui/gui-results.json、截图 01–13；verify-007c-cargo-check.log、verify-007c-tauri-build.log | pixi 交互报错已修（eventMode 剪枝，见下）；桌面壳真实构建通过：vistaverge.exe 46.8MB + VistaVerge_0.1.0_x64-setup.exe 36.3MB；阻塞清单见 SUMMARY §4 |

## 关键修复记录（EXP-007 域）

1. **pixi 交互 console 报错**（`currentTarget.isInteractive is not a function`）：根因=pixi-live2d-display@0.4.0 内嵌 @pixi/display@6.5.10，v7 EventBoundary 遍历到 v6 原型对象时调 v7 mixin 方法。修法=`Live2DAvatar.vue` 挂载后设 `model.eventMode='none'` + `interactiveChildren=false`（`_interactivePrune` 先查 eventMode，整棵子树剪出事件系统；画布本就无交互，视线只走指令协议）。复跑 GUI `console 无错误` PASS。
2. **工作态笔记本检查时序竞争**：mock 供应商流式近瞬时，`sleep` 断言撞空窗；改为点击前布 MutationObserver（微任务级捕获 class 变化），证据 `gui-results.json`。
3. **笔记本透视两度修正**（负责人走查指出）：①屏幕内容朝我们=反了 → 改为盖子背面对我们（Logo 灯）；②键盘面板仍朝我们=仍反 → 键盘面板整体收进盖后，只露盖下一条机身薄边；③整机悬浮 → 盖面直达机身底边落台面。负责人确认方向：屏幕朝她。

## 中间态风险登记（已闭合）

- ~~EXP-002 的 Rust keyring 命令仅有设计，集成冒烟待 EXP-007~~ → cargo check/test/tauri build 均过。
- ~~EXP-005 按冻结接口开发，EXP-002 实际签名偏差在 EXP-007 集成修~~ → 全门绿，无偏差残留。
