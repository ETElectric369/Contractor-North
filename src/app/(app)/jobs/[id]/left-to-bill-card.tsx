"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WhyFold } from "@/components/why-fold";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { formatCurrency } from "@/lib/utils";
import type { LeftToBill } from "@/lib/payment-schedule-math";
import type { EverythingBillable } from "@/lib/everything-billable";
import type { OpenDraft } from "@/lib/actuals-draw";
import { NewInvoiceButton, type NewInvoiceButtonProps } from "./new-invoice-button";
import { useRequestNextPayment } from "./payment-schedule-card";

/** A bill the fold names: its number and what it bills. */
export type LeftToBillBill = { id: string; number: string | null; total: number };

/** One row of the schedule, for the fold: billed, the next one, or still to come. */
export type LeftToBillRow = { label: string; percent?: number | null; dollars: number; billed: boolean; next: boolean };

/**
 * EVERYTHING BILLABLE (cn-v1181; it was Left to Bill, W1-19): the Overview's one figure and one button
 * on a job billed by its CONTRACT, the twin of the Unbilled card on a job billed by its work. Staff only
 * (the page never mounts it for a tech: every figure here is money). The owner, 2026-11-22: "yes \"left
 * to bill\" should definitely have all the billing data and lets change the name to \"Everything
 * Billable\"".
 *
 *   A fixed-price job with no schedule: lib/everything-billable, the SAME function the paid-in-full gate
 *   and the Get Paid sheet read, so the page and the gate can never disagree. THE ONE NUMBER is the whole:
 *   "Everything Billable $X" (the estimates, plus approved change orders, less the discounts given on
 *   sent bills, before tax), and under it a thin Billed | Still to Bill bar. "before tax" is said once
 *   when the estimate or a bill carries tax; the tax billed so far waits in the fold. Bills past what was
 *   agreed (an approved deduct never taken off, an extra billed by hand) is one plain sentence outside the
 *   fold. THE ONE BUTTON is never one the server refuses: Part of the Estimate while the estimate has a
 *   part to take (`partLeftGross`), Bill the Change Orders when only approved change orders are left and
 *   New Invoice bills them, none when nothing is left (and a sentence, never a dead end, when something
 *   is left that no door here bills). With a draft open and something left, the button reads
 *   "Open INV-9xx", where that click goes (the server's one-draft rule).
 *
 *   A job on a payment schedule (any billing type): the schedule's own figures, drawn the same way (the
 *   whole schedule, Billed | Still to Bill), and "Request Next Payment ($next)", the schedule card's own
 *   door, with the figure only when the click draws it: on Time & Material the server bills the work
 *   since the last bill instead, so the button says no figure there and the card says why. A schedule
 *   that draws less or more than the contract says so, outside the fold.
 *
 * The Why? fold holds the reasoning: each estimate at its before-tax price, each approved change order
 * with its sign, the discounts, each sent bill with its total and what it counts when that differs, and
 * the draft named and not counted (contract); or each payment on the schedule. A native <details>.
 */
