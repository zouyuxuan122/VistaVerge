# 任务: F1-REL 应用内自动更新 + 定制安装页

## 目标
接入 Tauri updater（签名校验、应用内检查/下载/安装更新），定制 NSIS 安装页（品牌图、中文、安装模式），让「更新接口 + 非默认安装页面」成为真实能力。

## 权威依据
- docs/plugins/PLUGIN_PLATFORM_UPDATES.md §5、§6、§7
- 工程控制/FEATURE-01/GAP_AUDIT.md §3（G-REL-01/02）
- 规划.txt：「有更新接口，可以在应用里自动更新，还要有非常好的安装页面、更新页面，不能是默认那种」

## 改动范围（文件域，互斥）
- 允许改：`desktop/src-tauri/**`（Cargo.toml、tauri.conf.json、capabilities、src/、icons、installer 资源）、`desktop/scripts/**`、`desktop/src/ui/UpdatePanel.vue`（新建）、`.gitignore`
- 禁止改：其他一切文件（前端设置页接线由前台做；不改 package.json 的 dependencies——@tauri-apps/plugin-updater 的 JS 依赖如需安装，允许且仅允许这一个）。
- 密钥纪律：updater 私钥生成后放 `desktop/src-tauri/keys/`（必须加进 .gitignore，绝不入库）；pubkey 写进 tauri.conf.json。

## 步骤
1. 【P0】生成 updater 密钥对：`npx @tauri-apps/cli signer generate -w desktop/src-tauri/keys/updater.key`（设密码则记录到 keys/README，不入库）；.gitignore 加 `desktop/src-tauri/keys/`。
2. 【P0】接入 tauri-plugin-updater：Cargo.toml 加依赖（cargo 走 rsproxy 镜像，本机缓存已暖）；lib.rs 注册插件；tauri.conf.json `plugins.updater.pubkey` 填公钥，`endpoints` 指向 GitHub Releases 的 `latest.json`（https://github.com/zouyuxuan122/VistaVerge/releases/latest/download/latest.json）；capabilities/default.json 加 updater 权限（check/install 与 process 重启所需最小集）。
3. 【P0】UpdatePanel.vue（新组件）：检查更新 → 显示版本/日期/日志 → 下载（进度条、字节数）→ 校验签名 → 安装并重启（给用户「稍后/立即重启」选择）；错误可读（网络失败/签名校验失败/无更新）；「稳定/预览」渠道显示预留。样式 scoped + 主题变量，兼容双主题。无更新源时（开发环境/未发布 latest.json）如实显示「未配置更新源」，不假装检查成功。
4. 【P0】定制 NSIS 安装页：tauri.conf `bundle.windows.nsis`——中文（SimpChinese）、installMode、headerImage/sidebarImage（用 src-tauri/icons 或新绘品牌位图，BMP/PNG 按 NSIS 要求尺寸）、自定义完成页文案；必要时 installerHooks (.nsh) 加品牌页。构建验证产出的安装包确实带定制页面。
5. 【P1】build-beta.mjs 升级：构建时带 updater 签名环境变量（TAURI_SIGNING_PRIVATE_KEY 从 keys/ 读，不入库）；产出 .sig 与 latest.json 生成脚本（指向 release 资产 URL）；保留既有「剔除 Live2D 模型 → 断言 → 出包」流程不动。
6. 【P1】版本号：desktop/package.json、src-tauri/Cargo.toml、tauri.conf.json 统一升到 0.1.0-beta.2。
7. 【P2】首启向导骨架（PLUGIN_PLATFORM §5）：仅在首次启动显示的欢迎页组件（硬件探测说明/供应商配置引导/麦克风测试入口链接到设置），localStorage 标记不再显示。若时间紧可降级为 UpdatePanel 内的「首次运行检查清单」区块。

## 验门
- [ ] `cargo check --manifest-path desktop/src-tauri/Cargo.toml` rc=0
- [ ] `cargo test --manifest-path desktop/src-tauri/Cargo.toml` rc=0
- [ ] `npm --prefix desktop run typecheck` 与 `build:vite` rc=0
- [ ] `cd desktop && npm run build`（tauri build）rc=0，NSIS 安装包产出且含定制页面（截图或解包证据）
- [ ] 签名产物 `.sig` 与 latest.json 生成脚本可跑（证据：日志/产物路径）

## 禁止
- 私钥绝不入库、不进日志；不把「未配置更新源」伪装成「已是最新」；不改文件域外文件；不 git；外部命令带 timeout 存日志 `.vistaverge/evidence/FEATURE-01/rel-*.log`。

## 交回格式
命令与 rc、文件清单、密钥存放位置（只写路径，不写内容）、验门证据、未完成项、域外观察。
