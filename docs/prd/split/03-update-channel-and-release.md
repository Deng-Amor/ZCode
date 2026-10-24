# CCode PRD 拆项3：自有更新通道与发布流程

- 任务卡：20261022-03R（总控台账第 21 行，E:\ZCode\docs\prd\总控台账.md）
- 母 PRD：E:\ZCode\docs\prd\ccode-product-prd.md（v1.0，待评审），本卡承接 §8「后续拆分」第 3 项
- 对应母 PRD 条目：§2 目标 2、§4.4 自有在线更新、§5 非功能要求（三平台一致）、§7 验收场景 3
- 盘点基线：仓库分支 `codex/ccode-update-feed` 当前工作区（分支名即本主题，大量未提交改动，涉及处标注「分支在途」），盘点时间 2026-10-22，全部以工作区实读为准

## 一、背景与目标

母 PRD §2 目标 2 原文：

> 客户端能从 CCode 自有更新服务发现、下载并安装新版本；更新失败不影响现有版本继续使用。

母 PRD §4.4「自有在线更新」原文五条：

> - CCode 使用独立的发布清单、下载域名、安装包名称、更新通道与版本号，不复用 ZCode 的更新地址或产品配置。
> - 客户端启动后按策略检查更新；发现新版本时显示版本、摘要、下载/安装状态和失败原因。
> - 更新包需校验版本、来源和完整性；下载或安装失败必须保留当前可运行版本。
> - 预览版与正式版必须使用明确不同的更新通道。用户安装预览版时，不能误以为自己在订阅正式版更新。
> - 更新完成后保留会话、账户恢复凭据、项目索引和用户设置。

本拆项把上述需求拆成两条主线：

1. **客户端更新链路主线**：更新器（electron-updater + 自定义 ManifestUpdateProvider）指向 CCode 自有更新域名，按安装身份固定 preview/stable 通道，完成检查、展示、下载、校验、安装与失败恢复，且失败时保留当前可运行版本、成功后保留用户数据。
2. **发布流程主线**：从 `pnpm bundle:ccode-preview` 构建产物（安装包 / blockmap / latest.yml）到 `https://ccode.sccsai.com/updates/{channel}/windows-x64/` 的渠道隔离发布（安装包先上传、清单后发布），以及构建期渠道与版本元数据的一致性保障。

仓库现状是「客户端更新链路已基本切到自有域名并按身份固定通道（分支在途），但发布侧流程没有仓库内脚本支撑、稳定版通道尚未发布、设置页遗留一个已失效语义的预览更新开关」（见「三、现状盘点」）。本卡的价值是固化缺口与验收判据，不重写已工作的更新器。

## 二、范围（内/外）

### 范围内

- **更新源与通道**（§4.4 第 1、4 条）：CCode 自有更新域名与清单（latest.yml）、preview/stable 渠道 URL 与目录隔离、安装身份固定通道、显式启动参数/环境变量更新源覆盖（`ZCODE_UPDATE_FEED_URL` / `--zcode-update-feed-url`）的保留与边界。
- **更新检查与展示**（§4.4 第 2 条）：启动检查与轮询策略、手动检查入口（菜单/托盘/设置页）、新版本展示版本号与摘要（releaseNotes）、下载/安装进度与失败原因展示。
- **校验与失败保留**（§4.4 第 3 条）：清单内 version/sha512/size 的强制校验、下载完整性校验、下载失败与安装失败的恢复路径、旧版本可继续运行。
- **更新后数据保留**（§4.4 第 5 条）：会话、账户恢复凭据（联动拆项2）、项目索引、用户设置在更新后完好（数据目录位于用户数据目录而非安装目录，联动拆项1 的隔离判据）。
- **发布流程**：`bundle:ccode-preview` 产物到自有域名 updates 目录的上传/发布步骤（安装包先上传、清单后发布、渠道目录隔离）、渠道一致性校验、发布清单内容规范（version/files/url/size/sha512/releaseNotes）。
- **版本号双轨**：`ccodeRelease.version`（产品发布号）与上游 `version`（运行时兼容标识）的口径及对外叙事统一。
- **设置页 `receivePreviewUpdates` 开关的处置**（去留与文案，见开放问题 O2，不代行拍板）。

### 范围外

