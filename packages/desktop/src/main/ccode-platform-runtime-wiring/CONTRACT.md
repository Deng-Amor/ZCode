# ccode-platform-runtime-wiring

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

意图：把 services 层 ccode-platform-runtime 组合根接进 Electron Main——订阅 confidential-controller 账号状态（登录→start，登出→stop），持有带认证头的 fetch 包装供遥测/回流/指令三条出网链复用，并在 will-quit 收尾。它是这些 services 模块在 Main 的**唯一**装配点。

不变量：

- 本模块不 import electron；账号、目录、fetch 全部经 options 注入（可在 vitest 里整体替换）。
- 状态迁移串行化：onStateChanged 回调经 `transition` promise 链排队，不并发 start/stop；一切异常走 `warn` 不上抛。
- 登录态为唯一启停依据；`account.getAuthHeaders()` 未登录时 rejects，由各 uploader 的退避/认证暂停语义消化，本模块不做重试。
- dispose 幂等且永不 reject；重复调用零副作用。
- 指令信封验签公钥、长轮询端点均为占位（待中台 M7 定稿），端点上线前通道只产生网络类退避，无业务效果。

交集 hook 点：

- confidential-controller：只经 `DesktopCcodeAccount` 窄口（getState/onStateChanged/getAuthHeaders），不触其内部类型与私有通道。
- audit-telemetry / skill-reflow-upload / platform-command-channel / ccode-platform-runtime：只经 `@zcode/services/*` 公共子路径出口消费，真工厂组装形态锚定 `packages/services/test/ccodePlatformRuntimeAssembly.test.ts`。
- 回流上传驱动（queue→uploader→recordReceipt 编排）不在本模块；归 skill-reflow-upload 侧驱动器与后续 Main 触发卡。
