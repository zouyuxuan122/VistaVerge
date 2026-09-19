# 任务: F1-CORE 核心链路（前台亲手）

## 目标
把陪伴能力接进主对话与语音链路：工具调用循环（memory.search）、知识库/口癖/角色卡注入、打断 UI、语音历史统一、选择性回应门控、戳一戳互动、高级设置接线。

## 权威依据
- 工程控制/FEATURE-01/GAP_AUDIT.md §2（G-COMP-04/05/07/08、G-VOICE-01..06、G-CHAT-01、B-C-01..08）、§3（B-P-07）
- docs/architecture/MEMORY_PERCEPTION.md §3/§8；docs/product/VOICE.md §1.2/§1.3/§1.6/§3.9；docs/product/UI_UX_AVATAR.md §1.4

## 改动范围（文件域，互斥）
- 允许改：desktop/src/app/{store,providerAccess,avatarBridge}.ts、desktop/src/services/**、desktop/src/data/**、desktop/src/ui/{ChatView,SettingsModal,Live2DAvatar,VideoAvatar,MemoryView}.vue、desktop/tests/unit/{services,data,app}-*（含新增）
- 禁止改：teacher/**、companion/**、sensors/**、mc/**、plugins/**、styles/**、其他 ui 组件、src-tauri/**

## 步骤
1. openaiCompat：chat 请求支持 tools/tool_choice；SSE 解析 tool_calls（流式增量合并）；finish_reason 透传。
2. store：工具循环（memory.search 首接；循环上限 3 轮；工具输出标 untrusted；计量照常）；streamAssistant 注入：人设（角色卡）+ 口癖风格段 + 知识库检索段 + 相关记忆段（混合检索 topN 自动注入，标记数据非指令）；historyTurns 设置生效（修 B-C-04）；MC 指令只在 MC 页签或显式前缀时触发（修 B-P-07）。
3. voiceSession：修 B-C-01（barge-in 触发帧入 utterance）、B-C-03（processing 态 5 帧去抖对齐）、B-C-02（私有 #history 改为从 store 统一历史读取，文本编辑/分支切换后语音上下文一致）；选择性回应门控（decideReplyGate 集成，门控为 record 时仅落转写不回复，设置三档：全回应/智能/仅唤醒）；语音 user-turn 同样过 MC/出门指令。
4. conversations：rollbackTo(messageId)（新分支=该消息之前的全部历史，截断后续）；修 B-C-05（编辑新分支不搬运旧回复后缀，从编辑点重新生成）。
5. ChatView：打断按钮（生成/播放中显示，调 getVoice().interrupt() 或取消文本流）；「回退到此处」按钮（rollbackTo + 提示不撤销外部动作）；复制后「已复制」反馈；删死表达式（B-C-03 UI 部分/G-VOICE-02）。
6. SettingsModal：高级设置接线（historyTurns、回应门控档位、打断灵敏度=BARGE_IN_FRAMES、减少动态效果开关→body class）；人设区：角色卡导入（调 companion.charcard，导入成功写 settings.persona 并预览）；知识库管理入口（导入文本文件、列表、删除）——companion.knowledge API 接线；口癖面板（查看/编辑/开关）。
7. Live2DAvatar/VideoAvatar：戳一戳互动（DOM 覆盖热区，不动 pixi 事件系统；点击→表情动作+本地反应台词池，接 avatarBridge； optionally LLM 反应，默认本地）。
8. TTS 本地接入路径：设置页「TTS 自定义端点」（baseURL 可改，文档化本地 IndexTTS/Qwen3-TTS 的 OpenAI 兼容服务接法）；能力显示（streaming 批式/流式徽章）。
9. 测试：工具循环（tool_calls SSE 合成帧→memory.search 被调→结果注入第二轮）、门控三档、barge-in 帧保留、rollbackTo、编辑新分支语义、historyTurns 生效。

## 验门
- typecheck / test:unit / test:contracts / build:vite 全 rc=0；新增测试全过。

## 禁止
- 不改文件域外文件；不以模拟代替真实验收宣称延迟指标；保持 AUDIO_MOUTH_IS_NOT_VISEME 诚实标注。