- 品牌/版权/打包元数据清理（homepage/author/maintainer 仍为 zcode.z.ai，属拆项1「品牌与数据目录隔离」R2.1，本卡只在「不复用 ZCode 产品配置」验收时引用其结论）。
- 数据目录隔离的实现（拆项1；本卡只消费「数据不在安装目录」这一前提作为更新保留判据）。
- 登录态恢复机制本身（拆项2；本卡只验收更新后恢复凭据仍在）。
- 上游 ZCode 的 GitLab CI 发布链路（`docs/desktop-ci-cd.md` 的 approve/validate/upload/preload/publish 流水线与 zcode.z.ai release API）：仅供参照，CCode 未接入，不在本卡改造。
- macOS/Linux 平台更新机制的具体实现：母 PRD §5 与既有 spec 的矛盾按任务卡要求列入开放问题 O1，拍板前不实现。
- 远程运行组件下载源（`cdn.codegeex.cn/zcode/electron/releases`，`remoteCdn.ts`）：属运行时组件分发，不是应用更新通道，归拆项1 B12/O5。
- 母 PRD 排除项（§6）：任务续接故障、五分钟授权失败、`Confidential controller: EXECUTION_FAILED` 修复。

## 三、现状盘点

标注约定：**已实测**（附路径与行号/符号名，本轮实际读取源码或产物）；**推断**（说明依据）；**待实测**（本轮未覆盖）。

### 3.1 客户端更新链路现状

