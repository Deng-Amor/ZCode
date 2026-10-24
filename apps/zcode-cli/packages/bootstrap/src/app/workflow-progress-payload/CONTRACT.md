# Workflow progress payload

Owner: agent-runtime。层：app。依赖：shared、zcode-cli。

公开入口为既有 dynamic-workflow-run-progress-payload.ts 和本目录 contract.ts。现有 Engine
事件页与父会话进度共用有界序列化；宿主修正是独立父会话观察，不伪造 Engine 事件或 journal cursor。
host 只允许 RecoveryUncertain/errored、显式来源和 sequence=0，通过 shared 唯一 parser。

本模块不拥有 run 状态、不做 IO、不执行 driver/model。保留既有 mintActorSessionId 应用接线，
因此登记为 app。元数据与类型契约不引入运行时包装或第二份规则。contract.test.ts 位于
bootstrap/tests/workflow-progress-payload，由现有 Vitest 发现并执行。
