# 总控技能保护 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. 用户已指定由子代理承担技术审核；连续推进，不重复索取人工方案批准。

**Goal:** 正式总控技能只能通过外部受信发布更新，客户端模型不能修改或替代正式版本。

**Architecture:** 数据中台是目标发行所有者。签名包格式独立于传输，客户端只持公钥并拒绝非授权内容；受限执行身份与独立 updater 负责实际不可写边界。先完成可验证的签名发行及消费，再接权限隔离，阶段完成不等于目标完成。

**Tech Stack:** TypeScript、Node crypto/fs、现有 Zod、Vitest、现有架构检查；不新增依赖。

**Spec:** docs/specs/managed-controller-skills.md

## Global Constraints

- 保留无关用户改动，在当前 checkout 实施；不同代理限制到各自文件，不覆盖品牌修改。
- 不修改真实总控、系统 ACL、账户或上线服务；隔离实验仅使用 fixture。
- 新模块注册 architecture-policy.yaml，调用方使用公开入口。
- 签名通过不是 OS 不可写证明；未完成隔离和正式部署不得关闭目标。
- 普通技能保持兼容；受管失败禁止 fallback。

## Review Focus

- 恶意发行路径、Windows 大小写/保留名、链接不能逃逸或覆盖。
- 错误签名、伪公钥、身份不符、旧版本、超限内容必须拒绝。
- 普通同名技能和 extraRoots 不能抢占受管身份。
- 验证和读取之间不能重新读取未经验证字节。
- 进程子树与高权限 RPC 不能绕过正式部署目录保护。

## Task 1: 签名发行契约与验证

- [x] 建立 packages/shared/src/managed-skills 受控模块和公开入口 `@zcode/shared/managed-skills`。
- [x] 定义严格 envelope/payload/file schema，使用 Ed25519 签原始 payload 字节，调用方提供可信身份与公钥。
- [x] 实现并验证正确签名、篡改、错误 key、路径穿越、大小写冲突、文件数量/大小上限、最低版本、身份错配、必需 SKILL.md。
- [x] 运行模块定向 Vitest，交由独立子代理审查。54 项通过，修复 UTF-16 路径碰撞和身份字段问题后复审通过。

## Task 2: 独立发布工具

- [x] scripts/publish-managed-skill.mts 从明确 source 读取普通文件，拒绝 symlink，输出签名包；私钥只从明确文件参数读取，不生成或记录真实私钥。
- [x] packages/shared/test/publishManagedSkill.test.ts 验证隔离目录签发、真实 CLI、拒绝覆盖输出、链接、私钥泄漏、失败清理、坏元数据及合法包跨边界验证。12 项通过，独立复审通过。
- [x] 发布工具不作为客户端模型工具注册；记录离线发行用法和未部署状态。

## Task 3: CLI 与 Host 集成

- [x] CLI NodeSkillAdapter 提供可信注入策略接口，普通根保留名称不参与选择；验证后直接使用已验证字节。34 项通过、1 项原有跳过；namespace 绕过修复后独立复审通过。正式 bootstrap 接线仍待完成。
- [ ] Bootstrap 注入部署可信策略；Host 技能发现、删除、复制、禁用、远端同步应用相同身份规则。
- [ ] 正式配置来源与安装目录必须有可信部署边界；缺失策略不宣称保护启用。
- [ ] 定向测试普通技能兼容、同名覆盖、损坏包、缺失包、缓存/版本切换及子代理继承。

## Task 4: 权限隔离和正式发布接入

- [ ] 实现 Windows 独立 updater 与受限模型执行边界，覆盖 shell/REPL/MCP/子进程及 Host 写入 RPC。
- [ ] 在隔离 fixture 验证实际身份、写/删/改 ACL/父目录 rename/junction 逃逸。
- [ ] 接数据中台发布态只读 API 与发行权限；正式信任锚与初始发行部署单独记录，不由测试 key 替代。
- [ ] 完成完整跨平台支持声明、迁移与失败回退；不支持的平台明确不能启用完整保护。

## Task 5: 交付验证

- [ ] 三轮功能、绕过与会话运行时验证，独立子代理审查并修复问题。
- [ ] 根 pnpm typecheck、pnpm lint、pnpm architecture:check --changed，以及受影响 CLI 自身检查。
- [ ] 核对每项最终要求证据，更新交接；目标只有在完整隔离及可信发布真正启用后才可完成。
