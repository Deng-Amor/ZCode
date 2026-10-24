# Ccode 官网

Ccode 中文展示与下载静态站，支持手机、平板和电脑。独立于 ZCode 桌面/Web 运行时，不读取用户会话、模型密钥或运行时配置。

检测到 iPhone、Android 或 iPad（含桌面 UA 的触屏 iPad）时，首屏和下载区显示“手机版待开发”，隐藏 Windows 下载/复制/校验入口。设备检测不依赖窗口宽度，电脑窄窗口仍可下载；禁用 JavaScript 时回退到明确标注的 Windows 下载信息。

## 本地运行

工作目录：`E:/ZCode/sites/ccode`。Node 版本跟随仓库 `mise.toml`（24.14.0）。此目录独立使用 npm 和 package-lock.json，不改变根 pnpm workspace。

```powershell
npm ci
npm run prepare:release -- ../../packages/desktop/dist-ccode/CCode-3.16.2-win-x64.exe
npm run dev
```

打开 `http://127.0.0.1:4321`。停止：终端按 Ctrl+C。

若未准备安装包，站点展示“安装包准备中”，不会生成假下载链接。已经有清单但文件不匹配时，启动和构建会失败；重新运行 `prepare:release` 修复。

## 更新安装包

```powershell
npm run prepare:release -- <新的CCode-版本号-win-x64.exe路径>
npm run build
```

准备脚本要求 `CCode-x.y.z-win-x64.exe` 文件名和 EXE 的 MZ 头，复制后生成 SHA-256、大小、版本和站内下载地址。头部检查并不验证签名或证明安装包身份；发布者应只选用已验收的 CCode 构建产物。

`public/release.json` 是唯一版本清单，脚本生成，不手工维护。`public/downloads/`、清单、构建产物和依赖均不进入 Git。更换版本后，旧安装文件仍保留在下载目录；正式打包前由发布者决定保留历史版本或移除旧文件。

## 检查与预览

```powershell
npm test
npm run check
npm run build
npm run test:e2e
npm run preview
```

E2E 默认使用已安装的 Microsoft Edge。其他机器可安装 Chromium 并显式选择：

```powershell
npx playwright install chromium
$env:PLAYWRIGHT_CHANNEL = 'chromium'
npm run test:e2e
```

测试服务绑定 127.0.0.1，测试完成自动关闭。截图输出到 `test-results/`。验证视口为 320/390/768/1440px；不等同于真实 iOS/Android 设备验收。

## 部署

产物目录为 `dist/`，包含官网和已暂存安装包，可以交给支持大文件下载的静态服务器。当前 Windows 包约 155.5 MiB，选择托管前确认单文件大小限制、EXE MIME 类型和下载响应；不要直接放到有较小单文件上限的平台。

本轮未配置公网域名、CDN、上传凭据，也未公开部署。localhost/127.0.0.1 的复制链接只在本机有效。局域网手机预览可运行 `npm run dev -- --host 0.0.0.0`，使用电脑的局域网 IP，并在操作系统防火墙中允许该端口；不要把此开发服务直接作为公网部署。

## 设计与来源

- 基于 Astro 静态站；保留并适配 AstroWind 的 `Headline.astro` 与 `WidgetWrapper.astro` 区块骨架。去除未使用的博客/分析/第三方嵌入，使用本站 CSS token，内容按文本输出。
- 来源：https://github.com/arthelokyo/astrowind ，参考提交 `14e1a691f80548dcc36370847b1a02c0d0b12821`。
- AstroWind MIT 原文保存在 `public/licenses/ASTROWIND.txt`，构建后继续公开保留。本站不是整个 AstroWind 模板的逐页复制。
- 品牌资源来自本仓库 `packages/ui/src/assets/chuansheng-logo.svg`。
- Xora 仅作为展示层次的参考，没有复制其代码、图片或字体。
- 工作台和右侧预览均为带标签的示意，不能作为真实执行结果或产品功能截图。
- 文案依据 `docs/specs/ccode-distribution.md`、`docs/specs/chuansheng-brand.md`；只提供 Windows 安装包，不承诺免费模型或上游自动更新。

## 视觉规范

`src/styles/global.css` 是官网 token 唯一所有者。主背景 `#faf9f6`、正文 `#24242b`、次要正文 `#64646e`、强调色 `#6d47da`；暗色覆盖由 `[data-theme=dark]` 提供。正文 16px、按钮/导航不低于44px热区；基础间距4px，主要断点768/1024，320px补充紧凑规则。动效只在 no-preference 时启用。应用 UI 的字号 token 和运行时布局不受官网影响。
