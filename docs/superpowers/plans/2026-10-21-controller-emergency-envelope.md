# ECA-2a 签名密文内容验证实施计划

> 执行方式：设计、仓库 spec、实施计划及代码已完成独立评审，本片段已实施。主 Agent 验证，独立子 Agent 审查，不提交或发布。

**Goal:** 用一个固定的标准 JWS profile 验证签名 manifest，以 AES-256-GCM 解密合成密文，再复用原 inner verifier，返回已验证内容。

**Architecture:** 增加 services/confidential-controller 内部纯模块，没有 IO、注册、业务状态或缓存所有权。输入均为已提供的有界 bytes、受信任期望发行及测试/内部调用者提供的 CEK。只返回 VerifiedManagedSkillBundle，绝不返回授权、grant 或 lease。不装配 application/source/cache，生产无调用者。

**Tech Stack:** TypeScript、node:crypto、TextDecoder、现有 zod 和 Vitest；候选不新增依赖。

**Spec:** docs/specs/ccode-emergency-authorization.md（ECA-2a 合同已实施并完成聚焦验证）；上游 REVISE 为 controller-emergency-envelope-design-review.md。原大稿的 tuple 编码、NFC 全域约束、domain+NUL 自定义签名包装不进入本切片。

## 全局约束与明确排除

- 仅内容真实性/完整性验证，不证明任何运行获授权；本地版本/摘要、成功解密都不是续跑许可。
- 不实现 continuation、grant、设备封装/证明、策略/时钟 evaluator、撤销/挑战/账本、source fallback、网络或磁盘 adapter。
- 不新增/修改 cache 或 Runtime owner；不改 UI/IPC、包公共 exports、服务装配或普通授权路径。
- 合成密钥只在内存，不读取真实 key，不安装依赖，不部署、不启动服务、不跑 GUI/模型，不设生产 TTL。
- 包内 keyId 只用于从调用方受信任集合查找，不能导入消息提供的 key/URL/证书；与内层 trust 独立。
- 原 managed-skills payload 摘要仍是内层 payloadBase64 解码 bytes 的 SHA256。

## 只读源码依据与选择理由

已读 packages/shared/package.json、packages/services/package.json、相关 exports、managed-skills/verify.ts、memory-cache.ts 和 Vitest 入口。shared 直接依赖只有 workspace model-option-map 和 zod；services 有 node-forge/zod，但无 jose/jsonwebtoken 直接依赖。根/desktop 所查 package.json 亦未发现直接 JOSE 项；不把锁文件传递包当可用公共 API。

公开复用入口：@zcode/shared/managed-skills 导出 verifyManagedSkillBundle、ManagedSkillTrust、VerifiedManagedSkillBundle、MANAGED_SKILL_BUNDLE_LIMITS。现有 verifier 用 Ed25519 验原始 payload bytes，检查 path、文件 hash、minimumVersion、SKILL.md。Markdown-only 是 memory-cache.ts 中单独的 /\.md$/i 规则，inner verifier 本身不提供；最小模块在返回前执行相同限制，不为消除这一行判断重构 cache。

选择 RFC 7515 Compact JWS + RFC 8037 alg=EdDSA/Ed25519。理由：其签名输入和 base64url 规则已有标准，无需自定义签名容器或 canonical JSON；固定一个算法、一把匹配 key、一份 payload 的 profile 可由 Node 标准 crypto 很小地实现。实现仅负责此 profile，不能命名/扩展成通用 JOSE 库。若后续需要多签名、JWK、算法协商、JWE 或 JWT，应重新评审直接 jose 依赖，不能持续堆分支。

## 固定 JWS profile

wire 输入为 ASCII compact 字符串 `protected.payload.signature`，恰好三段，均非空、无空白。payload 是 manifest 原始 UTF-8 JSON bytes 的无填充 base64url；不是 detached payload。拒绝其他 JWS JSON/flattened/general 表示、多个签名与 RFC7797 unencoded payload。

签名输入精确为 ASCII(protectedSegment + "." + payloadSegment)，用 crypto.verify(null, input, trustedEd25519Key, signatureBytes)。不加自定义域前缀，不签 decode 后 payload，不重新 JSON.stringify 验签。每段 base64url 必须只含 [A-Za-z0-9_-]，解码后再编码相等以排除非规范 pad bits；禁止 =、+/、空段。signature 解码必须 64 bytes。