| # | 断言 | 证据指针 | 状态 |
|---|------|----------|------|
| U1 | 更新源已固定为 CCode 自有域名并按渠道分路径：默认 feed 为 `https://ccode.sccsai.com/updates/${channel}/windows-x64/latest.yml`，channel 取 `ZCODE_PRODUCT_FLAVOR === "preview" ? "preview" : "stable"`；显式覆盖保留（启动参数 `--zcode-update-feed-url` 优先于环境变量 `ZCODE_UPDATE_FEED_URL`，均优先于默认值） | `E:\ZCode\packages\desktop\src\main\autoUpdater.ts` L29-30（覆盖开关常量）、L762-779（`resolveUpdateFeedSourceFromStartupConfig`，默认 URL 在 L773）；文件为分支在途修改 | 已实测 |
| U2 | 更新通道按安装身份固定，不再跟随用户设置：`resolveUpdateReleaseChannel` 忽略 `_settingService` 参数，直接返回安装 flavor 对应通道（注释原文「Preview 与正式版安装目录不同，不能由用户偏好切到另一种安装身份」）；ManifestUpdateProvider 的 `resolveReleaseChannel` 回调同源 | `autoUpdater.ts` L781-786、L820-824 | 已实测 |
| U3 | 更新功能仅 Windows x64 且需构建开关：`initAutoUpdater({ enabled: process.platform === "win32" && process.arch === "x64" && ZCODE_AUTO_UPDATE_ENABLED })`；`ZCODE_AUTO_UPDATE_ENABLED` 由构建期 define 注入（未注入一律 false）；菜单/托盘/命令处理三处入口同口径放行；`enabled: false` 时 fail-closed（手动检查对未初始化 updater 返回 dev-skipped，不发真实请求） | `E:\ZCode\packages\desktop\src\main\index.ts` L2256-2257；`E:\ZCode\packages\shared\src\env.ts` L60-62；`E:\ZCode\scripts\build-time-config.mjs` L44-46、L54；`E:\ZCode\packages\desktop\src\main\desktopApplicationMenu.ts` L252-261；`desktopTray.ts` L102-110；`desktopCommandHandlers.ts` L595-601；`autoUpdater.ts` L1603-1612（disabled 路径）、L62-65（fail-closed 注释）、L2088-2095 | 已实测 |
| U4 | 清单请求走自定义 provider：electron-updater 以 `provider: "custom" + ManifestUpdateProvider` 配置，`manifestUrl` 即 U1 解析出的 latest.yml 地址，请求会追加 `platform`/`device_mid`/`channel`（preview→3 / stable→1）query 与同名 header；返回内容按 latest.yml 同格式 YAML 解析，`version` 非字符串即抛错；请求通道随 `UpdateInfo.zcodeReleaseChannel` 带回用于过期结果判别 | `E:\ZCode\packages\desktop\src\main\manifestUpdateProvider.ts` L22（默认 API 路径常量）、L77-93（`buildElectronManifestUrl`）、L205-240（`getLatestVersion`，L228-231 版本校验、L238 通道回传）；`autoUpdater.ts` L809-831（`applyManifestUpdateProvider`）、L354-357（stale 判别） | 已实测 |
| U5 | 完整性校验链存在但分两段：仓库侧强制清单 files 每项带 sha512 或 sha2（缺失即抛 `Manifest file is missing checksum`）；下载完成后对安装包做哈希校验由 electron-updater 内建执行，仓库未覆写该逻辑 | `manifestUpdateProvider.ts` L150-153；本地实测产物 `E:\ZCode\packages\desktop\dist-ccode-preview-update\latest.yml`（含 `sha512`、`size`、`files[0].url`） | 仓库侧已实测；electron-updater 内建校验为推断（依赖库标准行为） |
| U6 | 下载/安装失败保留当前可运行版本：`autoDownload=false`、`autoInstallOnAppQuit=false`（Windows 明确等待用户显式安装）；下载失败不清空入口、退回「发现更新」可重试；安装失败（退出准备失败或安装器原生错误）进入 `recoverFromFailedUpdateInstall`：`app.relaunch()` + `app.exit(0)` 恢复旧版本进程，且恢复态保持到退出、防重复重启；`quitAndInstall` 前显式等待 host/agent 退出准备，避免 Windows 资源占用造成半更新 | `autoUpdater.ts` L1642-1646（两个开关）、L1103-1115（下载失败退回 available）、L128-140（`recoverFromFailedUpdateInstall`）、L1043-1049、L1131（安装失败恢复）、L493-507（退出准备硬前置）、L528-531（恢复原生安装入口的注释）；`E:\ZCode\packages\desktop\src\main\index.ts` L2258-2264（`onBeforeQuitAndInstall` 挂接 `prepareAppQuit` 与 Windows 进程准备） | 代码已实测；运行态验收未执行（见五、A3） |
| U7 | 更新后数据保留依赖「用户数据不在安装目录」：打包态数据根为 `%APPDATA%/{CCode|CCode Preview}/data`（拆项1 D1/D7 已实测），NSIS 覆盖安装不触碰用户数据目录；安装目录内如发现 `.zcode` 会被检测阻断以防误删；Windows 安装交接有统一退出屏障设计 | `E:\ZCode\packages\desktop\src\main\desktopEarlyDataBaseDirBootstrap.ts` L9-26；`E:\ZCode\packages\desktop\build\installer.nsh` L473-499（`zcodeFindNestedDataDir`）；`E:\ZCode\docs\desktop\windows-update-install-handoff.md`（交接时序与行为约束） | 代码/文档已实测；跨版本升级保留未运行验证（见五、A4） |
| U8 | 检查策略：启动即检查一次；轮询间隔 15 分钟，存在可见更新目标（available/downloaded）时加密到 2 分钟；下载中停轮询；支持跳过版本（按渠道持久化 `skippedElectronUpdateVersions`）、取消下载、手动检查清除跳过记录、自动下载偏好（`autoDownloadAndInstallUpdates`，默认关闭） | `autoUpdater.ts` L27-28（间隔常量）、L1919-1940（`ensureAutoUpdatePollInterval`）、L1158-1171（`shouldAutoDownloadAndInstallUpdates`）、L1173-1232（`skipAvailableUpdateVersion`）、L1382-1418（`cancelDownloadingUpdate`）；行为规范 `E:\ZCode\docs\desktop\auto-update-auto-download-install.md` | 已实测 |
| U9 | 设置页 `receivePreviewUpdates` 开关仍在且语义已失效（与 spec 矛盾的实态）：开关无条件渲染；改动仍经 `syncImmediateAppSettings` 触发 `refreshAutoUpdaterReleaseChannel(布尔值)`——该函数会把 `availableUpdateChannel` 置为「设置值」并重新检查，而 provider 实际按安装身份请求（U2）。若设置值与身份通道不一致，返回结果的 `zcodeReleaseChannel` 会被 stale 判别忽略，检查状态可能滞留 checking | `E:\ZCode\packages\ui\src\settingsPageHelpers.tsx` L707-721（开关渲染）；`E:\ZCode\packages\desktop\src\main\index.ts` L1174-1181（触发链）；`autoUpdater.ts` L1491-1546（`refreshAutoUpdaterReleaseChannel`）；对照 `E:\ZCode\docs\settings-preview-updates-copy.md`（描述开关控制 stable/preview 的旧口径） | 开关存在与触发链已实测；stale 滞留为推断（按 L354-357 与 L1491-1546 执行路径推演，未运行复现） |
| U10 | 更新链路测试已覆盖大半：`autoUpdaterReadyState.test.ts` 覆盖 feed URL 覆盖优先级、manifest 覆盖不退回 generic feed、preview/stable 刷新与 stale 判别、ready 状态恢复等；但测试样例 URL 全为 `*.example.test`，未检索到对默认 `ccode.sccsai.com` 渠道 URL 模板的直接断言（`sccsai` 在 `packages/desktop/test` 零命中） | `E:\ZCode\packages\desktop\test\autoUpdaterReadyState.test.ts` L711-749（URL 优先级）、L751 起（manifest 覆盖）、L343-697（preview 刷新/stale/ready）；检索命令 `git grep sccsai -- packages/desktop/test` 零命中 | 已实测（覆盖清单与缺口） |

