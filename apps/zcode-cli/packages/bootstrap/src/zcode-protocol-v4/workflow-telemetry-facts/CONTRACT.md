# Workflow telemetry facts

Owner: conversation。层：app。依赖：shared、zcode-cli。

公开入口为既有 conversation-telemetry-workflow-facts.ts 和本目录 contract.ts。它只派生已有
Engine actor-created/run-settled 的 workflow.lifecycle 事实，缺少 launchInputId 时不发。
宿主修正和非法来源通过 shared parser 排除，不重复生命周期/用量，不借 telemetry 诊断业务失败。

本模块不拥有 run 状态、不做持久化、不唤醒模型。类型契约直接引用真实签名，不包装实现、不另建缓存。
contract.test.ts 位于 bootstrap/tests/workflow-telemetry-facts，由现有 Vitest 发现并执行。
