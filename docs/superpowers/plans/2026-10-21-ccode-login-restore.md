# CCode 登录恢复实施计划

**Goal:** 重启和原地更新后安全恢复中台登录。
**Architecture:** 服务拥有登录世代与串行持久化；Main 注入系统加密；UI 使用现有异步 getState。
**Tech Stack:** TypeScript、Electron safeStorage、Node 异步文件 IO、Vitest。
**Spec:** docs/specs/ccode-confidential-controller.md「跨重启恢复中台登录」。

## 约束和评审重点

不保存密码、访问令牌、总控正文；不修改会话数据库。登录来源绑定、凭据轮换、网络异常保留、注销竞态与系统加密不可用均需测试。保留已有未提交改动；本次不自动提交。

## 实施

- [x] 为服务恢复、轮换、注销、来源隔离与竞态编写失败测试。
- [x] 在 confidential-controller/contract.ts 定义私有存储端口，在 platform-auth.ts 实现恢复和写入顺序，application.ts 让 getState 等待恢复。
- [x] 新增同模块 encrypted-login-store.ts 与文件加密测试；Main 的 index.ts 注入 safeStorage，拒绝 basic_text。
- [x] 通过公开账号接口验证登录→退出应用→恢复，以及恢复失败→重试的启动交互链路。
- [x] 独立评审并执行目标测试、pnpm typecheck、pnpm lint、架构检查。按实际授权与验证结果交付，不宣称真实账户验收已完成。

## 验证记录

- 5 个服务测试文件共 139 项通过；类型检查通过；Lint 100 条警告、0 错误；架构检查 0 违规。
- Windows Electron safeStorage 真实系统加密往返验证通过，测试进程已退出。
- 独立评审发现的异常身份与解密失败误清理问题已修复并复核通过。
- 真实账户跨重启登录仍需升级后首次登录验收；安装包已生成并原地安装成功（退出码 0），exe/app.asar/glm zcode.cjs 的 SHA-256 与构建一致，已重新启动用户应用；本次不自动提交。
