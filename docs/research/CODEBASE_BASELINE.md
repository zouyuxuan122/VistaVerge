# 现有代码基线与差距调研

日期：2026-09-18。方式：只读文件/元数据与一次 noEmit 类型检查；未构建、未修复产品代码、未验证真实服务或游戏。

## 1. 工作区

- `desktop/`：当前主力 Tauri2/Vite 原型，无Vue/Three/VRM/Live2D依赖。
- `s2s/`：Hugging Face speech-to-speech 参考源码，Apache-2.0，自有测试与协作规约。
- `cloud/`：原云模式启动、配置模板与mock网关。
- `deploy-package/`：旧教程下载、LiveTalking相关脚本/权重与人物声音素材。
- `docs/01-项目分析.md`、`docs/02-全云端改造方案.md`：历史架构记录，不是VistaVerge目标规范。
- `verify/验证报告.md`：历史协议验证，其中STT/LLM存在模拟路径，不能宣称真实LLM低延迟或质量已通过。

## 2. 证据索引

| 领域 | 可复核证据 | 结论 |
| --- | --- | --- |
| 人物 | `desktop/src/avatar-cloud.js:11–13,106–126` | MP4切换+整幅缩放，无骨骼与发音口型 |
| LLM | `desktop/src/engine.ts:373–399` | `stream:false`，内存历史 |
| 音频闭环 | `desktop/src/engine.ts:323–340,402–424` | 串行等待STT/LLM/完整TTS |
| 打断 | `desktop/src/engine.ts:256–270` | 基础200ms能量门判断，非完整状态取消 |
| 类型 | `desktop/src/engine.ts:328,335,338,340,366,444` | noEmit检查6处错误 |
| 密钥 | `desktop/src/main.js:7–26,459–471` | 三种provider key在localStorage |
| 人设 | `desktop/src/main.js:49–56` | 旧模板要求否认AI身份，需按新关系边界替换 |
| 原生壳 | `desktop/src-tauri/src/lib.rs:4–10` | 仅注册HTTP插件 |
| 权限 | `desktop/src-tauri/capabilities/default.json:9–16` | http(s)全域名放通 |
| CSP/麦克风 | `desktop/src-tauri/tauri.conf.json:22–27` | CSP null，含fake media permission参数，需审查并移除生产自动授权 |
| 工程命令 | `desktop/package.json:6–11` | 仅开发构建，无测试或typecheck script |
| 取消参考 | `s2s/src/speech_to_speech/pipeline/cancel_scope.py:1–59` | 代际+discard可借鉴但需独立测试 |
| 插件参考 | `s2s/src/speech_to_speech/backend_registry.py` | 静态provider注册，不是市场/通用沙箱 |
| 历史验证 | `verify/验证报告.md:3–6,19–32,53–59` | 旧时间线非真实LLM首音基准 |

## 3. 本轮实际运行的检查

命令（现有 node_modules，无安装/构建）：

```text
node desktop/node_modules/typescript/bin/tsc --noEmit -p desktop/tsconfig.json
```

退出码2：

```text
engine.ts(328,45) TS2345 AbortSignal is not assignable to AbortController
engine.ts(335,47) TS2345 AbortSignal is not assignable to AbortController
engine.ts(338,45) TS2345 AbortSignal is not assignable to AbortController
engine.ts(340,61) TS2345 AbortSignal is not assignable to AbortController
engine.ts(366,7) TS2322 Uint8Array<ArrayBufferLike> is not assignable to BodyInit
engine.ts(444,17) TS2551 Property 'aborted' does not exist on AbortController
```

调用方 `_processTurn` 取 `this.inFlight.signal`，被调 `_stt/_llm/_tts/_play` 却标成控制器，并部分访问 `ac.signal`。这不只是需要关闭strict：请求取消传播也要行为测试。具体修复在 FOUNDATION-01，不在调研阶段顺手改。

## 4. 复用与舍弃

复用候选：现有PCM/WAV思路、设备选择、provider配置、Realtime聊天与工具执行器、CancelScope设计、已有测试样例。逐项核许可与依赖，不整仓盲搬。

重建：Vue组件与状态、分支会话、流式音频调度、可驱动角色、权限/存储/记忆、任务、插件市场和更新。旧布局和视频不作为新产品最终形象。

旧文件不立即删除。入口README明确权威层级；历史验证只作原始证据，不能改写成新结果。新入库源码必须可复现且带合法资源；.gitignore隔离未授权媒体不等于已解决构建资源缺失。

## 5. 未验证项

真实音频硬件回声/ASR/TTS/LLM、当前exe运行、GPU帧率、实际VRM/Live2D、MC服务器、QQ与HA账号、Windows隔离环境、签名更新均未验证。已有编译产物不作为新的验收证据。