### 3.2 发布流程与版本元数据现状

| # | 断言 | 证据指针 | 状态 |
|---|------|----------|------|
| P1 | CCode 专用构建入口已存在且固定更新开关：`pnpm bundle:ccode-preview`（根 package.json scripts，分支在途）串行构建，环境固定 `ZCODE_ENV=production`、`ZCODE_PREVIEW_IDENTITY=1`（→ 编译期 `__ZCODE_PRODUCT_FLAVOR__="preview"`）、`ZCODE_AUTO_UPDATE=1`、`ZCODE_DESKTOP_DIST_DIR=dist-ccode-preview-update` | `E:\ZCode\scripts\build-ccode-preview.mjs` L8-15（未跟踪新文件）；flavor 折叠见 `E:\ZCode\packages\desktop\tsup.config.ts` L71 附近、`E:\ZCode\packages\desktop\scripts\desktop-product-identity.mjs`（`ZCODE_PREVIEW_IDENTITY` 解析） | 已实测 |
| P2 | 构建产物实测存在且含更新三件套：`dist-ccode-preview-update/` 下有 `CCode Preview-0.0.4/0.0.5/0.0.6/0.0.7-win-x64.exe` 各自 blockmap、`latest.yml`（version 0.0.7、files[].url/sha512/size）及 `win-unpacked`；产物名含空格「CCode Preview-…」；latest.yml 无 releaseNotes/releaseNotesByLocale 字段 | `E:\ZCode\packages\desktop\dist-ccode-preview-update\latest.yml` 与同目录文件清单（本轮实读） | 已实测 |
| P3 | **发布/上传流程无仓库脚本支撑（缺口）**：spec 描述「网站发布流程生成版本/files/url/size/sha512 清单，安装包先上传、清单随后发布，渠道隔离」，但全仓（含未跟踪文件）未检索到任何生成 `updates/{channel}/windows-x64/latest.yml` 目录结构或向 `ccode.sccsai.com` 上传安装包/清单的脚本；仓库内 `sites/ccode` 的 `prepare:release` 只生成官网下载页清单 `release.json`（sha256、单一 Windows 条目、无渠道维度），与更新器消费的 latest.yml 是两份独立产物 | `E:\ZCode\docs\specs\ccode-update-feed.md` L5（描述）；检索 `git grep -rln sccsai --untracked` 仅命中 autoUpdater.ts/index.ts/文档，无发布脚本；`E:\ZCode\sites\ccode\scripts\releases.mjs` L6、L37-44（release.json 生成，仅 sha256）；`E:\ZCode\sites\ccode\public\release.json`（当前内容） | 已实测（以检索为零为证）；真实上传操作发生在仓库外，待实测 |
| P4 | 稳定版通道只有 URL 预留、没有发布物：默认 feed 模板支持 `updates/stable/...`（U1），但构建入口只有 preview 身份（P1），根 `package.json` `ccodeRelease.channel` 当前为 `"preview"`；母 PRD §7 场景 3 验收的「新稳定版」尚无可升级对象 | `E:\ZCode\package.json` L4-7（`ccodeRelease: { "version": "0.0.7", "channel": "preview" }`）；`E:\ZCode\packages\desktop\scripts\build-metadata.mjs` L88-90（`productVersion`/`productChannel` 来源） | 已实测 |
| P5 | 版本号双轨：产品发布号 0.0.7（安装包 PE/asar `extraMetadata.version`、latest.yml version、更新比较用的 `app.getVersion()`）与上游运行时版本 3.16.2（根 `version`，远程资源兼容标识）并存；官网 `release.json` 仍记载 `CCode-3.16.2-win-x64.exe`（旧命名+上游版本号），与当前 preview 产物名（`CCode Preview-0.0.7-…` 含空格）和官网脚本文件名模式 `^CCode-(\d+\.\d+\.\d+)-win-x64\.exe$`（不匹配含空格的 preview 名）三方不一致 | `package.json` L2-7；`electron-builder.config.js` L563-566（`extraMetadata.version`/`ccodeReleaseChannel`）；`sites\ccode\scripts\releases.mjs` L6（模式）；`sites\ccode\public\release.json`（3.16.2）；P2 产物名 | 已实测 |
| P6 | 渠道存在两条独立输入且无一致性校验：更新通道实际由构建期 `ZCODE_PREVIEW_IDENTITY` 折叠的 `__ZCODE_PRODUCT_FLAVOR__` 决定（U1/U2）；`ccodeRelease.channel` 只作为打包元数据 `ccodeReleaseChannel` 写入 asar 内 package.json，全仓无运行时消费方——两者可以矛盾（如忘设 `ZCODE_PREVIEW_IDENTITY` 时打出「production 身份+元数据 preview」的包），无构建校验拦截 | `electron-builder.config.js` L565（唯一写入点）；`git grep ccodeReleaseChannel -- packages` 仅此一处；`E:\ZCode\packages\shared\src\env.ts` L28-42（flavor 折叠规则） | 已实测 |
| P7 | 打包配置已切断对上游更新 feed 的携带：`detectUpdateChannel: false`；`publish` 为 generic 占位 `http://localhost:8081`（仅满足 electron-builder 打包必需，不携带可配置旧 stable feed；注释明确运行时改用服务端 manifest provider）；`useMultipleRangeRequest: false` 保住差分下载 | `E:\ZCode\packages\desktop\electron-builder.config.js` L938-948（分支在途修改）；拆项1 B11 交叉印证 | 已实测 |
| P8 | 相关文档与代码存在漂移：`docs/desktop/build-time-optional-capabilities.md` L35 写「自动更新在 Desktop Main 启动时判定：`ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED`」，与实际判定（U3：win32 && x64 && 开关，无 flavor 条件）不一致；上游更新文档群（`auto-update-service-manifest.md`、`auto-update-baseline.md`、`auto-update-superseded-ready-package.md`、`post-update-release-notes.md`）描述 zcode.z.ai 服务端 manifest 模式，CCode 以静态 latest.yml URL 覆盖复用其客户端语义但未走服务端接口 | `E:\ZCode\docs\desktop\build-time-optional-capabilities.md` L11、L35；`E:\ZCode\docs\desktop\auto-update-service-manifest.md`（背景/接口节）；对照 `index.ts` L2257 | 已实测 |
| P9 | 旧版本手动升级路径已成事实约束：spec 记载「旧 0.0.3 需一次手动升级到启用更新的构建」；当前已发布 CCode 版本为 v0.0.1（首发）、0.0.2（换下载源）、0.0.3（中台总控集成预览包）均无自动更新，0.0.4+ 才带更新器 | `E:\ZCode\docs\specs\ccode-update-feed.md` L5；`E:\ZCode\docs\specs\ccode-distribution.md`（验收场景节，v0.0.1/0.0.2/0.0.3 记载） | 文档已实测；各历史安装包行为未逐一复测（待实测） |

