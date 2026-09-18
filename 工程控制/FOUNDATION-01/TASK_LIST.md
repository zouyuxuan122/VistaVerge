# FOUNDATION-01 任务总表

2026-09-18：FND-001 / FND-002 / FND-003 均 PASS（限定任务范围，前台独立复跑）。详见 ACCEPTANCE.md。以下保留原任务依赖与验门语义。

| 任务 | 目标 | 依赖 | 允许文件域 |
| --- | --- | --- | --- |
| [FND-001](tasks/FND-001.md) | 可运行音频基线测试及命令 | 无 | desktop/package.json、desktop/package-lock.json、desktop/vitest.config.ts、desktop/tests/unit/mic-capture.test.ts |
| [FND-002](tasks/FND-002.md) | 类型/请求取消信号正确性 | FND-001 | desktop/src/engine.ts、desktop/tests/unit/engine-abort.test.ts |
| [FND-003](tasks/FND-003.md) | 最小事件与代际取消合同 | FND-002 | packages/contracts/**、desktop/tests/contracts/** |

依赖：FND-001 → FND-002 → FND-003。文件域互斥，但运行器与合同有顺序依赖；本工作区写入仍串行，不能只因路径不同就同时写。

FND-001建立 `test:unit/test:contracts/typecheck` 脚本；无合同用例时test:contracts应失败，直到FND-003补齐，禁止passWithNoTests。FND-001期间旧typecheck预期失败并记录，不宣称整包绿灯；FND-002后必须通过，最终所有门通过。

任一必需验门（包括build:vite）BLOCKED时，对应任务与整包均不得PASS/VERIFIED，只能记录BLOCKED及已通过的子门；不得环境豁免后宣布整包完成。

每任务写测试→确认失败/当前行为→实现→通过→子智能体报告→独立审查→前台复跑。提交仅在明确授权后进行，逻辑任务保持可独立回滚。
