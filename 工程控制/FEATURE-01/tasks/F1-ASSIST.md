# 任务: F1-ASSIST GitHub 巡检 + QQ/微博草稿

## 目标
帮她长出「项目小助手」能力：只读巡检 GitHub 仓库的 PR/Issue 并给摘要提醒；QQ/微博消息草稿与预览（默认不外发）。

## 权威依据
- docs/plugins/DOMAIN_PLUGINS.md §1.4、§1.5、§3.7/§3.8、§4（D8/D9）、§6
- 工程控制/FEATURE-01/GAP_AUDIT.md §3（G-GH-01、G-CU-02）
- 规划.txt：「帮我看定期查看我项目的 PR issue 来审查」「它能操控我 QQ 发消息……还要学微博」

## 改动范围（文件域，互斥）
- 允许改：`desktop/src/assistant/**`（全部新建）、`desktop/src/ui/AssistantView.vue`（新建）、`desktop/tests/unit/assistant-*.test.ts`（新建）
- 禁止改：其他一切文件（页签接线由前台做；HTTP 用 @tauri-apps/plugin-http 的 fetch，与 llm 层一致；密钥读写用 platform/credentials 只读导入，不得修改）。

## 步骤
1. 【P0】`assistant/ghPatrol.ts`：GitHub 只读巡检——
   - 配置：owner/repo 列表、token（credentials 读 `ghToken`，最小 read 权限）、定时间隔（用户显式开启才定时，默认只手动）。
   - 拉取：open PR 列表（标题/作者/更新时间/草稿态/labels）、open issue 列表（标题/作者/更新时间/labels）；ETag/If-Modified-Since 条件请求 + 429/403 限流退避（指数退避，最多 3 次）；仅 GET，零写操作。
   - 摘要：`summarize(patrolResult)` 产出中文摘要文本（新增/更新/待评审分布），结果带 observedAt；上次巡检结果本地持久化（platform/persistence 只读导入或内存+localStorage）。
   - 网络不可达/未配置 token → 诚实状态（「未配置」「限流中」「离线」），不编造列表。
2. 【P0】`assistant/socialDraft.ts`：QQ/微博草稿——
   - `createDraft(platform: 'qq'|'weibo', { to?, text })`：草稿列表（本地持久化），每条带预览渲染（气泡样式数据）、敏感检查（长度上限、@全体 警示、链接标注）。
   - 「发送」按钮存在但永远先弹确认：确认后检查通道——无官方 API/隔离环境 → 明确「当前仅支持草稿，发送通道未就绪」（DOMAIN §1.5）；预留 `social.publish` 接口桩（默认禁用，返回 not-authorized）。
3. 【P0】`ui/AssistantView.vue`：两个卡片区——GitHub 巡检（配置表单：仓库、token 状态只显已配/未配；「立即巡检」按钮；结果列表与摘要；定时开关+间隔）；社媒草稿（平台切换、收件人/内容、预览气泡、草稿列表、发送确认弹层→诚实未就绪提示）。scoped 样式 + 主题变量，双主题兼容。
4. 【P1】导出事件挂载点 `setAssistantEventListener({ onPatrolSummary })`：巡检出摘要时回调（前台接到她的主动插话）。
5. 【P1】单测：ghPatrol（mock fetch：正常列表/ETag 304/429 退避/离线诚实态/零写操作断言——fetch 只收到 GET）；socialDraft（建稿/预览/敏感标注/发送永远确认+未就绪）。

## 验门
- [ ] `npm --prefix desktop run typecheck` rc=0
- [ ] `npm --prefix desktop run test:unit` 全过（含新增 assistant 测试）
- [ ] `npm --prefix desktop run build:vite` rc=0

## 禁止
- 零写 GitHub（任何 POST/PATCH/DELETE 都是红线）；社媒不得自动外发；token 不进日志/报告；不改文件域外文件；不 git；外部命令带 timeout 存日志 `.vistaverge/evidence/FEATURE-01/assist-*.log`。

## 交回格式
命令与 rc、文件清单、导出 API 签名清单、验门日志、未完成项、域外观察。
