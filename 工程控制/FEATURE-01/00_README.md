# FEATURE-01 控制包 —— 规划全功能收口 + 前端打磨 + beta.2 发布

## 目的与方向

负责人 2026-09-19 指示（原文要点）：检查规划.txt 全部功能实现了没；教师 PPT 讲课（打开 PPT、讲课、批注、放大镜）必须做好；女友陪伴（打断、口癖学习、知识库）必须完成；未完成的功能全部完成，已完成的继续补充有用功能并优化；全面查 bug 修复；打磨前端动效与手绘风、解决界面空旷；确认无误推送到 GitHub 并发布新产物。

## 范围

- 输入：`GAP_AUDIT.md`（4 路并行只读审计汇总，基线门全绿）。
- 执行：`TASK_LIST.md` 九个任务，文件域互斥见各任务文件。
- 不做（保持 BLOCKED，见 GAP_AUDIT §6）：真 MC 服务器、真 Computer Use 后端、社媒实际发送、真 viseme、PDF/OCR、可执行插件沙箱、多图生成人物。

## 审批

负责人在同一会话中明确「没有完成的功能就全部完成……最后确认无误推送到 github，发布新产物」，且既有记忆（连续交付要求）授权连续推进不逐包请示 → 本包制作完成即获准执行。Git 提交与推送沿用既有授权边界：仅本仓库 main，不公开发布敏感工作区（仓库本身为私有，产物发布到该私有仓库 Releases）。

## 入口

- 任务：`tasks/F1-TEACH.md`、`F1-COMP.md`、`F1-CORE.md`、`F1-PERCEPT.md`、`F1-UI.md`、`F1-REL.md`、`F1-ASSIST.md`、`F1-VERIFY.md`、`F1-SHIP.md`
- 验收：`ACCEPTANCE.md`；汇总：`SUMMARY.md`
- 证据：`.vistaverge/evidence/FEATURE-01/`
