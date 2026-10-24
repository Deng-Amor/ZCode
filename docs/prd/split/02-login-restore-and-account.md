# CCode PRD 拆项 2：登录态恢复与账户体验

- 来源：`E:\ZCode\docs\prd\ccode-product-prd.md`（母 PRD v1.0，待评审）§4.3「登录态恢复」、§5「非功能要求」、§7 验收场景 2
- 状态：待评审（拆分文档，不含代码改动）
- 事实基线：分支 `codex/ccode-update-feed` 工作区实读（2026-10-22），工作区含大量未提交改动，本文全部结论以当日实读为准
- 盘点标注约定：每条断言标注【已实测】（附文件路径与行号/符号名）、【推断】（说明依据）或【待实测】

# 一、背景与目标

CCode 桌面端存在两条相互独立的登录链路，本拆项必须同时覆盖：

1. **川升数据中台账号**（租户 + 用户名密码登录，承载总控专家授权），实现在 confidential-controller 模块；
2. **模型提供商 OAuth 登录**（ZAI / BigModel，承载模型对话与 Coding/Start Plan 套餐），实现在 oauth 模块。

母 PRD 对本拆项的锚定条目（引用原文，逐字对齐）：

- §4.3：「桌面端登录成功后，使用操作系统提供的安全存储保存刷新凭据及必要账号标识；不得保存明文密码或访问令牌。」「客户端启动时自动尝试恢复登录。」「网络暂时不可用、服务端暂时异常、限流或超时时，保留已保存凭据并显示“账号暂不可用，可重试”；不能直接清除登录态。」「明确拒绝、账号撤销、凭据损坏或来源不匹配时，清除失效凭据并进入登录页。」「账号切换或退出后，旧账号关联的本地会话与权限上下文必须隔离。」
- §5：「Windows、macOS、Linux 的产品身份、数据隔离和更新行为保持一致；平台安全存储不可用时不得退回明文保存。」「不记录密码、访问令牌、总控正文、企业敏感数据或私有接口响应到普通日志、会话导出或遥测中。」「所有远程交互应有明确超时、重试和可观察状态；用户能区分“等待中”“需要登录”“需要权限”“执行失败”和“已完成”。」
- §7 场景 2：「已登录用户关闭并重启 CCode，网络正常时自动恢复登录；网络暂时故障时保留凭据并提供重试。」
- §2 目标 3（关联）：「用户登录一次后，在安全存储可用的桌面环境中重启客户端可恢复登录，不反复要求输入账号密码。」

目标：把上述条目细化为可实施、可回读验收的工作项，明确两条链路各自的现状与差距，不改变母 PRD 口径。

# 二、范围（内/外）

**范围内**

- 中台账号登录凭据的安全存储、启动自动恢复、错误分类（暂时性故障 vs 明确失效）、注销与切换隔离。
- 模型提供商 OAuth 凭据的存储形态（是否达至「操作系统提供的安全存储」）、启动缓存恢复、JWT 过期/401 撤销分类、refresh token 现状。
- 登录相关 UI 状态与文案：登录失败态、恢复中（等待）态、「暂不可用/重试」态、过期重登提示。
- 退出登录的确认/重启交互及派生凭据（Coding/Start Plan key）清理。
- 凭据与令牌不落入日志、会话导出、遥测的核查。

**范围外**

- 母 PRD §6 明示排除项：任务续接失败、五分钟授权失败、`Confidential controller: EXECUTION_FAILED` 的根因修复。
- CCode 与 ZCode 的数据目录隔离与导入（拆项 1、拆项 4）；登录凭据文件落在哪个品牌根目录属拆项 1 结论，本拆项只引用。
- 更新通道与发布流程（拆项 3）；「更新后保留账户恢复凭据」的验收归拆项 3 场景，本拆项提供判据。
- 总控正文保密、发布与授权策略本体（`docs/specs/ccode-confidential-controller.md` 其余章节及拆项 5）。
- 中台服务端（`https://dp.sccsai.com/admin-api/`）侧的租户/令牌策略改动；ZAI/BigModel 服务端是否提供 refresh token 交换。
- Web 端与手机远控的凭据存储（Web 使用浏览器 localStorage：`E:\ZCode\packages\web\src\auth\webAuthService.ts` 的 `BrowserOAuthCredentialRepo`；手机远控复用桌面 Host 身份）。母 PRD §4.3 限定「桌面端」，Web/手机仅要求不被桌面改动破坏。

