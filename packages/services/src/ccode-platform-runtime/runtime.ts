import { DEFAULT_COMMAND_CHANNEL_POLICY, type CommandChannelPolicy } from "#src/platform-command-channel/index.js";
import type { CcodePlatformRuntime, CcodePlatformRuntimeConfig, CcodePlatformRuntimeDeps } from "./contract.js";

export function createCcodePlatformRuntime(config: CcodePlatformRuntimeConfig, deps: CcodePlatformRuntimeDeps): CcodePlatformRuntime {
  const auditTelemetry = deps.createAudit(config, deps);
  const expertSkills = deps.createExpert(config, deps);
  const skillReflow = deps.createReflow(config, deps);
  const commandChannel = deps.createCommandChannel(config, deps);
  let started = false;
  let disposed = false;
  return {
    auditTelemetry, expertSkills, skillReflow, commandChannel,
    async start() { if (started || disposed) return; started = true; auditTelemetry.scheduler.start(); skillReflow.armDailyTrigger(); await deps.startTransport?.(); },
    async stop() { if (!started) return; started = false; await deps.stopTransport?.(); },
    async dispose() { if (disposed) return; await this.stop(); disposed = true; await Promise.all([auditTelemetry.scheduler.dispose(), auditTelemetry.queue.dispose(), skillReflow.dispose()]); },
    async status() { return { started, disposed, skillReflow: skillReflow.getStatus(), auditQueue: await auditTelemetry.queue.stats(), commandChannelPolicy: config.commandChannelPolicy as CommandChannelPolicy ?? DEFAULT_COMMAND_CHANNEL_POLICY }; },
    processCommand(envelope) { return commandChannel.processEnvelope(envelope); },
  };
}
