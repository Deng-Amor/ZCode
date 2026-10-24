# CCode 官网更新源

Windows x64 安装版启用已有更新器。Preview 固定使用 https://ccode.sccsai.com/updates/preview/windows-x64/latest.yml，正式版固定stable路径；安装身份不跟随接收预览更新设置改变。其他平台暂不启用此Windows清单。保留显式启动参数/环境更新源覆盖。

开启构建开关ZCODE_AUTO_UPDATE后，自动检查及手动菜单均可用；不再按Preview身份禁用。沿用既有下载提示和用户安装设置，不新增强制安装。网站发布流程生成版本/files/url/size/sha512清单，安装包先上传、清单随后发布，渠道隔离。旧0.0.3需一次手动升级到启用更新的构建。

用户要求串行、不跑验收；本次不恢复总控台账并发工作。构建部署状态单独报告。