# 三、现状盘点

> 断言 1–9，每条附路径指针与实测状态。行号以 2026-10-22 工作区为准。

**1. 中台登录恢复已按母 PRD §4.3 实现：safeStorage 加密 + 仅存刷新令牌。**【已实测】
- `E:\ZCode\packages\desktop\src\main\index.ts` 667–692 行：`createControllerApplication` 注入 `createEncryptedPlatformSessionStore`，文件路径 `join(app.getPath("userData"), "ccode-account", "session.enc")`；加密能力为 Electron `safeStorage`，且 `process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"` 才视为可用（675 行）。
- `E:\ZCode\packages\services\src\confidential-controller\encrypted-login-store.ts` 9–72 行：`save` 前强制 `requireEncryption`，密文经临时文件（mode 0o600）原子替换；`load` 解密异常一律抛 `UNAVAILABLE` 不删除文件（41–44 行注释：「系统钥匙服务可能暂时拒绝解密，不能据此认定密文损坏并删除登录」）。
- `E:\ZCode\packages\services\src\confidential-controller\platform-auth.ts`：`#save`（125–136 行）只落盘 `{version, apiBaseUrl, tenantId, userId, refreshToken}`，不含 accessToken 与密码；`isStoredSession`（382–395 行）校验 `apiBaseUrl` 来源绑定；`restore`（57–112 行）仅当错误为 `AUTH_REQUIRED` 时清除凭据（96–101 行注释：「明确无效才删除；网络异常不能让下次启动失去可重试的刷新凭据」），401/403 与业务 code 401/403 映射为 `AUTH_REQUIRED`（`#request` 340–370 行），网络/超时/5xx 映射 `UNAVAILABLE`。
- 配套实施记录：`E:\ZCode\docs\superpowers\plans\2026-10-21-ccode-login-restore.md`（未跟踪文件）自述 139 项服务测试通过、Windows safeStorage 真实往返验证通过；同文件 25 行自述「真实账户跨重启登录仍需升级后首次登录验收」。此为计划书自述证据，真实账户验收【待实测】。

**2. 模型提供商 OAuth 凭据存于 `credentials.json`，AES-256-GCM 加密，但密钥不是操作系统安全存储。**【已实测】
- 路径：`E:\ZCode\packages\services\src\credential\credentialService.ts` 28–34 行，`getAppConfigDir() + "credentials.json"`；`E:\ZCode\packages\services\src\paths.ts` 46–58 行，`getAppConfigDir() = {dataBaseDir}/.zcode/v2`（品牌版 dataBaseDir 由启动入口设定，见拆项 1 与 `E:\ZCode\docs\specs\ccode-storage-isolation.md`）。
- 加密：`E:\ZCode\packages\services\src\credential\providers\credentialCipherProvider.ts`：AES-256-GCM（6 行）；密钥来自环境变量 `ZCODE_CREDENTIAL_SECRET` 或确定性回退值 `zcode-credential-fallback:{platform}:{homedir}:{username}`（24–38 行）——回退密钥可由本机公开信息推导，非 OS 钥匙串。
- `decrypt`（80–82 行）对不带 `enc:v1:` 前缀的存量值按明文直接返回（遗留兼容），即文件中历史上存在/仍可被读出的明文值不被拒绝。
- `credentialService.ts` 19–25 行注释自述「当前持久化格式仍是 JSON，但 value 会在写入前加密……后续可切换到 Electron safeStorage（钥匙串）托管密钥」。
- 结论：与母 PRD §4.3「使用操作系统提供的安全存储保存刷新凭据」及 §5「平台安全存储不可用时不得退回明文保存」存在差距，差距处置见「七、开放问题」1。

