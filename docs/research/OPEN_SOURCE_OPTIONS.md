# 开源方案调研与采用边界

日期：2026-09-18。仅调研，未安装/集成/benchmark。网络页面部分证书校验失败，GitHub主要事实经gh API/README复核；不能以搜索结果、stars或宣传延迟替代许可与可用性。采用时固定commit/tag并保存对应LICENSE、NOTICE和模型卡。

## 1. 已核实的主干候选

| 项目/官方来源 | 可复用内容 | 当前许可核查与结论 |
| --- | --- | --- |
| [AIRI](https://github.com/moeru-ai/airi) | VRM/Live2D交互、实时陪伴、MC经验 | GitHub MIT；素材/SDK各算。参考组件，不整仓换底座 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Everything is a Plugin，Cordis生命周期、工具/策略缝隙 | 官方描述与MIT已核实；预览期接口应加适配边界 |
| [three-vrm](https://github.com/pixiv/three-vrm) | VRM渲染、表情/骨骼能力 | MIT；模型资产另核，首选 |
| [Mineflayer](https://github.com/PrismarineJS/mineflayer) | Minecraft协议bot | MIT；配[pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)/[collectblock](https://github.com/PrismarineJS/mineflayer-collectblock)，锁版本 |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | 本地TTS与声音能力 | 仓库Apache-2.0；选定权重与性能单独确认 |
| [FireRedTTS2](https://github.com/FireRedTeam/FireRedTTS2) | 小红书FireRedTeam系候选 | 仓库Apache-2.0；不混同旧FireRedTTS许可 |
| [IndexTTS](https://github.com/index-tts/index-tts) | 用户指定2.5，情绪与发音控制 | 2.5存在性已确认；自定义bilibili Model Use License Agreement，不能按MIT使用 |
| [Tauri](https://github.com/tauri-apps/tauri) | 保留现有2.x桌面壳 | 仓库API显示Apache-2.0；具体crate可能双许可，按文件审查 |
| [SillyTavern](https://github.com/SillyTavern/SillyTavern) | 角色卡互操作/世界书交互参考 | AGPL-3.0；独立实现格式，不直接搬代码后假称宽松许可 |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | SQLite内向量检索候选 | 当前API Apache-2.0；发布成熟度/性能实测，保留替换接口 |

## 2. IndexTTS-2.5 纠正记录

主会话读取官方README确认：`2026/08/10` 发布IndexTTS-2.5，`indextts/infer_v2_5.py`、权重 `IndexTeam/IndexTTS-2.5`，文档有vLLM部署recipe。前轮“2.5存在性未核实”现已更新。

当前LICENSE仍使用“bilibili indextts2”定义并覆盖其发布范围的代码/权重，自定义条款包含特定规模额外授权、下游义务及其他模型改进限制。README指向此LICENSE不等于已确认所有2.5权重适用细节；选定模型卡和版本前需复核，不凭GitHub `NOASSERTION` 断言无许可证，也不声称是OSI宽松许可。

## 3. 需要比较而非全部引入

- [Silero VAD](https://github.com/snakers4/silero-vad)、[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)、[whisper.cpp](https://github.com/ggml-org/whisper.cpp)：本地语音检测/识别候选，按中文准确率、CPU、首字/终稿延迟与硬件档位选默认。
- [Pipecat](https://github.com/pipecat-ai/pipecat)、[LiveKit Agents](https://github.com/livekit/agents) 与工作区 `s2s/`：比较流式/打断/部署成本，不同时运行三套编排。
- [Home Assistant](https://github.com/home-assistant/core) 与[官方WebSocket API](https://developers.home-assistant.io/docs/api/websocket)：状态订阅优先，read/control权限分开，第三方集成另核。
- [pywinauto](https://github.com/pywinauto/pywinauto)、[FlaUI](https://github.com/FlaUI/FlaUI)：原生驱动候选，不作为宿主无焦点干扰的保证。
- [Voyager](https://github.com/MineDojo/Voyager)：借技能库和高层规划思路，研究demo非产品依赖。
- [my-neuro](https://github.com/morettt/my-neuro)、[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)：陪伴/打断对照；“my Neuro Sam”准确指向未确定，不强行同名。

## 4. 资产与研究候选

[Live2D Cubism发布许可](https://www.live2d.com/en/sdk/license/)不是普通MIT许可。SDK用途、可扩展应用分类、公司规模与模型许可分别确认；不把免费门槛一概套到VistaVerge。许可未满足时不分发SDK，手绘模式可先用合法二次元VRM。

[角色卡v3](https://github.com/kwaroran/character-card-spec-v3)、[v2](https://github.com/malfoyslastname/character-card-spec-v2)按字段互操作，解析器独立实现；市场内容本身可带另外许可，不擅自镜像社区。

[TRELLIS](https://github.com/microsoft/TRELLIS)、[InstantMesh](https://github.com/TencentARC/InstantMesh)、[TripoSR](https://github.com/VAST-AI-Research/TripoSR)仅列生成研究候选。输入图生成表面不等于多视角高质量人物，不等于自动骨骼/表情/可动画VRM。样本、权重、许可、硬件与人工修整成本先测，再决定是否产品化。

## 5. 采用记录模板

每项实际采用记录：需求ID、为何现有代码不足、上游URL/提交、具体复制或依赖文件、代码许可证、权重许可、素材同意、兼容版本、关键测试、升级路径、替换成本。无授权来源列为UNRESOLVED，不默认允许。

embedding 候选BGE/multilingual-e5的部分模型卡在此环境TLS失败，FTS5官网曾超时；具体模型维度、前缀、ONNX来源和权重许可尚未拍板。保留本地关键词/标签可用路径，避免模型下载失败导致全部失忆。
