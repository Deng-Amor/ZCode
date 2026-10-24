# CCode PRD 拆项1：品牌与数据目录隔离

- 任务卡：20261022-01（总控台账第 9 行，E:\ZCode\docs\prd\总控台账.md）
- 母 PRD：E:\ZCode\docs\prd\ccode-product-prd.md（v1.0，待评审），本卡承接 §8「后续拆分」第 1 项
- 对应母 PRD 条目：§2 目标 1、§4.1 品牌/版权/开源声明、§4.2 私有数据目录与配置迁移、§7 验收场景 1 与 4
- 盘点基线：仓库分支 `codex/ccode-update-feed` 当前工作区（含大量未提交改动），盘点时间 2026-10-22，全部以工作区实读为准

## 一、背景与目标

母 PRD §1 规定产品以 **CCode** 对外呈现，不再向用户暴露 ZCode 品牌、配置目录、更新源、版权名称或身份文案。母 PRD §2 目标 1 原文：

> 用户安装、启动、登录、升级和使用 CCode 时，不会误进入或依赖 ZCode 的产品数据、更新源或视觉身份。

本拆项把该目标拆成两条可独立验收的主线：

1. **品牌与法律信息主线**（母 PRD §4.1）：桌面应用名称、窗口标题、启动页、图标、关于页、安装包、更新提示和产品自我介绍统一使用 CCode 与川升AI；用户可见版权文本不得继续显示 ZCode；同时保留 Apache License 2.0 声明与上游依赖必要 notices，不能通过改名删除。
2. **数据目录隔离主线**（母 PRD §4.2）：CCode 使用独立于 ZCode 的应用数据根目录（至少隔离账户凭据、会话索引、项目索引、设置、日志、插件与更新元数据）；新安装不得读取或覆盖 ZCode 默认配置目录；升级已有 CCode 版本按 CCode 自身目录平滑迁移。

仓库中已有多份 spec 覆盖部分现状（`docs/specs/ccode-storage-isolation.md`、`ccode-about-license.md`、`ccode-distribution.md`、`ccode-website.md`），品牌隔离与目录隔离的大部分骨架已落地但存在残留 ZCode 暴露点（见「三、现状盘点」）。本卡的价值是补齐残留差距、固化验收判据，而不是从零新建。

## 二、范围（内/外）

### 范围内

- **品牌暴露点清理**：关于页版权行、关于页主名口径、打包元数据（homepage/author/maintainer）、`packages/desktop/package.json` 残留 productName、以及其他用户可见文案中的 ZCode 残留。
- **Apache-2.0 与第三方 notices 保留链路的验收固化**：`LICENSE → APACHE-2.0.txt` 与 `THIRD-PARTY-NOTICES.md` 随包、关于页许可入口可读（母 PRD §4.1 原文：「产品保留 Apache License 2.0 声明；版权、许可证和第三方声明应放在关于页或安装目录的常规法律信息入口，不干扰主使用流程」「开源上游依赖的必要 notices 必须保留，不能通过改名删除」）。
- **数据目录隔离验收固化**：打包态数据根指向 `%APPDATA%/CCode*`、不回退真实 HOME、新安装不读写 `~/.zcode`、Electron userData 独立。
- **已有 CCode 版本的升级迁移边界**：一次性 SQLite 会话库快照迁移的行为约束（只读源库、不覆盖目标、失败阻断启动），按 CCode 自身目录完成。
- **导入边界约束**（仅约束、不含导入功能本身）：需要导入 ZCode 数据时只能经用户触发的导入流程读取，导入默认复制、不删除或迁走原始 ZCode 数据（母 PRD §4.2 第 4 条的边界半句）。

### 范围外

