import { useEffect, useId, useRef, useState } from "react";
import { useCcodeAccount } from "@/hooks/useCcodeAccount.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import type { CcodeAccountPort, CcodePlatformTenant } from "./contract.js";

export function CcodeAccountEntry() {
  const { account, state, unavailable } = useCcodeAccount();
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  if (!account) return null;
  const t = (key: string) => intl.formatMessage({ id: `ccode.account.${key}` });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" className="h-11 w-full justify-start text-ui-base">
          {t(state?.authenticated ? "account" : "login")}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[calc(100dvh-4rem)] min-h-0 flex-col overflow-hidden sm:max-w-md">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {open && (
          <CcodeAccountForm
            account={account}
            authenticated={state?.authenticated === true}
            unavailable={unavailable}
            identity={state?.authenticated ? `${state.tenantId} / ${state.userId}` : undefined}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function CcodeAccountForm({
  account,
  authenticated,
  unavailable,
  identity,
  onBusyChange,
}: {
  account: CcodeAccountPort;
  authenticated: boolean;
  unavailable: boolean;
  identity?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `ccode.account.${key}` });
  const id = useId();
  const [tenants, setTenants] = useState<CcodePlatformTenant[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const submitting = useRef(false);
  const operationGeneration = useRef(0);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    // 跨窗口切换身份后，旧请求结果不能覆盖当前表单或显示旧身份错误。
    ++operationGeneration.current;
    submitting.current = false;
    setBusy(false);
    setError(undefined);
    setPassword("");
    return () => {
      ++operationGeneration.current;
    };
  }, [authenticated, identity]);
  useEffect(() => {
    if (authenticated) {
      setPassword("");
      return;
    }
    let active = true;
    setLoading(true);
    setError(undefined);
    void account
      .listTenants()
      .then((items) => {
        if (!active) return;
        setTenants(items);
        setTenantId((current) =>
          items.some((item) => item.id === current)
            ? current
            : items.length === 1
              ? items[0]!.id
              : "",
        );
        if (!items.length) setError("noTenants");
      })
      .catch(() => {
        if (active) setError("tenantError");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [account, authenticated, attempt]);

  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    const operation = ++operationGeneration.current;
    setBusy(true);
    setError(undefined);
    const input = { tenantId, username: username.trim(), password };
    setPassword("");
    try {
      if (authenticated) await account.logout();
      else await account.login(input);
    } catch {
      if (operation === operationGeneration.current)
        setError(authenticated ? "logoutError" : "loginError");
    } finally {
      if (operation === operationGeneration.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <form
      className="flex min-h-0 flex-col gap-4 overflow-y-auto"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {authenticated ? (
        <p className="break-words text-ui-base">
          {t("signedIn")} {identity}
        </p>
      ) : (
        <>
          <div className="space-y-2">
            <label htmlFor={`${id}-tenant`} className="text-ui-base">
              {t("tenant")}
            </label>
            <Select value={tenantId} onValueChange={setTenantId} disabled={busy || loading}>
              <SelectTrigger id={`${id}-tenant`} className="h-11 w-full">
                <SelectValue placeholder={t(loading ? "loading" : "selectTenant")} />
              </SelectTrigger>
              <SelectContent>
                {tenants.map((tenant) => (
                  <SelectItem key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label htmlFor={`${id}-username`} className="text-ui-base">
              {t("username")}
            </label>
            <Input
              id={`${id}-username`}
              className="h-11"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={128}
              disabled={busy}
              required
            />
          </div>
          <div className="space-y-2">
            <label htmlFor={`${id}-password`} className="text-ui-base">
              {t("password")}
            </label>
            <Input
              id={`${id}-password`}
              className="h-11"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              maxLength={1024}
              disabled={busy}
              required
            />
          </div>
        </>
      )}
      {(error || unavailable) && (
        <p role="alert" className="text-ui-base text-destructive">
          {t(error ?? "unavailable")}
        </p>
      )}
      {!authenticated && (error === "tenantError" || error === "noTenants") && (
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={loading || busy}
          onClick={() => setAttempt((value) => value + 1)}
        >
          {t("retry")}
        </Button>
      )}
      <Button
        type="submit"
        className="h-11"
        disabled={
          busy || (!authenticated && (loading || !tenantId || !username.trim() || !password))
        }
      >
        {t(busy ? "working" : authenticated ? "logout" : "login")}
      </Button>
    </form>
  );
}
