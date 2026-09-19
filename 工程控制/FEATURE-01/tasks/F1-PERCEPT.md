# 任务: F1-PERCEPT 感知/MC/插件 —— 关怀场景补全 + 已登记 bug 修复

## 目标
补齐 16℃ 一小时关怀、灯光/照度、HA 控制（授权门）、静默开关接线；MC 模拟世界修 bug 并加被打/反击互动；插件安装落盘持久化与新增权限阻断。

## 权威依据
- docs/plugins/DOMAIN_PLUGINS.md §1.1/§1.2、§3.4、§4（D3/D6）、§6
- docs/plugins/PLUGIN_PLATFORM_UPDATES.md §1（新增权限重新同意）、§3
- 工程控制/FEATURE-01/GAP_AUDIT.md §3（G-SENSE-01..04、G-MC-02、G-PLAT-01/02、B-P-01..11）

## 改动范围（文件域，互斥）
- 允许改：`desktop/src/sensors/**`、`desktop/src/mc/**`、`desktop/src/plugins/**`、`desktop/src/platform/persistence.ts`、`desktop/src/ui/{McView,PerceptionView,MarketView,TaskView}.vue`、`desktop/tests/unit/{sensors,mc,plugins}-*.test.ts`（含新增）
- 禁止改：其他一切文件（尤其 store.ts、styles、ChatView、ScreenPane）。样式用 scoped + 主题变量。
- 与 F1-CORE 的接口约定（已实现，直接用）：store 在 MC 页签或显式前缀时才调 `maybeHandleMcCommand`（B-P-07 已在 store 侧门控，你保持 session 内解析不变即可）；store 提供 `speakProactive(text)`——**不要 import store**，MC 任务完成播报由前台统一接（你在 mc/session 里加一个事件回调挂载点 `onTaskCompleted?: (summary: string) => void` 导出 setter，前台注册）。

## 步骤
1. 【P0】修 B-P-01/B-P-02：stepBuild 首次判定改为队列/任务级标志（不能用 blocksPlaced===0）；finish() 完整重置 craftUntil/depositPending 等全部任务态；补回归测试（二次搭建不谎报、合成取消后重进正常）。
2. 【P0】G-MC-02 被打/反击：新增「攻击/反击」能力——任务或即时指令「打他/反击」；模拟世界加 mob/玩家攻击事件源；PvP 开关（`pvp.enabled` 默认关、关时只规避不还手，`pvp.retaliate` 控制反击）；受击反应（掉血、低血逃跑/求援日志）。全部走真实状态机，不逐帧 LLM。
3. 【P0】G-SENSE-04/B-P-03：静默提醒开关真正生效——engine 构造读取开关状态，setQuietEnabled 更新 engine 配置（运行时切换立即生效）；补测试（关=不抑制，开=抑制）。
4. 【P0】G-SENSE-01 16℃ 一小时：perceptionStore 增加「设定温度持续监测」——轮询/订阅 HA 读数，记录 setpoint≤阈值（默认 16℃ 可配）的持续时长，≥1 小时（可配）触发关怀提醒（区分设定值/实测值文案，断线显示未知；安静时段按 DOMAIN §1.2 处理）；提醒走 perception.reminders 同一通道 + 每小时额度（默认 2）。
5. 【P1】G-SENSE-02 灯光/照度：HA 实体筛选加 illuminance/lux 传感器；照度低于阈值（可配）且有人活动时段 → 提醒「有点暗，要不要开灯」；同样走额度与安静时段。
6. 【P1】G-SENSE-03 HA 控制：haClient 加 `call_service`（写 WebSocket command）；控制动作必须经授权门——新增 perception 设置 `haControlEnabled`（默认关）+ 每次控制的显式确认回调；未授权调用直接拒绝并如实返回。UI：PerceptionView 加「开/关空调」示例按钮（带确认），文案符合「关心不是医学判断」。
7. 【P1】G-PLAT-01 插件落盘：registry 的 InstalledStore 换成 SQLite/文件持久化（可用 platform/persistence.ts 的 db_read/db_write_file 通道或 data/db 只读导入——二选一，注意循环依赖；选 data/db 则与记忆同库加表）；重启后已安装插件仍在。B-P-05 uninstall 一并清理文件字节。
8. 【P1】G-PLAT-02/B-P-04：install（升级）与 enable 时校验 permissionDiff.added——有新增权限的升级包安装后保持停用并给出「需重新同意」状态，用户在 MarketView 确认后才启用；补测试。
9. 【P2】B-P-06/08/09/10/11：registry 下载改 arrayBuffer 直接校验字节（不 text 重编码）；requireString 错误码按字段名区分；删 tickHz 死字段或接线；PerceptionView 过滤优先级加括号；TaskView 接 taskService 真实任务列表（无任务时显示真实空态，删掉硬编码门禁文案）。
10. 【P2】MC 事件挂载点：导出 `setMcEventListener({ onTaskCompleted })`，任务完成/被打反击/死亡时回调（摘要文本），供前台接到对话播报。

## 验门
- [ ] `npm --prefix desktop run typecheck` rc=0
- [ ] `npm --prefix desktop run test:unit` 全过（含新增：16℃ 持续判定/额度/安静时段、照度、HA 控制授权门、MC 反击 PvP 开关、二次搭建回归、插件落盘往返、新增权限阻断）
- [ ] `npm --prefix desktop run build:vite` rc=0

## 禁止
- 不改文件域外文件；不 git；外部命令带 timeout 存日志 `.vistaverge/evidence/FEATURE-01/percept-*.log`；16℃ 提醒文案不得出现医学结论；HA 控制不得默认开启；不伪造真实 HA 验收（无实例时用注入 fake 验证逻辑并如实说明）。

## 交回格式
命令与 rc、文件清单、验门日志、未完成项、域外观察（只登记）。
