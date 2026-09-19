# FEATURE-01 差距审计表

日期：2026-09-19。审计方式：4 个只读子智能体并行扫描「规划.txt + 设计文档 vs 代码现状」，前台汇总去重。
基线门（审计当日复跑）：typecheck rc=0；单测 386 passed；合同 36 passed（证据：`.vistaverge/evidence/FEATURE-01/baseline-*.log`）。
状态约定：IMPLEMENTED / PARTIAL / MISSING / STUB；差距类型：缺口/违规/过时/漂移/无主/UNRESOLVED。

## 1. 教师域（规划：PPT 讲课 + 教师闭环）

| ID | 功能点 | 依据 | 现状 | 类型 | 证据 |
|---|---|---|---|---|---|
| G-TEACH-01 | PPT 导入/解析/渲染 | 规划.txt「给一张 PPT 她就打开」；TEACHER_COMPANION §1.1 | MISSING | 缺口 | study.ts:22 仅 txt/md；全仓 pptx/slide 零命中 |
| G-TEACH-02 | PPT 批注/放大镜/激光笔 | 规划.txt「做标注、放大镜」 | MISSING | 缺口 | 全仓 annotation/magnifier 零命中 |
| G-TEACH-03 | 自动讲课链路（逐页讲解+旁白） | 规划.txt；TEACHER_COMPANION §3.2(9) | MISSING | 缺口 | 无 lecture 流程，仅单条问答 study.ts:357 |
| G-TEACH-04 | 诊断 / 苏格拉底多模式 / 提示 / 错因 / 变式 / 复盘 / 口语 / 代码隔离 | TEACHER_COMPANION §1.1、§4 T1-T11 | MISSING | 缺口 | 各关键词全仓零命中 |
| G-TEACH-05 | 间隔复习闭环 | TEACHER_COMPANION §1.1(6)、T6 | PARTIAL | 缺口 | SM-2 算法在 review.ts:66-98，但默认内存库不持久、UI 无复习入口（teacherStore.ts:56、teacherView.ts:175） |
| G-TEACH-06 | 引用可定位 + 页概念 | TEACHER_COMPANION §1.1(1)、§3.2(2) | PARTIAL | 漂移 | quoteSpan 硬编码 study.ts:300-310；UI 无点击跳转 |

### 教师域 bug（审计发现，编号 B-T-*）

- B-T-01（高）真实应用教师恒走 mock provider：teacherStore.ts:55 默认 createMockProvider，TeacherView.vue 不注入，store.ts resolveProvider 未导出。
- B-T-02（高）错题/复习默认内存库不持久：teacherStore.ts:56 默认 createMemoryStudyStore，重启全丢。
- B-T-03（中）store.review() 死接口：teacherView.ts 从未调用，复习闭环断。
- B-T-04（中）toCitation quoteSpan 失真：study.ts:300-310 恒取 chunk 前 80 字。
- B-T-05（中）导入失败不重置 events：teacherStore.ts:89-96。
- B-T-06（中）generateQuiz 忽略 difficulty 入参：study.ts:589/563。
- B-T-07（中）generateQuiz 上下文不设上限：study.ts:599-601 全 chunks 拼入。
- B-T-08（低）findChunks bigram 归一化不一致：study.ts:267-293。
- B-T-09（低）reviewEvent 契约不符且未被引用：review.ts:316-318（死代码）。
- B-T-10（低）askQuestion 无外部 signal 时构造永不 abort 的 signal：study.ts:342。
- B-T-11（低）submit 无并发保护：teacherStore.ts:139-155。
- B-T-12（低）unverified 主观题不进复习队列：teacherStore.ts:144。

## 2. 陪伴/语音/对话域