**3. OAuth 命名空间与落盘内容。**【已实测】
- `E:\ZCode\packages\services\src\oauth\repo\oauthCredentialRepo.ts` 13–16、24–34 行：键为 `oauth:active_provider`、`oauth:<provider>:access_token`、`oauth:<provider>:refresh_token`、`oauth:<provider>:user_info`、共享 `zcodejwttoken`；ZAI/BigModel access token 与 zcode JWT 均落盘（`saveTokenSet` 340–359 行），即访问令牌会持久化（加密后），仅密码不涉及（OAuth 无密码）。
- 解密失败分类清理：`clearCorruptOAuthSession`（451–466 行）在 AES-GCM 解密失败时清全部 OAuth 命名空间并回调 service 层清派生凭据；损坏 JSON 拒绝覆盖并备份（`credentialService.ts` `readAll` 62–73 行）。

**4. 桌面启动自动恢复流程（OAuth 链路）：本地缓存优先，不发起网络。**【已实测】
- `E:\ZCode\packages\ui\src\root\useRootOAuthEffects.ts` 142–216 行：启动后台调用 `services.oauthService.restoreCachedSessionState()`（150 行），恢复期间 `setIsRestoringOAuthSession(false)` 前侧边栏显示加载态。
- `E:\ZCode\packages\services\src\oauth\oauthService.ts` `restoreCachedSessionState`（188–300 行）：只读 `user_info` 缓存 + 本地 JWT `exp` 判定；任一凭据过期 → 队列内复核快照后清理并返回 `reauthentication-required`（`invalidateExpiredCachedSession` 302–346 行）；ZAI 缺 `zcodejwttoken` 按 `signed-out`（289–296 行）。无网络请求（216 行注释）。
- 网络校验版 `restoreSession()`（551–623 行，401/403 → logout，其他错误抛出且保留凭据）在生产代码无调用点，仅测试引用（`git grep` 仅命中 `packages/services/test/oauthService.test.ts`）。【已实测】
- 侧边栏恢复中状态：`E:\ZCode\packages\ui\src\WorkspaceSidebarFooter.tsx` 142–146 行 `showAuthRestoreLoading = !user && isRestoringOAuthSession`。

**5. 中台启动恢复的 UI 链路。**【已实测】
- `E:\ZCode\packages\services\src\confidential-controller\application.ts` 116–121 行：`account.getState()` 先 `await auth.restore()`（多窗口合并恢复），恢复完成前不返回已登录。
- `E:\ZCode\packages\ui\src\ccode-account\CcodeStartupLogin.tsx` 9–66 行：启动页在 `getState` 未决时显示「正在读取中台登录状态…」，读取失败（`unavailable`）显示「暂时无法读取登录状态，请稍后重新打开。」+「重新读取登录状态」重试按钮（36–49 行）；文案见 `E:\ZCode\packages\ui\src\i18n\locales\zh-CN.ts` 5–24 行。
- Renderer 仅经公开 IPC：`E:\ZCode\packages\desktop\src\main\desktopMainIpcPlatform.ts` 133–163 行只暴露 `getState/listTenants/logout/login`；状态变更仅广播 `CcodeAccountChanged` 通知失效（`index.ts` 694–705 行），不回传令牌。

