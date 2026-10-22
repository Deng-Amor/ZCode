import type { ChildProcess } from "node:child_process";
import type { ControllerPrivateChannel, ControllerPrivateChannelFactory } from "./contract.js";

/** Dedicated Node IPC only; stdout/stderr remain owned by the normal protocol. */
export function attachControllerChildChannel(
  child: ChildProcess,
  createChannel: ControllerPrivateChannelFactory,
): () => void {
  let disposed = false;
  let channel: ControllerPrivateChannel | undefined;
  const receive = (message: unknown) => channel?.receive(message);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    child.off("message", receive);
    child.off("disconnect", dispose);
    child.off("error", dispose);
    child.off("exit", dispose);
    channel?.dispose();
    channel = undefined;
    try {
      if (child.connected) child.disconnect();
    } catch {
      // IPC 可能已随子进程关闭；禁止将包含传输细节的原异常送入日志。
    }
  };
  child.on("message", receive);
  child.once("disconnect", dispose);
  child.once("error", dispose);
  child.once("exit", dispose);
  try {
    if (!child.connected || !child.send) {
      dispose();
      return dispose;
    }
    const created = createChannel((event) => {
      if (disposed || !child.connected || !child.send) {
        dispose();
        return;
      }
      try {
        child.send(event, (error: Error | null) => {
          if (error) dispose();
        });
      } catch {
        dispose();
      }
    }, dispose);
    // 工厂可同步关闭连接；迟到返回的 peer 也必须释放，不能重新激活。
    if (disposed) created.dispose();
    else channel = created;
  } catch {
    dispose();
  }
  return dispose;
}
