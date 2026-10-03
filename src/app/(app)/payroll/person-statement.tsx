"use client";

import Link from "next/link";
import { Check, ChevronRight, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoPopup } from "@/components/info-popup";
import { formatCurrency } from "@/lib/utils";
import {
  alreadyAppliedTo,
  firstName,
  owedReading,
  paymentsToShow,
  periodLabel,
  type PayPaymentRow,
  type PersonBalance,
} from "@/lib/payroll-math";
import { HELD_MILEAGE_FACTS, THREE_FIGURES_FACTS } from "./payroll-facts";

/**
 * HOW MANY PAYMENTS THE STATEMENT DRAWS BEFORE IT FOLDS THE REST AWAY.
 *
 * THE FAILURE THIS PREVENTS. The only door to the pay form is at the FOOT of this statement, past the
 * payment list, and the list was every payment the person had ever been handed. A year of weekly pay
 * put that door about 3,500px down — and every row he scrolled past on the way carried a one-tap Undo
 * that voids a payment and can unlock a pay period with no confirm. Six is enough to recognise the
 * last few weeks; the rest are one tap behind a fold, and `Paid` above is still the all-time sum.
 */
const STATEMENT_PAYMENTS = 6;

/**
 * ── ONE PERSON'S STATEMENT, AND THE BUTTON THAT PAYS HIM, SEPARATED ───────────────────────────
 *
 * Erik, 2026-10-01 (dfe1f59b): "separate the payroll detail from the button to pay them / record
 * payment and merge all the data into a more intuitive" page.
 *
 * WHAT WAS WRONG. Each person's whole card WAS the pay button, and the only breakdown of what he was
 * owed — the open pay periods, what had already been paid against them, the running-shift caveat —
 * was drawn INSIDE the form titled "Pay <name>". To look at a man's detail you had to open the form
 * that pays him. And the equation the whole page rests on, Erik's own framing, was never said:
 * `earned` and `paid` were computed per person (balanceForPerson) and handed to this page, and the
 * page read nothing but `owed`.
 *
 * WHAT IT IS NOW. Tapping a person opens his statement IN PLACE, under his own card — not a page, not
 * a sheet over the board. In place for two reasons. It is "inside the thing it belongs to", which is
 * where a figure wants to live; and the page's own answer banner (what a payment locked, with its
 * Undo) stays visible at the top instead of being covered by an overlay.
 *
 * THE STATEMENT PAYS NOBODY. It reads. One distinct Record Payment button, at the FOOT of it past
 * the detail, opens the form — which is unchanged, down to an amount that starts empty.
 */

/** "Sep 12" — the short form the board, the statement and the payment list all read in. ONE copy:
 *  a date-only string parses as UTC midnight, so formatting in a Pacific browser shows the day
 *  before, and a second copy of this is a second chance to forget the noon anchor. */
export const fmtDay = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * ONE PAYMENT, DRAWN ONE WAY. The statement lists this person's payments and Paid Recently lists
 * everybody's; before this there would have been two renderers of one row, free to drift in what
 * they said a voided payment looks like or which actions it still offers. `who` is the only
 * difference: the cross-person feed names the person, a statement already has.
 */
export function PaymentLine({
  payment: p,
  who,
  pending,
  onUndo,
  onConfirm,
}: {
  payment: PayPaymentRow;
  /** The person's name on a cross-person list; null inside their own statement. */
  who: string | null;
  pending: boolean;
  onUndo: () => void;
  /** Only an imported payment has anything to confirm, so only then is the control drawn. */
  onConfirm: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className={`text-sm ${p.voided ? "text-slate-400 line-through" : "text-slate-800"}`}>
          {fmtDay(p.paidOn)} · {who ? `${who} · ` : ""}
          {formatCurrency(p.amount)} · {p.method}
        </div>
        {/* A void never deletes (voidPayment clears nothing), so the row stays and says so. */}
        {p.voided && <div className="mt-0.5 text-xs font-medium text-slate-500">voided</div>}
        {p.reference && <div className="mt-0.5 text-xs text-slate-400">ref {p.reference}</div>}
        {p.note && (
          <div className={`mt-0.5 text-xs ${p.needsCheck && !p.voided ? "text-amber-700" : "text-slate-400"}`}>{p.note}</div>
        )}
      </div>
      {!p.voided && (
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {p.needsCheck && (
            <Button variant="outline" disabled={pending} onClick={onConfirm}>
              <Check className="h-4 w-4" /> That&apos;s Right
            </Button>
          )}
          <Button variant="ghost" className="text-slate-500" disabled={pending} onClick={onUndo}>
            <Undo2 className="h-4 w-4" /> Undo
          </Button>
        </div>
      )}
    </div>
  );
}

