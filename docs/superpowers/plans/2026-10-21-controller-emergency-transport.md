# 总控备用授权 ECA-1 实施计划

> 执行方式：独立子 Agent 实施，主 Agent 验证，另一 Agent 复审。使用 subagent-driven-development/TDD；流程评审按用户自主评审规则执行，不提交 Git。

**Goal:** 将主源 HTTP 失败划分为受控连接/超时候选与不可切换结果，保留现有公开码；不启用备用服务。

**Architecture:** 现有 http-source 是失败事实的唯一来源。内部错误类型继承安全错误类，不挂原始 cause；内部判断不从模块公共 index 导出。cache、private-channel、Runtime 与身份 owner 不变。

**Tech Stack:** TypeScript、Node fetch/AbortSignal、现有 Vitest。

**Spec:** `docs/specs/ccode-emergency-authorization.md` ECA-1/ECA-T01/ECA-T02。

## 全局约束

- 保留工作区既有改动；单一写者。无真实网络、服务、授权、密钥、明文文件和生产部署。
- 原公开错误码保持兼容。任意 UNAVAILABLE、未知 TypeError、TLS、业务拒绝均不自动获得切换资格。
- token 成功且 fetch 开始后才分类连接失败；父 signal 取消优先。已观察到终止结果不可被迟到超时覆写。
- 不改 platform-auth、公共 IPC、run store、cache 或包依赖；不提前实现后续设备/密文/grant 接口。

## 文件与步骤

- [x] 读取适用规则与现有 source 测试；保存目标原 SHA、非目标保护清单；执行架构 baseline，读取服务模块受控上下文。
- [x] 在 `packages/services/test/confidentialControllerHttpSource.test.ts` 增加聚焦测试（存在时先读并保留）。真实 source + 内存 fetch 替身，使用合成值，恢复 globals/计时器；先运行 RED 并确认失败来自缺失分类。
- [x] 在 `packages/services/src/confidential-controller/transport-failure.ts` 实现模块内部类型与判定；只暴露模块内导出，不加 index 公共入口。类型固定类别，错误 message/code 安全，不保留原始 cause。
- [x] 修改 `http-source.ts`：分清 token 与 fetch 阶段、保留独立 timeoutSignal、锁定终止结果；仅受控 shallow errno 白名单或明确 timeout 可候选，原公共 code 不变。中文注释说明分类边界。
- [x] GREEN：运行新测试及实际找到的相关 source/cache 测试；不运行全量。检查新 UT 是否被类型配置覆盖并如实记录。
- [x] 运行目标格式/Lint、架构 after；主 Agent 执行根 `pnpm typecheck`、`pnpm lint`。本片段不改 CLI 源码，不为此重复 CLI build/typecheck。
- [x] 独立审查代码与 RED/GREEN、取消/超时优先级、错误信息不泄漏、非目标 SHA；修正问题后复核。

## 必需断言

1. token 失败即使 cause 为连接错误也不可候选；身份/认证错误保持原码。
2. 实际 fetch 的 ECONNREFUSED/ECONNRESET/ETIMEDOUT/明确 Undici 连接超时按批准白名单分类；未列 errno 不猜测。
3. 独立超时与调用方取消区分；token 阶段超时不可候选；父取消胜过网络异常。
4. TLS/证书错误、未知 TypeError、401/403、业务 code 非零、非 JSON/无 no-store/坏 JSON/超限均不可候选；终止错误后 signal 到期不能改判。
5. 异常字段/JSON/message/cause 不包含合成 sentinel；成功授权与下载结果保持合同，未出现备用请求。

## 复审重点与未覆盖项

测试覆盖的是实际 source 内部分类，不是连接失败时获准续跑。DNS配置故障、HTTP 5xx、取消并发身份切换、响应读取中超时需逐项说明分类。密码协议、设备密钥、签名拒绝水位与真实服务均留在后续 ECA 片段，禁止用本片段通过宣称整体交付。


## 完成证据

ECA-1 已独立验收。实际 source RED 为 9 失败、27 通过；最终标准 Vitest 入口 2 文件、37 测试通过。目标格式/Lint、架构检查通过；根类型检查首次 OOM，逐项目串行预热后原 pnpm typecheck 通过，根 pnpm lint 为 0 错误、100 警告。新测试未纳入 services 的 src 类型检查范围。独立最终报告及原始日志保存在本会话交接 controller-emergency-transport/final-review.md 和 implementation/resume-after-space。该验收仅覆盖失败分类，不代表备用服务已启用。
