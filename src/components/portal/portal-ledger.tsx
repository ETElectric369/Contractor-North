import { ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { paymentMethodLabel } from "@/lib/payment-method";
import type { JobLedger, LedgerDay, LedgerStretch, LaborRow, ItemRow, LedgerPaymentRow } from "@/lib/portal/stretch-ledger";
import { fmtHours, fmtQty, fmtRange, fmtWeekday } from "./portal-format";

/**
 * THE STRETCHES OF WORK AGAINST THE PAYMENTS, as the office named them on the job. Each stretch
 * opens to its days, each day to its lines (who worked, how long, at what rate; what was bought
 * at the customer's price), then the payments made in it or at the end of it, and the balance
 * after it: everything worked so far minus everything paid so far. The figures come from the
 * ledger as they are (stretch-ledger reconciles them to the bills to the cent); nothing here
 * adds or rounds money.
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
  return (
    <details data-portal-stretch className="portal-glass group rounded-2xl" open={open}>
      <summary className={`portal-summary ${summaryFocus} flex min-h-[44px] items-center gap-3 px-4 py-3`}>
        <ChevronRight className={chevron} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-900">{s.label}</div>
          {range ? <div className="text-sm text-slate-600">{range}</div> : null}
          <div className="mt-0.5 text-sm text-slate-700">
            <span className="tabular-nums">Work {formatCurrency(s.workTotal)}</span>
            <span aria-hidden> · </span>
            <span className="tabular-nums">Paid {formatCurrency(s.paidTotal)}</span>
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

        <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-white/80 px-3 py-2 text-sm">
          <div>
            <dt className="text-xs text-slate-600">Work</dt>
            <dd className="font-semibold tabular-nums">{formatCurrency(s.workTotal)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-600">Paid</dt>
            <dd className="font-semibold tabular-nums">{formatCurrency(s.paidTotal)}</dd>
          </div>
          <div className="text-right">
            <dt className="text-xs text-slate-600">{s.balanceAfter < -0.005 ? "Paid Ahead" : "Balance After"}</dt>
            <dd className="font-bold tabular-nums">{formatCurrency(Math.abs(s.balanceAfter))}</dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

/** Who worked that day and how long, by the full name the bill prints. */
function peopleLine(d: LedgerDay): string {
  const byPerson = new Map<string, number>();
  for (const l of d.labor) byPerson.set(l.person, (byPerson.get(l.person) ?? 0) + l.hours);
  return [...byPerson.entries()].map(([p, h]) => `${p} ${fmtHours(h)}`).join(" · ");
}

function DayRow({ d, thisYear }: { d: LedgerDay; thisYear: string }) {
  const people = peopleLine(d);
  const things = d.items.length;
  return (
    <details className="group/day rounded-xl bg-white/80">
      <summary className="portal-summary flex min-h-[44px] cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]">
        <ChevronRight
          className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))] motion-safe:transition-transform group-open/day:rotate-90"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-900">{fmtWeekday(d.date, thisYear)}</div>
          <div className="truncate text-xs text-slate-600">
            {[people, things ? `${things} ${things === 1 ? "item" : "items"}` : ""].filter(Boolean).join(" · ") || "Charges"}
          </div>
        </div>
        <div className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(d.total)}</div>
      </summary>
      <div className="border-t border-slate-200/70 px-3 pb-2 pt-1">
        {!d.inRange ? (
          <p className="py-1 text-xs text-amber-900">
            After this stretch&apos;s dates. It is shown here until the next stretch starts.
          </p>
        ) : null}
        <ul className="divide-y divide-slate-200/70">
          {d.labor.map((l, i) => (
            <LaborLine key={`l${i}`} l={l} />
          ))}
          {d.items.map((it, i) => (
            <ItemLine key={`i${i}`} it={it} />
          ))}
        </ul>
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

const KIND_NOTE: Record<ItemRow["kind"], string> = {
  material: "",
  charge: "Charge",
  credit: "Credit",
  tax: "Tax",
  adjustment: "Adjustment",
};

function ItemLine({ it }: { it: ItemRow }) {
  const qty = it.kind === "material" || it.quantity !== 1
    ? `${fmtQty(it.quantity)}${it.unit ? ` ${it.unit}` : ""} at ${formatCurrency(it.unitPrice)}`
    : "";
  const note = [KIND_NOTE[it.kind], qty, it.datedBy === "bill" ? "dated by the bill" : ""].filter(Boolean).join(" · ");
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
          {!p.inRange ? " · after the stretch ended" : ""}
        </div>
      </div>
      <div className="shrink-0 font-semibold tabular-nums text-emerald-800">{formatCurrency(p.amount)}</div>
    </li>
  );
}