protected header 严格 parsed schema：恰好 {alg:"EdDSA", kid:非空有界字符串, typ:"ccode-encrypted-manifest+jws"}。typ 是应用 profile 标识，不宣称 IANA 已注册媒体类型。拒绝未知 header 成员，故 crit、b64、jwk、jku、x5c、x5u、x5t、zip 等只要出现就拒绝（即使 crit 空数组/b64=true）。无 unprotected header。alg 固定，无 none/HMAC/RSA/Ed448 fallback；key.asymmetricKeyType 必须为 ed25519。header 解析只作有界查表，验证前不返回业务数据或执行网络动作。

trust 是内部参数：精确允许 kid 与 Ed25519 公钥的集合，由可信调用者提供；不存在、重复匹配、空集合拒绝。公钥只接受公钥对象或单个 SPKI PUBLIC KEY，拒绝私钥输入。外层发布 key 与 inner ManagedSkillTrust 各自校验，不能一方覆盖另一方。

### JSON 重复成员的显式选择

本候选采用 RFC7515 §4 允许的“lexically last duplicate member”处理：单一原生 JSON.parse 解析 protected header，重复名称以最后值为准；manifest 和 AAD header 采用相同明确规则。每个结构只解析一次，把严格 schema 结果传给后续逻辑；禁止其他实现路径采用 first-wins、merge 或对原文 regex 取字段。签名仍覆盖全部原始文本，包括重复字段。未知成员最后值仍是未知成员，始终拒绝。

这是有意选用标准允许的确定语义，并非声称 JSON.parse 能检测/拒绝重复键。测试必须覆盖重复 alg/kid/typ、重复 version/tenant 和转义等价 key，断言所有比较使用最后值；例如最后 alg=none 必须拒绝，最后 alg=EdDSA 则仅能在受信任 Ed25519 对完整原文签名成功时继续。不能写“所有重复成员都拒绝”的错误验收。

选择理由是避免仅为重名检测新增自写 JSON tokenizer/canonicalizer。若独立评审要求全量拒绝重复成员，则此点为明确阻断，改选经审查直接 JSON parser 依赖后再冻结；不得以 regex 或 JSON.parse reviver 冒充重复检测。跨语言实施者必须使用等效 last-wins 或更严格拒绝，不能采用不同字段值。格式非 canonical，不要求属性排序、NFC 或对象回编码一致；业务 ID 按既有规则精确比较，不额外统一 Unicode。

## Manifest 与 AAD（无循环、无重序列化）

外层输入接口只接收 `{manifestJws: string, ciphertext: Uint8Array}`，不在此切片定义磁盘大 JSON/base64 包；这不是第二种签名容器，C 是已有 bytes 参数。

manifest 原始 JSON payload 的严格字段：
- schemaVersion: 1
- headerBase64url: 原始 AAD header UTF-8 JSON bytes 的无填充 base64url
- ciphertextDigest: SHA256(C)，小写 64 hex
- ciphertextBytes: C 精确字节数，正安全整数
- tagBase64url: GCM 16-byte tag，规范无填充 base64url

AAD header 严格字段：
- schemaVersion: 1
- tenantId: 非空有界字符串，与调用者期望值逐字比较；不支持 wildcard
- skillId: 与现有 managedSkillIdentitySchema 一致，且必须匹配期望发行
- version: 正安全整数，精确匹配预期，不允许只检查 >=
- releasePayloadDigest: 原内层 payload 原始 bytes 的 SHA256，小写 64 hex
- plaintextBytes: 解密后原 ManagedSkillEnvelope UTF-8 bytes 的长度
- algorithm: 固定 "AES-256-GCM"
- ivBase64url: 规范无填充 base64url，解码恰好 12 bytes

AAD **恰好为 headerBase64url 解码的原始 bytes**，不包含自定义域前缀，不将 JSON 对象重序列化。Header 不含 C 摘要或 tag；发行顺序是建立 Header -> AES GCM(P, CEK, iv, AAD原始Header bytes) -> manifest(C摘要/长度/tag/Header bytes) -> JWS，因而无循环。签名覆盖的 headerBase64url 精确绑定 AAD/iv/发行，manifest 同时覆盖 tag 与 C 摘要。

P 为现有 ManagedSkillEnvelope 的 UTF-8 JSON bytes；其中原 payloadBase64/signatureBase64 的标准带填充 base64 合同保持不变，不能误改为 JWS base64url。发行方每包随机 CEK32/iv12，同 CEK nonce 唯一；该纯消费函数无法证明发行端从未重用 nonce，此限制写入发布合同并在合成 fixture 使用新随机 key/iv。CEK 不入 manifest。

