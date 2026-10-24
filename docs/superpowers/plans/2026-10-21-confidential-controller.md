# CCode 中台内存总控实施计划

> 使用 executing-plans 在本会话逐项实现，独立子 Agent 审查设计和代码，不要求用户重复流程审批。

**Goal:** 中台发布核心 Skill，CCode 应用生命周期内仅内存缓存，任务调用重新注入，降低普通聊天、工具和日志泄露风险。
**Architecture:** 中台鉴权和版本授权与正文下载分开；独立应用级服务拥有缓存，CLI 只持有任务引用和固定版本。模型请求边界执行临时注入及记录隔离，受保护输出在广播/保存/工具执行前检查。
**Tech Stack:** TypeScript、Electron、现有 CLI runtime、Java 中台。
**Spec:** `docs/specs/ccode-confidential-controller.md`。

## 全局约束

- 保留已有 dirty；不提交、推送或部署。正式部署与发布内容仍需有实际证据才能声称上线。
- 用户要求普通聊天防泄露，接受专业提取仍有风险；不承诺任意模型输出绝对保密。
- 本轮开发者要求不新增或运行测试。执行类型、Lint、架构检查与独立代码审查，记录尚缺运行验收的事实。
- 不把正文放入普通 Skill、历史、环境变量、客户端文件、UI 或通用日志。
- 发布签名真实性不等于加密；服务端密钥与客户端登录分别管理。

## 审查重点

身份切换时迟到下载不得复活缓存；并发请求只下载一次但单个取消不能取消别人；续期不得静默换版本；模型失败也不能将原始请求写日志；普通聊天与任务分类错误不得触发内部规则公开。

## 1. 内存缓存及发行消费契约

文件：`packages/services/src/confidential-controller/{contract.ts,memory-cache.ts,index.ts,module.ts,CONTRACT.md,contract.example.ts}`；`architecture-policy.yaml`。

- [x] 实现 `ConfidentialControllerCache`，依赖 `ConfidentialControllerSource.authorize/download`，由装配层提供凭据；类内没有文件 IO。
- [x] `setIdentity` 建立独立身份代次；注销/换租户中止旧请求并清除缓存。
- [x] `acquire` 返回不包含正文的 handle；`use` 在再次检查身份与授权后提供临时指令及取消信号。
- [x] 同一技能版本下载合并；授权单独到期更新；绑定版本匹配、正文摘要不可变、大小及签名校验由发行消费适配器执行。
- [x] 独立审查并执行类型、Lint、架构检查。此阶段不能宣称已接通中台或桌面。

## 2. 中台登录、授权和发行接口

目标仓库：`E:/github/cs-platform-service`。先读取适用规则并检查 Git 状态。

- [ ] 复用系统租户与登录服务，新增核心 Skill 版本授权、发布与内容读取权限，固定版本、撤销及短期授权语义。
- [ ] 实现签名发布、加密存储、服务端密钥配置；不生成并冒充正式信任根，不输出凭据。
- [x] CCode 服务层增加有界 HTTPS 适配器，禁止缓存和跨源重定向；成功响应必须严格解析并验签。
- [ ] 登录态只通过私有服务通道流转；用户界面选择租户并登录，正常凭据处理遵循现有安全存储边界，Skill正文永不落盘。

## 3. 应用生命周期与 CLI 私有通道

- [ ] 根据独立生命周期审查确定应用级 cache 进程装配；跨窗口/会话/Agent重启复用，Main只负责进程与消息路由。
- [ ] 严格类型及运行时校验私有正文通道；不得走普通工具输出、可分享状态或renderer服务。
- [ ] 固定run版本，恢复/压缩/模型切换复用；未支持远端保护通道时明确拒绝，不静默回退。

## 4. 模型调用和内容泄露控制

目标：core runtime、adapters model、contracts请求类型。

