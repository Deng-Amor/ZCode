# 回执：CCode 客户端开发批次3b（总控 skill 化）——2026-10-23

- 批次范围：总控本地锁定 skill 架构落地（`docs/specs/ccode-controller-local-skill.md` 迁移清单）+ 平台运行时收尾件。母 PRD v1.1 §4.6 三层架构的客户端侧。
- 派发与验收：全部经 codex 后台任务卡（zhipu-brain 协议），总控独立复跑验收；判例与缺陷修复见 `总控台账.md` 行 77-100。

## 交付清单

| 卡 | 内容 | 状态 |
| --- | --- | --- |
| C13 | Electron Main 平台运行时装配（登录启/登出停/will-quit 销毁/认证 fetch 包装/getAuthHeaders 窄口） | ✅ 含编码事故字节级还原（台账行 86） |
| C14 | 诊断 bundle 触发器（diagnostic.bundle 引用事件+两臂+同臂同日幂等；总控修复 UTC→本地日界） | ✅ |
| C15 | 专家 skill 上 Skill 面（expert: 命名空间注入/占用过滤/内容端口加载/固定错误码） | ✅ 组合点与通道留后续 |
| C16 | 回流上传会话驱动器（分批/读盘/上传/回执消费/停批语义） | ✅ |
| C17 | 回流触发→驱动接线（onTriggerSession 回调+uploader 归因；总控修复固定路径测试缺陷） | ✅ |
| C18 | 总控本地锁定存储+更新器（整包加密/原子替换/digest 复核/回滚；总控修复 status 冷读+回滚膨胀两缺陷） | ✅ |
| C19 | 诊断 bundle 接线 Main wiring（bootstrap_failed 臂+每日摘要臂；builder 端口留接） | ✅ |
| C20 | 锁定加载层（skill-port P6b+core handler P6a 命中加载+stub 两层触发文案） | ✅ |
| C21 | 拆除 globalSystemPrompt 注入链+activateConfidentialController 管道（P5 全链/P4 CLI 侧；bootstrap.ts 退役） | ✅ 7 个 core 失败定性为本机 CRLF 夹具既有问题 |
| C22 | Main 侧锁定存储所有权（P2：装配 install/登出不清正文/getLockedContent/safeStorage） | ✅ |
| C23/C23R/C23R2 | 锁定内容通道（private-channel 协议 locked-content 化/按需 client/Host relay→Node IPC→Agent 入口注入 createApp） | ✅ 侦察结论(a) 沿用既有 Node IPC |

## 新总控架构端到端链路（已闭合）

模型调用 Skill(总控派单) → core handler 命中加载 → skill-port(locked) → locked-content client → Agent Node IPC → Host relay → Main private channel → application.getLockedContent → 锁定存储解密+digest 复核 → 正文仅进入该轮上下文。未装配/验签失败→固定提示诚实降级；登出不清副本；stub 常驻（discover 元数据条目）承载意图判定。

## 拆除清单（旧路线退役）

- globalSystemPrompt 全链（cli main 读取/bootstrap entrypoint 透传/context builder 全局段/subagent 继承）——rg 零命中。
- activateConfidentialController executor 管道。
- readControllerBootstrap stdio 客户端+其测试。
- 旧 bootstrap/bootstrap-ready 私有通道协议（保留通道基建承载新协议）。

## 未完项（后续批次）

- 更新源自接线（application updateSource ← http-source，Main 不接；C22 取舍）。
- 专家 skill 组合点+Main→CLI 通道（C15 收尾）；任务终态错误源（诊断 bundle 第三源）；诊断 archive 真实 builder 接线。
- references 文件级按需读取（spec OQ-8）；OQ-L8 文档同步（confidential-controller 头部/managed-controller-skills 头部）。
- 已知环境项：本机 autocrlf CRLF 夹具致 core 7 个 memory 测试失败（LF 机器可过）；`tsc -b` 直构 apps 包会在 src 落 .js 渣滓（验证流程 build 后须清理）。
- Agent 入口 fake-process 单测（C23R2 唯一缺测）。

## 验证快照（总控终验）

- services/adapters/bootstrap/desktop-main 定向测试与四包 tsc 全绿（分层复跑：10+6+28+11/11+5/5+18/18+135/135）。
- `pnpm architecture:check --changed` 0 违规（.js 渣滓清理后）；`pnpm lint` 0 error（既有 warning 104-107 条如实区分）。
- 全量 `pnpm test` 未跑（含桌面 E2E 与既有环境失败，留收尾批次统一处置）。
