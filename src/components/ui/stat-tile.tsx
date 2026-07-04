import * as React from "react";

/**
 * The ONE glance tile — the "KPI" idiom (a small label over a big number) was hand-rolled
 * ~20 times across the app with drift (label-above vs value-above, bg-tinted div vs Card,
 * green vs slate, px-4 vs px-3). This is the single source, the same shape Nort's projector
 * emits as `facts`: a page and a driver card now speak one visual language.
 *
 * tones: `default` neutral slate · `accent` sea-glass (a positive money figure that should
 * pop) · `warning` amber (a "needs attention" figure — follow-ups due, low stock). Value is
 * a node so callers can pass formatCurrency(...) or JSX.
 */
const TONE = {
  default: { box: "bg-slate-50", label: "text-slate-500", value: "text-slate-900" },
  accent: { box: "bg-[rgb(var(--glass-tint))]/10", label: "text-slate-500", value: "text-[color:rgb(var(--glass-ink))]" },
  warning: { box: "bg-amber-50", label: "text-amber-700", value: "text-amber-900" },
} as const;

export function StatTile({
  label,
  value,
  tone = "default",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: keyof typeof TONE;
}) {
  const t = TONE[tone];
  return (
    <div className={`rounded-xl px-4 py-3 ${t.box}`}>
      <div className={`text-xs font-medium ${t.label}`}>{label}</div>
      <div className={`mt-0.5 truncate text-2xl font-bold ${t.value}`}>{value}</div>
    </div>
  );
}

/** The row of tiles. Defaults to 2 columns; pass cols for 3/4. */
export function FactsGrid({
  cols = 2,
  className = "",
  children,
}: {
  cols?: 2 | 3 | 4;
  className?: string;
  children: React.ReactNode;
}) {
  const grid = cols === 4 ? "grid-cols-4" : cols === 3 ? "grid-cols-3" : "grid-cols-2";
  return <div className={`grid gap-3 ${grid} ${className}`}>{children}</div>;
}
