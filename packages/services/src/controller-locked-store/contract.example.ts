/**
 * controller-locked-store 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { ControllerLockedStore } from "./contract.js";

export function exampleControllerLockedStore(_contract: ControllerLockedStore): void {
  // 锁定存储只通过 install/load/status/rollback 暴露，不允许调用方直接写盘。
}
