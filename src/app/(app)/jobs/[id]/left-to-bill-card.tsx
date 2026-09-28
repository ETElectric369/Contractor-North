"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WhyFold } from "@/components/why-fold";
import { formatCurrency } from "@/lib/utils";
import type { LeftToBill } from "@/lib/payment-schedule-math";
import type { OpenDraft } from "@/lib/actuals-draw";
import { NewInvoiceButton, type NewInvoiceButtonProps } from "./new-invoice-button";
import { useRequestNextPayment } from "./payment-schedule-card";

const money = (n: number) => formatCurrency(n);

/** A bill the fold names: its number and what it bills. */
export type LeftToBillBill = { id: string; number: string | null; total: number };

/** One row of the schedule, for the fold: billed, the next one, or still to come. */
export type LeftToBillRow = { label: string; percent?: number | null; dollars: number; billed: boolean; next: boolean };

/** The estimates that make the contract, for the fold: the ACCEPTED ones (a job can win two), else
 *  the newest proposal on its own (contractTotalFromQuotes' own rule, so the fold names exactly the
 *  estimate the figure was taken from). */
export function contractEstimates<T extends { quote_number?: string | null; total?: number | null; status?: string | null; created_at?: string | null }>(
  quotes: readonly T[],
): { number: string | null; total: number; accepted: boolean }[] {
  const accepted = quotes.filter((q) => q.status === "accepted");
  const picked = accepted.length
    ? accepted
    : [...quotes].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))).slice(0, 1);
  return picked.map((q) => ({ number: q.quote_number ?? null, total: Number(q.total) || 0, accepted: q.status === "accepted" }));
}

/**
 * LEFT TO BILL (W1-19): the Overview's one figure and one button on a job billed by its CONTRACT, the
 * twin of the Unbilled card on a job billed by its work. Staff only (the page never mounts it for a
 * tech: every figure here is money).
 *
 *   A fixed-price job with a live estimate and no schedule: "Contract $C", the big "Left To Bill $L"
 *   (the contract less what went out on sent bills; lib/payment-schedule-math leftToBill), a thin
 *   Billed | Left bar, and the job's own New Invoice (lane 4's NewInvoiceButton, opened on Part Of
 *   The Estimate, which takes a part of exactly $L). The button never prints $L: the click opens the
 *   sheet that asks how much. With a draft open it reads "Open INV-0xx", which is where that click
 *   goes (the server's one-draft rule). Billed in full: "$0.00 · the contract is billed", no button.
 *
 *   A job on a payment schedule (any billing type): the schedule's own remaining and "Request Next
 *   Payment ($next)", the schedule card's own door (useRequestNextPayment), with the figure only when
 *   the click draws it: on Time & Material the server bills the work since the last bill instead, so
 *   the button says no figure there and the card says why. Fully drawn: $0.00, no button. A schedule
 *   that draws less or more than the contract says so in amber, outside the fold.
 *
 * The Why? fold holds the reasoning: the estimate, each sent bill and the draft (contract), or each
 * payment on the schedule (schedule). A native <details>, so it is in the page's HTML, folded.
 */
