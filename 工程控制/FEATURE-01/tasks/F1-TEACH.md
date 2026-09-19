# 任务: F1-TEACH 教师域 —— PPT 讲课 + 教师闭环修复补全

## 目标
让「给她一张 PPT，她就打开 PPT 讲课、在 PPT 上批注、用放大镜/激光笔演示」成为真实可用功能；同时修掉教师域全部已登记 bug，补齐闭环关键环节（复习入口、持久化、诊断、提示、错因、变式、复盘）。

## 权威依据
- 规划.txt（负责人 2026-09-19）：「我给他一张 PPT，他就打开 PPT，对那个 PPT 讲课，在 PPT 上做标注，在旁边演示，做批注和放大镜」
- docs/product/TEACHER_COMPANION.md §1.1、§1.4、§3.2、§4（T1-T11）、§6
- docs/requirements/USER_REQUIREMENTS.md TEACH-001/002
- 工程控制/FEATURE-01/GAP_AUDIT.md §1（G-TEACH-01..06、B-T-01..12）

## 改动范围（文件域，互斥）
- 允许改：`desktop/src/teacher/**`（含新建 pptx.ts、lecture.ts 等）、`desktop/src/ui/TeacherView.vue`、`desktop/src/ui/teacher/**`（新建组件）、`desktop/tests/unit/teacher-*.test.ts`（含新增）、`desktop/package.json`、`desktop/package-lock.json`（仅允许添加 `fflate` 依赖）
- 禁止改：其他一切文件，尤其 `src/app/store.ts`、`src/styles/app.css`、`src/ui/ScreenPane.vue`、`src/data/**`、`src/services/**`。组件样式一律用 `<style scoped>` + 主题变量（var(--ink)/var(--panel)/var(--accent) 等，参照既有组件），不得编辑 app.css。
- 依赖注入约定：真实供应商通过 `import { getAppProvider } from '../app/providerAccess'` 获取（前台已备好该文件，返回当前用户配置的 LLM provider，可能为 mock）。数据库实例通过 `import { getDb } from '../data/db'`（只读导入，不得修改该文件）。

## 步骤（P0 必须完成，P1 尽力，P2 有余力再做）
1. 【P0】修 B-T-01：TeacherView/teacherStore 默认注入 `getAppProvider()`，用户配了真实供应商就走真实供应商；保留 mock 回退（未配置时）。
2. 【P0】修 B-T-02/03/05/11：教师状态（资料、分块、题目、批改、错题、复习计划）默认落 SQLite（扩展 review.ts 的 DB store 或新建等价实现，表结构带 schema_version 断言同步到测试）；UI 加「开始复习」入口并调通 scheduleReview 闭环；导入失败重置 events；submit 加并发保护。
3. 【P0】PPTX 解析 `teacher/pptx.ts`：用 `fflate`（先 `npm install fflate`）解压 .pptx（zip）→ 解析 `ppt/presentation.xml`+rels 得页序 → 逐页解析 `ppt/slides/slideN.xml`：文本框（a:t 文本、pPr 层级、spPr 位置尺寸 EMU→px 换算）、图片（关系 ID→ppt/media/* 字节→blob URL）、备注（notesSlides）。.ppt（老二进制）明确报「不支持，请另存为 .pptx」。产出 `SlideDeck` 纯数据结构 + 单测（构造最小 pptx fixture，可用 fflate 在测试里现做 zip）。注入防护：所有解析出的文本按不可信数据处理，复用/对齐 study.ts detectInjection 思路。
4. 【P0】讲课编排 `teacher/lecture.ts`：状态机（选页/播放中/暂停/提问中）；逐页讲稿 = provider 流式生成（基于本页文本+前后页上下文+讲解风格指令），讲稿缓存；「提问」暂停讲解→基于资料回答→可继续；讲完一页可自动下一页（可开关）；全程事件（lecture.started/slide.explained/question.asked…，含 traceId）；暴露 `speak` 回调注入点（前台稍后接 TTS，本任务内默认仅文字字幕）。支持把 PPT 每页文本注册进资料库（引用锚点 = `幻灯片 第N页`）。
5. 【P0】讲课视图 `desktop/src/ui/teacher/LectureView.vue`：打开 .pptx（文件选择+拖放）→ 幻灯片主区（按比例缩放的 DOM 渲染：文本框绝对定位、图片、页码）+ 缩略图侧栏 + 工具栏：批注（canvas 覆盖层，画笔颜色/粗细/橡皮/撤销/清空，笔迹按页保存于内存）、放大镜（圆形透镜跟随指针、2x/3x/4x、可开关）、激光笔（红点+细尾迹模式）、页导航（上一页/下一页/跳页）、讲稿字幕区（流式显示+引用页码）+ 播放/暂停/提问框。整体必须兼容手绘/写实双主题（用主题变量）。
6. 【P0】修 B-T-04/06/07/08/10：quoteSpan 真实命中位置；difficulty 入参生效；generateQuiz 上下文设上限（对齐 MAX_CONTEXT_CHUNKS 思路）；bigram 归一化一致；取消信号修正（无外部 signal 时不构造孤儿 signal，保持可取消语义）。
7. 【P1】闭环补全：诊断（前测 3-5 题→各知识点掌握画像，落库）；提示（每题最多 3 级渐进提示，hint 按钮）；错因归类（gradeAnswer 输出 cause 枚举：概念不清/计算错误/审题偏差/表达不完整/未作答，复盘给分布）；变式（基于错题知识点生成 1-2 道变式）；学习复盘（统计必须来自真实 Attempt/Grading 记录，明确区分「观测事实」与「推测建议」，可导出 markdown）。
8. 【P1】修 B-T-09/12 + 清理死代码；B-T-12：unverified 主观题可手动「加入错题」。
9. 【P2】TeacherView.vue 重组为分区布局：资料库（文件导入 txt/md/pptx + 粘贴）/讲课/问答/小测/错题复习/诊断/复盘。引用锚点可点击定位（问答引用跳资料原文位置，PPT 引用跳对应页）。
10. 【P2】口语评分占位：无评测器时诚实显示「未评测」（仅 UI 占位，不伪造分数）。

## 验门（可机器复跑，全部 rc=0 才算完成）
- [ ] `npm --prefix desktop run typecheck`
- [ ] `npm --prefix desktop run test:unit`（全部通过，含新增 teacher-pptx/lecture/闭环测试）
- [ ] 新增测试至少覆盖：pptx 解析（文本框/图片/页序/备注/.ppt 拒绝）、讲课状态机（播放/暂停/提问/翻页/讲稿缓存）、批注数据结构按页存取、注入防护命中、复习闭环（答错入队→到期→复习→改期）、诊断→画像、错因分布、复盘数字与记录一致（T11 口径）
- [ ] `npm --prefix desktop run build:vite` rc=0

## 禁止
- 不得改文件域外任何文件；不得 git 任何操作；不得伪造「真实供应商验证」（无 key 时用 mock 验证接线并如实说明）；不得删除既有测试；不得弱化注入防护。
- 外部命令一律带 timeout 并把 stdout/stderr/rc 存到 `.vistaverge/evidence/FEATURE-01/teach-*.log`。

## 交回格式
实际执行的命令与 rc、新增/修改文件清单、验门日志路径、未完成项与原因、你发现的域外问题（只登记不修改）。