- [ ] 任务激活与普通聊天分开；删除受保护身份的普通Skill加载路径。
- [ ] 仅在模型调用边界注入，从权威历史和压缩输入隔离；逐次调用保留规则。
- [ ] 禁止保护调用的 rawRequestBodyCapture、runner-debug 请求/响应正文及异常body记录。
- [ ] 回复、推理、子代理输出与工具参数在广播/持久化/执行前检查；缓冲流式输出并检查完整单元，拒绝直接索取/转换内部规则及明显原文片段泄露。
- [ ] 审计可复用公开回复不暴露私有规则；明确高级改写/隐蔽通道不能完全防住。

## 5. 迁移与最终交付

- [ ] 功能链路可用后停止打包核心 Skill，保留用户原文件，不偷偷删除；无网络不回退旧副本。
- [ ] 类型、Lint、架构与独立审查；汇总 spec 每项证据，运行验收未做则不宣称完成。
- [ ] 用户需要的源码客户端保持运行；重新打包单独记录内容和版本，旧包不冒充新实现。

## 执行记录

- 2026-10-21续：Main在spawnHostProcess中以独立MessageChannelMain装配private channel并向Host交接一个端口；child exit/port close/发送失败清理。Host在通用消息解析和日志之前识别严格交接，只接收一次，正常/异常退出关闭。Host当前仅保留端口，Agent消费者尚未接入，未start或获取正文；不得宣称完整私有执行已启用。

- 2026-10-21续：新增ccode-account-ui模块及useCcodeAccount hook，侧栏中台登录对话框使用已有Dialog/Input/Select/Button；中英翻译。密码提交清空，不持久化；关闭卸载表单。账户变化只广播失效事件，hook先订阅后读并过滤迟到结果，表单用身份/操作代次过滤迟到错误。当前仅侧栏入口，启动登录页及验证码挑战未实现。
- 2026-10-21续：实查ARMS SDK的全局fetch包装会持有rawRequest/init并传给evaluateApi；Main collectors.api增加鉴权/核心内容路径filters，在SDK原始请求捕获前跳过。普通网络capture仅method/处理URL，已实读实现。全应用/CLI审计仍未结束。

- 2026-10-21：基线 architecture 通过；确认 runner-debug 生产态也会落盘 model-io，需要保护调用显式禁用。当前任务完整目标仍有效。
- 2026-10-21：内存模块已实现，HTTP消费适配器已编写（服务器尚无对应接口）。独立审查提出的异常正文泄露、迟到消费结果、授权/并发容量、令牌等待超时问题已修正。尚未集成到应用，不可视为功能已启用。
- Ruling: 不新增contract.test.ts或其他测试 — 当前开发者明确禁止未经用户要求新增/运行测试；只做静态检查及审查，实际运行验收证据仍缺失。
- Ruling: Main仅装配一次services缓存，固定run版本归Runtime所有 — 独立生命周期审查确认窗口Host和Agent都可能被回收，不能作为应用级缓存唯一所有者。
- 下一步中台：system模块可复用TenantBaseDO/BaseMapperX及权限框架；确认ApiAccessLogFilter会预读JSON请求，GlobalExceptionHandler会记录requestParams，发布/内容端点必须从通用body与异常日志中隔离，不能仅靠controller的responseEnable=false。
- 2026-10-21续：中台已新增CcodeController/CcodeControllerService/CcodeControllerCrypto/DO/Mapper以及建表SQL，支持publish/authorize/content/revoke；AES-GCM密文和Ed25519验证、tenant绑定、事务advisory锁、撤销不回退。框架预读日志和异常resolver对敏感路径单独保护。Java17离线Maven编译成功，未执行测试、SQL或部署；正式keys/内容/角色权限仍未配置。
- 2026-10-21续：客户端新增platform-auth.ts和application.ts，复用tenant/login/refresh/logout，内存token，refresh POST form，账户公开子集不含token；缓存/身份应用级工厂尚未在Main装配。独立审查auth通过；新增端点签名/路径/UTF8兼容问题已修正。
- 2026-10-21续：Main已装配单例application，账户端口经shared/platform、preload、desktopPlatform公开；Main仅允许预期URL的应用顶层窗口，登录字段严格检查，异常仅安全码。实际退出dispose，取消退出不清缓存。trusts仍为空，未启用核心Skill；登录UI和私有Host/CLI路由仍待完成。package_review静态审查未发现阻塞；architecture与lint通过，typecheck复跑中。未启动服务或运行测试。