## 四、需求细化

### 4.1 独立的发布清单、下载域名、安装包名称、更新通道与版本号（承接 §4.4 第 1 条，原文锚定）

- R1.1 保持 U1/P7 现状为不可回退判据：更新器默认源必须且只能是 `ccode.sccsai.com/updates/{channel}/windows-x64/latest.yml`；打包配置不得恢复可配置的上游 feed。
- R1.2 显式覆盖（`ZCODE_UPDATE_FEED_URL` / `--zcode-update-feed-url`）保留为诊断能力，但需在发布构建验收中确认正式包不带覆盖值启动时永远落到自有域名（覆盖只在显式传入时生效，U1 已满足，固化为 A1 判据）。
- R1.3 安装包名称与版本叙事统一（对应 P5 缺口）：对外发布号统一用 `ccodeRelease.version`；安装包文件名需定稿（含空格的「CCode Preview-」是否保留——影响 URL 编码、官网清单模式与 latest.yml `files[].url`），官网下载清单与更新清单的版本字段必须同源；上游 3.16.2 只保留为内部兼容标识，不再出现在任何用户可见下载文件名中。
- R1.4 「不复用 ZCode 的产品配置」的打包侧残余（homepage/author/maintainer 为 zcode.z.ai）归拆项1 R2.1，本卡验收 A1 只检查更新链路文件；两卡判据合起来才构成 §4.4 第 1 条的完整闭环。

### 4.2 启动检查与展示（承接 §4.4 第 2 条，原文锚定）

- R2.1 检查策略固化现状（U8）：启动检查 + 15 分钟轮询（可见目标时 2 分钟）+ 手动入口（菜单/托盘）；策略变更需先改本卡判据。
- R2.2 版本、下载/安装状态、失败原因展示沿用现有更新状态机与独立更新窗口（`UpdateStatePayload`/`UpdateCheckResultPayload`，含字节级进度）。
- R2.3 **摘要（releaseNotes）为当前缺口**（P2）：发布侧 latest.yml 需补 `releaseNotes` 或 `releaseNotesByLocale`（zh-CN/en-US），客户端解析与展示链路已存在（`normalizeLocalizedReleaseNotes`/`PostUpdateReleaseNotesDialog`），无需客户端改动即可点亮；发布脚本需校验该字段存在。