export function LeftToBillCard({
  jobId,
  view,
  billable = null,
  unread = false,
  draft = null,
  rows = [],
  isTm = false,
  openDraft = null,
  newInvoice,
}: {
  jobId: string;
  /** The schedule's figures (kind "schedule"); on a contract job only its kind is read. */
  view: LeftToBill;
  /** Contract: everythingBillable over the page's estimates, change orders, bills and discount lines. */
  billable?: EverythingBillable | null;
  /** Contract: a read behind the figure failed. Said, and no figure and no button: never a wrong one. */
  unread?: boolean;
  /** The job's open draft of any kind, named and never counted until it goes out. */
  draft?: LeftToBillBill | null;
  /** Schedule: its payments, in order. */
  rows?: LeftToBillRow[];
  /** A Time & Material job: Request Next Payment bills the work so far, never a figure here. */
  isTm?: boolean;
  /** The job's open draft and whether new work goes on it (openDraftOnJob). */
  openDraft?: Pick<OpenDraft, "id" | "number" | "refreshable"> | null;
  /** Contract: the page's facts for the job's New Invoice (the same props as the Invoices tab's). */
  newInvoice?: Omit<NewInvoiceButtonProps, "preset" | "label">;
}) {
  const router = useRouter();
  const lang = useLang();
  const t = translator(lang);
  const money = (n: number) => formatCurrency(n, lang);
  const { pending, error, requestNext } = useRequestNextPayment(jobId);
  const isSchedule = view.kind === "schedule";
  const e = isSchedule ? null : billable;
  const unreadHere = !isSchedule && unread;
  const noPrice = !isSchedule && !unreadHere && (!e || e.billable <= 0.005);

  // THE ONE NUMBER and its two halves: the schedule's own, or Everything Billable's.
  const whole = isSchedule ? view.scheduled : (e?.billable ?? 0);
  const billed = isSchedule ? view.billed : (e?.billed ?? 0);
  const left = isSchedule ? view.left : (e?.left ?? 0);
  const inFull = isSchedule ? view.billedInFull : !!e?.billedInFull;
  const barWhole = billed + left;
  const billedPct = barWhole > 0.005 ? Math.min(100, Math.max(0, (billed / barWhole) * 100)) : 0;
  const draftName = openDraft ? (openDraft.number ?? t("jb_ebTheDraft")) : null;

  const eyebrow = isSchedule ? t("jb_ebSchedule") : noPrice ? t("jb_ebNoPrice") : e?.accepted ? t("jb_ebContract") : t("jb_ebEstimate");

  // THE ONE BUTTON on a contract job: a door the server takes, or none.
  // BOTH figures (cn-v1181, lane S): something is still to bill (`left`, money asked ahead counted as
  // billed) AND a part can take something (`partLeftGross`, measured by work). They differ when a payment
  // request asked for the whole price: all billed, yet no bill carries the work; no part is offered there.
  const partToTake = !!e && e.left > 0.005 && e.partLeftGross > 0.005 && !!newInvoice?.hasEstimate;
  const changesToBill = !!e && !partToTake && e.left > 0.005 && (newInvoice?.changeOrdersToBill ?? 0) > 0;
  const contractButton: { preset?: "part"; label: string } | null =
    !newInvoice || noPrice || !e
      ? null
      : draftName && e.left > 0.005
        ? // An open draft is where any New Invoice goes (the server's one-draft rule): the button says so.
          { preset: partToTake ? "part" : undefined, label: fillText(t("jb_ebOpenDraft"), { number: draftName }) }
        : partToTake
          ? { preset: "part", label: t("jb_ebPartOfEstimate") }
          : changesToBill
            ? { label: t("jb_ebBillChangeOrders") }
            : null;
  const leftWithNoDoor = !isSchedule && !!e && e.left > 0.005 && !contractButton;

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            {!unreadHere && <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{eyebrow}</div>}
            {/* THE ONE NUMBER: the whole. */}
            <div className="mt-1 text-2xl font-bold text-slate-900">
              {t("jb_ebTitle")}
              {!unreadHere && <> {money(whole)}</>}
              {e?.taxed && <span className="text-base font-medium text-slate-500"> · {t("jb_ebBeforeTax")}</span>}
              {inFull && <span className="text-base font-medium text-slate-500"> · {isSchedule ? t("jb_ebEveryPaymentBilled") : t("jb_ebAllBilled")}</span>}
            </div>
            {/* Billed | Still to Bill, as one thin bar (text to visual: the figure's own mark). */}
            {barWhole > 0.005 && (
              <div className="mt-2 max-w-sm">
                <div
                  className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200"
                  role="img"
                  aria-label={fillText(t("jb_ebBarLabel"), { billed: money(billed), left: money(left) })}
                >
                  <div className="h-full bg-brand" style={{ width: `${billedPct}%` }} />
                </div>
                <div className="mt-1 flex justify-between gap-3 text-xs text-slate-500">
                  <span>
                    {t("jb_ebBilled")} {money(billed)}
                  </span>
                  <span>
                    {t("jb_ebStillToBill")} {money(left)}
                  </span>
                </div>
              </div>
            )}
            {/* Billed past what was agreed: a money fact, said outside the fold. */}
            {e && e.over > 0.005 && <p className="mt-1 text-sm text-slate-700">{fillText(t("jb_ebOver"), { amount: money(e.over) })}</p>}
            {/* The draft, named: it counts once it goes out. */}
            {draft && (
              <p className="mt-1 text-sm text-slate-500">
                {fillText(t("jb_ebDraftSaid"), { number: draft.number ?? t("jb_ebAnInvoice"), amount: money(draft.total) })}
              </p>
            )}
            {noPrice && <p className="mt-1 text-sm text-slate-500">{t("jb_ebNoPriceSaid")}</p>}
            {unreadHere && <p className="mt-1 text-sm text-slate-500">{t("jb_ebUnread")}</p>}
            {leftWithNoDoor && e && <p className="mt-1 text-sm text-slate-500">{fillText(t("jb_ebLeftNoDoor"), { amount: money(e.left) })}</p>}
            {/* MONEY ASKED AHEAD IS NOT A BILL FOR THE WORK (cn-v1181 fixer, F15): a request inside Billed
                comes off the next bill by itself, so a job whose price was asked ahead does not just read
                all billed. Plain, never amber. */}
            {!unreadHere && e && e.requestsToComeOff > 0.005 && (
              <p className="mt-1 text-sm text-slate-500">{fillText(t("jb_ebAskedAhead"), { amount: money(e.requestsToComeOff) })}</p>
            )}
            {isSchedule && isTm && view.next && <p className="mt-1 text-sm text-slate-500">{t("jb_ebTmNote")}</p>}
            <WhyFold label={t("jb_ebWhy")}>
              {isSchedule ? (
                rows.length ? (
                  <ul className="space-y-1">
                    {rows.map((r, i) => (
                      <li key={i}>
                        {r.label}
                        {Number(r.percent) > 0 ? ` · ${Number(r.percent)}%` : ""} · {money(r.dollars)} ·{" "}
                        <span className={r.billed ? "text-emerald-700" : r.next ? "text-amber-700" : undefined}>
                          {r.billed ? t("jb_ebBilled") : r.next ? t("jb_ebRowNext") : t("jb_ebRowToCome")}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null
              ) : e ? (
                <ul className="space-y-1">
                  {e.pieces.estimates.map((q, i) => (
                    <li key={`e${i}`}>
                      {fillText(t(q.accepted ? "jb_ebAcceptedEstimate" : "jb_ebEstimateNotAccepted"), { number: q.number ?? "", amount: money(q.amount) })}
                    </li>
                  ))}
                  {e.pieces.changeOrders.map((c) => (
                    <li key={c.id}>{fillText(t("jb_ebChangeOrder"), { label: c.label, amount: signed(c.amount, money) })}</li>
                  ))}
                  {e.discounts > 0.005 && <li>{fillText(t("jb_ebDiscounts"), { amount: signed(-e.discounts, money) })}</li>}
                  {e.pieces.bills.length === 0 ? (
                    <li>{t("jb_ebNothingOut")}</li>
                  ) : (
                    e.pieces.bills.map((b, i) => (
                      <li key={b.id ?? `b${i}`}>
                        {fillText(t("jb_ebWentOut"), { number: b.number ?? t("jb_ebAnInvoice"), amount: money(b.total) })}
                        {Math.abs(b.counts - b.total) > 0.005 && <> · {fillText(t("jb_ebCounts"), { amount: money(b.counts) })}</>}
                      </li>
                    ))
                  )}
                  {draft && <li>{fillText(t("jb_ebDraftFold"), { number: draft.number ?? t("jb_ebAnInvoice"), amount: money(draft.total) })}</li>}
                  {e.taxed && e.tax > 0.005 && <li>{fillText(t("jb_ebTaxBilled"), { amount: money(e.tax) })}</li>}
                </ul>
              ) : null}
            </WhyFold>
            {/* Said outside the fold: a schedule that won't draw the contract is a money fact. */}
            {isSchedule && view.scheduleShort > 0.005 && (
              <p className="text-sm text-amber-700">{fillText(t("jb_ebScheduleShort"), { amount: money(view.scheduleShort), contract: money(view.contract) })}</p>
            )}
            {isSchedule && view.scheduleOver > 0.005 && (
              <p className="text-sm text-amber-700">{fillText(t("jb_ebScheduleOver"), { amount: money(view.scheduleOver), contract: money(view.contract) })}</p>
            )}
            {error && <p className="mt-1 text-sm font-medium text-red-600">{error}</p>}
          </div>

          {/* THE ONE BUTTON: never one the server refuses, never a figure the click doesn't bill. */}
          {isSchedule ? (
            draftName && openDraft ? (
              <Button type="button" onClick={() => router.push(`/billing/${openDraft.id}`)} className="min-h-11 shrink-0">
                <FileText /> {fillText(t("jb_ebOpenDraft"), { number: draftName })}
              </Button>
            ) : view.next ? (
              <Button type="button" onClick={requestNext} disabled={pending} className="min-h-11 shrink-0">
                {pending ? t("jb_ebRequesting") : isTm ? t("jb_ebRequestNext") : fillText(t("jb_ebRequestNextAmount"), { amount: money(view.next.dollars) })}
                <ArrowRight className="h-4 w-4" />
              </Button>
            ) : null
          ) : contractButton && newInvoice ? (
            <NewInvoiceButton {...newInvoice} preset={contractButton.preset} label={contractButton.label} />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** A change order's or a discount's dollars with their sign: "+$1,000.00", "−$900.00". */
function signed(n: number, money: (n: number) => string): string {
  return `${n < 0 ? "−" : "+"}${money(Math.abs(n))}`;
}