**6. 错误分类现状（两条链路）。**【已实测】
- OAuth 轮询：`oauthService.ts` 762–785 行——HTTP 4xx（408/429 除外）为终态失败；网络错误/5xx/429 保留 flow 按服务端间隔重试；整个登录 flow 超时 `OAUTH_TIMEOUT_MS = 5 分钟`（41 行）。
- 运行期 401 撤销：`logoutIfCurrentCredentialRequest`（1046–1084 行）在会话变更队列内核对当前凭据后才清理（SG-01 迟到 401 保护）；规范见 `E:\ZCode\docs\oauth\jwt-401-auto-logout.md`、`jwt-invalid-restart-prompt.md`（确认后写一次性 marker 并 `RelaunchApp`）。
- 登录失败 UI 文案：统一「登录失败，请重试」，底层原因只进 logger（`E:\ZCode\docs\oauth-login-failure-copy.md`；`useRootOAuthEffects.ts` 312、404 行；`zh-CN.ts` 1250 行）。失败态三件套（Alert + 重新登录 + 取消）实现在 `E:\ZCode\packages\ui\src\WelcomeScreen.tsx` 292–295、398–440 行。
- 中台恢复错误分类见断言 1。**母 PRD §4.3 的「账号暂不可用，可重试」字样在全部 UI locale 中不存在**（`git grep "账号暂不可用"` 仅命中 `E:\ZCode\docs\specs\ccode-confidential-controller.md` 136 行对既有状态的描述）——文案口径差异列入开放问题 1。【已实测】

**7. 账号切换/退出的凭据隔离。**【已实测】
- OAuth provider 切换（ZAI↔BigModel 互斥域）：`oauthService.ts` `persistOAuthSession`（412–471 行）先清 inactive provider 命名空间再写新 token（451–456 行注释说明顺序原因），全程带快照回滚与 generation 校验。
- 退出：`logout/logoutAll`（1086–1125 行）在会话队列内清 active 会话并携带 `accountIdentity` 回调；派生清理 `E:\ZCode\packages\services\src\oauth\oauthProviderLogout.ts` 18–33 行按 `accountIdentity` 删除对应 Coding Plan API key（键构造 `E:\ZCode\packages\services\src\model-provider\accountProviderCredentialKey.ts` 35 行）。
- 桌面退出交互：`E:\ZCode\packages\ui\src\root\useRootWorkspaceActions.ts` 431–493 行——确认弹窗（区分运行中会话数量）→ `oauthService.logout()` → 清 provider family domain → `ClearCodingPlanWebviewStorage` → `RelaunchApp`；规范 `E:\ZCode\docs\desktop-logout-confirm-restart.md`（注意：该文件实际位于 `E:\ZCode\docs\` 根目录，任务卡所给 `docs\specs\` 路径下不存在，另两个指名 spec 同样实际在 `docs\` 根目录，已按实际路径实读）。
- 中台切换/注销：`platform-auth.ts` `login`（156–204 行）先把清除旧凭据排入同一写入队列再发登录请求；`clear()` abort 旧世代；`logout`（216–226 行）先清内存与磁盘再调远端注销。

**8. 本地会话/任务库未按账号维度隔离。**【已实测（代码事实）；处置待拍板】
- `E:\ZCode\packages\services\src\paths.ts` 190 行：任务索引 `tasks-index.sqlite` 直接位于 `getAppConfigDir()`，无账号分段；208 行：会话目录 `sessions/{getWorkspaceHash(workspacePath, workspaceIdentity)}` 按 workspace 哈希、不含账号维度。
- 代码中未见退出/切换时按账号清理或过滤会话列表的路径（退出只重启 App，见断言 7）。母 PRD §4.3「旧账号关联的本地会话与权限上下文必须隔离」对本地会话历史部分当前**未实现**；「权限上下文」（凭据、派生 key、Coding Plan webview storage）已实现隔离。需求取舍见开放问题 3。

**9. token 刷新与超时现状。**【已实测】
- 中台：`platform-auth.ts` `getAccessToken`（229–239 行）在 `expiresAt - now < 30s` 时刷新；`#refreshSession`（268–308 行）刷新走 POST 表单避免令牌入 URL（275 行注释）；刷新失败 `AUTH_REQUIRED` 才清除，网络错保留；所有请求 15 秒超时（`#request` 322 行 `AbortSignal.timeout(15_000)`）。
- OAuth 提供商：`refreshToken`（999–1043 行）仅限 active provider 且要求 adapter 提供 refresh 交换；ZAI/BigModel 当前 adapter 无 refresh 实现（`E:\ZCode\docs\oauth\jwt-expiry-reauthentication.md`：「Z.AI / BigModel 当前没有可用于续期 `zcodejwttoken` 的客户端 refresh 实现，所以已确认过期时必须重新登录」；`E:\ZCode\docs\oauth\jwt-401-auto-logout.md` 100 行同述）。轮询期间 BigModel polling 响应可带回 refresh_token 落盘（`oauthService.ts` 834–838 行），但无客户端续期路径。
- 超时可观察状态：启动恢复中（断言 4/5 的 loading）、登录等待/失败（WelcomeScreen 状态机）、中台 unavailable+重试（断言 5）均已具备，但各链路文案不统一（开放问题 1）。

