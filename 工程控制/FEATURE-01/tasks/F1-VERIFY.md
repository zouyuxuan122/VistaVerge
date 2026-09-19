# 任务: F1-VERIFY 集成接线 + 独立验证（前台）

## 目标
把各任务产物接成完整产品，前台独立复跑全部验门与真实走查后才写 PASS。

## 步骤
1. companion 接线：buildSystemPrompt 注入 persona（buildPersonaPrompt）/口癖（buildStylePrompt，强度档）/知识库（knowledge.search→buildKnowledgeContext）；设置「陪伴」页（角色卡导入/预览/清除、口癖面板、知识库管理）；语音 respondGate 接 companion.decideReplyGate；proactive 仲裁接 arbitrateProactive（每小时额度+安静时段）；用户消息喂 styleProfile 学习。
2. MC/助手事件接线：setMcEventListener.onTaskCompleted → speakProactive；setAssistantEventListener.onPatrolSummary → speakProactive（仲裁后）。
3. ScreenPane：AssistantView 页签接入（插件导航下新子页签或独立页签）；UpdatePanel 接入设置页；教师讲课入口确认。
4. 机器门全量复跑：typecheck / test:unit / test:contracts / build:vite / cargo check / cargo test，日志进 .vistaverge/evidence/FEATURE-01/verify-*.log。
5. GUI 走查（真浏览器 Playwright）：沿用 .vistaverge/evidence/EXP-01/gui/gui-check.py 模式扩展——对话（发送/流式/打断按钮/回退/编辑重新生成/复制反馈）、学习（教师面板+PPT 讲课打开 fixture pptx 渲染+批注画一笔+放大镜）、MC（指令+反击）、感知、市场、统计、设置（高级新控件/陪伴页）、主题切换（二次元/正常拨杆）、戳一戳气泡、窄窗折叠。console 零错误。截图进证据目录。
6. 文档同步：BETA.md 不实声明修正（教师 mock、QQ/微博）；HANDOFF.md 更新（新能力/新坑/页签数）；USER_REQUIREMENTS.md 新 ID 状态；docs/product/TEACHER_COMPANION.md PPT 讲课节确认与实现一致。
7. ACCEPTANCE.md 逐任务写结论；任一红灯 → 对应任务 FAIL 回炉，不 waiver。

## 验门
- 全部机器门 rc=0；GUI 走查全 PASS；文档-代码一致。

## 禁止
- 不复用子智能体自述当验收；不把能编译当验收过；不用 waiver 掩盖红灯。
