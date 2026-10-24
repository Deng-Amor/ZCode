/**
 * skill-reflow-upload 标准调用示例：装配层（后续集成卡，Main/CLI 启动序列）按此
 * 模仿组装本模块；示例本身可编译、类型即文档。
 */
import { mkdir } from "node:fs/promises";
import type {
  SkillReflowClock,
  SkillReflowDedupLedger,
  SkillReflowRootProvider,
  SkillReflowScanRoot,
  SkillReflowTriggerScheduler,
  SkillReflowUploadQueue,
} from "./contract.js";
import { createSkillReflowLedgerFile } from "./ledger.js";
import { createSkillReflowQueueFile } from "./queue.js";
import { createSkillReflowUploadService } from "./service.js";

/**
 * 最小装配：注入根提供者（roots 解析权威在 apps 层 resolveDefaultSkillRoots，
 * services 不反向依赖 apps，故以端口注入）+ 账本/队列（同一私有数据目录），
 * 每日首启触发一次；扫描只读用户技能目录，任何失败内化为状态面错误码。
 */
export async function exampleAssembleDailyReflowUpload(
  dataDirectory: string,
  rootProvider: SkillReflowRootProvider,
  scheduler: SkillReflowTriggerScheduler,
): Promise<ReturnType<typeof createSkillReflowUploadService>> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const ledger: SkillReflowDedupLedger = createSkillReflowLedgerFile({
    storageDirectory: dataDirectory,
  });
  const queue: SkillReflowUploadQueue = createSkillReflowQueueFile({
    storageDirectory: dataDirectory,
  });
  const clock: SkillReflowClock = { now: () => new Date() };
  const service = createSkillReflowUploadService({
    rootProvider,
    ledger,
    queue,
    stateDirectory: dataDirectory,
    scheduler,
    now: () => clock.now(),
  });
  // 幂等：同日重启时 runDailyFirstLaunchTrigger 返回 alreadyTriggeredToday，
  // 不重复扫描（spec §6.1 源 1）。
  await service.runDailyFirstLaunchTrigger();
  service.armDailyTrigger();
  return service;
}

/** 根提供者的装配侧实现示例：把 apps 层解析出的根映射为端口形态。 */
export const exampleRootProvider: SkillReflowRootProvider = {
  // 实际实现调用 resolveDefaultSkillRoots（apps/zcode-cli/packages/adapters，
  // spec E1/E6），只取 user/project scope 的 agents/zcode 来源根；
  // extraRoots 等归属不明根默认排除（spec §5.3 OQ-5）。
  async listRoots(): Promise<readonly SkillReflowScanRoot[]> {
    return [
      { id: "user-zcode", path: "~/.zcode/skills", scope: "user", source: "zcode" },
      { id: "project-agents", path: "<workspace>/.agents/skills", scope: "project", source: "agents" },
    ];
  },
};