# 四、需求细化

编号承接母 PRD §4.3/§5 条目；每项标注现状基线：〔已满足，需验收固化〕/〔有差距，需实施〕/〔待拍板〕。

**R1 凭据安全存储（§4.3 第 1 条；§5 第 1 条）**
- R1.1 中台链路：维持现状（session.enc + safeStorage + Linux basic_text 拒绝），补充验收证据固化。〔已满足，需验收固化〕
- R1.2 OAuth 链路：`credentials.json` 当前为「应用层 AES-GCM + 可推导回退密钥 + 明文直读兼容分支」（盘点断言 2），不满足「操作系统提供的安全存储；不得退回明文保存」。需按 `credentialService.ts` 23–24 行既注的方向设计迁移：host process 向 Main 请求 safeStorage encrypt/decrypt，密钥由 OS 托管；同时定义独立 CLI 场景（无 Main 进程）的降级策略与明文直读分支的淘汰计划。〔有差距，需实施〕
- R1.3 落盘最小化：中台仅存 refreshToken（已满足）；OAuth 链路 access token / zcode JWT 落盘为现行设计，是否收紧属协议约束（服务端 token 生命周期短），本拆项不擅自改口径，列入开放问题 5 关联评估。〔待拍板〕

**R2 启动自动恢复（§4.3 第 2 条）**
- 两条链路均已实现（盘点断言 4、5）。需补：真实账户端到端验收（断言 1 所引计划书自述未完成）、断网/慢网下「恢复中→可重试」的交互时序回归。〔已满足，需验收固化〕

**R3 暂时性故障保留凭据并提示可重试（§4.3 第 3 条；§7 场景 2）**
- 服务层两条链路均已按「网络类错误不清凭据」实现（断言 1、6）。差距：用户可见状态未统一为母 PRD 文案「账号暂不可用，可重试」——中台启动页为「暂时无法读取登录状态…」，OAuth 侧为「登录失败，请重试」/恢复中 loading。需对齐展示口径（或经评审修订母 PRD 措辞，见开放问题 1），并明确该状态在哪些链路（启动恢复、登录中、运行期 401 核验失败）出现。〔有差距，需实施〕

**R4 明确拒绝/撤销/损坏/来源不匹配清理（§4.3 第 4 条）**
- 中台：`AUTH_REQUIRED`（HTTP/业务 code 401/403、身份不匹配、成功解密后结构非法）清密文进登录页；来源绑定经 `apiBaseUrl` 校验。〔已满足，需验收固化〕
- OAuth：JWT exp 本地过期、明确 401/403、解密损坏三类均清理并进登录页/过期提示（断言 3、4、6）。〔已满足，需验收固化〕

**R5 账号切换/退出隔离（§4.3 第 5 条）**
- 凭据与权限上下文（OAuth 命名空间、派生 Coding Plan key、webview storage、中台世代）已隔离（断言 7）。〔已满足，需验收固化〕
- 旧账号本地会话（聊天历史、任务索引）无账号维度（断言 8）：需产品拍板「隔离」定义（不清理但新账号不可见旧账号会话？分库？还是仅权限隔离即达标），再排实施。〔待拍板〕

