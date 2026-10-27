/**
 * ccode-platform-runtime-wiring 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 */
import type { CcodePlatformRuntime, CcodePlatformRuntimeDeps } from "@zcode/services/ccode-platform-runtime";

/** Main 侧账号窄口：只暴露平台运行时需要的四个能力，不泄漏 confidential-controller 内部类型。 */
export interface DesktopCcodeAccount {
  /** 返回登录态与身份（authenticated 为 true 时 tenantId/userId 必有值）。 */
  getState(): Promise<{ authenticated: boolean; tenantId?: string; userId?: string }>;
  /** 登录/登出/身份变化通知；返回退订函数。 */
  onStateChanged(listener: () => void): () => void;
  /** 平台出网认证头（Bearer + tenant-id）；未登录 rejects，调用方据此退避/停轮询。 */
  getAuthHeaders(): Promise<Record<string, string>>;
}

export interface DesktopCcodePlatformRuntimeWiringOptions {
  readonly account: DesktopCcodeAccount;
  /** 平台数据目录（队列/账本/缓存/指令存储的唯一父目录）。 */
  readonly storageDirectory: string;
  /** 中台 API 基址（结尾带 /；与 confidential-controller 同一来源）。 */
  readonly apiBaseUrl: string;
  /** 回流归因字段，客户端自报。 */
  readonly ccodeRelease?: string;
  /** 本地持久 UUID，仅用于未验证的统计实例归因。 */
  readonly instanceId?: string;
  /** 当前已验签锁定总控的版本与摘要；缺失时不铸造普通任务事件。 */
  readonly getControllerAttribution?: () => Promise<{ version: number; digest: string }>;
  /** 指令信封验签公钥 PEM（占位：待中台指令签名公钥定稿，M7 OQ）。 */
  readonly commandSignerPublicKeyPem: string;
  /** skill 回流扫描 home 根。 */
  readonly homeDirectory: string;
  /** skill 回流扫描工作区根。 */
  readonly workingDirectory: string;
  readonly fetchImpl?: typeof fetch;
  /** 连续成功空轮询的最小请求间隔（2026-10-26 与中台对齐，缺省 5000ms；测试可注入小值）。 */
  readonly minEmptyPollIntervalMs?: number;
  /** 状态迁移/dispose 异常的唯一出口；缺省静默。 */
  readonly warn?: (message: string, error: unknown) => void;
  /** 测试注入：替换真组合根（缺省用真工厂装配）。 */
  readonly createRuntime?: (deps: CcodePlatformRuntimeDeps) => CcodePlatformRuntime;
  /** 测试注入：替换长轮询 transport（缺省 createLongPollTransport）。 */
  readonly createTransport?: (transport: { start(): Promise<void>; stop(): Promise<void> }) => { start(): Promise<void>; stop(): Promise<void> };
  /** 真实实现=createFeedbackDiagnosticArchive 适配，归后续接线；缺省不启用诊断 bundle。 */
  readonly diagnosticArchiveBuilder?: { build(): Promise<{ path: string; fileName: string; sizeBytes: number; digestHex: string }> };
}

export interface DesktopCcodePlatformRuntimeWiring {
  /** 带认证头的 fetch 包装（供各 uploader/transport 复用；未登录时调用 rejects）。 */
  fetch: typeof fetch;
  /** 外部错误源上报（spec §6A）：未启用诊断（无 builder）时 no-op；永不 reject。 */
  reportDiagnosticErrorTrigger(reason: "task_failed" | "crash_recovery" | "controller_bootstrap_failed"): void;
  reportTaskStarted(taskId: string, turnId: string): Promise<void>;
  reportTaskTerminal(taskId: string, turnId: string, result: string): Promise<void>;
  /** 幂等：退订账号监听→停 transport→runtime.stop+dispose；永不 reject。 */
  dispose(): Promise<void>;
}
