# FEATURE-01 验收记录

验收三层：机器门全 rc=0；前台独立复跑关键命令（不复用子智能体自述）；改动与文件域一致。
基线：typecheck rc=0 / 单测 386 / 合同 36（`.vistaverge/evidence/FEATURE-01/baseline-*.log`）。

| 任务 | 状态 | 机器门结果 | 证据路径 | 前台结论 |
|---|---|---|---|---|
| F1-TEACH | PASS | 前台独立复跑 typecheck rc=0、test:unit 525 passed、build:vite rc=0 | `.vistaverge/evidence/FEATURE-01/teach-*.log` + 前台复跑记录 | PPT 解析/讲课状态机/批注/放大镜/激光笔全部落地，B-T-01..12 修复有测试；真实供应商验收需用户 key（如实标注） |
| F1-COMP | PASS | 前台独立复跑 typecheck rc=0、test:unit 525 passed（companion 87 例） | `.vistaverge/evidence/FEATURE-01/comp-*.log` + 前台复跑记录 | 角色卡 v1/v2/v3+PNG、口癖、知识库、主动仲裁均为纯模块+全测试；接线由 F1-CORE 完成并复验 |
| F1-CORE | PASS | 前台亲手实现并复跑 typecheck rc=0、test:unit 525 passed（新增 feature-core 6 例、voice 门控/speak 4 例、conversations 更新） | 本会话命令记录 | 工具循环/记忆+知识库+人设+口癖注入/语音三修/回应门控/打断/回退/编辑重新生成/戳一戳/高级设置接线完成 |
| F1-PERCEPT | PASS | 前台独立复跑 typecheck rc=0、mc-combat+feature-core 20 例过；子智能体报 test:unit 568 passed、build rc=0（前台复跑全量单测见 VERIFY） | `.vistaverge/evidence/FEATURE-01/percept-*.log` + 前台抽跑记录 | 16℃/照度/HA 控制授权门/静默开关/MC 反击与二次搭建修复/插件落盘/新增权限阻断全部落地；真 HA/MC 服务器仍 BLOCKED（如实标注） |
| F1-UI | PASS | 前台独立复跑 typecheck rc=0；前台亲自核验截图（手绘对话/统计：显示器化、左上双拨杆、手绘字体生效、油墨卡、热力图可见、无遮挡/无语音球/署名可见）；子智能体报 568 单测+build+a11y 实测全过 | `.vistaverge/evidence/FEATURE-01/ui-*.{log,png,json}` | G-UI-01..10 与 B-U 大部闭合；3 项未完成（天气骨架挂点/弹层焦点陷阱/credit 双定义）登记 VERIFY 收尾 |
| F1-REL | PASS | cargo check/test rc=0（8 例）；typecheck/build:vite rc=0；`npm run build` 出包且 NSIS 定制页解包核验（品牌图 sha256 逐字节一致、中文文案内嵌）；签名管线与 latest.json 生成隔离取证可跑 | `.vistaverge/evidence/FEATURE-01/rel-*.log` | updater 接入完成、私钥 gitignore、版本号统一 beta.2；build:beta 端到端因 dev server 锁句柄被 BLOCKED→前台杀进程后重跑（见 F1-SHIP） |
| F1-ASSIST | PASS | 前台独立复跑 typecheck rc=0、test:unit 614 passed；GUI 走查巡检未配置诚实态/社媒发送先确认报未就绪实测 PASS | `.vistaverge/evidence/FEATURE-01/assist-*.log` + gui-feature-check | GitHub 只读巡检（ETag/限流退避/零写断言）与社媒草稿（恒确认+通道未就绪）落地；真实 token 网络验收留给用户配置后 |
| F1-VERIFY | PASS | 前台亲手：全量 typecheck rc=0、单测 614 passed、合同 36 passed；GUI 主走查 **32/32**（console 零错误）、讲课端到端 **10/10**（真实 .pptx）；走查抓到并已修 2 个真 bug（stage 穿透吃点击、剪贴板权限拒绝无反馈） | `.vistaverge/evidence/FEATURE-01/gui-feature-check.py`、`gui-lecture-check.py`、`gui/`（截图与 results.json） | 集成接线（助手页签/事件监听/讲课 TTS/UpdatePanel 入设置）完成；BETA.md 不实声明已修正（教师真实供应商路径、QQ/微博真实草稿）；HANDOFF.md 已更新 |
| F1-SHIP | PASS | build:beta rc=0（剔模型断言 27 文件 + updater 签名 + latest.json）；6 提交推送，三 SHA 一致（2a85a6b）；Release v0.1.0-beta.2 三资产齐全，`releases/latest` 指向 beta.2（发现 prerelease 不进 latest 端点，已转正式 Release 修复更新链路） | ship-build-beta-2.log、gh api 记录 | 安装包 7.87MB，SHA-256 95baba19…；SUMMARY.md 已收口 |
