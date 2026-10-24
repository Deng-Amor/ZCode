# 回执：CCode PRD §8 六项拆分（批次 ccode-prd-split-20261022）

- 回执性质：总控汇总回执（六份拆分文档批次交付）
- 台账行号：E:\ZCode\docs\prd\总控台账.md 派工 L9-L14（含取消与重派 L18-L23）、验收 L15-L17 与 L24-L26
- 日志落盘路径：本文件 E:\ZCode\docs\prd\split\回执-ccode-prd-split-20261022.md（各执行线程完整轨迹由 ZCode 会话托管，未另建日志文件）
- 池行号：不适用（本批次非清单池任务）

## 结果

验收：六份拆分文档全部产出，总控逐份实读核验——文件在盘、七章结构齐全（背景与目标/范围/现状盘点/需求细化/验收场景/依赖与里程碑/开放问题）、现状盘点断言均带代码或文档路径指针并标注 已实测/推断/待实测、验收场景均为可回读判据、与母 PRD 对应条目逐字锚定且冲突点全部进入开放问题未自行改口径：

- E:\ZCode\docs\prd\split\01-brand-and-data-isolation.md（26 条断言 B1-B15/D1-D11、场景 A1-A7、开放问题 O1-O6）
- E:\ZCode\docs\prd\split\02-login-restore-and-account.md（断言 1-9、场景 1-6、开放问题 1-6）
- E:\ZCode\docs\prd\split\03-update-channel-and-release.md（19 条断言 U1-U10/P1-P9、场景 A1-A7、开放问题 O1-O7）
- E:\ZCode\docs\prd\split\04-zcode-import.md（17 条断言 I-1~I-17、场景 A1-A7、开放问题 O1-O8）
- E:\ZCode\docs\prd\split\05-controller-expert.md（15 条断言、场景 A-E、开放问题 OQ-1~OQ-7）
- E:\ZCode\docs\prd\split\06-ledger-evidence-stress.md（10 条断言、场景 1-6、开放问题 OQ-1~OQ-6）

副作用同句写明：除上述六份新文件，以及 E:\ZCode\docs\prd\总控台账.md 与 E:\ZCode\docs\prd\ccode-product-prd.md 第 8 节回写链接和本回执文件外，仓库零写入；未执行任何 git 提交/推送，全部改动处于未跟踪/工作区状态。

## 异常

1. 首轮六线程派发中四个被取消：拆项2 在取消前已完整落盘产物（有效交付）；拆项3/4/5 无产物落盘，已重派本地线程并交付。
2. codex-10.0.0.127 通道未能建立（用户侧信息：SSH 已打通）：本机实测 22 端口开放（ED25519 主机键）、root/ubuntu/ccode/admin/administrator 五个用户名的公钥认证全部被拒（ccode_deploy 与 id_ed25519 两把钥匙均试过）；继续尝试触发对端连接重置（疑似防爆破限流），已按边界底线停手。本机无该通道凭据线索（~/.ssh 无 config、工作区与技能目录无 10.0.0.127 引用记录）。
3. 任务卡三份参考文档路径误写为 docs\specs\ 下（desktop-ci-cd.md、external-agent-commands-import.md、restore-legacy-sessions-official-plugin.md 等实际位于 E:\ZCode\docs\ 根目录）：执行线程均按实际路径实读并在各自文档中声明，不影响盘点结论。

## 处置

- 主任务未因通道阻塞停摆：拆项3/4/05 改走本地执行线程完成，与 codex 额度无关。
- 母 PRD §8 已回写六份链接与状态说明（拆分完成不等于六项已实施）。
- C:\Users\Administrator\.zcode\workspace\default\codex-task-ledger.md 追加 127 通道探测事实一行，供后续会话检索。
- 各拆项开放问题（合计约 40 项，含 05 拆项发现的内置信任公钥指纹与 spec 记录不一致、03 拆项发现的三平台更新矛盾与发布脚本缺口）全部保留待评审拍板，未代行。

## 证据

- 六份产物：E:\ZCode\docs\prd\split\01-brand-and-data-isolation.md E:\ZCode\docs\prd\split\02-login-restore-and-account.md E:\ZCode\docs\prd\split\03-update-channel-and-release.md E:\ZCode\docs\prd\split\04-zcode-import.md E:\ZCode\docs\prd\split\05-controller-expert.md E:\ZCode\docs\prd\split\06-ledger-evidence-stress.md
- 母 PRD 回写：E:\ZCode\docs\prd\ccode-product-prd.md
- 调度台账：E:\ZCode\docs\prd\总控台账.md
- codex 台账追加行：C:\Users\Administrator\.zcode\workspace\default\codex-task-ledger.md

## 自判项（待复核）

- 「完成这些任务」被解释为完成母 PRD §8 的六项拆分（产出拆分文档），而非直接实施六项工程：依据是母 PRD 状态为待评审、§8 标题即「后续拆分」、且六项实施前需先拍板各拆项开放问题。该解释待用户复核。
