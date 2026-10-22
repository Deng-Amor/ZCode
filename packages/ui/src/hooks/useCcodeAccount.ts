import { useCallback, useEffect, useRef, useState } from "react";
import type { CcodePlatformLoginState } from "@/ccode-account/contract.js";
import { usePlatform } from "./usePlatform.js";

export function useCcodeAccount() {
  const account = usePlatform().ccodeAccount;
  const [state, setState] = useState<CcodePlatformLoginState>();
  const [unavailable, setUnavailable] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!account) return;
    try {
      const next = await account.getState();
      if (request !== generation.current) return;
      setState(next);
      setUnavailable(false);
    } catch {
      if (request !== generation.current) return;
      setState(undefined);
      setUnavailable(true);
    }
  }, [account]);

  useEffect(() => {
    setState(undefined);
    setUnavailable(false);
    if (!account) return;
    const notify = () => {
      void refresh();
    };
    const unsubscribe = account.onStateChanged(notify);
    window.addEventListener("focus", notify);
    notify();
    return () => {
      ++generation.current;
      unsubscribe();
      window.removeEventListener("focus", notify);
    };
  }, [account, refresh]);
  return { account, state, unavailable, refresh };
}