### 4.3 校验与失败保留（承接 §4.4 第 3 条，原文锚定）

- R3.1 完整性：保持「清单 files 缺 sha512/sha2 即拒绝」（U5）为硬约束；发布脚本生成清单时必须写入 sha512 与 size，并在上传前自校验（见 R4.2）。
- R3.2 版本：保持 manifest `version` 必须为字符串且经 semver 比较大于当前版本才提示（U4/U8），不提供降级路径。
- R3.3 来源：清单解析以 manifestUrl 为基址解析相对文件 URL；发布规范应规定 `files[].url` 使用相对路径（落在 `updates/{channel}/windows-x64/` 同目录），禁止绝对 URL 指向其他域——是否追加代码级同域强制校验见开放问题 O5。
- R3.4 失败保留旧版本：保持 U6 全部机制（显式安装、下载失败退回可重试、安装失败 relaunch 恢复、退出准备硬前置），任何重构不得以超时掩盖安装交接时序（AGENTS.md 纪律）。

### 4.4 预览版与正式版通道隔离（承接 §4.4 第 4 条，原文锚定）

- R4.1 保持「安装身份固定通道」（U2）：preview 安装只读 `updates/preview/...`，stable 安装只读 `updates/stable/...`；用户设置不得切换安装身份的通道。
- R4.2 渠道目录互斥：发布流程必须把两渠道产物写入各自目录，脚本级校验「本次发布只触碰一个渠道目录」（对应 P3 缺口，新增）。
- R4.3 清理失效开关（对应 U9，依赖开放问题 O2 拍板）：`receivePreviewUpdates` 移除或改写为不暗示通道切换的说明文案；`refreshAutoUpdaterReleaseChannel` 与按设置刷新通道的调用链同步清理，消除「设置值/身份值」双源；`settings-preview-updates-copy.md` 按结论修订或作废。
- R4.4 渠道一致性校验（对应 P6 缺口，新增）：构建或发布前校验 `ZCODE_PREVIEW_IDENTITY` 折叠的 flavor 与 `ccodeRelease.channel` 一致，不一致即失败。

### 4.5 更新后数据保留（承接 §4.4 第 5 条，原文锚定）

- R5.1 依赖并复用拆项1 的目录隔离事实（U7）：会话库/任务索引/设置/凭据均在用户数据目录，更新只覆盖安装目录。
- R5.2 账户恢复凭据保留与拆项2 的登录态恢复联合验收（A4）：升级后重启不要求重新登录（安全存储可用时）。

### 4.6 发布流程需求（P3/P4 缺口，新增）

- R6.1 仓库内提供发布脚本/流程文档：输入 `dist-ccode-preview-update` 产物，产出 `updates/{channel}/windows-x64/` 下的安装包、blockmap、latest.yml；顺序为「安装包与 blockmap 先上传并校验远端可取，latest.yml 最后发布」（与 spec `ccode-update-feed.md` 口径一致），避免客户端拿到清单却拉不到包。
- R6.2 发布脚本校验：latest.yml 的 version 与安装包文件名版本一致、sha512/size 与实际上传文件一致、channel 目录与构建身份一致（R4.4）。
- R6.3 stable 通道发布物与时间表：按开放问题 O1 结论推进；拍板前不发布 stable，也不宣称满足 §7 场景 3。
- R6.4 存量无更新版本（≤0.0.3）的手动升级路径在官网 FAQ/发布说明中保持可查（P9）。

## 五、验收场景

每条为可回读的客观判据（静态判据给出确切文件与检索式；运行判据注明操作与观察点）：