| ID | 功能点 | 依据 | 现状 | 类型 | 证据 |
|---|---|---|---|---|---|
| G-COMP-01 | 角色卡 v2/v3 导入 | TEACHER_COMPANION §1.3、T8；USER_REQ COMP-002 | MISSING | 缺口 | 仅 instructions 文本域（SettingsModal.vue:261） |
| G-COMP-02 | 酒馆/SillyTavern 卡市场 | USER_REQ COMP-002 | MISSING | 缺口 | 市场仅自建 index.json 数据包 |
| G-COMP-03 | 口癖/说话风格学习 | 本轮负责人明确要求 | MISSING | 缺口 | 全仓零实现 |
| G-COMP-04 | 知识库注入陪伴对话 | 规划.txt；TEACH-001 | MISSING | 缺口 | streamAssistant 只拼 system+history（store.ts:330-347） |
| G-COMP-05 | 模型主动 memory.search（工具调用循环） | MEMORY_PERCEPTION §3；MEM-002 | MISSING | 缺口 | 工具已注册（tools.ts:238）但 LLM 请求无 tools、无 tool_calls 解析 |
| G-COMP-06 | 主动插话（AI 主动发言仲裁） | VOICE §1.4；规划「她甚至可能打断我」 | MISSING | 缺口 | 全仓无主动发起 |
| G-COMP-07 | 主动关心进入对话/语音 | MEMORY §7 | PARTIAL | 缺口 | 出门提醒仅 UI Toast，不进对话不发声 |
| G-COMP-08 | 互动反馈（戳/打她有反应） | 规划「我打他一下他会打回来」 | MISSING | 缺口 | Live2DAvatar.vue:176,189-196 事件全禁 |
| G-VOICE-01 | 常听 + 说话对象判断 + 选择性回应 + token 优化 | VOICE §1.3/§1.6；COST-001 | MISSING | 缺口 | 每个语音片段都跑 STT+LLM，无常听开关/回应门控 |
| G-VOICE-02 | UI 打断入口 | VOICE §1.2、V1 | MISSING | 缺口 | 仅整会话 stop；interrupt() 从未被 UI 调用（ChatView.vue:136 死表达式） |
| G-VOICE-03 | 渐进 ASR / 增量转写 | VOICE §1.1 | MISSING | 缺口 | stt/openaiCompat.ts:92-126 整段批式 |
| G-VOICE-04 | 能力协商（asr/tts streaming、phoneme） | VOICE §3.5、V5 | PARTIAL | 缺口 | provider.ts:13-31 仅 llm.streaming |
| G-VOICE-05 | 本地 TTS（IndexTTS/Qwen3-TTS 等）接入路径 | VOICE §4；VOICE-003 | PARTIAL | 缺口 | 仅 OpenAI 兼容 HTTP；本地模型多有 OpenAI 兼容端点，缺自定义 baseURL/能力显示与文档 |
| G-VOICE-06 | 高级设置接线（VAD/打断灵敏度/历史轮数/减少动效） | VOICE §3.9；UI §1.6.3 | MISSING | 缺口 | SettingsModal.vue:312-317 全 disabled |
| G-VOICE-07 | 口型同步 | UI 合同 A3/A4/A9 | PARTIAL | 漂移 | 音量包络近似，代码诚实标注 AUDIO_MOUTH_IS_NOT_VISEME；本轮保持并改进节奏 |
| G-CHAT-01 | 显式「回退到此处」+ 已复制反馈 | CHAT-001 | PARTIAL | 缺口 | 复制/编辑/重试/分支有；无回退按钮、无复制反馈 |

### 陪伴/语音域 bug（B-C-*）

- B-C-01（高）barge-in 起始音频被丢弃：voiceSession.ts:304-330，interrupt 清空 prepad 后未把触发帧加入 utterance，吞首字。
- B-C-02（高）语音私有 #history 与 DB/文本历史双轨永不同步：voiceSession.ts:110,408-413；store.ts:473-482。
- B-C-03（中）processing 态单帧即打断误触发：voiceSession.ts:313-317（ai-speaking 有 5 帧去抖，processing 没有）。
- B-C-04（中）llmArgs 历史 .slice(-16) 硬编码，historyTurns 设置无效：store.ts:311。
- B-C-05（中）编辑中间消息把后缀原样复制进新分支且不重新生成：conversations.ts:251-253。
- B-C-06（中）AEC 仅浏览器约束，无自播回声验证/降级：voiceSession.ts:215-219。
- B-C-07（低）流式阶段打断留下无回复的悬空用户消息：store.ts:473。
- B-C-08（低）高级设置全只读占位：SettingsModal.vue:312-317。

## 3. 插件/更新/MC/CU/感知域

