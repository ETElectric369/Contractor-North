import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg" | "icon";

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

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  // md is the DEFAULT button. Bumped 40px → 44px so every default control (e.g. the My Day
  // clock in/out) clears the 44px touch-target minimum for gloved field hands on a phone.
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-6 text-base",
  // Icon buttons sit at the same 44px touch target so a tap doesn't miss.
  icon: "h-11 w-11",
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
        "btn-gloss inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--glass-ink))] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
