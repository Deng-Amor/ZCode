/**
 * M2 就绪后的进程通道服务端预留；当前无消费者，不接入 desktop/host 三跳链路。
 */

type CatalogItem = { skillId: string; name?: string; description?: string; version?: number };
type Message =
  | { type: "expert.get-catalog"; requestId: string }
  | { type: "expert.get-content"; requestId: string; skillId: string }
  | { type: string; requestId?: unknown; skillId?: unknown };

export function createExpertSkillsChannelServer(options: {
  store: { list(): Promise<readonly CatalogItem[]>; get(scope: string, skillId: string): Promise<unknown> };
  scope: () => string;
}) {
  return {
    async handle(message: unknown): Promise<unknown> {
      if (!message || typeof message !== "object") return { type: "IGNORED" };
      const input = message as Message;
      if (typeof input.type !== "string" || typeof input.requestId !== "string") return { type: "IGNORED" };
      try {
        if (input.type === "expert.get-catalog") {
          const entries = await options.store.list();
          return { type: input.type, requestId: input.requestId, entries: entries.map((entry) => ({
            skillId: entry.skillId, name: entry.name ?? entry.skillId, description: entry.description ?? "", version: entry.version ?? 0,
          })) };
        }
        if (input.type === "expert.get-content" && typeof input.skillId === "string" && input.skillId.length > 0) {
          const content = await options.store.get(options.scope(), input.skillId);
          return content === undefined
            ? { type: input.type, requestId: input.requestId, errorCode: "NOT_CACHED" }
            : { type: input.type, requestId: input.requestId, content };
        }
      } catch {
        return { type: input.type, requestId: input.requestId, errorCode: "UNAVAILABLE" };
      }
      return { type: "IGNORED" };
    },
  };
}
