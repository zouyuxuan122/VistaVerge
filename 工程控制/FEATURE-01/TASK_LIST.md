# FEATURE-01 任务列表

| 任务 | 标题 | 执行者 | 文件域（互斥） | 覆盖差距 | 依赖 |
|---|---|---|---|---|---|
| F1-TEACH | 教师域：PPT 讲课 + 闭环修复 | 子智能体 A | desktop/src/teacher/**、desktop/src/ui/TeacherView.vue、desktop/src/ui/teacher/**、desktop/tests/unit/teacher-*、desktop/package.json、desktop/package-lock.json | G-TEACH-01..06、B-T-01..12 | providerAccess.ts（前台预备）、fflate |
| F1-COMP | 陪伴纯模块：角色卡/口癖/知识库/主动插话 | 子智能体 B | desktop/src/companion/**（新建）、desktop/tests/unit/companion-* | G-COMP-01/03/04(数据层)/06 | 无（纯模块，集成由前台） |
| F1-CORE | 核心链路：工具循环/语音修复/打断 UI/知识库注入/戳一戳 | 前台（亲手） | desktop/src/app/store.ts、providerAccess.ts、avatarBridge.ts、services/**、data/**、ui/ChatView.vue、ui/SettingsModal.vue、ui/Live2DAvatar.vue、ui/VideoAvatar.vue、ui/MemoryView.vue、tests/unit/{services,data,app}-* | G-COMP-04/05/07/08、G-VOICE-01..06、G-CHAT-01、B-C-01..08、B-P-07 | F1-COMP 交付后接线 |
| F1-PERCEPT | 感知/MC/插件：16℃、灯光、HA 控制、静默开关、MC 反击与修复、插件落盘与权限门 | 子智能体 C | desktop/src/sensors/**、desktop/src/mc/**、desktop/src/plugins/**、desktop/src/platform/persistence.ts、desktop/src/ui/{McView,PerceptionView,MarketView,TaskView}.vue、desktop/tests/unit/{sensors,mc,plugins}-* | G-SENSE-01..04、G-MC-02、G-PLAT-01/02、B-P-01..11 | 无 |
| F1-UI | 前端打磨：手绘字体/显示器化/左上切换/动效/空旷填充/窄窗/a11y | 子智能体 D | desktop/src/styles/**、desktop/src/app/App.vue、desktop/src/ui/{ScreenPane,NavPill,ThemeSwitch,MirrorView,WorkspaceView,StatsView,ReminderToast}.vue、desktop/src/ui/decor/**、desktop/index.html、desktop/public/fonts/** | G-UI-01..10、B-U-01..11 | 无（与 CORE 文件域互斥已确认） |
| F1-REL | 自动更新 + 定制安装页 | 子智能体 E | desktop/src-tauri/**、desktop/scripts/**、desktop/src/ui/UpdatePanel.vue（新）、.gitignore | G-REL-01/02 | 无 |
| F1-ASSIST | GitHub 巡检 + QQ/微博草稿 | 子智能体 F | desktop/src/assistant/**（新建）、desktop/src/ui/AssistantView.vue（新）、desktop/tests/unit/assistant-* | G-GH-01、G-CU-02 | 无（页签集成由前台） |
| F1-VERIFY | 集成接线 + 机器门 + GUI 走查 | 前台 | 集成点小改（ScreenPane 页签、main.ts、BETA.md、docs） | 全部 | F1-TEACH/COMP/CORE/PERCEPT/UI/REL/ASSIST |
| F1-SHIP | 统一提交推送 + beta.2 发布 | 前台 | git 全域 | — | F1-VERIFY 全 PASS |

依赖图：TEACH/COMP/PERCEPT/UI/REL/ASSIST 六路并行（文件域互斥，但受并发上限分两到三波派发）→ CORE 与 COMP 串行（接线）→ VERIFY → SHIP。
