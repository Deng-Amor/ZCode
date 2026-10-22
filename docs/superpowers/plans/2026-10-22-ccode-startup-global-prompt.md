# CCode 启动全局提示词实施计划

**Goal:** 完成一次启动分发、标准全局提示词、提交及 Windows 打包。
**Spec:** docs/specs/ccode-startup-global-prompt.md
**Architecture:** application 单次装配 → 专用启动 IPC → CLI 配置 → ContextBuilder。默认模型调用不再接 execution scope。
**Tech Stack:** TypeScript、Electron、Node IPC、Vitest、pnpm。

## 约束与评审重点

保留已有工作区改动；不推送/部署；正文不落盘；不改变任务路由 lease。重点检查并发初始化、迟到身份、五分钟后执行、工作流 persona、诊断泄漏。独立子 Agent 评审代替流程性用户审批。

## 工作项

- [x] 服务：先添加超过授权到期后仍能返回启动配置、并发单次下载、身份失效的回归测试；将 application 改为单次校验装配；新增 bootstrap 消息并沿 private relay 转发。运行服务定向 Vitest。
- [x] Runtime：先添加全局段与 persona/workflowActor 共存及子代理继承测试；增加 globalSystemPrompt 配置和 ContextBuilder 段，覆盖请求转录保护。运行受影响 CLI 测试。
- [x] CLI 启动：新增一次配置读取 adapter；main → RunDependencies → bootstrap 传入 globalSystemPrompt，不再创建 execution scope。测试完成/断连/非法消息/超时。
- [x] 更新现有规范和发行说明，独立审查后执行 pnpm typecheck、pnpm lint、CLI typecheck/lint 和 architecture:check --changed。
- [ ] 仅暂存本任务及其必要已有依赖，中文 Conventional Commit 分段正文；核验 git log -1 --format=full。生成下一预览版本安装包并核验文件及摘要；不自动发布。