可计算 manifestPayloadDigest=SHA256(JWS payload 原始 bytes) 供后续协议参考，但本切片不创建 grant 或把该摘要替换 releasePayloadDigest，也无需持久化它。

## 输入界限与解密顺序

候选资源上限：JWS compact <= 16 KiB ASCII；protected decoded <= 1 KiB；manifest decoded <= 8 KiB；AAD header decoded <= 4 KiB；kid/tenantId <= 256 UTF-8 bytes；C/P <= MANAGED_SKILL_BUNDLE_LIMITS.envelopeBytes = 20 MiB；CEK32、iv12、tag16、signature64 固定长度。每个 base64url 解码前按 decoded 上限计算 encoded 最大长度；不会先任意 split/decode 无限字符串。manifest 中声明长度必须同时满足实际 C 长度和 Header plaintextBytes（无压缩 GCM 的 C/P 等长）。版本/长度拒绝 NaN、Infinity、负数、非整数及溢出。fatal UTF-8 解码，拒绝 BOM，严格 unknown-key/schema 校验。

1. 验接口类型/原始长度，防御复制调用者 C 和 CEK（避免调用期间篡改）；函数同步且无 await/callback，返回 owned bytes。CEK caller buffer 由调用方管理，本函数只清零自己副本。
2. 切 JWS 三段、检查长度/base64url；解析 header、可信 key 查找、验精确 ASCII signing input。验签前不解析业务 manifest，不运行解密。
3. 解码/解析 manifest 和保存原始 AAD bytes；检查期望 tenant/skill/version/releasePayloadDigest、算法、实际长度、SHA256(C)、tag/iv 长度。失败均不得调用解密。
4. createDecipheriv("aes-256-gcm", CEKcopy, iv, {authTagLength:16})；setAAD(rawHeader)、setAuthTag(tag)。update 返回 bytes 只留局部 Buffer，final 成功前不解析、字符串化、返回、日志或给 callback。采用同步 return 接口而非流式消费者。
5. final 成功后 concat 有界 P，检查长度并 fatal 解码/JSON.parse 现有 inner envelope；verifyManagedSkillBundle(envelope, innerTrust)；精确重算 payloadBase64 bytes 的 SHA256 与期望/header 相等；验证返回 skill/version 和所有 path 都匹配 .md。
6. 返回独立 owned VerifiedManagedSkillBundle。finally 尽力清零 CEKcopy/临时解密 buffers；失败时不能返回任何部分内容。inner verifier 已生成的有效文件 bytes 是结果，不清零成功结果。JS 字符串/GC 无物理擦除保证，不能宣传管理员不可提取。

错误为内部固定 code（INVALID_ENVELOPE/UNTRUSTED_SIGNATURE/BINDING_MISMATCH/INVALID_CONTENT/DECRYPT_FAILED 等最终命名在 spec 固定），无原始 cause、正文或 key。此函数不发日志，不接收任意 stdout/debug hook。即便成功，也不能授予租约或接入生产 source。

## 文件范围与 spec 具体修改

本次文档迁移范围（已写并完成独立复核）：
1. docs/specs/ccode-emergency-authorization.md：将 ECA-2 拆为 ECA-2a 内容验证与后续授权合同；完整记录以上唯一 JWS profile、raw-byte AAD、摘要命名、last-wins 选择、资源限额、非授权返回和 no production wiring。给 ECA-T05 增加最小合成子场景，标记其不覆盖 ECA-T03/T04/T06/T07/T08。
2. docs/superpowers/plans/2026-10-21-controller-emergency-envelope.md（本文件）：记录本切片步骤、边界和门禁，与 spec 一起复核后实施。

源码仅新增两文件，现有 ECA-1 三目标保持不动：
- packages/services/src/confidential-controller/encrypted-release.ts：纯内部类型、固定 JWS/profile/schema 与 AES/inner 校验。函数例如 verifyEncryptedControllerRelease(input, expectedRelease, contentTrusts, innerTrust, cek): VerifiedManagedSkillBundle；不得从 index.ts 或 services/node.ts 导出。
- packages/services/test/confidentialControllerEncryptedRelease.test.ts：合成发布 helper 与真实 crypto 正反例；如长度需要额外 helper，由评审后限定测试内拆分，不能顺手重构生产 cache。

