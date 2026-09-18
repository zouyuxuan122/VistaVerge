# @vistaverge/contracts (FND-003 最小事件与代际取消合同)

状态：**未接入任何 runtime**。这是 FOUNDATION-01 的最小合同库原语，只定义并校验三个
turn 类 v1 事件与一个代际计数原语，不声称已接入旧引擎、桌面应用或任何服务。

## 范围

- 只做 JSON 数据合同的类型与显式解析函数，**不引入运行时 schema 依赖**。
- 只做 schema 校验，**不检查全局时间排序**。
- 输入按 JSON 数据对待；**不支持不可信 JavaScript getter 的执行隔离**。
- 不涉及 UI、IPC 服务、权限、模型或业务插件；这些属于后续包。

## 事件合同（EnvelopeV1）

公共字段：

| 字段 | 约束 |
| --- | --- |
| `protocolVersion` | 恒为 `1` |
| `type` | `turn.started` \| `turn.cancelled` \| `text.delta` |
| `traceId` / `sessionId` / `turnId` | 非空字符串，各 ≤128 字符 |
| `generation` / `seq` | 非负安全整数 |
| `emittedAt` | 有限非负 epoch 毫秒 |
| `payload` | 按 `type` 精确匹配，见下 |

三种 type 的 payload：

- `turn.started`：`{ inputKind: 'text' | 'speech' }`
- `turn.cancelled`：`{ reason: 'user' | 'stop' | 'superseded' | 'timeout' }`
- `text.delta`：`{ text: string }`，长度 1 至 16384 字符

未知版本、未知 type、额外字段或错误 payload 一律拒绝。**默认拒绝额外字段是 v1 策略**；
未来新增字段必须经版本或明确能力协商，不静默放宽。解析返回判别结果：

```ts
import { parseEnvelope } from './src/envelope';

const result = parseEnvelope(unknownValue);
if (result.ok) {
  // result.value: EnvelopeV1
} else {
  // result.code: EnvelopeErrorCode, result.path: string
}
```

错误码：`NOT_OBJECT`、`UNKNOWN_FIELD`、`MISSING_FIELD`、`INVALID_PROTOCOL_VERSION`、
`INVALID_TYPE`、`INVALID_ID`、`INVALID_INTEGER`、`INVALID_TIMESTAMP`、`INVALID_PAYLOAD`。

失败对象只含 `code` 与 `path`。`path` 只由已知字段名（如 `$.payload.text`）或未知字段的
**容器**（`$` / `$.payload`）构成，**不回显输入正文、密钥，也不把用户控制的未知字段名写进
path**。

### 版本语义

`protocolVersion: 1` 是**线协议主版本判别**，不是包版本。合同包自身按 **SemVer** 发行；
破坏性 schema 变更增加主版本（`protocolVersion` 递增），兼容性变更走包内次/修订版本。
后续扩展按公共合同流程进行，**禁止把这个小库误报成插件框架或产品功能已完成**。

### 任务域事件

本 schema 只覆盖携带 `turnId` 的 turn 类事件。任务域事件（`taskId` / `actionId`）另立
合同；**不能把缺少 `turnId` 的任务事件塞进本 schema**。

## GenerationGate（代际取消）

```ts
import { GenerationGate } from './src/generation';

const gate = new GenerationGate(); // 默认初值 0
gate.current;                     // 只读
gate.advance();                   // 加 1 并返回新值；取消使 advance
gate.accepts(captured);           // 仅安全整数且等于 current 时为 true
```

- 构造器签名 `constructor(initial: number = 0)`；`initial` 必须是非负安全整数，否则抛
  `GenerationGateError`（`code: 'INVALID_INITIAL'`）。
- 达到 `Number.MAX_SAFE_INTEGER` 后 `advance()` 抛 `GENERATION_EXHAUSTED`，**不 wrap 复用旧代际**。
- 取消使 `advance`；恢复不回退 generation。
- 多个会话各持有实例，互不影响。

## 验证

- `npm --prefix desktop run test:contracts`（Vitest，禁止空测试通过）
- `node desktop/node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json`

测试位于 `desktop/tests/contracts/`，通过相对路径加载本包源码。

## 未做 / 边界

本库不集成 runtime、不启动外部服务、不改变权限与引擎；生产集成、任务域合同与更多事件类型
由后续 RUNTIME / REALTIME 包另行建立。
