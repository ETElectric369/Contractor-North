import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg" | "icon" | "icon-sm";

const variants: Record<Variant, string> = {
  // Primary CTA is sea-glass, not brand blue: a SOLID dark-teal fill (--glass-ink) so the
  // call-to-action stays strong and white text clears WCAG AA (~4.8:1). The .btn-gloss
  // sheen (applied on every button below) gives it the glassy front face.
  primary:
    "bg-[rgb(var(--glass-ink))] text-white hover:bg-[rgb(var(--glass-ink))]/90 shadow-sm",
  // secondary/outline/ghost warm to a faint sea-glass tint on hover (not slate) so mouse-
  // over is consistent with the nav's ink-teal feel.
  secondary:
    "bg-slate-100 text-slate-900 hover:bg-[rgb(var(--glass-tint))]/15 hover:text-[rgb(var(--glass-ink))]",
  outline:
    "border border-slate-300 bg-white text-slate-800 hover:bg-[rgb(var(--glass-tint))]/10 hover:border-[rgb(var(--glass-ink))]/40 hover:text-[rgb(var(--glass-ink))]",
  ghost: "text-slate-700 hover:bg-[rgb(var(--glass-tint))]/10 hover:text-[rgb(var(--glass-ink))]",
  // Destructive stays red — that red is semantic (irreversible action), not brand chrome.
  destructive: "bg-red-600 text-white hover:bg-red-700",
};

// ONE SOURCE OF TRUTH for a button's internals. Height + label size + horizontal padding
// AND the icon size all live here, keyed to `size`. The `[&_svg]:size-*` utility sizes any
// lucide icon child from the button itself (a descendant selector, so it overrides whatever
// h-4/h-5 a caller hand-passed) — so every <Button> renders with a consistent icon-to-text
// scale without each call site setting it. (base adds shrink-0 so an icon never squishes.)
const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm [&_svg]:size-4",
  // md is the DEFAULT button. Bumped 40px → 44px so every default control (e.g. the My Day
  // clock in/out) clears the 44px touch-target minimum for gloved field hands on a phone.
  md: "h-11 px-4 text-sm [&_svg]:size-4",
  lg: "h-12 px-6 text-base [&_svg]:size-5",
  // Icon buttons sit at the same 44px touch target so a tap doesn't miss.
  icon: "h-11 w-11 [&_svg]:size-5",
  // icon-sm is THE TINY SQUARE (Erik 2026-09-11: "share can be this super tiny box with arrow
  // icon") — a 32px box for the eye that still obeys the 44px law above: a transparent ::before
  // bleeds 6px past every edge, so the finger lands on 44px while the eye sees 32. It is ::before,
  // not ::after, because .btn-gloss::after is the specular sheen; and `overflow-visible!` carries
  // !important because .btn-gloss is unlayered CSS that sets overflow:hidden — which would clip
  // the bleed, and an unlayered rule beats any plain utility. Outline/ghost callers only; it has
  // no label room, so the caller MUST pass aria-label + title.
  "icon-sm":
    "relative h-8 w-8 overflow-visible! [&_svg]:size-4 before:absolute before:-inset-1.5 before:content-['']",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "btn-gloss inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors [&_svg]:shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--glass-ink))] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
