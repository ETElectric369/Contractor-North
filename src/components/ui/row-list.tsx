import * as React from "react";
import Link from "next/link";
import { Badge } from "./badge";

type BadgeTone = React.ComponentProps<typeof Badge>["tone"];

export type RowItem = {
  key: React.Key;
  /** Primary line — the record's name / number. */
  label: React.ReactNode;
  /** Dimmer second line, e.g. a job number, a date, "phone · role". */
  sub?: React.ReactNode;
  /** Right-aligned value, e.g. formatCurrency(total). */
  value?: React.ReactNode;
  /** A status pill on the right. */
  badge?: { tone?: BadgeTone; text: React.ReactNode };
  /** Tap-through deep link. */
  href?: string;
};

/**
 * The ONE record-row list — a customer's jobs, a set of estimates/invoices, any list of
 * records shown as label · (sub) · (value) · (badge), tap-through. This idiom was hand-rolled
 * (and tripled on the customer page); it's the same shape Nort's projector emits as `rows`.
 * Wrap it in a <Card className="overflow-hidden"> at the call site (or not).
 */
export function RowList({ items, empty }: { items: RowItem[]; empty?: React.ReactNode }) {
  if (!items.length) return <>{empty ?? null}</>;
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((r) => {
        const inner = (
          <div className="flex items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-slate-900">{r.label}</div>
              {r.sub ? <div className="truncate text-xs text-slate-400">{r.sub}</div> : null}
            </div>
            {r.value || r.badge ? (
              <div className="flex shrink-0 items-center gap-3">
                {r.value ? <span className="text-sm">{r.value}</span> : null}
                {r.badge ? <Badge tone={r.badge.tone}>{r.badge.text}</Badge> : null}
              </div>
            ) : null}
          </div>
        );
        return (
          <li key={r.key}>
            {r.href ? (
              <Link href={r.href} className="block hover:bg-slate-50">{inner}</Link>
            ) : (
              inner
            )}
          </li>
        );
      })}
    </ul>
  );
}
