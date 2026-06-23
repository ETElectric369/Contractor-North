import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names, resolving conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatCurrency(value: number | null | undefined) {
  const n = Number(value ?? 0);
  // A NaN/Infinity slipping in would render "$NaN"/"$∞" on a customer-facing
  // payment request — coerce non-finite to 0.
  return currency.format(Number.isFinite(n) ? n : 0);
}

// THE business timezone all dates render in. The server runs in UTC, so without a
// timeZone every server-rendered date prints UTC and disagrees with the browser —
// the recurring off-by-one / "timezone again" bug. Single source of truth; override
// per-deploy with NEXT_PUBLIC_DEFAULT_TIMEZONE, or per-call with the `tz` arg.
export const DEFAULT_TIMEZONE = process.env.NEXT_PUBLIC_DEFAULT_TIMEZONE || "America/Los_Angeles";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Format a date. A date-ONLY value ("YYYY-MM-DD", e.g. a due date) is a wall-
 *  calendar day and is rendered literally — never shifted across zones. A full
 *  timestamp is rendered in the business timezone (default America/Los_Angeles),
 *  the same on the UTC server and in the browser. Pass `tz` for a specific org. */
export function formatDate(value: string | Date | null | undefined, tz: string = DEFAULT_TIMEZONE) {
  if (!value) return "—";
  if (typeof value === "string" && DATE_ONLY.test(value)) {
    // Anchor to noon UTC + render in UTC → the literal day, stable in any zone.
    return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Format an instant (timestamp) as date + time in the business timezone. */
export function formatDateTime(value: string | Date | null | undefined, tz: string = DEFAULT_TIMEZONE) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Time-only ("h:mm AM") in the business timezone. */
export function formatTime(value: string | Date | null | undefined, tz: string = DEFAULT_TIMEZONE) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}

/** Short date ("Mon D", no year) — date-only safe, timestamps in the business tz. */
export function formatDateShort(value: string | Date | null | undefined, tz: string = DEFAULT_TIMEZONE) {
  if (!value) return "—";
  if (typeof value === "string" && DATE_ONLY.test(value)) {
    return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  }
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
}

/** Hours between two timestamps, minus lunch minutes, rounded to 2 decimals. */
export function hoursBetween(
  start: string | Date,
  end: string | Date,
  lunchMinutes = 0,
) {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 0; // bad timestamp → 0, not NaN
  // A negative lunch would ADD payable time; clamp to >= 0. Non-numeric → 0.
  const lunch = Math.max(0, Number(lunchMinutes) || 0);
  const ms = Math.max(0, e - s - lunch * 60_000);
  return Math.round((ms / 3_600_000) * 100) / 100;
}

export function formatDuration(hours: number) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

/**
 * Make a free-text search term safe to embed in a PostgREST `.or(...)` filter.
 * Strips the structural characters PostgREST uses as delimiters (commas,
 * parens, colons, wildcards, backslashes) and caps length, so user input can't
 * break out of or inject into the filter expression.
 */
export function sanitizeSearch(input: string | undefined | null): string {
  return (input ?? "")
    .replace(/[,()*:%\\"']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/** Format a US phone number progressively: "(530) 933-6686". */
export function formatPhone(input: string | null | undefined): string {
  let digits = (input ?? "").replace(/\D/g, "").slice(0, 11);
  let country = "";
  if (digits.length === 11 && digits.startsWith("1")) {
    country = "1 ";
    digits = digits.slice(1);
  }
  if (digits.length === 0) return "";
  if (digits.length < 4) return `${country}(${digits}`;
  if (digits.length < 7) return `${country}(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `${country}(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

/** Title-case a string ("dallas" → "Dallas"); good enough for city names. */
export function titleCase(input: string | null | undefined): string {
  return (input ?? "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .trim();
}

/** Two-letter uppercase state code. */
export function formatState(input: string | null | undefined): string {
  return (input ?? "").replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 2);
}

/** US zip: "75201" or "75201-1234". */
export function formatZip(input: string | null | undefined): string {
  const d = (input ?? "").replace(/[^\d]/g, "").slice(0, 9);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

export function initials(name: string | null | undefined) {
  if (!name) return "?";
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
