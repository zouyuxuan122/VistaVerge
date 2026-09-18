# 赛博女友 · 全云端模式 — 使用说明

> 原项目（freedidi《AI 赛博女友》教程）需要 ~17 GB 显存（RTX 4090 实测）。
> 本工作区把它改造成**全云端模型**：LLM / STT / TTS 全部走云端 API，
> 口型用前端素材方案替代 LiveTalking，**核显笔记本零 GPU 运行**。

## 工作区结构

```
cybergirl-cloud/
├── deploy-package/            博客一键部署包原样（分析用；云模式不需要里面的模型权重）
├── s2s/                       上游 huggingface/speech-to-speech 源码（已改 UI，见下）
├── docs/
│   ├── 01-项目分析.md         架构 / 数据流 / 组件表 / 关键参数
│   ├── 02-全云端改造方案.md   三条路线对比 + 云服务映射 + 口型三级策略 + 延迟成本
│   └── shots/                 冒烟验证截图
├── cloud/
│   ├── cloud.env.example      云服务配置模板
│   ├── start-cloud-server.sh  Linux/WSL 启动脚本（读 cloud.env）
│   └── start-cloud-server.ps1 Windows 启动脚本
└── README-云端模式.md         本文件
```

## UI 改了什么（对应教程里 localhost:7860 的界面）

改动全部在 `s2s/demo/`（即教程部署的 HF Space `smolagents/hf-realtime-voice` 同源代码）：

| 文件 | 改动 |
|---|---|
| `index.html` | 顶栏新增「☁ 全云端」状态徽标；设置弹窗改为双标签页（连接/对话 · ☁ 云服务）；新增云服务面板（供应商预设 / STT·LLM·TTS 三件套 base_url+model+key / 音色 ID / 数字人背景开关 / 复制启动命令 / 下载 cloud.env / 填入小雅人设） |
| `main.js` | 云配置持久化(localStorage)、预设填充、`speech-to-speech serve` 启动命令生成（参数名与上游 handler 一一核对）、剪贴板超时回退、徽标状态点 |
| `avatar-cloud.js` | **新增**：云模式数字人背景层——idle/listening/speaking 三段素材状态切换（L0）+ 按语音包络呼吸缩放（L1），替代 LiveTalking 真口型；预留 L2 云端数字人 API 接口 |
| `style.css` | 徽标 / 标签页 / 云面板样式（追加在文件尾部，无侵入） |
| `assets/*.mp4` | 新增：三段素材取自部署包原视频，可直接替换成自己的形象 |

改好的 `demo/` 目录可整体替换原教程 WSL 里的 `~/s2s/hf-realtime-voice`（其余部署步骤不变时也兼容本地模型模式）。

## 快速开始（全云端，Windows 本机即可）

1. **装编排服务**（Python 3.12，无需显卡）：
   ```powershell
   pip install "speech-to-speech"
   ```
2. **配云服务**：两种方式任选
   - 打开前端设置 → ☁ 云服务 → 选预设（硅基流动/DashScope/DeepSeek/OpenAI）→ 填密钥 → 「复制启动命令」或「下载 cloud.env」
   - 或复制 `cloud/cloud.env.example` 为 `cloud.env` 手动填写
3. **起服务**：
   ```powershell
   # 终端 1：编排服务（CPU）
   powershell -ExecutionPolicy Bypass -File cloud\start-cloud-server.ps1

   # 终端 2：前端
   cd s2s\demo
   npm ci
   python -m uvicorn server:app --host 127.0.0.1 --port 7860
   ```
4. 浏览器开 http://127.0.0.1:7860/ → 点语音球 → 说话。
   首次记得把 NOISE GATE 拖到最左（与原教程相同），人设可用「填入小雅人设」一键填入。

## 音色克隆（替代原 Qwen3-TTS 本地克隆）

- **硅基流动**：控制台「声音克隆」上传 `deploy-package/ref.wav`（5–15 秒干净人声）→ 得到自定义音色 ID → 填进 TTS 音色框（形如 `<user>:<voice_id>`）。
- **OpenAI**：无克隆，用 `gpt-4o-mini-tts` 预设音色 + instructions 控制语气。

## 本次实际验证记录（详见 verify/验证报告.md）

**端到端实测通过**：真实起 `speech-to-speech serve`（UI 同款云端参数）+ 真实 Realtime WebSocket
推流部署包 ref.wav 真人语音 → VAD 断句 → STT 转写出原文 → LLM 流式回复 → **真实微软云端人声**
（edge-tts 晓晓）返回 10.9s/13.4s 音频，全程 4.6s；换真 faster-whisper tiny(CPU) 再验一轮同样 PASS。
真实浏览器（Edge）直连改造后前端：会话建立、listening→user-speaking 状态机、数字人视频层渲染正常。

说明：因本机无付费云 Key（OpenAI 被墙/国内云需注册），STT/LLM 的"云端"由自建 OpenAI 兼容网关
（`cloud/mock-cloud-gateway.py`）承接——请求形状与真实供应商逐字一致（日志见 `verify/cloud-requests.log`），
TTS 则是真实微软云。**拿到 Key 填进 UI 即为完全体。** 产物：`verify/out.wav`（云端人声）、
`verify/ws-client.mjs`（协议测试客户端）。

## 与原方案的效果差异（如实说）

- 延迟：原 ~1.5–2 s → 云端 ~2–3 s（把 `S2S_MIN_SILENCE_MS` 降到 900 可抢回一截）。
- 口型：LiveTalking 是真口型；云模式默认 L0 状态切换 + L1 包络微动效，暗光侧光构图下观感可接受。要真口型走 L2 云端数字人 API（`avatar-cloud.js` 预留接口）。
- 断网即哑、API 按量计费（日常聊天约 ¥0.5–1.5/小时，见 docs/02 §4）。

## 本次冒烟验证记录

- `npm ci` + `uvicorn server:app` 启动，`/`、`/avatar-cloud.js`、`/vendor/*`、`/assets/*.mp4` 全部 200。
- 无头浏览器截图验证：首页徽标、数字人背景贴右渲染、设置双标签页、云面板三件套、预设填充、
  徽标绿点、启动命令生成（含全部参数）、人设模板填入、背景层开/关与持久化 —— 全部通过。
- 无头 Chromium 缺 H.264 解码器属测试环境限制，真实 Chrome/Edge 播放 mp4 正常。
