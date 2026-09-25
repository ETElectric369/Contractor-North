import { ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { paymentMethodLabel } from "@/lib/payment-method";
import type { JobLedger, LedgerDay, LedgerSplit, LedgerStretch, LaborRow, ItemRow, LedgerPaymentRow, SplitLine } from "@/lib/portal/stretch-ledger";
import type { LineGroup } from "@/lib/portal/line-kind";
import { fmtHours, fmtQty, fmtRange, fmtWeekday } from "./portal-format";

/**
 * THE STRETCHES OF WORK AGAINST THE PAYMENTS, as the office named them on the job. Each stretch
 * opens to its days, each day to its lines, then the payments made in it or at the end of it, and
 * the balance after it: everything worked so far minus everything paid so far. The figures come
 * from the ledger as they are (stretch-ledger reconciles them to the bills to the cent); nothing
 * here adds or rounds money.
 *
 * LABOR AND MATERIALS, APART, AT EVERY LEVEL (Erik, 2026-09-24: "all the sections should also have
 * a clearer separation of labor and materials its confusing"). A stretch says Labor, Materials and
 * Paid as three figures; inside, each day lists its Labor (who, hours, amount) and its Materials
 * (the items) under their own small headings with a subtotal each, and any other kind of line
 * (Change Orders, Credits, Sales Tax, Other) under its own heading only when the day has one. The
 * groups and their subtotals are the ledger's `split` (line-kind), not worked out here.
 *
 * <details> is the whole interaction: it opens with a tap, Enter or Space, needs no script, is
 * read as expandable by a screen reader, and works before the page has finished loading.
 */
export function PortalLedger({ ledger, thisYear, openLast = true }: { ledger: JobLedger; thisYear: string; openLast?: boolean }) {
  const n = ledger.stretches.length;
  return (
    <div className="space-y-3">
      {ledger.stretches.map((s, i) => (
        <StretchCard key={`${s.id ?? "all"}-${i}`} s={s} thisYear={thisYear} open={openLast && i === n - 1} />
      ))}
    </div>
  );
}

/** "Labor" with its hours when it has any: "Labor · 83.5 hours". */
export function splitLabel(line: SplitLine, split: LedgerSplit): string {
  return line.group === "labor" && split.laborHours > 0 ? `${line.label} · ${fmtHours(split.laborHours)}` : line.label;
}

/**
 * Labor, Materials and any other group as their own lines, then the total they add up to. Used by
 * the money card (Work So Far) and at the foot of every stretch (Work In This Stretch).
 */
export function SplitRows({ split, total, totalLabel }: { split: LedgerSplit; total: number; totalLabel: string }) {
  return (
    <>
      {split.lines.map((l) => (
        <div key={l.group} data-portal-split={l.group} className="flex items-baseline justify-between gap-3 py-0.5">
          <dt className="min-w-0 text-slate-700">{splitLabel(l, split)}</dt>
          <dd className={`shrink-0 tabular-nums ${l.amount < -0.005 ? "text-emerald-800" : "text-slate-900"}`}>{formatCurrency(l.amount)}</dd>
        </div>
      ))}
      <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-slate-300/80 pt-1">
        <dt className="font-semibold text-slate-900">{totalLabel}</dt>
        <dd className="shrink-0 font-semibold tabular-nums text-slate-900">{formatCurrency(total)}</dd>
      </div>
    </>
  );
}

const summaryFocus =
  "cursor-pointer list-none rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]";
const chevron = "h-5 w-5 shrink-0 text-[rgb(var(--glass-ink))] motion-safe:transition-transform group-open:rotate-90";

function Balance({ value, label }: { value: number; label: string }) {
  const ahead = value < -0.005;
  return (
    <div className="text-right">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-600">{ahead ? "Paid Ahead" : label}</div>
      <div className={`text-lg font-bold tabular-nums ${ahead ? "text-emerald-800" : "text-slate-900"}`}>
        {formatCurrency(Math.abs(value))}
      </div>
    </div>
  );
}

function StretchCard({ s, thisYear, open }: { s: LedgerStretch; thisYear: string; open: boolean }) {
  const range = fmtRange(s.startsOn, s.endsOn, thisYear);
  // Labor, Materials (always), any other group the stretch has, and Paid: each its own figure.
  const figures: { key: string; text: string; green?: boolean }[] = [
    ...s.split.lines.map((l) => ({ key: l.group, text: `${l.label} ${formatCurrency(l.amount)}` })),
    { key: "paid", text: `Paid ${formatCurrency(s.paidTotal)}`, green: true },
  ];
  return (
    <details data-portal-stretch className="portal-glass group rounded-2xl" open={open}>
      <summary className={`portal-summary ${summaryFocus} flex min-h-[44px] items-center gap-3 px-4 py-3`}>
        <ChevronRight className={chevron} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-900">{s.label}</div>
          {range ? <div className="text-sm text-slate-600">{range}</div> : null}
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-slate-700">
            {/* Each label keeps its figure: on a phone a pair wraps whole, never "Labor" / "$1,850.00". */}
            {figures.map((f) => (
              <span key={f.key} className={`whitespace-nowrap tabular-nums ${f.green ? "text-emerald-800" : ""}`}>
                {f.text}
              </span>
            ))}
          </div>
        </div>
        <Balance value={s.balanceAfter} label="Balance After" />
      </summary>

      <div className="border-t border-white/70 px-3 pb-3 pt-2 sm:px-4">
        {s.days.length === 0 ? (
          <p className="px-1 py-2 text-sm text-slate-600">No work billed in this stretch yet.</p>
        ) : (
          <ul className="space-y-2">
            {s.days.map((d) => (
              <li key={d.date}>
                <DayRow d={d} thisYear={thisYear} />
              </li>
            ))}
          </ul>
        )}

        {s.payments.length > 0 ? (
          <div className="mt-3">
            <h4 className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">Payments</h4>
            <ul className="mt-1 divide-y divide-slate-200/70 rounded-xl bg-white/80">
              {s.payments.map((p, i) => (
                <PaymentRow key={`${p.date}-${i}`} p={p} thisYear={thisYear} />
              ))}
            </ul>
          </div>
        ) : null}

        <dl className="mt-3 rounded-xl bg-white/80 px-3 py-2 text-sm">
          <SplitRows split={s.split} total={s.workTotal} totalLabel="Work In This Stretch" />
          <div className="flex items-baseline justify-between gap-3 py-0.5">
            <dt className="text-slate-700">Paid</dt>
            <dd className="shrink-0 tabular-nums text-emerald-800">{formatCurrency(s.paidTotal)}</dd>
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-slate-300/80 pt-1">
            <dt className="font-semibold text-slate-900">{s.balanceAfter < -0.005 ? "Paid Ahead" : "Balance After"}</dt>
            <dd className="shrink-0 font-bold tabular-nums">{formatCurrency(Math.abs(s.balanceAfter))}</dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

/** A day's rows under their group headings: Labor first (the people, then any hand-typed hours),
 *  Materials second, then the rest, each in the order the ledger gave them. */
function dayGroups(d: LedgerDay): { group: LineGroup; label: string; amount: number; hours: number; labor: LaborRow[]; items: ItemRow[] }[] {
  return d.split.lines.map((l) => {
    const items = d.items.filter((it) => it.group === l.group);
    const hours = l.group === "labor" ? d.split.laborHours : 0;
    return { group: l.group, label: l.label, amount: l.amount, hours, labor: l.group === "labor" ? d.labor : [], items };
  });
}

function DayRow({ d, thisYear }: { d: LedgerDay; thisYear: string }) {
  const groups = dayGroups(d);
  return (
    <details className="group/day rounded-xl bg-white/80">
      <summary className="portal-summary flex min-h-[44px] cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]">
        <ChevronRight
          className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))] motion-safe:transition-transform group-open/day:rotate-90"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-900">{fmtWeekday(d.date, thisYear)}</div>
          <div className="flex flex-wrap gap-x-2 text-xs text-slate-600">
            {groups.map((g) => (
              <span key={g.group} className="whitespace-nowrap tabular-nums">
                {g.label} {formatCurrency(g.amount)}
              </span>
            ))}
          </div>
        </div>
        <div className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(d.total)}</div>
      </summary>
      <div className="border-t border-slate-200/70 px-3 pb-2 pt-1">
        {d.outside === "after" ? (
          <p className="py-1 text-xs text-amber-900">
            After this stretch&apos;s dates. It is shown here until the next stretch starts.
          </p>
        ) : d.outside === "before" ? (
          <p className="py-1 text-xs text-amber-900">Before this stretch&apos;s dates. Work before the first stretch is shown with it.</p>
        ) : null}
        {groups.map((g) => (
          <section key={g.group} data-portal-day-group={g.group} className="pt-1.5" aria-label={`${g.label}, ${fmtWeekday(d.date, thisYear)}`}>
            <h5 className="flex items-baseline justify-between gap-3 text-[11px] font-semibold uppercase tracking-wide text-[rgb(var(--glass-ink))]">
              <span>
                {g.label}
                {g.hours > 0 ? <span className="font-medium normal-case tracking-normal text-slate-600"> · {fmtHours(g.hours)}</span> : null}
              </span>
              <span className="tabular-nums text-slate-900">{formatCurrency(g.amount)}</span>
            </h5>
            <ul className="divide-y divide-slate-200/70">
              {g.labor.map((l, i) => (
                <LaborLine key={`l${i}`} l={l} />
              ))}
              {g.items.map((it, i) => (
                <ItemLine key={`i${i}`} it={it} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </details>
  );
}

function LaborLine({ l }: { l: LaborRow }) {
  return (
    <li className="flex items-start justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="font-medium text-slate-900">{l.person}</div>
        <div className="text-xs text-slate-600">
          {l.lump ? `Billed as one amount, ${fmtHours(l.hours)}` : `${fmtHours(l.hours)} at ${formatCurrency(l.rate)} an hour`}
        </div>
      </div>
      <div className="shrink-0 tabular-nums text-slate-900">{formatCurrency(l.amount)}</div>
    </li>
  );
}

const DATED: Record<ItemRow["datedBy"], string> = {
  purchase: "",
  bill: "dated by the bill",
  deposit: "taken off the deposit",
};

function ItemLine({ it }: { it: ItemRow }) {
  const qty = it.kind === "material" || it.quantity !== 1
    ? `${fmtQty(it.quantity)}${it.unit ? ` ${it.unit}` : ""} at ${formatCurrency(it.unitPrice)}`
    : "";
  // The heading already says what kind of line it is; the note says only how much and when.
  const note = [qty, DATED[it.datedBy]].filter(Boolean).join(" · ");
  return (
    <li className="flex items-start justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="break-words text-slate-900">{it.description}</div>
        {note ? <div className="text-xs text-slate-600">{note}</div> : null}
      </div>
      <div className={`shrink-0 tabular-nums ${it.amount < 0 ? "text-emerald-800" : "text-slate-900"}`}>{formatCurrency(it.amount)}</div>
    </li>
  );
}

function PaymentRow({ p, thisYear }: { p: LedgerPaymentRow; thisYear: string }) {
  const what = p.kind === "credit" ? "Credit applied" : paymentMethodLabel(p.method) || "Payment";
  return (
    <li className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="font-medium text-slate-900">{what}</div>
        <div className="text-xs text-slate-600">
          {fmtWeekday(p.date, thisYear)}
          {p.outside === "after" ? " · after the stretch ended" : p.outside === "before" ? " · before the stretch started" : ""}
        </div>
      </div>
      <div className="shrink-0 font-semibold tabular-nums text-emerald-800">{formatCurrency(p.amount)}</div>
    </li>
  );
}

