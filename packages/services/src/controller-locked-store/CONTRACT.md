# controller-locked-store

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

不变量：

- 更新器是锁定存储唯一写入者；正文整包加密后通过 staging 文件原子替换。
- manifest 的 current/rollback 只保存版本、digest、落地时间和加密快照，不保存明文。
- load 必须复核整包 digest 与每个文件 sha256，失败不得返回正文。

交集：验签依赖 `@zcode/shared/managed-skills`，加密能力由 Desktop 装配层注入；本模块不访问真实网络或 safeStorage。
