# Ccode 官网实施计划

> **For agentic workers:** 使用 superpowers:executing-plans，由主 Agent 实现、独立子 Agent 审查。用户 AGENTS.md 优先：不为流程确认打断，不提交或推送。

**Goal:** 交付电脑和手机可用的 Ccode 展示下载静态官网。
**Architecture:** `sites/ccode` 是独立 Astro 项目，不属于运行时 workspace；保留 AstroWind 派生区块及 MIT 许可。构建只读取发布脚本生成的下载清单。
**Tech Stack:** Astro、TypeScript、CSS token、Node test runner、Playwright E2E。
**Spec:** `docs/specs/ccode-website.md`

## Global Constraints

- 中文官网，品牌 Ccode；Windows 安装包产品名 CCode，开发方川升AI。
- 只提供已存在的 Windows x64 安装包；不虚构下载、用户评价或性能数据。
- 不改用户已有文件，不把安装包、生成清单、node_modules、dist 提交。
- 没有公网下载配置时仅交付本地完整链路，不擅自发布。
- 手机和电脑一套响应式页面，320px 无横向溢出。

## Review Focus

- 无安装包时不能出现有效下载链接；构建必须识别已生成清单但文件被删除/替换。
- 文件名不得包含目录穿越；准备安装包必须校验 EXE 头与目标命名。
- 手机浏览不能暗示可安装桌面 EXE；剪贴板失败提供可选中文本链接。
- localStorage 不可用时页面正常；减少动态效果偏好必须被尊重。
- 所有演示数据明确标识，所有按钮可用，键盘可操作，清单不可包含本地源路径。

## Task 1：安装包分发边界

Files: `sites/ccode/scripts/releases.mjs`, `sites/ccode/scripts/prepare-release.mjs`, `sites/ccode/test/releases.test.mjs`。

- [x] 写测试并观察缺失实现失败：无清单返回 null；合法 EXE 生成文件/hash/清单；错误文件名、无效 EXE 拒绝；替换/删除暂存文件时拒绝。
- [x] 实现异步 `prepareRelease(source, publicDir)` 与 `readRelease(publicDir)`；后者用于 Astro 配置启动/构建前校验。
- [x] 准备本地真实安装包，执行定向单测；清单字段仅包含公开下载元数据。

## Task 2：响应式展示官网

Files: `sites/ccode/src/pages/index.astro`, `src/layouts/Layout.astro`, `src/components/*`, `src/styles/global.css`, `src/scripts/site.ts`，配置/许可证/README。

- [x] 写 Playwright 场景：320/390/768/1440 宽度、导航、主题、演示场景、FAQ、复制和下载。
- [x] 首次 E2E 受缺失 Chromium 阻塞，未获得页面实现前的红灯证据；改用本机 Edge 后执行通过。后续演示产物问题有单独 RED→GREEN 证据。
- [x] 移植 AstroWind Headline/WidgetWrapper 区块骨架并保留来源，建立 token 和按钮/导航，再实现整页。
- [x] 加入本地品牌资源，示意工作台标识“界面示意 · 非运行结果”，不包含真实用户数据。
- [x] 执行 Astro check、build、E2E，查看桌面与手机截图并修正发现问题。

## Task 3：审查与交付

- [x] 独立子 Agent 审查实现和验收证据；无阻断问题；修正演示产物名称不随场景切换的问题。
- [x] 执行根目录 typecheck、lint、architecture:check --changed，单独记录既有问题。
- [x] README 记录安装包更新、构建部署、重启命令和公网配置限制。
- [x] 测试服务自动退出，4321 无监听；交付源码、截图与验证结果。

## 验证记录

- 最终 Node 使用仓库固定的 24.14.0。
- 安装包单测 5/5；Edge E2E 7/7，包含完整 EXE 下载与 SHA-256 比对、存储拒绝、禁用 JavaScript 和 reduced-motion。
- Astro check：0 errors / 0 warnings / 0 hints；静态构建通过。
- 根 typecheck 通过；根 lint 0 errors / 96 既有 warnings；官网脚本定向 lint 0 errors / 0 warnings。
- 根架构检查 0 violations；独立 `sites/ccode` 不在运行时 managed-module 覆盖内，不能以该检查声称站点内部边界已被自动验证。
- 未执行真实手机设备测试，未验证生产托管；没有公开部署、提交或推送。