export function PersonStatement({
  balance,
  periods,
  heldMileage,
  period,
  payments,
  onClock,
  pending,
  onRecord,
  onUndo,
  onConfirm,
}: {
  /** Straight off PayrollView's props — the SAME PersonBalance the card above reads, so the card and
   *  the statement under it cannot disagree about a figure (balanceForPerson is the only arithmetic). */
  balance: PersonBalance;
  /** This person's UNLOCKED pay periods and their gross (owedPeriods[id]). */
  periods: { start: string; end: string; gross: number }[];
  /** EVERY pay period holding unsettled business miles of his, oldest first, the viewed one included
   *  (page.tsx heldMileage[id]). `offset` is the `?period=N` that opens it, or null when no
   *  non-negative offset reaches it. Mileage settles one period at a time, so without this the
   *  held-miles figure had nowhere to send him. */
  heldMileage: { start: string; end: string; miles: number; offset: number | null }[];
  /** The pay period the page is showing, so the held-miles line can say how much of its figure the
   *  Mileage block below is actually holding instead of pointing "below" and hoping. */
  period: { start: string; end: string };
  /** THIS person's payments, newest first, voided ones included — all of them, not a window. The
   *  cross-person feed's "Showing 12 of 40 payments" had nowhere to go; a man's own list is where
   *  the rest of his payments were always supposed to be. It still is: the newest few are drawn and
   *  the remainder sit behind one fold, so none of them is out of reach and none of them stands
   *  between him and the pay door at the foot (paymentsToShow says what that cap may not hide). */
  payments: PayPaymentRow[];
  /** A shift still running. The figure rule is owedReading's, shared with the card. */
  onClock: boolean;
  pending: boolean;
  onRecord: () => void;
  onUndo: (p: PayPaymentRow) => void;
  onConfirm: (p: PayPaymentRow) => void;
}) {
  const who = firstName(balance.name);
  const reading = owedReading({ name: balance.name, owed: balance.owed, onClock });
  const applied = alreadyAppliedTo(periods, balance.owed);
  const inView = periodLabel(period.start, period.end);
  // How much of the held figure the Mileage block below is actually holding, and which other pay
  // periods hold the rest. Matched on the period's own bounds, not on an index or a count.
  const isViewed = (h: { start: string; end: string }) => h.start === period.start && h.end === period.end;
  const heldHere = heldMileage.find(isViewed)?.miles ?? 0;
  const heldElsewhere = heldMileage.filter((h) => !isViewed(h));
  const { shown, hidden } = paymentsToShow(payments, STATEMENT_PAYMENTS);

  return (
    <div className="border-t border-slate-200 bg-slate-50/70 px-4 py-4 sm:px-5">
      {/* OWED = EARNED − PAID, in that order, with the line above Owed that makes it a subtraction
          on sight. Erik's own framing, and until now the page never said it: both halves were
          computed and handed over, and only the answer was drawn. */}
      <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Owed Is Earned Less Paid</h3>
          <InfoPopup
            title="How These Three Figures Are Worked Out"
            label="About Earned, Paid And Owed"
            bullets={THREE_FIGURES_FACTS}
            className="-my-2 -mr-2"
          />
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-sm text-slate-600">Earned</span>
          <span className="text-base font-semibold tabular-nums text-slate-900">{formatCurrency(balance.earned)}</span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-sm text-slate-600">Paid</span>
          <span className="text-base font-semibold tabular-nums text-slate-900">{formatCurrency(balance.paid)}</span>
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-slate-200 pt-2">
          <span className="text-sm font-semibold text-slate-900">{reading.kind === "ahead" ? "Ahead" : "Owed"}</span>
          {/* THE SAME RULE AS THE CARD, from the same function: a withheld figure has no number to
              print, so this cannot quietly draw a balance that is short a running shift. */}
          {reading.amount === null ? (
            <span className={`text-sm font-semibold ${reading.kind === "onClock" ? "text-amber-700" : "text-slate-500"}`}>
              {reading.word}
            </span>
          ) : (
            <span className={`text-2xl font-bold tabular-nums ${reading.kind === "ahead" ? "text-slate-500" : "text-slate-900"}`}>
              {formatCurrency(reading.amount)}
            </span>
          )}
        </div>
        {reading.line && (
          <p className={`mt-1.5 text-xs ${reading.kind === "onClock" ? "text-amber-700" : "text-slate-500"}`}>{reading.line}</p>
        )}
      </div>

      {periods.length > 0 && (
        <div className="mt-3">
          <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Pay Periods Still Open</h3>
          <div className="mt-1 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
            {periods.map((p) => (
              <div key={`${p.start}|${p.end}`} className="flex items-baseline justify-between gap-3 px-4 py-2">
                <span className="text-sm text-slate-700">{periodLabel(p.start, p.end)}</span>
                <span className="text-sm font-medium tabular-nums text-slate-900">{formatCurrency(p.gross)}</span>
              </div>
            ))}
          </div>
          {/* Two numbers on one card that fail to add up: the open periods come to more than is
              owed exactly when money has already gone against those same hours. Say it. */}
          {applied > 0.005 && reading.kind === "owed" && (
            <p className="mt-1 px-1 text-xs text-slate-500">Less {formatCurrency(applied)} you have already paid against these.</p>
          )}
        </div>
      )}

      {/* HELD MILEAGE IS ITS OWN LINE AND ITS OWN BUCKET (0095's two-lock rule): miles here, never
          dollars, and never added into any of the three figures above.

          AND IT SAYS ITS OWN SCOPE, which is the whole point of this block. The figure counts every
          unsettled business mile in the 18-month window; the Mileage block below holds ONE pay period,
          because settleMileage stamps one pay period at a time. "Mileage is settled on its own below"
          was therefore false the morning after any period rolled over: the statement said 30 miles
          were held and the block said "No miles logged in this pay period", with no period named and
          no door. So the line now says how much of the figure is in view, and every other pay period
          holding miles gets a door of its own underneath. */}
      {balance.heldMiles > 0.05 && (
        <div className="mt-3">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 px-1 text-xs text-slate-500">
              {balance.heldMiles.toFixed(1)} business miles are held and not settled.{" "}
              {heldHere > 0.05
                ? `${heldHere.toFixed(1)} of them are in ${inView}, in Mileage below.`
                : `None of them are in ${inView}, the pay period in view.`}
            </p>
            <InfoPopup
              title="How Held Mileage Is Settled"
              label="About Held Mileage"
              bullets={HELD_MILEAGE_FACTS}
              className="-mr-2 -mt-2"
            />
          </div>
          {heldElsewhere.length > 0 && (
            <div className="mt-1 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
              {heldElsewhere.map((h) =>
                // A period the pager cannot reach (forward-dated hours) is STATED, never drawn as a
                // door: a link to the wrong period is worse than a line he has to read.
                h.offset === null ? (
                  <div key={`${h.start}|${h.end}`} className="flex min-h-11 items-center justify-between gap-3 px-4 py-2">
                    <span className="min-w-0 truncate text-sm text-slate-500">{periodLabel(h.start, h.end)}</span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-500">{h.miles.toFixed(1)} mi held</span>
                  </div>
                ) : (
                  <Link
                    key={`${h.start}|${h.end}`}
                    href={`/payroll?period=${h.offset}`}
                    className="flex min-h-11 items-center justify-between gap-2 px-4 py-2 active:bg-slate-50"
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-slate-800">{periodLabel(h.start, h.end)}</span>
                    <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-slate-600">
                      {h.miles.toFixed(1)} mi held
                      <ChevronRight aria-hidden className="h-4 w-4 text-slate-400" />
                    </span>
                  </Link>
                ),
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Payments</h3>
        {payments.length === 0 ? (
          <p className="mt-1 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
            No payment recorded for {who} yet.
          </p>
        ) : (
          <div className="mt-1 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
            {shown.map((p) => (
              <PaymentLine
                key={p.id}
                payment={p}
                who={null}
                pending={pending}
                onUndo={() => onUndo(p)}
                onConfirm={() => onConfirm(p)}
              />
            ))}
          </div>
        )}
        {/* THE REST, ONE TAP AWAY. Nothing is dropped — paymentsToShow keeps any still-unchecked
            payment in the list above whatever the cap, so the amber banner at the top of the page
            can never be pointing at a "That's Right" that is folded out of sight. The count names
            what is HIDDEN, not how many he has ever been paid; `Paid` above is the all-time sum. */}
        {hidden.length > 0 && (
          <details className="group mt-1">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-1 text-sm font-medium text-slate-600 [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-open:rotate-90" />
              Show {hidden.length} Older {hidden.length === 1 ? "Payment" : "Payments"}
            </summary>
            <div className="mt-1 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
              {hidden.map((p) => (
                <PaymentLine
                  key={p.id}
                  payment={p}
                  who={null}
                  pending={pending}
                  onUndo={() => onUndo(p)}
                  onConfirm={() => onConfirm(p)}
                />
              ))}
            </div>
          </details>
        )}
      </div>

      {/* THE ONLY DOOR TO THE PAY FORM, and it is at the FOOT of the statement on purpose: the tap
          that opened this statement landed at the top of it, so a button directly under that tap is
          a button a second tap reaches by accident. Opening the form still pays nothing — the amount
          starts empty — but money is not where we practise being nearly careful enough. */}
      <Button variant="primary" className="mt-4 w-full" disabled={pending} onClick={onRecord}>
        Record Payment…
      </Button>
    </div>
  );
}
