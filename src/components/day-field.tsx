"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { todayStrInTz } from "@/lib/tz";

/**
 * THE one day field (cn-v1153).
 *
 * Erik, 2026-11-07: "sometimes on my phone the calendar that pops up is the iphone native calendar
 * which is better then using our own but then sometimes the app calendar pops up on others, maybe
 * we should look into continuity of systems and single source of truth." So every door that asks
 * for a day renders this: a native `<input type="date">`, which on the phone IS the iPhone wheel
 * and on the Mac is the system's own picker. The phone already speaks the person's language and
 * writes the day in their own order (11/7 or 7/11) — no catalog key, no locale code of ours.
 *
 * What it is NOT: never a custom month grid, never a 14-day chip strip, never a label or a wrapper.
 * Shortcut chips that carry a MEANING (Tomorrow, Mon, In a Week in come-back-picker) sit beside it;
 * the field itself is only the box. Any screen that draws its own `<input type="date">` fails
 * tests/one-day-field.test.ts.
 *
 * The value is always "yyyy-mm-dd" or "" (the native format), controlled or uncontrolled: a form
 * that reads FormData by `name` keeps working. `noPast` sets `min` to the company's today in `tz`
 * (the phone's day when tz is null) unless the caller passed its own `min`.
 */
export type DayFieldProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "onChange"
> & {
  /** "yyyy-mm-dd" or "". Given → controlled. */
  value?: string;
  /** "yyyy-mm-dd" or "". For an uncontrolled field a form reads by `name`. */
  defaultValue?: string;
  /** Hands the iso day ("yyyy-mm-dd", "" when cleared) first; the raw event second. */
  onChange?: (iso: string, e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Refuse days before the company's today (its `min`); the caller's own `min` wins. */
  noPast?: boolean;
  /** The company's IANA zone for `noPast`; null/undefined → the phone's own day. */
  tz?: string | null;
};

/** "yyyy-mm-dd" today in the company's zone; the phone's own day when there is no zone. */
export function companyToday(tz?: string | null): string {
  if (tz) return todayStrInTz(tz);
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const DayField = React.forwardRef<HTMLInputElement, DayFieldProps>(
  ({ value, defaultValue, onChange, noPast, tz, min, className, ...rest }, ref) => {
    const controlled = value !== undefined;
    return (
      <Input
        ref={ref}
        type="date"
        {...(controlled ? { value } : { defaultValue })}
        onChange={(e) => onChange?.(e.target.value, e)}
        min={min ?? (noPast ? companyToday(tz) : undefined)}
        // 44px: the thumb target; twMerge drops Input's own h-10.
        className={cn("h-11", className)}
        {...rest}
      />
    );
  },
);
DayField.displayName = "DayField";