**R6 日志与导出不落敏感信息（§5 第 2 条）**
- 中台错误仅返回固定诊断码（`ConfidentialControllerError` code），登录表单 catch 后只显示统一文案（`CcodeAccountEntry.tsx` 138–141 行）；OAuth 失败原因仅进 logger（断言 6）。需按 §5 做一次全链路核查（含 service logger 级别）作为回归项。〔已满足，需验收固化〕

**R7 超时/重试/可观察状态（§5 第 4 条）**
- 超时：中台 15s、OAuth flow 5min、刷新写回带 generation 防护（断言 9）。重试：轮询按服务端间隔、中台启动页手动重试。差距与 R3 合并处理：统一「等待中/需要登录/失败/完成」的可见状态口径。〔有差距（仅展示口径），需实施〕

# 五、验收场景

> 每条为可回读的客观判据，不含「完成/成功」类空话。执行前提为拆项 1 已定品牌数据根；路径中 `%APPDATA%\<CCode userData>` 指桌面 `app.getPath("userData")` 实际值。

1. **断网重启保留凭据可重试**：中台已登录后断网，关闭并重启 CCode——`<userData>\ccode-account\session.enc` 文件仍存在（不被删除）；启动页出现 unavailable 提示与「重新读取登录状态」按钮（`CcodeStartupLogin.tsx` unavailable 分支）；恢复网络点击重试后 `getState` 返回 `authenticated: true`。对照判据：全程不出现登录表单被强制清空的磁盘删除动作（session.enc mtime 不变）。
2. **明确拒绝清理**：构造中台 refresh-token 返回 401（或业务 code 401）——`session.enc` 被删除、启动页进入登录表单；对照构造返回 5xx/网络错误——`session.enc` 保留且提示可重试。判据可回读：文件存在性 + `platform-auth.ts` restore 分支日志（仅固定错误码）。
3. **加密不可用不落明文**：stub `safeStorage.isEncryptionAvailable()` 为 false（或 Linux 下 backend 为 `basic_text`）执行登录——`save` 抛 `UNAVAILABLE`，`<userData>\ccode-account\session.enc` 与临时文件均不出现；若文件已存在，其内容不是可直接 `JSON.parse` 出 `refreshToken` 的明文。
4. **落盘内容最小化**：中台正常登录后取 `session.enc` 解密产物——JSON 键集合恰为 `{version, apiBaseUrl, tenantId, userId, refreshToken}`，无 `accessToken`、无密码字段（对照 `platform-auth.ts` `#save`）。
5. **OAuth 凭据文件无明文令牌**：ZAI/BigModel 登录后读取 `{dataBaseDir}\.zcode\v2\credentials.json`——`oauth:*:access_token`、`oauth:*:refresh_token`、`zcodejwttoken` 的值均以 `enc:v1:` 开头；全文件不出现 `eyJ`（裸 JWT）形式的明文令牌。
6. **退出/切换清理派生凭据**：桌面确认退出（`useRootWorkspaceActions.handleLogout` 路径）后，在 `RelaunchApp` 生效前读取 `credentials.json`——`oauth:*` 键与 `account-provider:*:account:<accountIdentity>:api-key` 键已删除；OAuth ZAI↔BigModel 切换后，`oauth:active_provider` 只指向新 provider 且旧 provider 命名空间键不存在。

# 六、依赖与里程碑

