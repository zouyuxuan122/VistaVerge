# FEATURE-01 阶段汇总

日期：2026-09-19。目标：规划.txt 全功能差距收口 + 前端打磨 + beta.2 发布。
执行方式：制作（4 路并行只读审计 → GAP_AUDIT → 控制包）与执行分离；7 个执行任务分 3 波派发，
前台亲手完成 F1-CORE/F1-VERIFY/F1-SHIP 并独立复跑全部关键门。

## 差距闭合情况（对照 GAP_AUDIT）

| 域 | 收口前 | 收口后 |
|---|---|---|
| 教师（G-TEACH-01..06、B-T-01..12） | PPT 零实现、闭环大半 MISSING、恒走 mock | ✅ PPT 解析/渲染/批注/放大镜/激光笔/讲课状态机/TTS 旁白；闭环补全（诊断/提示/错因/变式/复习落库/复盘）；12 项 bug 全修 |
| 陪伴（G-COMP-01..08、G-VOICE-01..07、G-CHAT-01、B-C-01..08） | 角色卡/口癖/知识库/主动插话/常听门控全 MISSING，语音双轨/吞帧/误打断 | ✅ 角色卡 v1v2v3+PNG、口癖学习、知识库注入+工具调用循环、三档回应门控、UI 打断、主动插话仲裁、戳一戳；8 项 bug 全修（口型保持包络并诚实标注） |
| 平台（G-PLAT、G-REL、G-MC、G-CU、G-SENSE、G-GH、B-P-01..11） | 插件内存态/权限不阻断/零更新/零巡检/零社媒/16℃缺失/静默开关失效/MC 谎报 | ✅ 插件落盘+新增权限阻断、应用内更新（updater 签名+定制安装页+latest.json）、16℃/照度/HA 控制授权门/静默接线、MC 反击+sim 修复、GitHub 只读巡检、QQ/微博真实草稿；11 项 bug 全修 |
| UI（G-UI-01..10、B-U-01..11） | 无手绘字体、统计页亮色不可见、主题切换在右上、界面空旷、动效零散 | ✅ 站酷快乐体（OFL 本地）、显示器化+左上双拨杆、顶栏中段/状态浮签/桌面小物、统计手绘化、镜像只读语义、动效补全、reduce-motion/键盘可达/aria-live/窄窗折叠；11 项 bug 全修（credit 双定义留为已知债） |
| 文档一致性（BETA/HANDOFF 漂移） | 教师/QQ·微博不实声明、页签数漂移 | ✅ 已修正；需求矩阵新增 TEACH-003/COMP-003..005/KNOW-001；教师合同补 §1.1A |

明确保持 BLOCKED（未伪造）：真 MC 服务器、真 Computer Use 后端、QQ/微博实际发送、真 viseme、PDF/OCR、可执行插件沙箱、角色卡社区市场、代码签名（updater 签名是独立机制，已具备）。

## 各任务状态

| 任务 | 状态 | 执行者 | 提交 |
|---|---|---|---|
| F1-TEACH | PASS | 子智能体 A | 0865c98 |
| F1-COMP | PASS | 子智能体 B | 72520e7 |
| F1-CORE | PASS | 前台亲手 | 72520e7 |
| F1-PERCEPT | PASS | 子智能体 C | e48db65 |
| F1-UI | PASS | 子智能体 D | 521e313 |
| F1-REL | PASS | 子智能体 E | 5c2d5a0 |
| F1-ASSIST | PASS | 子智能体 F | 72520e7 |
| F1-VERIFY | PASS | 前台亲手 | （含 521e313 穿透修复、ChatView 剪贴板反馈） |
| F1-SHIP | PASS | 前台亲手 | 2a85a6b + Release v0.1.0-beta.2 |

## 机器门与真实验证（前台独立复跑）

| 门 | 结果 | 证据 |
|---|---|---|
| typecheck / test:unit / test:contracts | rc=0 / **614 passed** / **36 passed** | final-*.log |
| cargo check / cargo test | rc=0 / **8 passed** | final-cargo-*.log |
| build:beta（剔模型断言 + updater 签名 + latest.json） | **rc=0** | ship-build-beta-2.log |
| GUI 新能力走查 | **32/32**，console 零错误 | gui-feature-check.py + gui/ |
| 讲课端到端（真实 .pptx 打开→渲染→讲稿→批注→放大镜→翻页→提问锚点） | **10/10** | gui-lecture-check.py + gui/ |
| NSIS 定制页 | 解包核验位图 sha256 一致、中文文案内嵌 | rel-nsis-* |
| 三 SHA 一致 | HEAD = main = origin/main = 2a85a6b | git rev-parse |
| Release 资产 | setup.exe + .sig + latest.json；`releases/latest` 指向 beta.2 | gh api |

走查抓到并已修的真实缺陷：`.stage` 全宽透明层吃掉人物区点击（pointer-events 穿透）；
剪贴板权限被拒时复制无反馈（改为如实「复制失败」）。

## 遗留项（下批控制包候选）

1. manualChunks 分包（主 chunk 1.7MB）；2. PDF 课件导入；3. 会话历史列表 UI；
4. 可执行插件沙箱宿主与 SDK 示例；5. 角色卡社区市场接入插件源；6. 真机语音调优（需用户 Key）；
7. 设置弹层焦点陷阱与天气加载骨架挂点（F1-UI 未完成的三小项）；8. `com.vistaverge.app` identifier 建议改名。