无 package.json/lockfile、shared verifier、application/cache/http-source/transport-failure、设备接口、CI 或架构规则修改。跨包仅用 @zcode/shared/managed-skills 公开入口。若现有模块架构上下文禁止新内部纯文件，停止并按实际边界改计划，不能先绕策略。

## 执行步骤（本片段已完成）

- [x] 确认 E 可写、root typecheck 因 ENOSPC 损坏派生产物已按主任务处理；核对 Git 与保护 SHA，保留并发改动。先运行 node scripts/check-workspace-freshness.mjs。
- [x] 更新并独立评审上述 spec/计划，特别批准重复成员处理、资源上限与唯一标准 profile；不以本文替代评审。
- [x] 按 architecture-governance 执行 pnpm architecture:check --changed 并读取目标 services 模块受控 context，记录 baseline。
- [x] 写聚焦 RED 用例：真实内外不同 Ed25519 key、随机 CEK/iv、小合成 Markdown 经 JWS+GCM 解密能回到相同 bytes；import/缺函数 RED 要进一步确认真正行为缺失，不将其他工具失败当 RED。
- [x] 实现仅上述内部纯模块；执行下列针对性测试至 GREEN。再补反例，确保每类拒绝可定位到安全边界。
- [x] 运行 pnpm exec vitest run packages/services/test/confidentialControllerEncryptedRelease.test.ts packages/services/test/confidentialControllerMemoryCache.test.ts；实际测试入口以当前 Vitest config 为准，禁止改成全量 pnpm test。
- [x] 主 Agent 执行 pnpm typecheck、pnpm lint、pnpm architecture:check --changed 和目标格式检查，记录真实 exit 与已有失败。不为本切片重建 CLI/启动 GUI。
- [x] 独立复审 raw signing input、AAD bytes、不可信 header、无明文早放、非公开入口和保护 SHA。未通过则留在片段内修正，不装配备用服务。未经用户另行授权不提交/推送。

## 合成测试清单与评审重点

1. 正向真实 Ed25519 JWS + AES-GCM + 原 inner verifier；raw manifest/header 使用不同属性顺序和合法空白也成功（证明不依赖重序列化）；更改空白但不重签须失败。JWS signing input 与标准 RFC 定义逐字节断言，可由第二份独立 fixture 构造器计算，不能只测同一个实现自签自验。
2. 固定算法：none/HS256/Ed448、未知 kid、错误用途 key、私钥 trust、未知 header/crit/b64/jwk/jku/x5c、多段/缺段、非法 alphabet/padding/pad bits 全拒绝；不触发网络/动态 key 加载。
3. 重复成员与转义 key 的 last-wins 精确测试：最后值控制严格 schema/绑定，签名覆盖全部原文；禁止 first-wins 或混合解析。全量重复拒绝若被要求则先换获批 parser 方案，不写自制 tokenizer。
4. C/tag/iv/AAD/header/外签名/内签名逐一篡改；同一原正文重新加密后的两份合法包互换 C/tag/Header，拒绝；期望 tenant/skill/version/payloadDigest 不符拒绝。
5. 缺/额外字段、非法 UTF-8/BOM、非 JSON、上限前后字节、C/声明/P 长度不符、错误 key 长度；不分配超限 Buffer。测试整数边界及 Unicode ID 精确比较，不自动做 NFC/casefold。
6. GCM update 成功但 final 因 tag 错误而失败，函数抛安全错误且无 return 值/消费者 callback；模块无日志/流式输出。不得仅断言 throw 就宣称所有外部泄露出口验证完成。
7. 外层和 GCM 正确但 inner 文件 hash/path/minimumVersion/SKILL.md 错误、非 .md 文件、原 payloadDigest 不符，仍拒绝。inner 正常错误不泄露内容，已知正常 cache 测试不回归。
8. caller C/CEK 未被修改；成功结果 owned bytes；输入参数 CEK 仅内部纯函数使用且无 public export/生产调用。源码静态检查确保无 IO/logger/source/cache 装配。

本片段已通过 82 个聚焦测试、根类型检查、根 Lint（100 个警告、0 个错误）、目标格式与架构检查及独立代码审查。新测试文件未纳入 services 的 src 类型检查范围；资源边界测试未穷尽每一限制的 N-1/N/N+1。本片段只解决 REVISE 的 B1/B4 最小内容切片；B2 权限水位映射、B3 完整时间接受谓词和所有真实独立服务/设备前置条件继续留待后续设计，不以“暂不处理”暗示已通过。