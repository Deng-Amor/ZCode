import { cn } from "@/components/lib/utils.js";
import brandLogoUrl from "@/assets/chuansheng-logo.svg";

/** 原图透明通道作为遮罩，按主题前景色呈现，保持横向品牌比例。 */
export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block w-28 shrink-0 bg-current", className)}
      style={{
        aspectRatio: "743 / 228",
        mask: `url(${brandLogoUrl}) center / contain no-repeat`,
        WebkitMask: `url(${brandLogoUrl}) center / contain no-repeat`,
      }}
    />
  );
}

export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return <ZCodeAboutLogo className={className} />;
}