| ID | 功能点 | 依据 | 现状 | 类型 | 证据 |
|---|---|---|---|---|---|
| G-PLAT-01 | 插件安装落盘持久化 | PLUGIN_PLATFORM §3 | MISSING | 缺口 | registry.ts:278-299 纯内存 Map，重启即丢 |
| G-PLAT-02 | 新增权限阻断启用 | PLUGIN_PLATFORM §1 | MISSING | 违规 | permissionDiff 只展示不阻断（registry.ts:448-471） |
| G-PLAT-03 | 发行者签名验证 | PLUGIN_PLATFORM §3 | MISSING | 缺口 | registry.ts:10-11 自述留待 RELEASE-01 |
| G-PLAT-04 | 可执行插件宿主/SDK | PLUGIN_PLATFORM §2/§4 | MISSING | 缺口 | 仅 theme/character 数据包 |
| G-REL-01 | 应用内自动更新（Tauri updater+签名） | PLUGIN_PLATFORM §6；RELEASE-001 | MISSING | 缺口 | Cargo.toml 无 updater；tauri.conf.json 无 pubkey |
| G-REL-02 | 定制 NSIS 安装页/首启向导 | PLUGIN_PLATFORM §5 | MISSING | 缺口 | 无 nsis 定制段 |
| G-MC-01 | 真实服务器连接（Mineflayer） | DOMAIN §1.1、D1 | STUB | 缺口 | 本地模拟；无服务器凭据 → 本轮保持 BLOCKED 并增强模拟互动 |
| G-MC-02 | 受击反击/被打反应 | 规划「我打他一下他会打回来」；DOMAIN §1.1(4) | MISSING | 缺口 | TaskKind 无 attack；受击仅定时扣血 sim.ts:355-365 |
| G-MC-03 | 语音/MC 指令互通 + 游戏状态入 LLM | DOMAIN §1.1(3)、D2 | MISSING | 缺口 | 语音路径不调 MC（store.ts:473-477）；状态不入上下文 |
| G-CU-01 | Computer Use 真实执行后端 | COMPUTER_USE §1-5 | STUB | 缺口 | WorkspaceView 硬编码演示动画；本轮保持诚实演示+登记 |
| G-CU-02 | QQ/微博草稿与预览 | DOMAIN §1.5、D9 | MISSING | 缺口 | 全仓零实现；BETA.md:125「仅草稿」为不实声明 |
| G-GH-01 | GitHub PR/Issue 只读巡检 | DOMAIN §1.4、D8 | MISSING | 缺口 | 全仓零实现 |
| G-SENSE-01 | 16℃ 一小时关怀 | DOMAIN §1.2、D6 | MISSING | 缺口 | 无持续时间逻辑 |
| G-SENSE-02 | 灯光/照度感知 | 规划「觉得太暗了」 | MISSING | 缺口 | 无 lux/illuminance 处理 |
| G-SENSE-03 | HA 控制（call_service，授权门） | DOMAIN §1.2、§3.4 | MISSING | 缺口 | haClient 仅读 |
| G-SENSE-04 | 静默提醒开关接线 | DOMAIN §6 | MISSING | 违规 | setQuietEnabled 不影响 engine（perceptionStore.ts:274,283-286） |

### 平台域 bug（B-P-*）

- B-P-01（高）MC 二次搭建谎报成功：sim.ts:633 以 blocksPlaced===0 判首次。
- B-P-02（高）MC finish() 不重置 craftUntil/depositPending：sim.ts:198-210。
- B-P-03（中）静默开关无效（同 G-SENSE-04）。
- B-P-04（中）新增权限可直接启用（同 G-PLAT-02）。
- B-P-05（中）uninstall 残留文件字节：registry.ts:472-478。
- B-P-06（中）registry 下载 text() 重编码致 size-mismatch 误报：registry.ts:339-340。
- B-P-07（中）MC 指令正则过宽，普通聊天误入队：store.ts:366 + tasks.ts:60-67。
- B-P-08（低）manifest requireString 统一抛 invalid-license 误导：manifest.ts:235。
- B-P-09（低）session.tickHz 死字段；resetSimulation Object.assign 脆弱：session.ts:24,51-56。
- B-P-10（低）PerceptionView 过滤优先级 `a || b && c`：PerceptionView.vue:28-32。
- B-P-11（低）TaskView 硬编码门禁列表未接 taskService：TaskView.vue:4-11。

