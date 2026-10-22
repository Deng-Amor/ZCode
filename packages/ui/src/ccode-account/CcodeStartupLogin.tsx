import { useEffect, useState, type ReactNode } from "react";
import { useCcodeAccount } from "@/hooks/useCcodeAccount.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { Button } from "@/components/ui/button.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { CcodeAccountForm } from "./CcodeAccountEntry.js";

export function CcodeStartupLogin({ children }: { children: ReactNode }) {
  const { account, state, unavailable, refresh } = useCcodeAccount();
  const { intl } = useZCodeIntl();
  const [finished, setFinished] = useState(false);
  const [busy, setBusy] = useState(false);
  const authenticated = state?.authenticated === true;
  useEffect(() => {
    // 启动登录只处理一次；之后注销不能卸载正在使用的工作区。
    if (authenticated) setFinished(true);
  }, [authenticated]);
  if (!account || finished || authenticated) return children;
  const t = (key: string) => intl.formatMessage({ id: `ccode.account.${key}` });
  return (
    <main className="relative flex h-dvh min-h-0 flex-col items-center justify-center overflow-hidden bg-background px-4 pb-4 pt-16 text-foreground">
      <div className="pointer-events-none absolute left-0 right-0 top-0 h-12 [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />
      <section
        aria-labelledby="ccode-startup-login-title"
        className="flex max-h-full min-h-0 w-full max-w-md flex-col gap-4 overflow-hidden rounded-2xl border border-popover-border bg-background p-6 shadow-md"
      >
        <header className="shrink-0 space-y-2">
          <ZCodeAboutLogo className="h-auto w-16" />
          <h1 id="ccode-startup-login-title" className="text-ui-xl font-semibold">
            {t("title")}
          </h1>
          <p className="text-ui-base text-muted-foreground">{t("description")}</p>
        </header>
        {unavailable && !busy ? (
          <div className="space-y-3">
            <p role="alert" className="text-ui-base text-destructive">
              {t("unavailable")}
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full"
              onClick={() => void refresh()}
            >
              {t("retryAccount")}
            </Button>
          </div>
        ) : state || busy ? (
          <CcodeAccountForm
            account={account}
            authenticated={false}
            unavailable={unavailable}
            onBusyChange={setBusy}
          />
        ) : (
          <p role="status" className="text-ui-base text-muted-foreground">
            {t("checkingAccount")}
          </p>
        )}
        <p className="shrink-0 text-ui-caption text-muted-foreground">{t("startupHint")}</p>
      </section>
    </main>
  );
}
