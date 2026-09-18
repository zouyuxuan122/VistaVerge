# Computer Use：无干扰执行与映射大光标

状态：待审批 / 未实施。权威：[最高设计](../../VISTAVERGE_DESIGN.md) §2.2。

## 1. 用户体验合同

用户在宿主记事本继续打字，AI 在 VistaVerge 的“AI 工作区”浏览网页、准备文件或操作隔离应用。AI 的大光标只在该画面内移动，显示目标、点击波纹和当前动作；宿主鼠标不动、键盘不被拦截、焦点不被抢走。

“本机只读镜像”是用户当前窗口/屏幕的授权预览，不可通过大光标执行输入。“AI 工作区”是独立执行平面，必须清楚标识“这是 AI 的独立环境，不是本机正在使用的窗口”。二者不能用同一个未说明的“映射”开关混淆。

默认全局停止按钮、工作区局部急停、任务取消快捷键；快捷键仅触发控制指令，不成为键盘记录器。失联/权限撤销时停止接受新动作。

## 2. 执行后端分级

| 后端 | 能做什么 | 硬限制与定位 |
| --- | --- | --- |
| 官方 API/协议 | GitHub、天气、家居、文件转换等 | 不一定有真实鼠标轨迹；用明确动作高亮，不造假点击 |
| 受管理独立浏览器 | DOM/协议输入、截图、网页任务 | 首期默认；独立 profile、无宿主登录复用；验证无系统焦点变化 |
| UIA 控制模式 | 某些原生控件可后台 Invoke/Value | 不保证不抢焦点；默认不在宿主执行，只在隔离环境作驱动 |
| 隔离 VM/独立受支持会话 | 原生 QQ 等、guest 内输入和捕获 | 需要系统版本、资源、许可证、安装与登录；不是所有机器都具备 |
| 宿主全局输入 | SendInput/鼠标移动/抢焦点 | 不属于本需求的默认或隐藏回退路径 |

独立浏览器输入隔离不等于完整系统安全沙箱：下载、文件、网络、localhost和凭据仍经策略约束。不要弹出会抢焦点的宿主文件选择器、外部协议或打印窗口；这类动作中止并转换为受控下载/授权请求。浏览器启动、崩溃恢复也必须接受焦点测试。

Windows Home 不假定有 Hyper-V/Sandbox；其他 VM 或远程环境须单独部署和许可评估，不默认安装。Windows Sandbox 主要适合临时任务，关闭销毁，不作为稳定长期账号环境。普通 Windows 虚拟桌面不是独立输入会话。首启 capability probe 报告可用后端，缺隔离就只保留 API/浏览器/草稿，不接管宿主。

## 3. 画面、光标与坐标合同

执行面：`surfaceId, backendKind, ownerTaskId, isolationMode, inputCapabilities`。

帧：`frameId, capturedAt, surfaceId, width, height, viewportRevision, contentRect, scale`。执行坐标是目标视口 CSS 像素或 guest 像素，明确单位，绝不把宿主 screenX/Y 直接当执行坐标。

显示层以 contain/letterbox 映射，扣除黑边与缩放；缩放/DPI/分辨率变化增加 revision，旧 frame/revision 动作拒绝或重新定位。大光标限制在内容矩形内。目标身份与元素在执行前重新校验，超时、页面导航、遮挡/目标丢失时不盲点旧位置。

动作事件：`actionId, surfaceId, target, phase(planned/dispatched/confirmed/failed), frameId, revision, generation`。规划路径可预览但样式与“已执行”区分；点击波纹只在 dispatch，完成标记来自结果证据。光标不能在执行失败时继续表演成功。

默认 CSS/SVG/Canvas 光标绘制在映射组件内部，**不创建宿主顶层 overlay 窗口**。抓取帧和光标流分开，按单调时钟关联；卡帧显示“画面延迟”，禁止对过期帧继续输入。初始帧陈旧上限目标 500ms，按后端测量调整并告知，不作为跨网络保证。

只读镜像的多屏/负坐标/混合 DPI 在捕获适配器处理，输出统一内容帧；这些宿主坐标不流向执行接口。隐藏/最小化画面不可抓时显示不可用，不能用旧截图当实时画面。

## 4. 任务与副作用

优先 API → DOM → 隔离环境 UIA → 隔离环境视觉点击。每执行面仅一个输入租约。截图裁剪和无障碍树按任务最小化传递，OCR/网页/消息/游戏文字视为不可信输入。

发 QQ/微博：选平台与收件人 → 确认账号、目标和正文 → 预览 → 获准发送 → 检查目标应用结果。首期可交草稿，后续实际发送依赖合法接口或已登录隔离环境。不可假设宿主 QQ 会话自动可在 VM 复用；平台限制/风控如实报告，不绕过。

取消不能撤销已发送；网络断开后外部结果未知时查询状态或请用户核实，不自动重发。工具重试有幂等键、次数上限、截止时间，禁止无限视觉点击。

## 5. 验收与调优

建立独立宿主观察进程，记录 GetCursorPos、前台窗口与焦点、可识别的输入注入事件；同时让用户/测试员在记事本输入已知文本。分两组：宿主静止时 AI 动作不导致光标/焦点变化；用户主动移动时不要求光标恒定，而要求没有额外注入/焦点变化和丢字。单靠最终坐标未变无法排除移走再移回。

隔离后端必须同时证明 guest/浏览器目标**实际改变**，避免“什么也没做”通过不干扰测试。用只在测试环境运行的主动干扰对照验证观察器能发现问题，不在用户生产桌面注入对照。

矩阵：浏览器点击输入拖动滚动、下载/上传取消、弹窗、页面跳转、resize、DPI125%/150%/混合DPI、多屏、遮挡、卡帧、断线、AI停止、外部结果未知。要求大光标不越界、目标正确、用户输入不中断、未授权副作用为零。

初批约20种确定任务、每种重复至少5次，目标成功率≥90%；安全约束不因总体成功率而豁免。报告点击次数、重试、视觉token、帧延迟P95、总耗时和人工接管原因。静态扫描禁用 API 只是辅助，不能代替运行时验证。

## 6. 参考与待验证项

- <https://playwright.dev/docs/api/class-mouse>：页面 CSS 像素鼠标，不等于宿主输入。
- <https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview>：UIA模式不承诺焦点隔离。
- <https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationelement-setfocus>。
- <https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-overview>。
- <https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api>。

具体 browser/VM 捕获驱动、Windows SKU、guest license、账号与平台 ToS 在 CONTROL-01 原型先验证。此文不承诺任意本机应用都能后台无干扰控制。
