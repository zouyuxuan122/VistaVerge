# 任务: F1-SHIP 统一提交推送 + beta.2 发布（前台）

## 目标
全部任务 PASS 后：统一提交、推送 main、构建并发布 0.1.0-beta.2（含签名安装包与 latest.json）。

## 权威依据
- ENGINEERING_SPEC.md §6（提交规范）；AGENTS.md（前台唯一提交者）
- HANDOFF.md §3（Git 授权边界：用户本轮已明确授权推送源码与发布产物）

## 步骤
1. `git status` + 逐区 diff 审阅（确认无越界改动、无密钥/模型/私钥入库：keys/、live2d、assets mp4 必须在 .gitignore）。
2. 分主题提交（feat: 教师 PPT 讲课与闭环 / feat: 陪伴能力（角色卡·口癖·知识库·工具循环·选择性回应） / feat: 感知与 MC 互动 / feat: 自动更新与定制安装页 / feat: GitHub 巡检与社媒草稿 / feat: 前端打磨 / fix: FEATURE-01 登记缺陷 / docs: FEATURE-01 控制包与文档同步）。
3. 推送 origin main，核对三 SHA 一致（HEAD = main = origin/main）。
4. `npm run build:beta`（剔除 Live2D 模型 → 断言 → 出包 → 移回）；updater 签名出 .sig；生成 latest.json。
5. GitHub Release：v0.1.0-beta.2 预发布，上传安装包 + sig + latest.json + 校验和；release notes 写本轮功能与已知 BLOCKED。
6. SUMMARY.md 收口：差距闭合清单、每任务状态、遗留项（真 MC 服务器/真 CU 后端/真 viseme 等仍 BLOCKED）。

## 禁止
- 密钥/模型/私钥入库；force push；跳过三 SHA 核对；未 PASS 先发布。
