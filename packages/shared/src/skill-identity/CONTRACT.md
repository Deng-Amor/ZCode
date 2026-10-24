# Skill identity predicates

Skill 保留名/专家命名空间身份判定的唯一权威实现（pure functions，零 IO、零依赖）。
Public entrypoint: `@zcode/shared/skill-identity`。

不变量：

- 判定语义为 NFKC 归一 + 路径分段匹配（`\` `/` `:` 三分隔符、逐段 trim）：
  全角变体（`ｅｘｐｅｒｔ：`、`ｃｏｎｔｒｏｌｌｅｒ`）与路径别名（`locks/controller`、
  `总控派单/alias`）同样命中；裸名 `expert` 不占用命名空间，普通名不命中。
- 保留名家族：`CONFIDENTIAL_CONTROLLER_SKILL_NAME`（「总控派单」）与
  `CONFIDENTIAL_CONTROLLER_SKILL_ID`（`controller`）互斥于专家命名空间
  （`EXPERT_SKILL_NAMESPACE` 前缀身份），两组判定互不重叠。
- 本模块是唯一事实来源：contracts（`@zcode/contracts` 的 `skills` 出口）与
  services `skill-reflow-upload` 一律从本入口转出口/导入，禁止再持有实现或镜像。
  语义变更必须改这里并同步两侧消费者测试，不允许在消费方单独加分支。
- 纯函数模块：不得引入 IO、平台 API 或对其他 managed 模块的依赖
  （requires 为空）。

迁移记录：2026-10-22 批次2b 卡5 从
`apps/zcode-cli/packages/contracts/src/skills/index.ts` 原样迁入
（语义逐字节保持），contracts 原出口签名不变、改为转出口委托。
相关 spec：`docs/specs/ccode-expert-skills-distribution.md` §5.3、
`docs/specs/ccode-skill-sync-upload.md` §5.3。
