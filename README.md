# VistaVerge

> 一个能交流、陪伴学习、感知情境并完成授权任务的插件化智能伙伴。

**当前状态：`0.1.0-beta.1` 测试版已发布。** 功能可用但仍在快速迭代，
**欢迎提 issue**（bug、体验、观感、吐槽都行）→ <https://github.com/zouyuxuan122/VistaVerge/issues>

新增了「感知中心」（真实天气 / 室内温度 / Home Assistant / 主动提醒）与 **MC 模拟世界**
（真体素世界 + 真 A* 寻路 + 真挖掘/合成/搭建，可边玩边聊）。
本轮另做了一轮独立缺陷审查并修掉 22 项真实缺陷，详见 [BETA.md](BETA.md)。

## 从这里阅读

0. **[BETA.md](BETA.md) — 测试版说明（装什么、能做什么、哪些还没做、怎么提 issue）**
1. **[HANDOFF.md](HANDOFF.md) — 交接文档（新会话/新模型从这里开始）**：当前状态、代码地图、阻塞清单、已知坑与裁决。
2. [总体计划书](VISTAVERGE_DESIGN.md)：产品方向、架构、阶段与不可突破的约束。
3. [需求追踪](docs/requirements/USER_REQUIREMENTS.md)：需求 ID、对应设计和验收入口。
4. [现状调研](docs/research/CODEBASE_BASELINE.md)与[开源选型](docs/research/OPEN_SOURCE_OPTIONS.md)。
5. [UI 与角色](docs/product/UI_UX_AVATAR.md)、[语音体验](docs/product/VOICE.md)。
6. [本地记忆与感知](docs/architecture/MEMORY_PERCEPTION.md)、[隔离电脑操作](docs/plugins/COMPUTER_USE.md)。
7. [教师与陪伴](docs/product/TEACHER_COMPANION.md)、[MC 与连接器](docs/plugins/DOMAIN_PLUGINS.md)。
8. [验收与调优](docs/quality/ACCEPTANCE_MATRIX.md)、[交付阶段](docs/roadmap/DELIVERY_PHASES.md)。
9. [控制包入口](工程控制/README.md)：[EXP-01 执行汇总](工程控制/EXP-01/SUMMARY.md)与
   [AUDIT-01 缺陷审查](工程控制/AUDIT-01/SUMMARY.md)。

## 三条产品硬约束

- **不干扰用户：** AI 大光标只显示在应用内映射画面；默认不移动宿主鼠标、不抢焦点、不注入宿主输入。不支持隔离操作的应用明确报告限制。
- **真实可验证：** 模拟服务只能证明接线，不能代替真实 ASR/TTS/LLM、Minecraft 或原生桌面体验验收。
- **本地、可控：** 记忆可查看、更正、按标签检索和删除；角色卡、网页和插件内容不能提高自身权限。

## 快速上手

```bash
cd desktop
npm install
npm run dev:vite      # http://127.0.0.1:5173（离线 Mock 模式，无需任何 Key）
npm run build:beta    # 产出可分发安装包（自动剔除 Live2D 模型）
```

安装包见 Releases。未做代码签名，SmartScreen 会提示「未知发布者」——这是预期行为，不是绕过安全提示。

## 素材与许可

- **Live2D 模型「阿芙洛狄忒」**（灵境Sanctuary）授权禁分发，因此**仓库与发行产物都不含它**，
  数字人模型由用户自备（放 `desktop/public/live2d/` 后自行构建）。这是唯一原因，不是功能缺失。
- **3D 笔记本道具**：CC-BY 4.0，来源与 sha256 见 `desktop/public/models/PROVENANCE.md`，界面内有署名。
- 本仓库尚未发布根 LICENSE，这不改变已存在第三方代码各自的许可；未获授权的素材不纳入分发。

## 历史资料边界

`README-云端模式.md`、`desktop/README-桌面版.md`、`docs/01-项目分析.md`、`docs/02-全云端改造方案.md` 与 `verify/验证报告.md` 均为旧原型资料，保留作历史证据，**不是 VistaVerge 的现行设计或新功能验收**。新设计以本页入口和最高设计为准；不重写历史报告来伪造新结果。
