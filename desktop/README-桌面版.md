# 赛博女友 · 云端版 — Tauri 桌面应用

> 原网页方案（s2s Python 服务 + 浏览器）的**桌面应用化**：Tauri 2 + TypeScript/Rust，
> **安装包仅 4.4 MB**，无需 Python、无需 WSL、无需显卡。语音管线（VAD→STT→LLM→TTS）
> 全部在前端 TypeScript 引擎内完成，云调用经 Rust 侧 tauri-plugin-http 代理（无 CORS 限制）。

## 与网页版架构差异

| | 网页版（s2s/demo） | 桌面版（desktop/） |
|---|---|---|
| 语音编排 | 本地 Python speech-to-speech 服务 (8765) | **前端 TS 引擎**（无本地服务） |
| VAD/断句 | 服务端 silero VAD + smart-turn | 前端能量 VAD（噪声门阈值 + 最短语音 + 停顿断句，手感参数与 start-voice.sh 对齐） |
| 云调用 | Python handler 发起 | `@tauri-apps/plugin-http`（Rust reqwest） |
| 数字人口型 | LiveTalking（网页）/素材层（云模式） | 素材层 idle/listening/speaking + 语音包络微动效 |
| 打包 | 无 | NSIS 安装包 4.4 MB（含 WebView2 引导） |

## 代码结构

```
desktop/
├── index.html                 界面（顶栏/语音球/设置弹窗/气泡/历史面板）
├── src/
│   ├── engine.ts              云端语音引擎（核心）：Worklet 采集 → 能量 VAD → STT→LLM→TTS→回放
│   ├── worklets/mic-capture.js  16kHz/40ms 采集 + RMS
│   ├── avatar-cloud.js        数字人背景层（notify/level 由引擎直接驱动）
│   ├── main.js                UI 胶水（状态机/设置/噪声门弧/设备枚举/历史）
│   └── style.css              沿用 hf-realtime-voice 全套样式
└── src-tauri/
    ├── tauri.conf.json        窗口/打包配置（NSIS；additionalBrowserArgs 自动授予麦克风权限）
    ├── capabilities/default.json  core:default + http 全域名作用域
    └── src/                   Rust 壳（窗口 + http 插件，仅 20 行）
```

## 开发与打包

```powershell
cd desktop
npm install
npx tauri dev          # 开发（WebView2 调试：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9224"）
npx tauri build        # 产出 NSIS 安装包
# → src-tauri/target/release/bundle/nsis/CyberGirlCloud_0.1.0_x64-setup.exe
```

静默安装：`CyberGirlCloud_0.1.0_x64-setup.exe /S`（装到 `%LOCALAPPDATA%\CyberGirlCloud`，含卸载入口）。

## 使用

1. 打开应用 → 设置 → ☁ 云服务：选供应商预设、填 API Key（三件套可分别用不同供应商）
2. 点语音球 → 说话 → 停顿 1.2 秒自动断句 → 她用云端音色回答、数字人开口
3. 说话可随时打断（barge-in）；对话历史在右上角面板

## 验证记录（2026-09-13，全部通过）

- **外观**：窗口/语音球/数字人视频层/设置面板/徽标全部渲染（docs/shots/desktop-first.png）
- **端到端**（dev + 生产安装包各一轮）：注入真实语音（ref16.wav/合成音源）→ VAD 断句 →
  云网关 STT → LLM（含 8 轮历史上下文，n_msgs=10）→ 真实微软云 TTS 人声回放 →
  状态机 idle→listening→user-speaking→processing→ai-speaking→listening 闭环 →
  数字人 idle/listening/speaking.mp4 随状态切换（docs/shots/desktop-speaking.png）
- **打包**：NSIS 静默安装成功（注册表卸载项 + %LOCALAPPDATA%\CyberGirlCloud），
  安装版启动正常、设置持久化、同套 e2e 再次通过
- 桌面化过程中发现并修复：`ctx.resume()` 无手势永久 pending 卡死启动；噪声门关闭时
  VAD 阈值逻辑错误；能量 VAD 滞回带被房间底噪冻结回合；状态→数字人形象映射缺失