- 本轮最终验证：typecheck复跑exit0；architecture 0违规；lint 96现有warning/0error；git diff --check通过。未执行测试或真实登录。

- 本轮UI最终静态检查：typecheck exit0，architecture 0违规，lint 96warning/0error，独立复审无新增阻塞。ARMS RPC仅显式tRPC中间件，不包装当前账户普通Electron IPC。无真实登录或运行测试。

- 2026-10-21续：CLI generate/stream统一skipTranscript；每请求factory禁用rawRequestBodyCapture并沿重试/鉴权刷新继承，JSON解析错误不含正文。独立审查无阻塞；根typecheck/lint/architecture通过，CLI typecheck补仓库工具PATH后32任务成功，CLI lint0error/70warning。runner-stream原1580+行单文件按既有策略登记warn，阈值仍800。未跑测试，完整私有通道与模型防泄露未完成。

- 2026-10-21续：新增应用私有channel服务，ready/complete/completed授权复核，取消/过期/注销清理，8calls/16channels限额和退出终态。独立复核通过，typecheck/lint/architecture通过，未运行测试。尚未接Electron/Host/CLI，完整模型注入和输出防护继续实施。

- 2026-10-21续：Host relay已start并严格校验/单播，独立审查通过。本轮新增child-channel Node IPC适配器，chat factory透传Host→createLocalServices→ProcessManager，退出/断连释放peer。命令必须显式supportsConfidentialControllerIpc才建第四stdio；默认CLI尚不声明，消费者待实现。独立审查发现tap代理不转发IPC，已改为能力命令绕过tap并复核通过。根typecheck修复spawn重载后通过；lint96warnings/0errors、architecture0违规、diff检查通过。没有测试、服务重启、部署或新安装包，完整目标继续。
- 2026-10-21续：新增CLI私有IPC消费端及公开包子路径，8calls/30s握手、严格事件、取消信号、complete确认后才返回缓冲值、安全异常。独立审查通过，根/CLI typecheck与lint、architecture通过；无测试。bootstrap/model与默认能力尚未启用，继续完整目标。

- 2026-10-21续：消费端complete之前新增纯JSON快照+规范化正文片段筛查，覆盖字符串/keys/text+delta分片，拒绝后仅安全错误；JSON预检防静默改工具参数。独立审查问题已修并复核，根/CLI静态检查通过，无测试。实际模型入口尚未启用，继续调用隔离与全链路目标。

- 2026-10-21续：runner请求/全局/admission状态出口按私有metadata白名单隔离，日志关闭且强制skipTranscript；保留准入生命周期和白名单额度码，修复独立审查指出的误限流风险，复核通过。根/CLI静态检查通过，无测试；实际注入/缓冲/最终错误隔离仍待集成。

- 2026-10-21续：Model executor新增Runtime私有port路径，临时system注入、完整缓冲筛查确认后返回/回放，分通道重建修复交错漏检；脱敏模型错误保留调度分类，拒绝SDK预执行工具。独立复审通过、根/CLI静态检查通过，无测试。Runtime/bootstrap端口未装配，默认未启用，继续完整目标。

- 2026-10-21续：Runtime/App optional私有端口贯穿主step/core子代理/dynamic与legacy workflow子Runtime；新增只存版本的task scope，首ready锁定、并发不同版拒绝、后续固定版。独立审查遗漏已修，静态检查通过，无测试。任务入口尚未创建/恢复/关闭scope与自动激活，继续完整目标。

- 2026-10-21续：Skill保留名改为Runtime授权激活（保护factory配置时），固定确认无正文；新外部turn清active、同target复用scope，子任务捕获快照。增加前置hook之前及handler前的执行门禁，封住并行子任务抢跑；审查修复并复核。默认client/factory尚未装配，继续完整目标。
