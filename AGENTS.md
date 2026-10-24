## 核心原则

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## CCode 总控 Skill 来源

（2026-10-22 拍板修订：按「总控本地锁定 skill + 中台签名推送更新；专家 skill 中台按需下发；回流上传与审计遥测」三层架构表述，取代原「仅内存消费 + 启动全局提示词注入」口径；规格以 `docs/specs/ccode-controller-local-skill.md` 为准。2026-10-23 批次3b 客户端侧核心链路已按其迁移清单落地闭环——锁定存储/更新器、Main 所有权、skill-port 命中加载、按需通道、旧全局注入链退役；真实运行验收与中台侧联调未完成，不得宣称整体交付。）

- 核心总控 Skill 的唯一来源是数据中台知识库的「总控skills」文件夹；以中台审核发布的固定版本为准。中台侧需求见 `docs/prd/ccode-dataplatform-prd.md`。
- 总控通用派发部分为本地内置锁定 skill：首次成功登录后从中台获取并经 Ed25519 验签落地为本地加密锁定副本（加密定位为防君子门槛，不是保密措施）；更新走中台签名推送，验签后原子落地、可回滚；用户不可改锁定原件，只可开分支迭代；触发为 stub 常驻 + 完整 skill 命中加载，不采用启动全局提示词整段注入。详见 `docs/specs/ccode-controller-local-skill.md`（取代 `docs/specs/ccode-startup-global-prompt.md`）。
- 领域专家 skill 唯一存于数据中台、按需下发：命中领域才加载、未命中零请求；下发内容经验签后本地缓存，用户只读不可改。详见 `docs/specs/ccode-expert-skills-distribution.md`。
- skill 回流上传与审计遥测分别见 `docs/specs/ccode-skill-sync-upload.md`、`docs/specs/ccode-audit-telemetry.md`。
- 用户已授权独立备用服务方案：仅允许按 `docs/specs/ccode-emergency-authorization.md` 保存中台签名的加密备用包及必要非敏感元数据；明文正文和长期明文解密密钥不落盘。第一阶段仅已有授权且绑定版本的运行续跑，明确拒绝/撤销/验签失败不得转备用；设计或代码存在不代表备用服务已启用或真实验收。
- 总控锁定正文不进入普通日志、遥测、会话存储、导出、分享与压缩摘要；输出保护、恢复规则与旧路线取代关系详见 `docs/specs/ccode-confidential-controller.md`（2026-10-22 起为部分取代状态，取代关系与保留清单见其文末）。未完成真实运行验收不得宣称整体交付。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行：

| 用途             | 命令                                                 |
| ---------------- | ---------------------------------------------------- |
| 类型检查         | `pnpm typecheck`                                     |
| Lint             | `pnpm lint` / `pnpm lint:fix`                        |
| 格式检查         | `pnpm fmt:check`                                     |
| 桌面开发         | `pnpm dev:desktop`                                   |
| Web 开发         | `pnpm dev:web`                                       |
| 提交前检查       | `pnpm verify:pre-push`（Lint、架构检查与受影响单测） |
| 架构检查         | `pnpm architecture:check --changed`                  |
| 模块阅读包       | `pnpm architecture:context <module-id>`              |
| 未使用依赖与导出 | `pnpm knip`                                          |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`                |

affected 使用 Vitest 官方选择，只运行选中的根 UT；选中整个套件时说明并跳过 UT，成功退出，不因此阻止 Push；不替代 CLI 测试或桌面 E2E。全量使用 `pnpm test` / `pnpm test:unit`，仅在用户明确要求时调用。范围与输出合同见 [pre-push 说明](docs/testing/pre-push-hook.md)。

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

- `packages/desktop`：Electron main、host、renderer。
- `packages/web`、`packages/server`：Web 客户端与服务端。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `apps/zcode-cli`：Agent CLI 与运行时。
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 有行为改动时先补充对应测试；交互改动需要 E2E 场景。检查测试与实现是否一致，并实际执行可用的验证。未执行或环境受限时如实说明。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- PR 描述须说明背景、设计意图与修改前后行为；包含 bugfix 时逐项说明触发场景、根因证据、修复机制及回归验证，并尽量关联已有工单链接。未确认的根因或引入提交如实标注，不根据模块或时间接近推断归因。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows、macOS 和 Linux。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`，提供严格类型与运行时校验。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。
- Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存任务队列、快照等业务状态。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。

## CCode Windows Preview 发布与热更新

- CCode Preview Windows x64 的更新清单地址为：`https://ccode.sccsai.com/updates/preview/windows-x64/latest.yml`。
- 发布链路不在本仓库内完成：安装包先上传到阿里云 OSS 私有桶 `cs-platform-service` 的 `ccode/releases/<版本>/` 前缀；随后更新独立网站仓库 `E:\\ccode-website` 的 `deploy/release.json`，由该仓库的 `master` 分支 CI 部署到 `https://ccode.sccsai.com`。
- 网站仓库的标准发布命令为：`npm run prepare:release -- --remote`，然后 `npm run build`；确认生成结果后提交并执行 `git push origin master`，等待 GitHub Actions 成功。
- 上传包时必须使用新的版本目录和严格命名的包文件，例如 `ccode/releases/0.0.8/CCode-0.0.8-win-x64.exe`；安装包上传成功后才更新 `release.json`，禁止原地覆盖历史版本。OSS 对象应保留私有 ACL、原始文件名的 `Content-Disposition`、`x-oss-meta-sha256` 和禁止覆盖设置。
- 旧的可复用上传入口是本机仓库外脚本 `C:\\Users\\Administrator\\.codex\\ccode-oss-upload-v005.py`。该脚本会从 `E:\\github\\cs-platform-service\\.env.dev` 读取数据库连接信息，再从 `infra_file_config` 的 `id=25` 读取 OSS 配置；后续发布应复制为对应版本脚本或改为参数化脚本，不要把其中的凭据、数据库密码、AccessKey 或 AccessSecret 写入 Git、AGENTS.md、日志或提交。
- 上传后必须核验：OSS 对象大小与本地安装包一致、`x-oss-meta-sha256` 一致、对象 ACL 为 `private/default`；再回读 `https://ccode.sccsai.com/updates/preview/windows-x64/latest.yml`，确认版本、文件大小和 SHA-512；同时对下载 URL 执行 HEAD 检查。
- 已安装 `0.0.7` 的客户端不会因远端重新发布同版本而热更新，热更新必须提升产品版本到 `0.0.8` 或更高，并同步生成安装包、`.blockmap` 和 `latest.yml`。
- 发布状态以远端 `latest.yml` 和下载包的实际回读结果为准；没有上传成功和线上回读证据时，不得宣称已发布。
