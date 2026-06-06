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
  return currency.format(Number(value ?? 0));
}

export function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(value: string | Date | null | undefined) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Hours between two timestamps, minus lunch minutes, rounded to 2 decimals. */
export function hoursBetween(
  start: string | Date,
  end: string | Date,
  lunchMinutes = 0,
) {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  const ms = Math.max(0, e - s - lunchMinutes * 60_000);
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