**依赖**
- 拆项 1（品牌与数据目录隔离）：`dataBaseDir`/`userData` 品牌根确定后，本拆项的凭据文件路径与验收路径才固定；`ccode-storage-isolation.md` 的库迁移不得破坏 `credentials.json` 与 `session.enc`。
- `E:\ZCode\docs\specs\ccode-confidential-controller.md`「跨重启恢复中台登录」（130–158 行）：中台链路的权威 spec，本拆项不重复定义，仅消费。
- 拆项 3（自有更新）：「更新后保留账户恢复凭据」场景由拆项 3 验收，本拆项提供判据 1/4 作为其前置。
- 既有 spec 集：`E:\ZCode\docs\oauth\`（jwt-401-auto-logout / jwt-expiry-reauthentication / jwt-invalid-restart-prompt / desktop-oauth-polling / oauth-multi-provider-final-plan / app-marketing-attribution / oauth-multi-provider-implementation）、`E:\ZCode\docs\oauth-login-failure-copy.md`、`E:\ZCode\docs\zai-oauth-environment-origin.md`、`E:\ZCode\docs\desktop-logout-confirm-restart.md`（后三者在 `docs\specs\` 下不存在，实际位于 `docs\` 根目录，已实读）。

**里程碑（顺序执行，M2 可与 M3 并行）**
- M1 口径对齐：关闭开放问题 1、3、4（文案口径、会话隔离定义、验收链路归属），产出拍板记录。
- M2 中台链路验收固化：补真实账户「登录→退出应用→重启恢复」与「恢复失败→重试」验收（补齐计划书自述缺口），固化判据 1–4 为回归用例。
- M3 OAuth 凭据安全存储迁移：按 R1.2 出设计（Main 注入 safeStorage、CLI 降级策略、明文直读分支淘汰），实施后以判据 5、6 回归。
- M4 状态与文案统一：R3/R7 展示口径实施与 i18n 双语补齐。
- M5 E2E 与回归收口：验收场景 1–6 全量回读执行，交总控验收。

# 七、开放问题

1. **「账号暂不可用，可重试」文案口径**：母 PRD §4.3 与 `ccode-confidential-controller.md` 136 行均使用该措辞，但现有 UI locale 中不存在此文案（中台为「暂时无法读取登录状态，请稍后重新打开。」，OAuth 为「登录失败，请重试」）。需拍板：新增统一状态文案并覆盖哪些链路，还是修订母 PRD 措辞以对齐现状。锚定校验结论：母 PRD 原文与仓库文案不一致，未自行改口径。
2. **OAuth 凭据加密密钥差距的定性**：`credentials.json` 的回退密钥可由 `platform/homedir/username` 推导（盘点断言 2），是否构成对 §5「不得退回明文保存」的违反（定性为「弱加密」还是「事实明文」），决定 R1.2 的优先级；同时需与独立 CLI（无 Main 进程、与桌面共享该文件与文件锁，见 `credentialService.ts` 144–152 行注释）的兼容一起设计。
3. **旧账号本地会话隔离的定义**：会话/任务库无账号维度（盘点断言 8）。「隔离」若解释为分库/不可见，涉及 `tasks-index.sqlite` 与 `sessions/` 结构改动，波及拆项 1/4 与会话管理技能约束；若解释为仅权限上下文隔离，现状即达标。需母 PRD 作者拍板。
4. **验收场景 2 的链路归属**：母 PRD 场景 2 未区分中台账号与模型提供商 OAuth；两条链路实现与风险不同（中台有真刷新恢复，OAuth 受 zcodejwttoken 无续期约束）。建议双链路分别验收（本拆项判据已覆盖），需总控确认。
5. **「不反复要求输入账号密码」的服务端依赖**：`zcodejwttoken` 与提供商 access token 无客户端续期（盘点断言 9），过期即重登属现行协议事实；§2 目标 3 在 OAuth 链路的完全达成依赖服务端提供 refresh 交换，超出本拆项与客户端仓库范围，需单列服务端需求或调整目标解释。
6. **Linux 平台 OAuth 链路等价策略**：中台链路已拒绝 `basic_text`（盘点断言 1），`credentials.json` 链路在 Linux 无对应「安全存储不可用」判定（其加密不依赖 OS）；R1.2 迁移时需一并定义。
