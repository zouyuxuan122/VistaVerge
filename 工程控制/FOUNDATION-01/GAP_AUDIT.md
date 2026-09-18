# FOUNDATION-01 差距审计

审计日期2026-09-18，仅本包范围。设计基线为待审批v1.1；批准前差距不构成自动修改授权。

| ID/类型 | 权威条款及摘录 | 现状证据 | 差异 | 任务 |
| --- | --- | --- | --- | --- |
| GAP-F01 缺口 | ENGINEERING_SPEC.md §3“正常路径、取消/重试…必须可观察” | desktop/package.json:6–11 无测试script；mic-capture.js:12–31为可测行为 | 无桌面行为机器门 | FND-001 |
| GAP-F02 违规 | ENGINEERING_SPEC.md §3“类型/合同/单测”及最高设计§2.5 | engine.ts:328/335/338/340/366/444；noEmit返回6错误 | 信号类型与HTTP body不符合类型检查；取消传播不可信 | FND-002 |
| GAP-F03 缺口 | SYSTEM_CONTRACTS.md §2“generation/seq…”、§4“消费者检查代际” | engine.ts:7–13仅CustomEvent说明；src中无通用schema，参考CancelScope仅在Python | 无共享可校验事件与TS取消原语 | FND-003 |

可复核命令（不修复）：

```text
node desktop/node_modules/typescript/bin/tsc --noEmit -p desktop/tsconfig.json
```

2026-09-18结果rc=2、6错误，原始摘要见 [CODEBASE_BASELINE](../../docs/research/CODEBASE_BASELINE.md)。本包不把本地视频、权限过宽或localStorage密钥顺手改掉；这些已记录于总体调研，进入后续SECURITY-DATA/EXPERIENCE/REALTIME包。
