# 系统架构与合同

状态：待审批 / 未实施。上层：[最高设计](../../VISTAVERGE_DESIGN.md) §2–4。

## 1. 边界与数据所有权

| 单元 | 唯一职责 | 不可承担 |
| --- | --- | --- |
| Vue UI | 展示、输入、角色渲染、虚拟光标 | 持有所有密钥、绕过权限直接调用工具 |
| Tauri Rust 宿主 | 凭据与权限仲裁、进程、系统能力、更新 | 执行未受限的插件字符串代码 |
| 会话运行时 | 回合、生成、任务优先级、响应调度 | 自授予文件/账号/设备权限 |
| 数据服务 | SQLite 单写、迁移、会话/记忆/索引一致性 | 将派生索引当真相源 |
| 第一方工具/模型适配器 | 明确能力与结果、取消与健康状态 | 假报供应商能力、假报业务完成 |
| 第三方插件宿主 | 隔离加载、资源配额、权限代理 | 直接共享主 UI 的 Tauri 桥或凭据 |

单写服务可由 Rust 数据层承载；Node 通过 RPC 访问，不直接开第二个独立写入通道。跨进程接口尽量窄，native bridge 与模型 SDK 分开版本化。

## 2. 通信与生命周期

本地 IPC 优先受当前用户约束的管道/受控通道。若原型使用 loopback WebSocket/HTTP，必须绑定回环、随机端口/会话密钥、校验 Origin 和用户会话，不开放到 LAN；不能因为 localhost 就免认证。进程崩溃撤销会话能力，销毁未完成输入租约，任务进入可恢复/需确认状态。

- 控制 RPC：协议版本、请求 ID、方法、参数、截止时间、授权上下文。
- 事件：`protocolVersion, type, traceId, sessionId, turnId, generation, seq, emittedAt, payload`；不涉及对话的任务可不带 turnId，但仍需 traceId 与自身任务 ID。
- 二进制音频：`streamId, generation, sequence, sampleRate, channels, sampleFormat, sampleOffset` + payload；声明格式，不假定所有返回是 24k PCM。
- UI 局部 cursor/frame 事件走有界队列；日志不保存大段音频或秘密。
- 从启动→握手→协商→ready→draining→stopped 状态可观察，启动失败可回退文字会话但不伪装语音已连接。

## 3. 稳定接口族

| 接口 | 方法与返回重点 |
| --- | --- |
| ModelProvider | capabilities、streamReply、cancel、health；token/text/tool delta，usage 可为 unknown |
| SpeechProvider | transcribeStream 或 transcribeBatch；synthesizeStream 或 synthesizeSegment；音频格式、时间戳和取消能力 |
| AvatarRenderer | load/dispose、capabilities、setExpression、setGaze、playMotion、setViseme、quality |
| ToolProvider | describe、prepare、execute、cancel、status；权限、幂等键、效果与证据 |
| TaskService | create、pause、resume、cancel、observe；持久化检查点、副作用账本 |
| MemoryService | search、proposeWrite、correct、forget、export；标签、scope、来源、版本 |
| SensorProvider | snapshot、subscribe、health；观测时间与过期，不把未知值当零 |
| RegistryProvider | list、resolve、verify、install、upgrade、rollback；来源和信任身份 |
| SurfaceProvider | open、capture、dispatch、close；surface 类型/能力/帧/坐标版本及输入隔离声明 |

这些是待 schema 化合同，不是当前已存在的代码 API。第一批只固定事件、错误和取消公共部分，避免在需求不稳时冻结所有业务字段。

## 4. 取消与副作用

`generation` 是会话回合的取消代际，不是全局权限。取消先本地停播/闭口，清空未消费输出，传播到上游；所有消费者检查代际，拒绝迟到结果。无法真正取消的 provider 允许后台结束但不向用户复播，统计耗费。

工具执行前复核有效授权与目标身份，执行后记录证据。重试必须检查 `actionId` 与幂等键；外部发送已提交或状态未知时不得盲目再发。工具取消结果可为 `cancelled / completed_before_cancel / outcome_unknown`，UI 不将其混为“已撤销”。

## 5. 任务优先级与子智能体

优先顺序：用户停止/权限撤销 → 实时音频与本地安全反应 → 当前会话 → 正在进行的授权动作 → 记忆索引与后台任务。

运行时子智能体是可选计划器/检索器，不等于每个模块都跑一个 LLM。默认父任务最多两个并行 LLM 子任务，默认递归深度 1；每任务声明 wall-time、token、tool-count、scope 与取消代际，可在高级设置降低或经授权提高。MC 高频控制、VAD、家居阈值是本地确定逻辑。

记忆检索与天气获取可并行；有副作用的动作按执行面持独占输入租约。子智能体权限只能缩小父权限，输出带证据和置信，主调度只接受结构化结果，不把子智能体文字当新的系统指令。索引/记忆写入统一裁决。

## 6. 安全默认值

- CSP 从当前 null 收紧至明确源；插件 UI 使用隔离面板，不共享全局对象。
- 原生 HTTP 按 provider 的已批准端点访问，拒绝任意重定向绕过/内网探测；局域网家居端点单独授权。
- OS 凭据库保存秘密；常规配置仅含 secretRef；模型和主题包不允许执行安装脚本。
- 第三方可执行代码在有效隔离验证前明确标“受信任原生插件”，不能宣传成安全沙箱。
- 角色卡、工具返回、知识库、远程页面和检索记忆作为不可信数据；工具权限在模型外检查。

## 7. 维护与兼容

协议 SemVer、必需能力协商、弃用窗口与错误码回归 fixture。错误至少区分权限拒绝、能力缺失、认证失败、超时、取消、数据损坏、外部结果不确定、版本不兼容。界面显示可操作说明，不抛原始含密钥的错误。

contract tests 覆盖合法/非法事件、未知版本、字段上限、过期代际、取消竞争和旧配置迁移。插件 ABI 改动必须同时更新兼容矩阵与迁移说明，不让业务插件直接引用主应用内部文件。
