"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:border-brand disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

/** Textarea that grows with its content so you can always see all the text. */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, onInput, ...props }, ref) => {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement);

  const fit = React.useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, []);

  // Re-fit when the controlled value changes, and after layout settles on mount
  // (a textarea mounted inside a just-opened modal reads scrollHeight = 0 until
  // it's actually painted — defer with rAF so existing text isn't shown collapsed).
  React.useEffect(() => {
    fit();
    const r = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(r);
  }, [fit, props.value, props.defaultValue]);

  return (
    <textarea
      ref={innerRef}
      onFocus={fit}
      onInput={(e) => {
        fit();
        onInput?.(e);
      }}
      className={cn(
        "flex min-h-[80px] w-full resize-none overflow-hidden rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:border-brand disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    // No vertical padding: with an explicit height the browser centers the
    // text itself — padding made iOS clip / bottom-align it in short selects.
    className={cn(
      "flex h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-0 text-sm leading-tight text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:border-brand disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Select.displayName = "Select";

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("mb-1.5 block text-sm font-medium text-slate-700", className)}
      {...props}
    />
  );
}