- **A1 自有更新源与渠道 URL 可回读（对应 §4.4 第 1/4 条）**：回读 `E:\ZCode\packages\desktop\src\main\autoUpdater.ts` 的 `resolveUpdateFeedSourceFromStartupConfig`，默认 URL 模板为 `https://ccode.sccsai.com/updates/${channel}/windows-x64/latest.yml` 且 channel 由 `ZCODE_PRODUCT_FLAVOR` 推导（preview/stable 两分支前缀互不相同）；在 `autoUpdater.ts`、`manifestUpdateProvider.ts`、`index.ts` 的 `initAutoUpdater` 调用段检索 `zcode.z.ai` / `cdn-zcode.z.ai` / `generic` feed URL 零命中；回读 `electron-builder.config.js` publish 段仍为占位 `http://localhost:8081` 且 `detectUpdateChannel: false`。
- **A2 清单完整性强制可回读（对应 §4.4 第 3 条）**：回读 `manifestUpdateProvider.ts` `resolveManifestFiles`，对缺 sha512/sha2 的文件抛 `Manifest file is missing checksum`；对照发布产物 latest.yml（如 `dist-ccode-preview-update\latest.yml` 或线上 `updates/{channel}/windows-x64/latest.yml`）含 `version`、`files[].url`、`files[].sha512`、`size`，且（R2.3 落地后）含 `releaseNotes` 或 `releaseNotesByLocale`。
- **A3 下载/安装失败保留可运行版本（运行态，对应 §4.4 第 3 条，需实测执行）**：在安装了 0.0.7 preview 的环境分别制造两类故障——(a) 断网或把 latest.yml 换成 404/损坏 YAML 后启动并手动检查更新：应用功能正常，更新入口回到可重试或 idle，本地 0.0.7 未被卸载/退出；(b) 制造安装器无法接管（如以占用安装目录文件的方式触发 quitAndInstall 失败路径）：观察应用经 `recoverFromFailedUpdateInstall` 自行 relaunch 回到旧版本且进程存活，日志含 `[auto-update] install failed after shutdown started: relaunch app`。
- **A4 升级后数据与登录保留（运行态，对应 §4.4 第 5 条与 §7 场景 3，需实测执行）**：从 0.0.6 preview 经自有通道升级到 0.0.7 preview 后重启：`%APPDATA%\CCode Preview\data\.zcode\v2\setting.json`、`tasks-index.sqlite`、`cli/db` 会话库、安全存储中的恢复凭据均存在且应用可读；已登录账号重启后不要求重新输入密码（安全存储可用时，联动拆项2）。
- **A5 发布流程可回读且顺序正确（对应 P3 缺口与 R6.1，交付后判据）**：仓库存在可回读的发布脚本/流程文档，其执行顺序为「上传安装包+blockmap → 远端可取校验 → 发布 latest.yml」，且脚本含两处校验：latest.yml version 与包名版本一致、sha512/size 与上传文件一致；发布 stable 与 preview 时写入的目录常量分别为 `updates/stable/windows-x64/` 与 `updates/preview/windows-x64/`，脚本内不存在向对方目录写入的路径。
- **A6 渠道一致性校验存在（对应 P6/R4.4，交付后判据）**：回读构建/发布校验脚本或 `build-ccode-preview.mjs` 及其稳定版对应物，存在「`ZCODE_PREVIEW_IDENTITY` 折叠 flavor 与 `package.json ccodeRelease.channel` 不一致即构建失败」的断言，并有对应单测。
- **A7 失效开关处置可回读（对应 U9/R4.3，视开放问题 O2 结论）**：按拍板结论回读——若移除：`settingsPageHelpers.tsx` 不再渲染 `receivePreviewUpdates` 行，`index.ts` `syncImmediateAppSettings` 无 `refreshAutoUpdaterReleaseChannel` 调用；若保留改文案：新文案不含「切换更新通道/预览版更新」语义，且 `autoUpdater.ts` `resolveUpdateReleaseChannel` 不再保留无效果的设置参数双源。

## 六、依赖与里程碑

### 依赖

- **上游 spec（已存在，实现前必须重读）**：`E:\ZCode\docs\specs\ccode-update-feed.md`（本主题总纲：渠道 URL、身份固定、先包后清单）、`ccode-distribution.md`（打包身份与版本双轨、v0.0.1-0.0.3 发布记载）、`ccode-website.md`（官网下载清单 release.json 规范）、`E:\ZCode\docs\settings-preview-updates-copy.md`（旧开关文案，待 O2 处置）；行为文档 `E:\ZCode\docs\desktop\auto-update-service-manifest.md`、`auto-update-auto-download-install.md`、`auto-update-superseded-ready-package.md`、`windows-update-install-handoff.md`、`post-update-release-notes.md`、`build-time-optional-capabilities.md`（P8 漂移需随本卡修订）；上游 CI 参照 `E:\ZCode\docs\desktop-ci-cd.md`、`E:\ZCode\docs\desktop-ci-artifact-layout.md`（CCode 未接入，只借鉴先包后清单/不覆盖 stable feed 的顺序设计）。
- **兄弟拆项**：拆项1 的品牌元数据终值（O3 域名）与数据目录判据（A4 的前提 D1/D7）；拆项2 的凭据保留（A4 联合验收）；本卡为拆项1 提供 A1 更新链路侧判据。
- **外部输入**：`ccode.sccsai.com` 的 updates 目录托管方式与上传凭据（当前上传在仓库外操作，P3）；stable 通道发布时间表（O1）；安装包命名定稿（O3）。
- **构建链路**：`pnpm bundle:ccode-preview`（`scripts/build-ccode-preview.mjs`）为 A3/A4 的产物来源；本卡不新建构建入口。