- 「从 ZCode 导入」入口、导入范围选择、导入结果报告（母 PRD §4.2 第 5 条、§4.5）——归拆项4「ZCode 项目/会话导入」。
- 自有更新服务、发布清单、更新通道与版本号策略（母 PRD §4.4）——归拆项3「自有更新通道与发布流程」；本卡只覆盖更新**提示文案与更新源 URL 的品牌一致性**。
- 登录态恢复（§4.3）——拆项2。
- 总控专家（§4.6）、台账校验（§4.7）——拆项5/6。
- 仓库内部 workspace 包名（`zcode`、`@zcode/*`）、协议字段、品牌根目录下 `.zcode` 存储子目录结构：按 `docs/specs/ccode-distribution.md`「2026-10-21 并存修复」节明确保留，不做破坏性改名（不是系统全局名称）。
- 母 PRD 排除项（§6）：任务续接故障、五分钟授权失败、`Confidential controller: EXECUTION_FAILED` 修复。

## 三、现状盘点

以下断言基于当前工作区实读。标注约定：**已实测**（附路径与行号/符号名，本轮实际读取源码）；**推断**（说明依据）；**待实测**（本轮未覆盖）。

### 3.1 品牌暴露点

| # | 断言 | 证据指针 | 状态 |
|---|------|----------|------|
| B1 | 打包产品身份已是 CCode：production `appId: "com.chuansheng.ccode"`、`productName: "CCode"`；preview 为 `com.chuansheng.ccode.preview` / `"CCode Preview"`，Linux 可执行名/包名 `ccode`/`ccode-preview` | `E:\ZCode\packages\desktop\scripts\desktop-product-identity.mjs` L8-24（`PRODUCTION_IDENTITY`/`PREVIEW_IDENTITY`） | 已实测 |
| B2 | 运行时应用名为 CCode：`runtimeApplicationName = "CCode Dev"/"CCode Preview"/"CCode"`，主进程 `app.setName()` 与 `process.title` 均用它；Electron userData 路径为 `appData/{runtimeApplicationName}`（即 `%APPDATA%/CCode`，与 ZCode 官方版目录隔离） | `E:\ZCode\packages\desktop\src\main\desktopRuntimeEnv.ts` L65-67（`runtimeApplicationName`）、L75-79（`runtimeUserDataPath`）；`E:\ZCode\packages\desktop\src\main\index.ts` L300、L313 | 已实测 |
| B3 | 窗口标题/启动页标题为「川升」：renderer `<title>川升</title>`；主窗口未显式传 title，标题来自该 HTML；更新状态窗 `title: ""` | `E:\ZCode\packages\desktop\src\renderer\index.html` L6；`E:\ZCode\packages\desktop\src\main\index.ts` L1806；`E:\ZCode\packages\desktop\src\main\desktopWindowChrome.ts` L599（`title: options.title`，主窗口调用未传） | 已实测 |
| B4 | 菜单与托盘文案已用 CCode：中文「关于 CCode」「打开 CCode」、托盘 tooltip `CCode`（英文同）；托盘实际 `setToolTip(tray.tooltip)` | `E:\ZCode\packages\shared\src\desktopMenu.ts` L90、L111-112、L143、L163-164；`E:\ZCode\packages\desktop\src\main\desktopTray.ts` L85 | 已实测 |
| B5 | **关于页版权行仍显示 ZCode（与母 PRD §4.1 冲突点）**：`ABOUT_MESSAGES` 中文 `版权所有 © ${year} ZCode。`、英文 `Copyright © ${year} ZCode.`，经 `formatAboutCopyright` 渲染进许可子弹窗正文（主视图不展示，属「次级许可入口」）；macOS 系统面板 copyright 字段为 `"Apache License 2.0"` | `E:\ZCode\packages\desktop\src\main\about.ts` L60（`ABOUT_APPLICATION_NAME = "川升"`）、L77-89（`ABOUT_MESSAGES`，L80/L87 为版权行）、L198-203（`formatAboutCopyright`）、L226；`E:\ZCode\packages\desktop\src\main\aboutWindow.ts` L229（许可弹窗内渲染 copyright） | 已实测 |
| B6 | 关于页主名口径不统一：关于页主名/标题为「川升」（`关于川升`），而菜单、托盘用「CCode」；母 PRD §4.1 要求统一「CCode 与川升AI」 | `about.ts` L60、L76-84；对照 `desktopMenu.ts` L90/L111 | 已实测 |
| B7 | **打包元数据仍含 ZCode**：electron-builder `extraMetadata.homepage: "https://zcode.z.ai"`、`author: { name: "ZCode", email: "dev@zcode.z.ai" }`；Linux `maintainer: "ZCode <dev@zcode.z.ai>"`（进入 deb 包 metadata） | `E:\ZCode\packages\desktop\electron-builder.config.js` L569-573、L886 | 已实测 |
| B8 | `packages/desktop/package.json` 残留 `"productName": "ZCode"`（打包时被 extraMetadata.productName 覆盖为 CCode，但该字段在未被覆盖的场景仍是 ZCode） | `E:\ZCode\packages\desktop\package.json` L128；覆盖点 `electron-builder.config.js` L563-566 | 已实测 |
| B9 | 安装包身份已是 CCode：`main: "out/ccode-main.mjs"`、产物名 `${productName}-${version}-...`、deep link 协议仅 `ccode`、安装清单 `.ccode-install-manifest`、NSIS 日志 `CCode-installer.log`/`CCode-uninstaller.log` | `electron-builder.config.js` L567、L247-250、L816-823、L162；`E:\ZCode\packages\desktop\build\installer.nsh` L5、L8、L22 | 已实测 |
| B10 | Apache-2.0 与第三方 notices 随包保留：extraResources 将仓库 `LICENSE` 复制为 `APACHE-2.0.txt`、`THIRD-PARTY-NOTICES.md` 原名随包；Electron 自身 notices 由 afterExtract 附加；仓库根 `THIRD-PARTY-NOTICES.md` 存在 | `electron-builder.config.js` L711-712、L647-655（afterExtract）；`E:\ZCode\scripts\third-party-notices.mjs` L6（`noticesFileName = "THIRD-PARTY-NOTICES.md"`）；仓库根文件存在 | 已实测 |
| B11 | 更新 feed 已用 CCode 自有域名：默认 `https://ccode.sccsai.com/updates/${channel}/windows-x64/latest.yml`（ManifestUpdateProvider）；electron-builder 内 generic publish URL 仅为构建必需的占位 `http://localhost:8081` | `E:\ZCode\packages\desktop\src\main\autoUpdater.ts` L772-773；`electron-builder.config.js` L939-948 | 已实测 |
| B12 | 远程组件下载源 URL 路径含 zcode：默认国内源 `https://cdn.codegeex.cn/zcode/electron/releases`（远程运行时组件下载，非应用更新源） | `E:\ZCode\packages\desktop\src\main\remoteCdn.ts` L5-6、L45-46 | 已实测 |
| B13 | 产品自我介绍身份口径已定义为 CCode：未跟踪新文档《川升桌面助手身份》规定自我介绍为「我是 CCode，由川升AI开发的AI助手」；该身份在打包运行时的实际装配链路是否生效未验证 | `E:\ZCode\apps\zcode-cli\docs\design\v2\chuansheng-assistant-identity.md`（工作区未跟踪文件） | 文档已实测；运行时装配待实测 |
| B14 | 官站为独立 CCode 站点（`sites/ccode`，Astro 静态站，安装包名 CCode、开发方川升AI），按 spec 不接入桌面运行时 | `E:\ZCode\sites\ccode`（目录存在）；`E:\ZCode\docs\specs\ccode-website.md` | 目录已实测；站点内容待实测 |
| B15 | 图标资产处于更换中：`build/icon.ico`、`icon_installer.ico`、`icon_windows.png` 在工作区为已修改状态，新增未跟踪 `build/chuansheng-icon.svg`；图标视觉内容是否已完全去 ZCode 未逐一核验 | `E:\ZCode\packages\desktop\build\`（git status：M icon.ico / M icon_installer.ico / M icon_windows.png / ?? chuansheng-icon.svg） | 文件状态已实测；视觉内容待实测 |

### 3.2 数据目录隔离现状

| # | 断言 | 证据指针 | 状态 |
|---|------|----------|------|
| D1 | 打包态数据根独立于 `~/.zcode`：主进程在任何服务导入前，`isPackaged` 时把 `ZCODE_DESKTOP_HOME_DIR`/`ZCODE_DATA_BASE_DIR` 设为 `appData/{CCode|CCode Preview}/data` | `E:\ZCode\packages\desktop\src\main\desktopEarlyDataBaseDirBootstrap.ts` L9-14 | 已实测 |
| D2 | 启动设置唯一来源为品牌目录下 `.zcode/v2/setting.json`：`resolveBootstrapSettingsFile` 以 `ZCODE_DESKTOP_HOME_DIR` 为默认 home；旧设置若指向真实 HOME 则强制回品牌目录，不接回共享目录 | `E:\ZCode\packages\desktop\src\main\desktopDataBaseDirBootstrap.ts` L5-9（setting 路径）、L40-48（早期注入）；`desktopEarlyDataBaseDirBootstrap.ts` L17-21（HOME 防回退） | 已实测 |
| D3 | 打包态显式下发独立存储与会话库：`ZCODE_HOME`/`ZCODE_STORAGE_DIR` = 品牌根 `.zcode`、`ZCODE_SESSION_DB_PATH` = 品牌根 `.zcode/cli/db/db.sqlite`；Host/CLI 不继承原版数据库环境覆盖 | `desktopEarlyDataBaseDirBootstrap.ts` L22-26；`E:\ZCode\packages\desktop\src\main\desktopRuntimeEnv.ts` L587-594（buildHostProcessEnv 打包态同值下发） | 已实测 |
| D4 | 服务层全部业务路径派生自 `ZCODE_DATA_BASE_DIR`：`getDataBaseDir()`（env 优先，默认 homedir）→ `getZCodeDataRootDir()` = `{dataBaseDir}/.zcode`，凭据/设置为 `v2`（`getAppConfigDir`），任务索引 `{dataBaseDir}/.zcode/v2/tasks-index.sqlite`；打包态被 D1 覆盖为品牌目录，独立 CLI/开发态默认仍 `~/.zcode` | `E:\ZCode\packages\services\src\paths.ts` L37-43（`getDataBaseDir`）、L46-48、L56-58、L188-191 | 已实测 |
| D5 | CLI 会话库桌面分支不落 `~/.zcode`：`getDefaultSessionDbPath()` 在 `ZCODE_DESKTOP_HOME_DIR` 存在时返回 `{storage}/cli/db/db.sqlite`，仅在无桌面环境时回退 `homedir()/.zcode/cli/db/db.sqlite` | `E:\ZCode\apps\zcode-cli\packages\adapters\src\storage\session-store\paths.ts` L8-15 | 已实测 |
| D6 | 首次迁移为一次性 SQLite 一致性快照：仅当品牌实例已有 `v2/tasks-index.sqlite` 且独立库缺失时，把 `CCODE_LEGACY_SESSION_DB`（指向 `homedir()/.zcode` 旧库）以只读方式 SQLite backup 到目标；文件锁串行；`quick_check` + 全表行数核对；同目录硬链接原子发布；目标已存在绝不覆盖；失败抛错阻断启动、保留源库 | 同上文件 L26-65（`migrateLegacyDesktopSessionDb`）；legacy 指针来源 `desktopEarlyDataBaseDirBootstrap.ts` L27-31 | 已实测（代码）；运行验收未执行 |
| D7 | Electron userData 与官方版隔离：userData = `%APPDATA%/CCode`（production）/`%APPDATA%/CCode Preview`（preview）/`%APPDATA%/CCode Dev`（开发），remote-assets-cache、窗口状态等随 userData 走品牌目录 | `desktopRuntimeEnv.ts` L75-82（userData/sessionData）、L317-326（remote cache 在 userData 下） | 已实测 |
| D8 | Windows 卸载/升级不误删 `.zcode`：NSIS 层在覆盖安装目录时检测安装目录及其子目录内 `.zcode` 并阻断，防止安装器清掉品牌数据 | `E:\ZCode\packages\desktop\build\installer.nsh` L471-558（zcodeFindNestedDataDir 与安装目录数据阻断） | 已实测（脚本）；运行验收未执行 |
| D9 | 产品版本与上游运行时版本双轨：根 `package.json` `name: "zcode"`、`version: "3.16.2"` 保留为内部标识；`ccodeRelease: { version: "0.0.7", channel: "preview" }` 为产品版本，打包 `extraMetadata.version` 取 `buildMetadata.productVersion`（即 0.0.7） | `E:\ZCode\package.json` L2-7；`E:\ZCode\packages\desktop\scripts\build-metadata.mjs` L89-90；`electron-builder.config.js` L564-565 | 已实测 |
| D10 | 日志导出、崩溃捕获等边缘路径是否全部落在品牌根（spec `ccode-storage-isolation.md` 要求启动恢复和日志导出不残留真实 HOME）未逐文件核验 | `E:\ZCode\packages\desktop\src\main\exportLogs.ts`（工作区已修改，本轮未逐行读取） | 待实测 |
| D11 | macOS/Linux 平台的身份/数据目录行为（Finder 工作流、desktop entry、`~Library` 路径）未在本轮核验，母 PRD §5 要求三端一致 | `docs/specs/ccode-distribution.md`「2026-10-21 并存修复」节声明已统一 | spec 已实测；平台行为待实测 |

## 四、需求细化

### 4.1 品牌、版权与开源声明（承接母 PRD §4.1，原文锚定）

母 PRD §4.1 原文四条全部保留，逐条落到仓库需求：

1. **桌面应用名称、窗口标题、启动页、图标、关于页、安装包、更新提示和产品自我介绍统一使用 CCode 与川升AI。**
   - R1.1 关于页主名口径统一（现状 B5/B6：主名「川升」、菜单「CCode」并存）：关于页按「应用名 CCode + 开发方 川升AI」组合呈现，标题与主视图用同一常量来源；具体组合方式见开放问题 O2，需产品拍板后落 `about.ts` 的 `ABOUT_APPLICATION_NAME`/`ABOUT_MESSAGES`。
   - R1.2 更新提示与产品自我介绍沿用 CCode/川升AI 口径（现状 B11/B13 基本满足）：把 B13 的身份口径从设计文档固化为运行时验收判据（待实测项补齐）。
   - R1.3 图标视觉去 ZCode 完成度核验（现状 B15 待实测项补齐）。
2. **用户可见版权文本不得继续显示 ZCode。**
   - R1.4 `about.ts` L80/L87 版权行 `© ${year} ZCode。` 改为川升AI 版权行；由于该行位于许可子弹窗内且承担上游署名职责，与 Apache-2.0 §4(d) notices 保留的边界见开放问题 O1——本卡不自行改口径，拍板前不动代码。
3. **产品保留 Apache License 2.0 声明；版权、许可证和第三方声明应放在关于页或安装目录的常规法律信息入口，不干扰主使用流程。**
   - R1.5 保持现状 B10 链路（`LICENSE → APACHE-2.0.txt`、`THIRD-PARTY-NOTICES.md` 随包、关于页低调许可入口），作为不可回退的验收判据（见五、场景 A1）。
4. **开源上游依赖的必要 notices 必须保留，不能通过改名删除。**
   - R1.6 任何品牌清理改动不得删除或改名 `THIRD-PARTY-NOTICES.md`、`APACHE-2.0.txt` 及 Electron notices 附加逻辑（`stageElectronNotices`）；仓库内部 `@zcode/*` 包名属非用户可见标识，按 spec 保留，不在清理范围。

### 4.2 打包与安装元数据清理（B7/B8/B12）

- R2.1 `electron-builder.config.js` `extraMetadata.homepage`/`author` 与 `linux.maintainer` 去 ZCode（zcode.z.ai 域名与 ZCode 名称），改为 CCode/川升AI 名义与发布方域名；deb/pacman/rpm 的包名与 maintainer 需同步，保证 fpm 校验仍通过。正式域名取值见开放问题 O3/O5。
- R2.2 `packages/desktop/package.json` L128 `"productName": "ZCode"` 改为 CCode 或移除（需先确认无构建链路依赖该字段默认值；electron-builder 路径已被 extraMetadata 覆盖）。
- R2.3 远程组件下载源 `https://cdn.codegeex.cn/zcode/electron/releases`（B12）是否迁移到无 zcode 路径的自有 OSS，跟随 `ccode-distribution.md`「便于后续迁移到自有 OSS」预留决策，不在本卡强行变更 URL（URL 变更属拆项3 依赖面）。

### 4.3 CCode 私有数据目录与配置迁移（承接母 PRD §4.2，原文锚定）

母 PRD §4.2 前三条已由现状 D1-D8 大体满足，本卡固化为验收判据并补边界：

- R3.1 **「CCode 使用独立于 ZCode 的应用数据根目录，至少隔离：账户凭据、会话索引、项目索引、设置、日志、插件与更新元数据。」**——逐类核对品牌根下落位：凭据/设置/任务索引在 `{品牌根}/.zcode/v2`（D4）、会话正文在 `{品牌根}/.zcode/cli/db`（D5）、userData 附属（remote-assets-cache、窗口状态、更新元数据）在 `%APPDATA%/CCode`（D7）；D10 日志导出路径补实测。
- R3.2 **「新安装不得读取或覆盖 ZCode 的默认配置目录。」**——新安装路径上对 `~/.zcode` 的唯一合法读点是 D6 的首次迁移，且其触发前提是「品牌实例已存在旧共享库历史」（升级场景），全新安装不满足该前提、不触发；此边界需作为回归判据（五、场景 A4/A5）。
- R3.3 **「升级已有 CCode 版本时，按 CCode 自身目录完成平滑迁移。」**——保持 D6 行为约束：只读源、锁内复查、完整性核对、原子发布、目标存在绝不覆盖、失败阻断不掩盖。
- R3.4 导入边界（承接 §4.2 第 4 条边界半句）：对 `~/.zcode` 的读取仅允许两类——D6 一次性快照迁移（升级）、用户触发的导入流程（拆项4 实现）；两者都必须复制语义，不得删除或迁移走原始 ZCode 数据。导入结果报告（§4.2 第 5 条）归拆项4。

### 4.4 约束与不变量（实现时不得破坏）

- 早期引导顺序不变：`desktopEarlyDataBaseDirBootstrap` 必须先于任何 services 模块求值执行（现状注释明确该约束）。
- 保留 `ccode-distribution.md` 拍板：内部 workspace 包名、协议字段、品牌根下 `.zcode` 目录结构不做破坏性迁移。
- Windows AppUserModelId 沿用 `resolveWindowsAppUserModelIdForFlavor`（打包态复用 appId，开发态独立 `com.chuansheng.ccode.development`），品牌清理不得引入第三套 AUMID。

## 五、验收场景

每条为可回读的客观判据（静态判据注明确切文件与检索式；运行判据注明操作与观察点）：

- **A1 关于页版权与许可证入口（对应母 PRD §7 场景 1、§4.1）**：回读 `E:\ZCode\packages\desktop\src\main\about.ts`，`formatAboutCopyright` 两个语言分支生成的版权字符串不含 `ZCode` 字样（检索 `rg -n "ZCode" packages/desktop/src/main/about.ts` 在版权相关行零命中）；同文件许可入口仍读取 `APACHE-2.0.txt`（打包态 `process.resourcesPath` 下）；回读 `E:\ZCode\packages\desktop\electron-builder.config.js` extraResources 段仍存在 `LICENSE → APACHE-2.0.txt` 与 `noticesFileName` 两条目。
- **A2 关于页/菜单/托盘品牌一致（§4.1）**：回读 `about.ts` 的 `ABOUT_APPLICATION_NAME` 与 `ABOUT_MESSAGES.*.aboutTitle`、`packages/shared/src/desktopMenu.ts` 的 `titleBar.menu.help.about` 与 `tray.tooltip`，四个字符串同取「CCode/川升AI」拍板口径（开放问题 O2 的结论），且均不含 `ZCode`。
- **A3 打包元数据去 ZCode（§4.1 安装包）**：回读 `electron-builder.config.js`，`extraMetadata.homepage`、`extraMetadata.author`、`linux.maintainer` 三处值不含 `zcode`（大小写不敏感检索）；`productName` 仍来自 `desktop-product-identity.mjs` 的 `CCode`/`CCode Preview` 身份；回读 `packages/desktop/package.json`，`productName` 字段为 `CCode` 或已删除。
- **A4 数据根隔离（静态，§4.2/§7 场景 4 前半）**：回读 `desktopEarlyDataBaseDirBootstrap.ts`，打包态 `ZCODE_DATA_BASE_DIR` 取自 `appData/{CCode|CCode Preview}/data`；`homedir()` 在该文件中仅出现在旧值防回退比较与 `CCODE_LEGACY_SESSION_DB` 指向两处白名单位置；回读 `apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts`，`getDefaultSessionDbPath` 在 `ZCODE_DESKTOP_HOME_DIR` 存在的分支不含 `homedir()`。
- **A5 数据根隔离（运行态，§7 场景 4 前半，需实测执行）**：在干净 Windows 环境（无 `~/.zcode` 或已备份其快照/哈希）安装并启动打包产物，完成首启与一次会话后退出：`%USERPROFILE%\.zcode` 不存在，或其目录 mtime 与内容哈希与启动前一致；`%APPDATA%\CCode\data\.zcode\v2\setting.json` 存在且不含指向真实 HOME 的 `dataBaseDir`。
- **A6 升级迁移不破坏源库（运行态，§4.2，需实测执行）**：构造「品牌 tasks-index 已存在、独立 cli db 缺失、`~/.zcode` 旧库在用（WAL 含未 checkpoint 数据）」环境启动：品牌库生成后与旧库全表行数一致；`~/.zcode/cli/db/db.sqlite` 及 `-wal` 文件字节不变；再次启动不重复迁移；人为制造损坏源库时启动失败并保留已生成目标文件，不以空库顶替。
- **A7 第三方 notices 保留（§4.1 第 4 条）**：解包/检查最终安装包 resources 目录（或 CI 产物清单），`APACHE-2.0.txt` 与 `THIRD-PARTY-NOTICES.md` 存在且 `THIRD-PARTY-NOTICES.md` 内容包含 Electron 及上游依赖署名条目（对照 `scripts/third-party-notices.mjs` 的生成逻辑）。

## 六、依赖与里程碑

### 依赖

- **上游 spec（已存在，实现前必须重读）**：`E:\ZCode\docs\specs\ccode-storage-isolation.md`（目录隔离与一次性迁移规则）、`ccode-about-license.md`（关于窗口许可入口设计）、`ccode-distribution.md`（打包身份、协议 `ccode://`、install manifest、共存规则）、`ccode-website.md`（官网品牌与下载清单）。
- **兄弟拆项**：拆项3「自有更新通道」依赖本卡的元数据口径（homepage/域名、R2.1/R2.3 的取值）；拆项4「ZCode 导入」依赖本卡的目录隔离与导入边界（R3.4）；本卡不阻塞拆项2「登录态恢复」，但 A5 环境需其登录产物落品牌目录。
- **外部输入**：开放问题 O1/O2/O3/O5 的拍板（版权行口径、关于页名称组合、自有域名、远程组件 OSS 路径）——O1/O2 阻塞 R1.1/R1.4 编码，其余不阻塞验收判据固化。
- **构建链路**：`pnpm bundle:ccode-preview`（`scripts/build-ccode-preview.mjs`）为 A3/A7 的产物来源；A5/A6 需要可运行的 Windows 打包产物与干净环境。

### 里程碑

- **M1 判据固化（本卡交付）**：本文档评审通过，现状盘点与验收场景成为拆项1 的回读基线。
- **M2 品牌残留清理**：O1/O2 拍板后完成 R1.1/R1.4/R2.1/R2.2 编码与单测，A1/A2/A3 静态判据全绿；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
- **M3 目录隔离运行验收**：在打包产物上执行 A5/A6/A7（含 D10/D11 待实测项补齐），与总控约定的环境一并记录；未执行的部分在台账中如实标注，不宣称完成。

## 七、开放问题

- **O1 版权行与上游署名边界（阻塞 R1.4）**：母 PRD §4.1「用户可见版权文本不得继续显示 ZCode」与现状 `about.ts` L80/L87 在许可子弹窗内保留 `© ZCode`（`ccode-about-license.md` 拍板为「原署名保留在次级许可入口」）直接冲突。需拍板：版权行改为「© 川升AI」后，上游 ZCode 署名是移入 `THIRD-PARTY-NOTICES.md`（notices 义务仍满足），还是继续在许可弹窗以「上游署名」小字保留（则 §4.1 该句需豁免许可弹窗）。本卡不自行改口径。
- **O2 关于页名称组合（阻塞 R1.1）**：母 PRD 要求统一「CCode 与川升AI」，现状关于页主名只有「川升」、菜单托盘只有「CCode」。需拍板最终组合（例如主名 CCode、副行「由川升AI开发」），并决定 `formatAboutCopyright` 版权主体名称。
- **O3 打包元数据正式值（阻塞 R2.1 终值）**：`homepage` 与 author/maintainer 邮箱域名需发布方给定（候选 `ccode.sccsai.com`，未确认）；deb maintainer 变更需与既有 dpkg 包名 `ccode` 的升级链路兼容。
- **O4 独立 CLI 的隔离义务**：`apps/zcode-cli` 脱离桌面启动时默认仍写 `~/.zcode`（D4/D5 的 homedir 回退）。母 PRD 未明确 CLI 单独分发场景；若 CCode 未来独立分发 CLI，需另行拍板其默认目录，本卡维持现状。
- **O5 远程组件 CDN 路径**：`cdn.codegeex.cn/zcode/electron/releases` 是否及何时迁至自有路径（与 `ccode-distribution.md` 的 OSS 迁移预留对齐），影响 B12 是否计入品牌暴露清单。
- **O6 母 PRD 与工作区的版本事实核对**：母 PRD §7 场景 1 假定「新用户安装后关于页只出现 CCode/川升AI」，而当前工作区（未提交改动）尚未满足（B5/B6）；同时根 `package.json` `ccodeRelease` 为 `0.0.7 preview` 而 `ccode-website.md` 记载首发包名为 `CCode-3.16.2-win-x64.exe`（上游版本号），两者并存属双轨版本策略（D9），需在拆项3 统一对外版本叙事，避免官网与关于页版本号口径分裂。