## 4. UI/前端域

| ID | 功能点 | 依据 | 现状 | 类型 | 证据 |
|---|---|---|---|---|---|
| G-UI-01 | 手绘字体（手写/漫画体） | 负责人「手绘风变得更好看」 | MISSING | 缺口 | index.html 无字体加载 |
| G-UI-02 | 统计页手绘样式 + 亮色可见性 | 负责人；UI 合同 §1.2 | MISSING | 缺口 | StatsView 零手绘覆盖；heat-cell 亮色不可见 |
| G-UI-03 | 屏幕左上角「二次元/正常」物理切换 | 规划.txt | MISSING | 缺口 | 主题切换在右上顶栏（App.vue:53） |
| G-UI-04 | 屏幕面板显示器化（边框/电源灯/底座）+ 映射/对话切换 | 规划.txt | MISSING | 缺口 | screen-pane 仅玻璃卡 |
| G-UI-05 | 镜像页只读视觉语义 + 手绘对比度 | UI 合同 §1.5.1 | PARTIAL | 缺口 | 深色空框、placeholder 对比度 2.5:1 |
| G-UI-06 | 界面丰富度（顶栏中段/人物区 HUD/空态/任务页/emoji→SVG 图标） | 负责人「界面很空」 | PARTIAL | 缺口 | 见审计 §三清单 |
| G-UI-07 | 动效补全（弹层/主题 crossfade/入场 stagger/骨架/复制反馈） | 负责人「打磨动效」 | PARTIAL | 缺口 | 见审计 §二③ |
| G-UI-08 | 减少动态效果开关 + 键盘可达 + aria-live | UI 合同 §1.6 | MISSING | 缺口 | 仅 prefers-reduced-motion 兜底 |
| G-UI-09 | 窄窗折叠为窄条 | UI 合同 §1.1.4、A1 | PARTIAL | 缺口 | 仅 DeskLaptop 一处 media query |
| G-UI-10 | 角色手绘滤镜 | 规划「二次元界面全部手绘风」 | MISSING | 缺口 | 手绘仅覆盖 UI chrome |

### UI bug（B-U-*）

- B-U-01 亮色热力图空态/统计卡不可见：StatsView.vue:186-221。
- B-U-02 手绘镜像 placeholder 低对比：app.css:266-272。
- B-U-03 手绘胶带压页签：app.css:419-434。
- B-U-04 laptop-credit 双定义冲突：app.css:1014-1025 vs DeskLaptop.vue:63-72。
- B-U-05 手绘输入框描边不一致：app.css:523-525。
- B-U-06 写实用户气泡对比度低：app.css:211。
- B-U-07 消息工具条无 hover 设备不可达：app.css:212-213。
- B-U-08 设置弹层无 Esc/焦点陷阱：SettingsModal.vue:178。
- B-U-09 页签无键盘 roving tabindex：ScreenPane.vue:33-39。
- B-U-10 提醒浮层无 aria-live：ReminderToast.vue:21-29。
- B-U-11 App.vue:3 陈旧「语音球」注释。
- B-U-12 pinia 死依赖：main.ts:2,18。

## 5. 文档-代码不一致（违规登记）

- BETA.md:32 教师「✅ 可用」但实际恒走 mock provider（B-T-01）。
- BETA.md:125 QQ/微博「仅草稿」但零实现（G-CU-02）。
- HANDOFF.md §5「五页签」与现状 7 页签漂移（事实性更新即可）。

## 6. 本轮明确保持 BLOCKED（外部条件，不伪造）

真 Mineflayer 服务器连接（无服务器/账号）；真 Computer Use 隔离执行后端（大工程，保持诚实演示）；QQ/微博实际发送（无官方 API/隔离环境）；真 viseme 口型（无音素时长源，保持包络并诚实标注）；PDF/OCR 解析引擎（本轮 PPTX 优先）；可执行插件沙箱宿主（保持数据包+明示未开放）；多图生成人物（研究线）。
