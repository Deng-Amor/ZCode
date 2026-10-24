import type { ZCodeAppLogoProps } from "@/components/mobile-ui/contract.js";
import { cn } from "@/components/lib/utils.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";

/** 产品图标随前景色适配主题；外层保留现有布局和测试钩子。 */
export function ZCodeAppLogo({ className }: ZCodeAppLogoProps) {
  return (
    <span
      aria-hidden="true"
      data-app-logo="zcode"
      className={cn("inline-flex shrink-0 items-center justify-center select-none", className)}
    >
      <ZCodeAboutLogo className="h-auto w-full" />
    </span>
  );
}
