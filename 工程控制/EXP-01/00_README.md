# EXP-01：VistaVerge 可交付桌面应用（执行域第一批）

状态：**已批准连续执行 / IN_PROGRESS**。批准依据：2026-09-18 用户“直接推进到完整的交付状态”“继续推进”。

## 目的

把 FOUNDATION-01 的测试与合同基础推进为**本地可运行、可构建的 VistaVerge 桌面应用**。权威：VISTAVERGE_DESIGN.md、ENGINEERING_SPEC.md、docs/product/*、docs/architecture/*、docs/plugins/*。

## 本轮交付定义（范围冻结）

- 品牌 VistaVerge、严格 CSP、OS 凭据仓、去掉生产假麦克风授权。
- 左电脑屏幕/右三维角色场景/底部椭圆导航；写实与手绘双主题。
- 对话：流式（能力协商，批式显式降级）、复制/编辑分支/重试、持久化。
- 语音：批式引擎保留 + 流式 LLM/分句 TTS 链路、处理中打断、播放账本；本地 mock 供应商供离线演示与测试。
- 本地记忆：SQLite(sql.js)+FTS5+标签+更正/忘记/导出，模型可 memory.search。
- 三维场景：精致电脑（显示器/键帽/线材）+ 程序化占位人物（明确标注占位）+ VRM 导入接口（许可声明门）。
- 只读镜像、AI 工作区演示（虚拟光标仅在演示面内）、任务视图。
- 教师基础（资料/测验/批改/错题本）、天气+出门提醒、HA 适配器（无实例标 BLOCKED）、插件市场骨架（数据包+校验）。
- GUI 真实验证 + Tauri 构建。

## 明确不在本轮（外部 BLOCKED，给接入路径不伪造）

真实付费供应商验收、真实 VRM/Live2D 资产、DeepSeek 金鱼娘、MC 服务器、QQ/微博真实发送、HA 真实设备、代码签名自动更新、多图生成模型。逐项在 SUMMARY 给出阻塞与接入路径。

## 执行纪律

任务串行/并行按 TASK_LIST 依赖图；同工作区写入串行（并行仅文件域互斥时）。子智能体零 Git 写权限；前台独立复跑；证据到 `.vistaverge/evidence/EXP-01/`。任一必需门 BLOCKED → 对应任务与整包不得 PASS。
