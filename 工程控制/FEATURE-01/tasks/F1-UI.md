# 任务: F1-UI 前端打磨 —— 手绘风升级 + 布局丰富 + 动效 + 空旷治理

## 目标
负责人原话：「打磨前端动效以及前端界面审美好看点，这个手绘风变得更好看；更多的细节，现在有点空旷了，除了那块板以外界面很空」。在不破坏 HANDOFF §5 既定形态的前提下全面升级。

## 权威依据
- docs/product/UI_UX_AVATAR.md §1、§4、§6
- HANDOFF.md §5「主界面最终形态」（先读！列明了不能改回去的元素）
- 工程控制/FEATURE-01/GAP_AUDIT.md §4（G-UI-01..10、B-U-01..11）

## 改动范围（文件域，互斥）
- 允许改：`desktop/src/styles/**`、`desktop/src/app/App.vue`、`desktop/src/ui/{ScreenPane,NavPill,ThemeSwitch,MirrorView,WorkspaceView,StatsView,ReminderToast}.vue`、`desktop/src/ui/decor/**`（新建装饰组件）、`desktop/index.html`、`desktop/public/fonts/**`（新建，含 PROVENANCE.md）
- 禁止改：其他一切文件——尤其 store.ts、ChatView.vue、SettingsModal.vue、Live2DAvatar/VideoAvatar（前台正在加戳一戳，样式冲突：你的漫画滤镜只许用 app.css 里的 `[data-theme=handdrawn]` 选择器，不改这两个文件）、teacher/**、companion/**、sensors/mc/plugins 的 .vue（另一子智能体在改）。
- 与 F1-CORE 的接口约定：减少动态效果 = `<html class="reduce-motion">`（store 已切换该 class），你在 app.css 加 `.reduce-motion` 块停掉非必要动画（保留状态可见性）。

## 步骤（按投入小效果大排序）
1. 【P0】G-UI-01 手绘字体：下载一款许可清晰（OFL）的中文手写/漫画体 woff2（如站酷/思源/Google Fonts 的 Zhi Mang Xing 等），放 `public/fonts/`，写 PROVENANCE.md（来源/许可/sha256）；index.html 预加载；app.css `--font-display` 接入标题/页签/对话气泡名。不得用外链 CDN（离线+CSP）。
2. 【P0】G-UI-02 统计页手绘样式：`.stat-card/.stat-table/.heat-cell/.stat-chart` 补 `[data-theme=handdrawn]` 油墨卡+硬投影；修亮色热力图空态不可见、卡片无轮廓（B-U-01）。
3. 【P0】G-UI-03 屏幕左上角切换：ScreenPane 顶部左侧加「二次元 / 正常」拨杆（复用现有 setTheme，保留顶栏 ThemeSwitch 不删），带滑块动效；二次元=手绘、正常=写实，文案用负责人语言。
4. 【P0】G-UI-04 屏幕「显示器化」+「映射/对话」快捷切换：屏幕面板加显示器边框厚度/内屏凹槽/电源灯/底座；面板左上（切换旁边）加「对话 / 映射」小拨杆快速切 chat/mirror 页签（不动既有 7 页签）。
5. 【P0】G-UI-06 空旷治理：顶栏中段加链路状态/时间/装饰分隔；对话页写实主题也加空态（B-U 关联：`.chat-empty` 不再 display:none，写实给暗色版涂鸦或简洁插画）；人物区加「她在做什么」状态浮签（读 store.sceneState/页签，装饰组件放 decor/）；底部两侧加桌面小物（漫画贴纸/便签，纯装饰不拦输入）。
6. 【P1】G-UI-05 镜像页：只读语义视觉化（扫描线/「只读镜像·不可操作」水印图标）；修手绘对比度（B-U-02）；修手绘胶带压页签（B-U-03，挪胶带或加页签右 padding）。
7. 【P1】G-UI-07 动效：设置弹层 scale+fade 入场退场；主题切换全页 crossfade（用 View Transitions 或类切换过渡，注意 Tauri WebView 兼容，降级无动画）；市场/记忆按钮与列表 transition+hover；感知/统计/MC 卡片入场 stagger；天气/HA 加载骨架微光；消息工具条 hover 位移（复制反馈前台已做，别重复）。
8. 【P1】G-UI-08 a11y：`.reduce-motion` 停非必要动画；设置弹层 Esc 关闭+焦点圈（B-U-08）；页签 roving tabindex+方向键（B-U-09）；ReminderToast aria-live（B-U-10）；消息工具条 `@media (hover:none)` 常显（B-U-07）。
9. 【P1】G-UI-09 窄窗折叠：1280px 以下右侧场景折叠为窄条（UI 合同 §1.1.4），而不是只隐藏笔记本；topbar/stage/screen-pane 补 media query。
10. 【P2】G-UI-10 角色漫画滤镜：手绘主题下 `.avatar-pane` 叠加纸纹/网点/描边感（CSS filter/overlay，app.css 实现，不改组件）；emoji 图标换内联 SVG 油墨图标（NavPill/WorkspaceView；ChatView 的 🎙 不在你文件域，跳过）。
11. 【P2】杂项：B-U-04 laptop-credit 双定义合并（保留可见署名！）；B-U-05 输入框描边统一 ink；B-U-06 写实用户气泡提对比；B-U-11 删 App.vue 陈旧语音球注释。
12. 【P2】「当前任务」页：若 F1-PERCEPT 已接 taskService 则只做样式；否则保留其硬编码（不动逻辑，等集成）。

## 验门
- [ ] `npm --prefix desktop run typecheck` rc=0
- [ ] `npm --prefix desktop run test:unit` 全过（ui-shell 等现有测试不破坏；结构变更同步修测试选择器）
- [ ] `npm --prefix desktop run build:vite` rc=0
- [ ] 起 `npm --prefix desktop run dev:vite`，用 playwright/截图人工核对：手绘与写实双主题各截图 ≥4 张（对话/统计/镜像/设置），贴进 `.vistaverge/evidence/FEATURE-01/ui-*.png`，确认无样式崩坏、无遮挡输入框、字体生效

## 禁止
- 不得破坏 HANDOFF §5 清单（人物全 bleed 层、屏幕覆盖至她身前、页签只增不删、笔记本方向与署名、双主题默认手绘、胶囊导航、无中央语音球、laptop-credit 可见）。
- 不改文件域外文件；不 git；字体必须许可清晰且本地打包；外部命令带 timeout 存日志 `.vistaverge/evidence/FEATURE-01/ui-*.log`。

## 交回格式
命令与 rc、文件清单、截图清单（路径）、验门日志、未完成项、域外观察（只登记）。
