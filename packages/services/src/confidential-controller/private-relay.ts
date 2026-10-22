import { z } from "zod";
import {
  ConfidentialControllerError,
  type ControllerPrivateChannel,
  type ControllerPrivateCommand,
  type ControllerPrivateEvent,
} from "./contract.js";
import { parseControllerPrivateCommand } from "./private-channel.js";

const MAX_CALLS = 8;
const MAX_PEERS = 32;
const requestId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("invalidated") }),
  z.strictObject({
    type: z.literal("bootstrap-ready"),
    requestId,
    version: requestId,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    systemPrompt: z.string().max(32 * 1024 * 1024),
  }),
  z.strictObject({
    type: z.literal("ready"),
    requestId,
    version: requestId,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    instruction: z.string().max(32 * 1024 * 1024),
  }),
  z.strictObject({ type: z.literal("completed"), requestId }),
  z.strictObject({
    type: z.literal("failed"),
    requestId,
    code: z.enum([
      "AUTHORIZATION_EXPIRED",
      "AUTHORIZATION_REJECTED",
      "AUTH_REQUIRED",
      "IDENTITY_CHANGED",
      "CANCELLED",
      "UNAVAILABLE",
      "EXECUTION_FAILED",
      "INVALID_RELEASE",
      "VERSION_CHANGED",
      "CAPACITY_EXCEEDED",
    ]),
  }),
]);

interface Peer {
  active: boolean;
  lastId: number;
  calls: Map<number, number>;
  send(event: ControllerPrivateEvent): void;
  close(): void;
}
interface Call {
  kind: "bootstrap" | "acquire";
  peer: Peer;
  localId: number;
  phase: "acquiring" | "ready" | "completing" | "cancelling";
}

/** Host-only routing. No rule cache, task state, public RPC or logging. */
export function createControllerPrivateRelay(upstream: {
  send(command: ControllerPrivateCommand): void;
  close(): void;
}) {
  let disposed = false;
  let nextId = 0;
  const peers = new Set<Peer>();
  const calls = new Map<number, Call>();
  const closePeer = (peer: Peer) => {
    if (!peer.active) return;
    peer.active = false;
    peers.delete(peer);
    for (const globalId of peer.calls.values()) {
      calls.delete(globalId);
      if (!disposed) sendUpstream({ type: "cancel", requestId: globalId });
    }
    peer.calls.clear();
    try {
      peer.close();
    } catch {
      /* Never expose transport payload errors. */
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const peer of peers) closePeer(peer);
    calls.clear();
    try {
      upstream.close();
    } catch {
      /* Private transport teardown. */
    }
  };
  const sendUpstream = (command: ControllerPrivateCommand) => {
    if (disposed) return;
    try {
      upstream.send(command);
    } catch {
      dispose();
    }
  };
  const sendPeer = (peer: Peer, event: ControllerPrivateEvent) => {
    if (!peer.active) return;
    try {
      peer.send(event);
    } catch {
      closePeer(peer);
    }
  };
  return {
    dispose,
    receive(message: unknown) {
      if (disposed) return;
      const parsed = eventSchema.safeParse(message);
      if (!parsed.success) {
        dispose();
        return;
      }
      const event = parsed.data;
      if (event.type === "invalidated") {
        // Host 的 Main 端口只交接一次；撤销 CLI 消费者后保留上游供重新登录使用。
        for (const peer of peers) closePeer(peer);
        return;
      }
      const call = calls.get(event.requestId);
      // Agent取消/退出后Main仍可能完成一个已在途的响应，不能投递给新Agent。
      if (!call) return;
      if (event.type === "bootstrap-ready") {
        if (
          call.kind !== "bootstrap" ||
          (call.phase !== "acquiring" && call.phase !== "cancelling")
        ) {
          dispose();
          return;
        }
        calls.delete(event.requestId);
        call.peer.calls.delete(call.localId);
        if (call.phase !== "cancelling") sendPeer(call.peer, { ...event, requestId: call.localId });
        return;
      }
      if (event.type === "ready") {
        if (call.phase === "cancelling") return;
        if (call.phase !== "acquiring" || call.kind !== "acquire") {
          dispose();
          return;
        }
        call.phase = "ready";
      } else {
        if (
          event.type === "completed" &&
          call.phase !== "completing" &&
          call.phase !== "cancelling"
        ) {
          dispose();
          return;
        }
        calls.delete(event.requestId);
        call.peer.calls.delete(call.localId);
      }
      sendPeer(
        call.peer,
        event.type === "completed" && call.phase === "cancelling"
          ? { type: "failed", requestId: call.localId, code: "CANCELLED" }
          : { ...event, requestId: call.localId },
      );
    },
    createChannel(transport: {
      send(event: ControllerPrivateEvent): void;
      close(): void;
    }): ControllerPrivateChannel {
      if (disposed) throw new ConfidentialControllerError("CANCELLED");
      if (peers.size >= MAX_PEERS) throw new ConfidentialControllerError("CAPACITY_EXCEEDED");
      const peer: Peer = { ...transport, active: true, lastId: 0, calls: new Map() };
      peers.add(peer);
      return {
        dispose: () => closePeer(peer),
        receive(message) {
          if (!peer.active || disposed) return;
          const command = parseControllerPrivateCommand(message);
          if (!command) {
            closePeer(peer);
            return;
          }
          if (command.type === "acquire" || command.type === "bootstrap") {
            if (command.requestId <= peer.lastId) {
              closePeer(peer);
              return;
            }
            peer.lastId = command.requestId;
            if (calls.size >= MAX_CALLS || nextId >= Number.MAX_SAFE_INTEGER) {
              sendPeer(peer, {
                type: "failed",
                requestId: command.requestId,
                code: "CAPACITY_EXCEEDED",
              });
              return;
            }
            const globalId = ++nextId;
            peer.calls.set(command.requestId, globalId);
            calls.set(globalId, {
              peer,
              localId: command.requestId,
              phase: "acquiring",
              kind: command.type,
            });
            sendUpstream({ ...command, requestId: globalId });
          } else {
            const globalId = peer.calls.get(command.requestId);
            if (globalId === undefined) return;
            const call = calls.get(globalId)!;
            if (command.type === "complete") {
              if (call.phase !== "ready") {
                closePeer(peer);
                return;
              }
              call.phase = "completing";
            } else call.phase = "cancelling";
            sendUpstream({ type: command.type, requestId: globalId });
          }
        },
      };
    },
  };
}

export type ControllerPrivateRelay = ReturnType<typeof createControllerPrivateRelay>;