### 里程碑

- **M1 判据固化（本卡交付）**：本文档评审通过，现状盘点与 A1-A7 成为拆项3 回读基线。
- **M2 发布流程落地**：R6.1/R6.2 发布脚本与 R4.4/A6 渠道一致性校验入仓，A5/A6 静态判据全绿；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
- **M3 preview 通道端到端验收**：在 0.0.6 preview 真机环境经自有通道升级 0.0.7，执行 A2/A3/A4；releaseNotes（R2.3）随首份补齐字段的清单发布验证。
- **M4 通道清理与 stable 决策落地**：O1/O2 拍板后执行 R4.3（A7）、R6.3；未拍板项保持现状并在台账如实标注，不宣称满足 §7 场景 3。

## 七、开放问题

- **O1 三平台更新一致性矛盾（任务卡点名，不代行拍板）**：母 PRD §5 原文「Windows、macOS、Linux 的产品身份、数据隔离和更新行为保持一致」与既有 spec `ccode-update-feed.md`「其他平台暂不启用此 Windows 清单」及代码事实（U3：仅 win32+x64 启用，macOS/Linux 走 `enabled:false` fail-closed）直接矛盾。需拍板：(a) 母 PRD 放宽为「Windows 先行、其余平台待定」，或 (b) 为 macOS（zip/dmg+自动更新）与 Linux（AppImage）制定各自通道方案并同步 spec。连带问题：母 PRD §7 场景 3 验收语为「新稳定版」，而当前仅 preview 通道有发布物（P4），场景 3 在 stable 首发前不可验收——口径需一并明确。
- **O2 设置页 `receivePreviewUpdates` 开关去留（阻塞 R4.3/A7）**：通道已按安装身份固定（U2），但开关仍展示「提前收到预览版更新」并触发已失效的通道刷新链（U9），`settings-preview-updates-copy.md` 的描述随之失真。需拍板：移除开关并清理调用链，或保留开关改作「订阅预告通知」类非通道语义；stale 滞留（U9 推断部分）是否单独立缺陷单由总控定。
- **O3 版本叙事与安装包命名定稿（阻塞 R1.3）**：三处并存——`ccodeRelease.version` 0.0.7、官网 release.json 3.16.2（旧命名 `CCode-3.16.2-win-x64.exe`）、实际产物 `CCode Preview-0.0.7-win-x64.exe`（含空格，官网脚本模式不匹配，P5）。需拍板：安装包名是否去空格（影响 URL 编码、latest.yml files[].url 与官网清单模式）；官网下载清单何时切换到 0.0.x 产品版本号；拆项1 O6 的同源问题在此收敛。
- **O4 更新承载方式的长期形态**：现状为静态 latest.yml 直连（U1/U4，复用上游 ManifestUpdateProvider 的解析与 stale 判别，但不走服务端 manifest 接口与灰度 API）。需拍板：长期保持静态清单（简单、无灰度），或接入中台 release API（获得灰度/回滚/按设备定向，参照 `docs/desktop/auto-update-service-manifest.md` 与 `desktop-ci-cd.md` 的 publish 链路设计）。影响 R6.1 脚本形态与 M3 之后的能力边界。
- **O5 来源校验强度**：当前客户端只强制 sha512 存在（U5），清单内绝对 URL 不限域（R3.3 仅靠发布规范约束）。需拍板：是否在 `resolveManifestFiles` 增加同域（ccode.sccsai.com）强制校验，或引入清单签名（成本与收益需权衡）；拍板前 A2 判据不含同域项。
- **O6 渠道双输入收敛方案（阻塞 A6 形态）**：更新通道实际由构建期 flavor 决定，`ccodeRelease.channel` 仅是死元数据（P6）。需拍板：以构建期 flavor 为唯一事实源（`ccodeReleaseChannel` 元数据保留仅作审计），或反过来以 `ccodeRelease.channel` 驱动构建身份；A6 校验按结论实现。
- **O7 文档漂移修订责任**：`build-time-optional-capabilities.md` L35 的启动判定描述与代码不符（P8）。随本卡 M2 一并修订，还是单独走文档修订任务，由总控定。
