import { z } from 'zod';
import { screenControllerOutput } from './output-screen.js';
import { PrivateControllerError, type PrivateControllerClient, type PrivateControllerCode } from './contract.js';
export * from './contract.js';
export { readControllerBootstrap } from './bootstrap.js';
export { protectControllerModelRequest, privateControllerStatusSink, privateGlobalPromptModelError } from './model-privacy.js';
export { generateControllerText, streamControllerText } from './model-call.js';
export { createControllerExecutionScope } from './execution-scope.js';
export { createControllerSkillPort } from './skill-port.js';

const MAX_CALLS = 8;
const MAX_INSTRUCTION_CHARS = 32 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), requestId: idSchema, version: idSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/), instruction: z.string().max(MAX_INSTRUCTION_CHARS) }).strict(),
  z.object({ type: z.literal('completed'), requestId: idSchema }).strict(),
  z.object({ type: z.literal('failed'), requestId: idSchema,
    code: z.enum(['AUTHORIZATION_EXPIRED', 'AUTHORIZATION_REJECTED', 'AUTH_REQUIRED', 'IDENTITY_CHANGED', 'CANCELLED', 'UNAVAILABLE',
      'EXECUTION_FAILED', 'INVALID_RELEASE', 'VERSION_CHANGED', 'CAPACITY_EXCEEDED']) }).strict(),
]);
type Command = { type: 'acquire' | 'complete' | 'cancel'; requestId: number; version?: number };
interface Call {
  phase: 'acquiring' | 'executing' | 'completing';
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  cleanup(): void;
  ready(event: Extract<z.infer<typeof eventSchema>, { type: 'ready' }>): void;
  complete(): void;
  reject(error: PrivateControllerError): void;
}

/** Bootstrap owns this adapter and disposes it with the IPC connection. */
export function createPrivateControllerClient(ipc: Pick<NodeJS.Process,
  'on' | 'off' | 'send' | 'connected' | 'disconnect'> = process): PrivateControllerClient {
  const calls = new Map<number, Call>();
  let nextId = 0;
  let disposed = false;
  const finish = (id: number) => {
    const call = calls.get(id);
    if (!call) return;
    calls.delete(id);
    clearTimeout(call.timer);
    call.cleanup();
    return call;
  };
  const fail = (id: number, code: PrivateControllerCode) => {
    const call = finish(id);
    if (!call) return;
    call.controller.abort();
    call.reject(new PrivateControllerError(code));
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipc.off('message', receive);
    ipc.off('disconnect', dispose);
    for (const id of calls.keys()) fail(id, 'UNAVAILABLE');
    try { if (ipc.connected) ipc.disconnect?.(); } catch { /* Already disconnected. */ }
  };
  const send = (command: Command) => {
    if (disposed || !ipc.connected || !ipc.send) { dispose(); return; }
    try {
      ipc.send(command, (error: Error | null) => { if (error) dispose(); });
    } catch { dispose(); }
  };
  const cancel = (id: number, code: PrivateControllerCode) => {
    if (!calls.has(id)) return;
    fail(id, code);
    send({ type: 'cancel', requestId: id });
  };
  const armTimeout = (id: number, call: Call) => {
    clearTimeout(call.timer);
    call.timer = setTimeout(() => cancel(id, 'UNAVAILABLE'), HANDSHAKE_TIMEOUT_MS);
    call.timer.unref();
  };
  function receive(message: unknown) {
    const parsed = eventSchema.safeParse(message);
    if (!parsed.success) { dispose(); return; }
    const event = parsed.data;
    const call = calls.get(event.requestId);
    // 取消后的迟到响应丢弃；从未分配过的 ID 表示协议错误。
    if (!call) { if (event.requestId > nextId) dispose(); return; }
    if (event.type === 'failed') { fail(event.requestId, event.code); return; }
    if (event.type === 'ready' && call.phase === 'acquiring') {
      clearTimeout(call.timer);
      call.phase = 'executing';
      call.ready(event);
    } else if (event.type === 'completed' && call.phase === 'completing') {
      finish(event.requestId)?.complete();
    } else dispose();
  }
  ipc.on('message', receive);
  ipc.on('disconnect', dispose);
  return {
    dispose,
    use(consume, options) {
      if (disposed || !ipc.connected || !ipc.send)
        return Promise.reject(new PrivateControllerError('UNAVAILABLE'));
      if (options?.signal?.aborted) return Promise.reject(new PrivateControllerError('CANCELLED'));
      if (options?.version !== undefined && !idSchema.safeParse(options.version).success)
        return Promise.reject(new PrivateControllerError('INVALID_RELEASE'));
      if (calls.size >= MAX_CALLS || nextId >= Number.MAX_SAFE_INTEGER)
        return Promise.reject(new PrivateControllerError('CAPACITY_EXCEEDED'));
      const id = ++nextId;
      const controller = new AbortController();
      return new Promise((resolve, reject) => {
        const onAbort = () => cancel(id, 'CANCELLED');
        let accepted: Parameters<typeof resolve>[0] | undefined;
        const call: Call = {
          phase: 'acquiring', controller, reject,
          cleanup: () => options?.signal?.removeEventListener('abort', onAbort),
          complete: () => { if (accepted) resolve(accepted); },
          ready: (event) => {
            if (options?.version !== undefined && event.version !== options.version) {
              cancel(id, 'VERSION_CHANGED'); return;
            }
            void Promise.resolve().then(() => {
              if (!calls.has(id) || controller.signal.aborted) return;
              return consume({ version: event.version, digest: event.digest,
                instruction: event.instruction, signal: controller.signal });
            }).then((value) => {
              if (!calls.has(id) || controller.signal.aborted) return;
              try {
                value = screenControllerOutput(event.instruction, value) as typeof value;
              } catch {
                cancel(id, 'EXECUTION_FAILED');
                return;
              }
              accepted = { version: event.version, digest: event.digest, value: value as Awaited<ReturnType<typeof consume>> };
              call.phase = 'completing';
              armTimeout(id, call);
              send({ type: 'complete', requestId: id });
            }, (error: unknown) => cancel(id,
              error instanceof PrivateControllerError ? error.code : 'EXECUTION_FAILED'));
          },
        };
        calls.set(id, call);
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        armTimeout(id, call);
        send({ type: 'acquire', requestId: id, ...(options?.version === undefined ? {} : { version: options.version }) });
      });
    },
  };
}
