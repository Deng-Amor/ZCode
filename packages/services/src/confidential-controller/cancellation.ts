import { ConfidentialControllerError } from "./contract.js";

/** Stop waiting even when an injected dependency does not honor its abort signal. */
export function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new ConfidentialControllerError("CANCELLED"));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