export function LeftToBillCard({
  jobId,
  view,
  estimates = [],
  sent = [],
  draft = null,
  rows = [],
  isTm = false,
  openDraft = null,
  newInvoice,
}: {
  jobId: string;
  view: LeftToBill;
  /** contractEstimates(quotes): the estimate(s) the contract is. */
  estimates?: { number: string | null; total: number; accepted: boolean }[];
  /** Contract: the bills that went out (non-void, not a draft), each with what it bills. */
  sent?: LeftToBillBill[];
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
  const { pending, error, requestNext } = useRequestNextPayment(jobId);
  const isSchedule = view.kind === "schedule";
  const accepted = estimates.some((e) => e.accepted);
  const noPrice = !isSchedule && view.contract <= 0.005;
  const whole = view.billed + view.left;
  const billedPct = whole > 0.005 ? Math.min(100, Math.max(0, (view.billed / whole) * 100)) : 0;
  const draftName = openDraft ? (openDraft.number ?? "The Draft") : null;

  const eyebrow = isSchedule
    ? `Payment Schedule · ${money(view.scheduled)}`
    : noPrice
      ? "No Price On The Estimate Yet"
      : `${accepted || estimates.length === 0 ? "Contract" : "Estimate"} ${money(view.contract)}`;
  const doneWords = isSchedule ? "every payment is billed" : "the contract is billed";

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{eyebrow}</div>
            {/* THE ONE NUMBER. */}
            <div className="mt-1 text-2xl font-bold text-slate-900">
              Left To Bill {money(view.left)}
              {view.billedInFull && <span className="text-base font-medium text-slate-500"> · {doneWords}</span>}
            </div>
            {/* Billed | Left, as one thin bar (text to visual: the figure's own mark). */}
            {whole > 0.005 && (
              <div className="mt-2 max-w-sm">
                <div
                  className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200"
                  role="img"
                  aria-label={`${money(view.billed)} billed, ${money(view.left)} left`}
                >
                  <div className="h-full bg-brand" style={{ width: `${billedPct}%` }} />
                </div>
                <div className="mt-1 flex justify-between gap-3 text-xs text-slate-500">
                  <span>Billed {money(view.billed)}</span>
                  <span>Left {money(view.left)}</span>
                </div>
              </div>
            )}
            {/* The draft, named: it counts once it goes out. */}
            {draft && (
              <p className="mt-1 text-sm text-slate-500">
                {`${draft.number ?? "An invoice"} (${money(draft.total)}) is a draft.`}
              </p>
            )}
            {noPrice && <p className="mt-1 text-sm text-slate-500">The estimate on this job has no price yet, so there is nothing to take a part of.</p>}
            {isSchedule && isTm && view.next && (
              <p className="mt-1 text-sm text-slate-500">
                On Time &amp; Material, Request Next Payment bills the hours and receipts since the last bill; the schedule is the guide.
              </p>
            )}
            <WhyFold>
              {isSchedule ? (
                rows.length ? (
                  <ul className="space-y-1">
                    {rows.map((r, i) => (
                      <li key={i}>
                        {r.label}
                        {Number(r.percent) > 0 ? ` · ${Number(r.percent)}%` : ""} · {money(r.dollars)} ·{" "}
                        <span className={r.billed ? "text-emerald-700" : r.next ? "text-amber-700" : undefined}>
                          {r.billed ? "Billed" : r.next ? "Next" : "Still To Come"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null
              ) : (
                <ul className="space-y-1">
                  {estimates.map((e, i) => (
                    <li key={`e${i}`}>
                      {e.accepted ? "Accepted estimate" : "Estimate, not accepted yet"} {e.number ?? ""} · {money(e.total)}
                    </li>
                  ))}
                  {sent.length === 0 ? (
                    <li>Nothing has gone out on a bill yet.</li>
                  ) : (
                    sent.map((b) => (
                      <li key={b.id}>
                        {b.number ?? "An invoice"} · {money(b.total)} · went out
                      </li>
                    ))
                  )}
                  {draft && (
                    <li>
                      {draft.number ?? "An invoice"} · {money(draft.total)} · draft, not counted until it goes out
                    </li>
                  )}
                  {view.over > 0.005 && <li>The bills that went out come to {money(view.over)} more than the contract (an extra billed on top).</li>}
                </ul>
              )}
            </WhyFold>
            {/* Said outside the fold: a schedule that won't draw the contract is a money fact. */}
            {isSchedule && view.scheduleShort > 0.005 && (
              <p className="text-sm text-amber-700">
                This schedule draws {money(view.scheduleShort)} less than the {money(view.contract)} contract.
              </p>
            )}
            {isSchedule && view.scheduleOver > 0.005 && (
              <p className="text-sm text-amber-700">
                This schedule draws {money(view.scheduleOver)} more than the {money(view.contract)} contract.
              </p>
            )}
            {error && <p className="mt-1 text-sm font-medium text-red-600">{error}</p>}
          </div>

          {/* THE ONE BUTTON: never one the server refuses, never a figure the click doesn't bill. */}
          {isSchedule ? (
            draftName && openDraft ? (
              <Button type="button" onClick={() => router.push(`/billing/${openDraft.id}`)} className="min-h-11 shrink-0">
                <FileText /> Open {draftName}
              </Button>
            ) : view.next ? (
              <Button type="button" onClick={requestNext} disabled={pending} className="min-h-11 shrink-0">
                {pending ? "Requesting…" : isTm ? "Request Next Payment" : `Request Next Payment (${money(view.next.dollars)})`}
                <ArrowRight className="h-4 w-4" />
              </Button>
            ) : null
          ) : !view.billedInFull && newInvoice ? (
            <NewInvoiceButton {...newInvoice} preset="part" label={draftName ? `Open ${draftName}` : "New Invoice"} />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
