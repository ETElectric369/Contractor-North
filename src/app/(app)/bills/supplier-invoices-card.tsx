"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";
import { r2, type SupplierActionResult } from "./supplier-balance";
import { ShelfTicketSheet, type ShelfCountLine } from "@/components/shelf-count";
import { companyUseWord } from "@/lib/paperwork";
import type { TicketLineChoice } from "@/lib/shelf-plan";
import {
  claimableDiscounts,
  discountReading,
  documentOpenAmount,
  explainKind,
  invoicesNeedingBill,
  invoicesNeedingJob,
  isUsableJobName,
  jobPickerLabel,
  lateInterest,
  missedDiscounts,
  needsJobTotals,
  openDocuments,
  sayKind,
  supplierSaysOpen,
  type SupplierInvoiceKind,
  type SupplierReconcileFeed,
} from "./supplier-reconcile";

export interface SupplierInvoiceActions {
  /**
   * A PERSON says which job an invoice belongs to. Never inferred, not once: the same road reads
   * "5659 RHODESIA", "561 RHODESIA", "5661 RHODESIA" and "5659 RODESSIA" on CED's paper, and he
   * has five separate jobs on it. A machine picking there is guessing with his job costs.
   */
  setInvoiceJob: (input: { invoiceId: string; jobId: string }) => Promise<SupplierActionResult>;
  /**
   * Optional: turn a supplier invoice the app never scanned into a bill on its job, at CED's own
   * line prices. Without it the row still names the money and links to the job, which is the
   * whole point of the section - a button that can only refuse would be worse than no button.
   */
  recordAsBill?: (input: { invoiceId: string; differentPurchase?: boolean }) => Promise<SupplierActionResult>;
  /**
   * Same Purchase: Tie Them (audit v994, DB1). A bill already in his books may be this purchase:
   * the same number, or a counter ticket on this account and job within a few dollars and days
   * (a counter ticket's sales-order number is never on CED's invoice). A person presses it; the
   * server re-derives the candidates and writes only the link.
   */
  tieToBill?: (input: { invoiceId: string; billId: string }) => Promise<SupplierActionResult>;
  /**
   * RECORD TO SHELF (Shop Stock, Phase 2): the document goes in as a shelf ticket, not a job's,
   * each line counted onto the shelf by a person or marked Not Stock. `shelfLines` reads the lines
   * the record will write, in its order; `recordToShelf` is Record It As A Bill with the answers.
   */
  shelfLines?: (invoiceId: string) => Promise<{ ok: true; lines: ShelfCountLine[]; total: number } | { ok: false; error: string }>;
  recordToShelf?: (input: { invoiceId: string; differentPurchase?: boolean; toShelf: TicketLineChoice[] }) => Promise<SupplierActionResult>;
}

/** How many rows a section shows before it says how many more there are. */
const LIST_LIMIT = 6;

const KIND_TONE: Record<SupplierInvoiceKind, Tone> = {
  invoice: "slate",
  credit_memo: "green",
  service_charge: "red",
  statement: "indigo",
};

/** "21 days", "today", "3 days ago" - a deadline read the way he would say it out loud. */
function sayDeadline(days: number | null): string {
  if (days === null) return "no date on it";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 0) return `${days} days from now`;
  if (days === -1) return "yesterday";
  return `${-days} days ago`;
}

/**
 * WHAT RECONCILING WITH THE SUPPLIER FOUND (Erik, 2026-09-19; migration 0273).
 *
 * He got into his CED payment portal tonight and downloaded every document. Forty-seven parsed,
 * every one reconciles to the cent, and the first thing the portal said was that we were wrong:
 *
 *     CED says $3,845.14.    The app said $6,476.93.
 *
 * This card is the reconciliation, on a phone, for a man standing at a counter. It holds four
 * things and decides none of them - every judgement in it comes out of supplier-reconcile.ts,
 * which is pure and has a test around it built from his real strings:
 *
 *  1. WHAT CED SAYS, and how fresh that is. Their number, not ours, because only the supplier
 *     knows which invoices a payment settled. A credit memo and a service charge sit in the same
 *     list wearing the same shape as an invoice, so each one says what it IS: a service charge is
 *     interest he paid for being late, and saying that plainly is the only thing that stops it.
 *  2. INVOICES WITH NO JOB. CED's own job name, his jobs to pick from, best guess first and NEVER
 *     preselected.
 *  3. PURCHASES NOT IN HIS BOOKS. $1,765.72 of invoices bought since the app started and recorded
 *     nowhere in it - which means a job's cost is understated, and one of those jobs is about to
 *     be invoiced.
 *  4. THE DISCOUNT STILL ON THE TABLE. $29.62 by 10 October, beside the $60.42 of late interest
 *     CED charged him while $25.99 of the same discount quietly expired.
 *
 * NOTHING HERE IS HIDDEN TO KEEP IT TIDY. Every list that is cut short says how many it cut and
 * what they hold, and the one date boundary in the whole card (purchases older than his first
 * scanned bill) says out loud what it left off and why.
 */
export function SupplierInvoicesCard({
  anchorId,
  accountName,
  feed,
  today,
  onRecordPayment,
  actions,
}: {
  /** The id the account card upstairs links down to. */
  anchorId: string;
  /** What he calls them: "CED Truckee". Used in every sentence, so it is never "the supplier". */
  accountName: string;
  feed: SupplierReconcileFeed;
  /** The ORG's today (todayStrInTz), never the browser's day: it ages every deadline on here. */
  today: string;
  /** Opens the payment sheet on the account card above. The discount section's one action, and
   *  the only reason this card knows the sheet exists. */
  onRecordPayment?: () => void;
  actions: SupplierInvoiceActions;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last thing that happened, in the SERVER'S own words - only it knows what actually landed
   *  in the database, and a screen guessing at that is how a man trusts a number nobody wrote. */
  const [done, setDone] = useState<string | null>(null);
  /** One row open at a time. A phone screen has room for one decision. */
  const [openRow, setOpenRow] = useState<string | null>(null);
  /** What he has picked in an open row's picker, before he presses. Nothing is preselected, ever. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  /** The action key of the last refusal, so the row that caused it can say so itself. */
  const [failedAt, setFailedAt] = useState<string | null>(null);
  /** Record To Shelf's sheet: the document's lines, read from the server, each counted by a person. */
  const [shelfSheet, setShelfSheet] = useState<{
    invoiceId: string;
    number: string;
    differentPurchase: boolean;
    lines: ShelfCountLine[];
    total: number;
  } | null>(null);

  function openShelf(invoiceId: string, number: string, differentPurchase: boolean) {
    if (!actions.shelfLines) return;
    setError(null);
    setFailedAt(null);
    setBusy(`shelf:${invoiceId}`);
    start(async () => {
      const res = await actions.shelfLines!(invoiceId);
      setBusy(null);
      if (!res.ok) {
        setError(res.error);
        setFailedAt(`bill:${invoiceId}`);
        return;
      }
      setShelfSheet({ invoiceId, number, differentPurchase, lines: res.lines, total: res.total });
    });
  }

  // Held steady across renders so the reads below are not redone on every keystroke in a picker -
  // `feed` is a fresh object every time the page re-renders, and forty invoices ranked against
  // thirty-one jobs is not work to repeat for nothing on a phone.
  const invoices = useMemo(() => feed?.invoices ?? [], [feed]);
  const jobs = useMemo(() => feed?.jobs ?? [], [feed]);

  const says = useMemo(() => supplierSaysOpen(invoices), [invoices]);
  const documents = useMemo(() => openDocuments(invoices), [invoices]);
  const needJob = useMemo(() => invoicesNeedingJob(invoices, jobs), [invoices, jobs]);
  const needJobTotals = useMemo(() => needsJobTotals(needJob), [needJob]);
  const needBill = useMemo(
    () => invoicesNeedingBill(invoices, { since: feed?.recordsSince ?? null }),
    [invoices, feed?.recordsSince],
  );
  const claimable = useMemo(() => claimableDiscounts(invoices, today), [invoices, today]);
  const missed = useMemo(() => missedDiscounts(invoices, today), [invoices, today]);
  const interest = useMemo(() => lateInterest(invoices), [invoices]);

  const nothingWaiting =
    needJob.length === 0 && needBill.rows.length === 0 && claimable.total <= 0.005;

  function run(fn: () => Promise<SupplierActionResult>, key: string, fallback: string) {
    setError(null);
    setFailedAt(null);
    setBusy(key);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (!res.ok) {
        setDone(null);
        setError(res.error ?? "Nothing was saved. Try again.");
        // AND WHERE HE WAS LOOKING WHEN IT HAPPENED (review, 2026-09-19). This card is long; a
        // refusal rendered only at the top is a thousand pixels above the thumb that caused it,
        // so a button un-disables, the row does not change, and the reason is off screen. The
        // banner above stays - it is what a screen reader reaches first - and the same sentence
        // is repeated under the row that asked.
        setFailedAt(key);
        return;
      }
      setDone(res.message ?? fallback);
      setOpenRow(null);
      router.refresh();
    });
  }

  /**
   * A section's "Show All" switch. NOTHING IS EVER CUT SILENTLY: the button says how many rows
   * are behind it AND what they hold, so a list that stops at six never quietly costs him a
   * number. Pass the whole count and the money in the tail; the rest is arithmetic.
   */
  function more(key: string, total: number, hiddenTotal: number, verb = "Holding") {
    const hidden = total - LIST_LIMIT;
    if (hidden <= 0) return null;
    return (
      <button
        type="button"
        onClick={() => setShowAll((s) => ({ ...s, [key]: !s[key] }))}
        className="mt-2 min-h-11 w-full rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 active:bg-slate-50"
      >
        {showAll[key]
          ? `Show Fewer (${LIST_LIMIT} Of ${total})`
          : `Show The Other ${hidden}, ${verb} ${formatCurrency(hiddenTotal)}`}
      </button>
    );
  }

  return (
    <Card id={anchorId} className="mb-6 scroll-mt-20 p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">What {accountName} Says You Owe</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          {accountName}&apos;s own documents, read off their portal. Where they disagree with your
          bills, they are right: only your supplier knows which invoices a payment settled.
        </p>
      </div>

      {/* THEIR NUMBER, WHOLE. Charges and credits are named underneath it rather than netted out
          of sight - a credit memo is money coming BACK, and a man who cannot see it will not
          chase it. */}
      <div className="mb-3 rounded-lg bg-slate-50 px-4 py-3">
        <div className="text-2xl font-bold tabular-nums text-slate-900">{formatCurrency(says.owed)}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-slate-500">
          {says.documents} open {says.documents === 1 ? "document" : "documents"}
          {says.asOf ? `, the newest dated ${formatDate(says.asOf)}` : ""}.{" "}
          {formatCurrency(says.charges)} charged
          {says.credits > 0.005 ? `, less ${formatCurrency(says.credits)} of credit coming back to you` : ""}.
        </div>
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {done && (
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">
          {done}
        </div>
      )}

      {nothingWaiting && (
        <p className="mb-3 rounded-lg bg-green-50 px-4 py-2.5 text-sm text-green-800">
          Every document {accountName} has sent is on a job, in your bills, and inside its discount
          date. Nothing here needs you.
        </p>
      )}

      {/* ── 1. INVOICES WITH NO JOB ─────────────────────────────────────────────────────────────
          CED prints a job name on every invoice and it very nearly matches his own. Very nearly
          is the problem: the matcher ranks and the line under each picker says how sure it is,
          but nothing is ever chosen for him. */}
      {needJob.length > 0 && (
        <section className="mb-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Invoices With No Job ({needJob.length})
          </h3>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
            {formatCurrency(needJobTotals.total)} of buying that no job is carrying yet.{" "}
            {accountName} wrote a job name on each one. Nothing below is picked for you.
            {needJobTotals.undecided > 0
              ? ` ${needJobTotals.undecided} of them could be more than one of your jobs, so they are yours to settle.`
              : ""}
            {/* SAID BEFORE HE MEETS THE ROW, not discovered when he taps one and finds no picker.
                CED booked these to shop stock, which is never a job, so they are the one kind of
                row on this card with nothing to decide - and a row that refuses without warning
                is the thing this app is not allowed to do. */}
            {needJobTotals.stock > 0
              ? ` ${needJobTotals.stock} of them ${needJobTotals.stock === 1 ? "is" : "are"} shop stock, holding ${formatCurrency(needJobTotals.stockTotal)}, and stay as overhead.`
              : ""}
          </p>

          <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {(showAll.job ? needJob : needJob.slice(0, LIST_LIMIT)).map(({ invoice, match }) => {
              const isOpen = openRow === `job:${invoice.id}`;
              const choice = picked[invoice.id] ?? "";
              const canPick = match.verdict !== "stock" && match.ranked.length > 0;
              return (
                <li key={invoice.id}>
                  {/* THE WHOLE ROW IS THE TARGET. One thumb, one target, no second button inside
                      it to mis-tap on a ladder (the payroll board's rule). */}
                  <button
                    type="button"
                    onClick={() => setOpenRow(isOpen ? null : `job:${invoice.id}`)}
                    aria-expanded={isOpen}
                    className="flex min-h-[60px] w-full items-center justify-between gap-3 px-3 py-2.5 text-left active:bg-slate-50"
                  >
                    <span className="flex min-w-0 items-start gap-2">
                      {isOpen ? (
                        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                      )}
                      <span className="min-w-0">
                        {/* CED'S OWN WORDS, unless CED's own words are the form's column header.
                            Invoice 1102291 came through with "CUSTOMER ORDER NO." where the job
                            name should be - quoting that back at him as if it meant something is
                            the app making him decode its input instead of reading it for him. The
                            raw string is still shown, one line down, labelled as what it is. */}
                        <span className="block truncate text-sm font-medium text-slate-900">
                          {isUsableJobName(invoice.jobNameRaw)
                            ? `“${invoice.jobNameRaw!.trim()}”`
                            : "No job name on it"}
                        </span>
                        {/* EVERY WORD ON THIS LINE COSTS ONE AT THE END OF IT. At 375px the
                            "Invoice " prefix pushed whether it was settled off the edge, and that
                            is the fact that decides whether the money is still his to hold on to.
                            A credit memo still says what it is, because there the word IS news. */}
                        <span className="block truncate text-xs text-slate-400">
                          {invoice.kind === "invoice" ? "" : `${sayKind(invoice.kind)} `}
                          {invoice.invoiceNumber}
                          {invoice.invoiceDate ? ` · ${formatDate(invoice.invoiceDate)}` : ""}
                          {!isUsableJobName(invoice.jobNameRaw) && invoice.jobNameRaw?.trim()
                            ? ` · their copy says “${invoice.jobNameRaw.trim()}”`
                            : ""}
                        </span>
                      </span>
                    </span>
                    {/* SETTLED OR OPEN BELONGS BESIDE THE MONEY, not on the end of a line that
                        truncates. At 375px it was the last thing on that line and so the first
                        thing to vanish - and whether he has already paid for something changes
                        what he does about it. */}
                    <span className="shrink-0 text-right">
                      <span className="block text-sm font-semibold tabular-nums text-slate-800">
                        {formatCurrency(invoice.total)}
                      </span>
                      <span className="block text-xs text-slate-400">
                        {invoice.closed ? "settled" : "still open"}
                      </span>
                    </span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-slate-100 bg-slate-50 px-3 py-3">
                      <p className="mb-2 text-xs leading-relaxed text-slate-600">{match.because}</p>

                      {/* A CONTROL THAT CAN ONLY REFUSE MUST NOT RENDER. CED booked this one to
                          STOCK, which is not a job and never will be - so there is no picker,
                          and a sentence says why instead of a dead button. */}
                      {canPick ? (
                        <>
                          <Label htmlFor={`job-${invoice.id}`}>Which job was this for?</Label>
                          <Select
                            id={`job-${invoice.id}`}
                            value={choice}
                            onChange={(e) => setPicked((p) => ({ ...p, [invoice.id]: e.target.value }))}
                          >
                            {/* NEVER PRESELECTED. The empty option is the one that is chosen when
                                the row opens, on every row, including the ones the matcher is
                                sure about. */}
                            <option value="">— Pick the job —</option>
                            {match.ranked.map(({ job }) => (
                              <option key={job.id} value={job.id}>
                                {jobPickerLabel(job)}
                              </option>
                            ))}
                          </Select>
                          <Button
                            className="mt-2 h-12 w-full"
                            disabled={pending || !choice}
                            onClick={() =>
                              run(
                                () => actions.setInvoiceJob({ invoiceId: invoice.id, jobId: choice }),
                                `job:${invoice.id}`,
                                `Invoice ${invoice.invoiceNumber} is on ${
                                  match.ranked.find((g) => g.job.id === choice)?.job.name ?? "that job"
                                }.`,
                              )
                            }
                          >
                            {busy === `job:${invoice.id}` ? "Filing It…" : "File It On This Job"}
                          </Button>
                          {!choice && (
                            <p className="mt-1.5 text-xs text-slate-500">
                              Pick a job and this button files {formatCurrency(invoice.total)} onto its
                              costs.
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-xs leading-relaxed text-slate-600">
                          This is shop stock, so there is no job to put it on. It stays as overhead,
                          which is where it belongs.
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {more(
            "job",
            needJob.length,
            r2(needJob.slice(LIST_LIMIT).reduce((s, r) => s + (Number(r.invoice.total) || 0), 0)),
          )}
        </section>
      )}

      {/* ── 2. PURCHASES NOT IN HIS BOOKS ───────────────────────────────────────────────────────
          The one that costs him real money quietly. $1,765.72 of it CED has already been paid
          for, so nothing anywhere will ever raise it again on its own. */}
      {needBill.rows.length > 0 && (
        <section className="mb-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Purchases Not In Your Books ({needBill.rows.length})
          </h3>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
            {formatCurrency(needBill.total)} bought at {accountName} with no bill anywhere in here,
            so the job it was bought for is not carrying the cost.
            {needBill.settledTotal > 0.005 ? (
              <>
                {" "}
                <span className="font-medium text-amber-800">
                  {formatCurrency(needBill.settledTotal)} of it is already paid for
                </span>
                , which means nothing on this screen will ever raise it again. Check those jobs
                before you invoice them.
              </>
            ) : (
              ""
            )}
            {/* COPY MUST NOT PROMISE A BUTTON THAT ISN'T THERE, and must not promise it on rows
                it cannot appear on. The first draft said "say which job up in Invoices With No Job
                and Record It As A Bill appears on the row down here" - but that list and this one
                are different sets, so he could file six jobs up there and come back to no new
                buttons at all, and a purchase CED booked to STOCK can never be given a job in the
                first place. It now says only what is true of the rows he is looking at. */}
            {needBill.rows.some((r) => !r.jobId)
              ? actions.recordAsBill
                ? ` ${needBill.rows.filter((r) => !r.jobId).length} of them have no job on them here, and a purchase needs a job before its cost can go anywhere${actions.recordToShelf ? ", unless it is shop stock: Record To Shelf is on every row" : ""}. Each one is up in Invoices With No Job as well: answer it on THAT row, and this row gets its button.`
                : " Most of these are on no job here either. Say which job up in Invoices With No Job and the cost can follow it there."
              : ""}
          </p>

          <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {(showAll.bill ? needBill.rows : needBill.rows.slice(0, LIST_LIMIT)).map((invoice) => (
              <li key={invoice.id} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-900">
                      {invoice.jobId && invoice.jobName ? (
                        <Link href={`/jobs/${invoice.jobId}`} className="hover:text-brand hover:underline">
                          {invoice.jobName}
                        </Link>
                      ) : isUsableJobName(invoice.jobNameRaw) ? (
                        `“${invoice.jobNameRaw!.trim()}”`
                      ) : (
                        "No job name on it"
                      )}
                    </span>
                    {/* WHERE IT STANDS GOES ON THE SMALL LINE, not in the title. "(not on a job
                        here yet)" hung off the end of a quoted road name and was the half that
                        got cut on a 375px phone, which left the row saying nothing it needed to. */}
                    <span className="block truncate text-xs text-slate-400">
                      {invoice.invoiceNumber}
                      {invoice.invoiceDate ? ` · ${formatDate(invoice.invoiceDate)}` : ""}
                      {invoice.jobId ? "" : " · no job yet"}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-semibold tabular-nums text-slate-800">
                      {formatCurrency(invoice.total)}
                    </span>
                    {/* The one that stings: money that has already left his account for a job
                        that never saw the cost. It gets the amber, on the row, every time. */}
                    <span className={`block text-xs ${invoice.closed ? "text-amber-700" : "text-slate-400"}`}>
                      {invoice.closed ? "already paid for" : "still open"}
                    </span>
                  </span>
                </div>

                {/* MAYBE ALREADY IN HIS BOOKS (audit v994, DB1). A bill that carries this number,
                    or a counter ticket on this account and job for the same money a few days
                    apart, may be this very purchase. Each one is offered, with the words that
                    matched, and a person says which it is: Same Purchase ties them and writes no
                    money; Different Purchase records it after all. Record It As A Bill never sits
                    beside these on its own, because one press of it was a second bill. */}
                {invoice.samePurchase?.length && actions.tieToBill ? (
                  <div className="mt-2 space-y-2 rounded-lg bg-amber-50 px-3 py-2.5">
                    {invoice.samePurchase.map((c) => (
                      <div key={c.billId} className="space-y-1.5">
                        <p className="text-xs leading-relaxed text-amber-900">{c.sentence}</p>
                        <Button
                          variant="outline"
                          className="h-11 w-full"
                          disabled={pending}
                          onClick={() =>
                            run(
                              () => actions.tieToBill!({ invoiceId: invoice.id, billId: c.billId }),
                              `tie:${invoice.id}`,
                              `Invoice ${invoice.invoiceNumber} is tied to the bill already in your books.`,
                            )
                          }
                        >
                          {busy === `tie:${invoice.id}` ? "Tying Them…" : "Same Purchase: Tie Them"}
                        </Button>
                      </div>
                    ))}
                    {actions.recordAsBill && invoice.jobId ? (
                      <Button
                        variant="outline"
                        className="h-11 w-full"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => actions.recordAsBill!({ invoiceId: invoice.id, differentPurchase: true }),
                            `bill:${invoice.id}`,
                            `Invoice ${invoice.invoiceNumber} is now a bill on ${invoice.jobName ?? "its job"}.`,
                          )
                        }
                      >
                        {busy === `bill:${invoice.id}` ? "Recording It…" : "Different Purchase: Record It Anyway"}
                      </Button>
                    ) : (
                      <p className="text-xs leading-relaxed text-amber-900">
                        If it is a different purchase, give it a job up in Invoices With No Job, and Different Purchase: Record It Anyway appears here.
                      </p>
                    )}
                    {/* Shop stock is a different purchase too: the intro says Record To Shelf is on
                        every row, so a row with a same-purchase match carries it here, as the same
                        person's decision the Tie asks for. */}
                    {actions.recordToShelf && actions.shelfLines && (
                      <Button
                        variant="outline"
                        className="h-11 w-full"
                        disabled={pending}
                        onClick={() => openShelf(invoice.id, invoice.invoiceNumber, true)}
                      >
                        {busy === `shelf:${invoice.id}` ? "Reading Its Lines…" : "Different Purchase: Record To Shelf"}
                      </Button>
                    )}
                  </div>
                ) : null}
                {failedAt === `tie:${invoice.id}` && error && (
                  <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-700">
                    {error}
                  </p>
                )}
                {/* ONE ACTION, AND ONLY WHEN THERE IS ONE TO OFFER. With recordAsBill wired it
                    writes the cost onto the job at CED's own line prices. Without it the job name
                    above is a link, which is the way forward for a row that HAS a job; for one
                    that does not, the section's own intro says where to go, once, instead of the
                    same sentence repeating down six rows of a phone screen. */}
                {/* RECORD TO SHELF (Shop Stock, Phase 2): on any row, job or no job, because CED
                    writing a job on it doesn't stop a person deciding it is stock. "STOCK" in its
                    job box only says so beside the button; nothing is picked for him. */}
                {actions.recordToShelf && actions.shelfLines && !(invoice.samePurchase?.length && actions.tieToBill) && (
                  <div className="mt-2 space-y-1">
                    {companyUseWord(invoice.jobNameRaw)?.shelf && (
                      <p className="text-xs text-sky-800">CED wrote &ldquo;{invoice.jobNameRaw!.trim()}&rdquo; on it: this reads like shop stock.</p>
                    )}
                    <Button
                      variant="outline"
                      className="h-11 w-full"
                      disabled={pending}
                      onClick={() => openShelf(invoice.id, invoice.invoiceNumber, false)}
                    >
                      {busy === `shelf:${invoice.id}` ? "Reading Its Lines…" : "Record To Shelf"}
                    </Button>
                  </div>
                )}
                {actions.recordAsBill && invoice.jobId && !(invoice.samePurchase?.length && actions.tieToBill) && (
                  <Button
                    variant="outline"
                    className="mt-2 h-11 w-full"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => actions.recordAsBill!({ invoiceId: invoice.id }),
                        `bill:${invoice.id}`,
                        `Invoice ${invoice.invoiceNumber} is now a bill on ${invoice.jobName ?? "its job"}.`,
                      )
                    }
                  >
                    {busy === `bill:${invoice.id}` ? "Recording It…" : "Record It As A Bill"}
                  </Button>
                )}
                {failedAt === `bill:${invoice.id}` && error && (
                  <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-700">
                    {error}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {more(
            "bill",
            needBill.rows.length,
            r2(needBill.rows.slice(LIST_LIMIT).reduce((s, r) => s + (Number(r.total) || 0), 0)),
          )}

          {/* WHAT THIS LIST LEFT OUT, SAID OUT LOUD. These predate the first bill this app ever
              held, so it could not have recorded them and there is nothing to fix - but money
              that simply disappears off a screen is what makes a man stop trusting the screen. */}
          {needBill.olderRows > 0 && (
            <p className="mt-2 text-xs text-slate-400">
              Another {needBill.olderRows}{" "}
              {needBill.olderRows === 1 ? "purchase" : "purchases"} holding{" "}
              {formatCurrency(needBill.olderTotal)} are from before your first bill here
              {needBill.since ? ` on ${formatDate(needBill.since)}` : ""}, so they were never going
              to be in your books. They are not on this list.
            </p>
          )}
        </section>
      )}

      {/* WHAT THE LIST ABOVE LEAVES OUT, AND WHY - OUTSIDE THE LIST, SO IT OUTLIVES IT (review,
          2026-09-19). Nested inside `needBill.rows.length > 0` these vanished the moment he
          finished the list, and the green "nothing here needs you" banner then said every CED
          document was in his books while $225.47 of returned merchandise sat unaccounted for. The
          sentence that explains an absence has to outlast the thing it was explaining. */}
      {needBill.reversedRows > 0 && (
        <p className="mb-3 text-xs leading-relaxed text-slate-400">
          {needBill.reversedRows === 1
            ? `One purchase, ${formatCurrency(needBill.reversedTotal)}, went straight back to ${accountName} on a credit memo`
            : `${needBill.reversedRows} purchases, ${formatCurrency(needBill.reversedTotal)} between them, went straight back to ${accountName} on credit memos`}
          . You kept nothing and you owe nothing, so there is no bill to record and they are not on
          the list above.
        </p>
      )}

      {/* ── 3. THE DISCOUNT STILL ON THE TABLE ──────────────────────────────────────────────────
          A date, a number, and what it costs to miss it. The interest line beside it is the
          argument: he has paid CED $60.42 for being late while this same discount expired. */}
      {(claimable.total > 0.005 || missed.total > 0.005 || interest.charged > 0.005) && (
        <section className="mb-4">
          <h3 className="text-sm font-semibold text-slate-900">
            {claimable.total > 0.005 ? "Discount Still On The Table" : "The Discount You Are Missing"}
          </h3>

          {claimable.total > 0.005 ? (
            <div className="mt-1 rounded-lg bg-green-50 px-4 py-3">
              <div className="text-xl font-bold tabular-nums text-green-900">
                {formatCurrency(claimable.total)}
              </div>
              {/* WHAT THE DATE ACTUALLY BUYS. When every live discount falls on one day the
                  whole figure rides on it and the sentence says so; when they do not, quoting
                  the whole amount against the soonest date would promise money that date cannot
                  claim. Two sentences, and the screen picks the true one. */}
              <p className="mt-0.5 text-xs leading-relaxed text-green-900">
                {claimable.dueOnNext >= claimable.total - 0.005 ? (
                  <>
                    comes off if {accountName} is paid by{" "}
                    <span className="font-semibold">{formatDate(claimable.nextDeadline)}</span>, which is{" "}
                    {sayDeadline(claimable.daysLeft)}. It is spread across {claimable.rows.length}{" "}
                    {claimable.rows.length === 1 ? "invoice" : "invoices"}.
                  </>
                ) : (
                  <>
                    is still on the table across {claimable.rows.length}{" "}
                    {claimable.rows.length === 1 ? "invoice" : "invoices"}, and{" "}
                    {formatCurrency(claimable.dueOnNext)} of it goes if {accountName} is not paid by{" "}
                    <span className="font-semibold">{formatDate(claimable.nextDeadline)}</span>, which is{" "}
                    {sayDeadline(claimable.daysLeft)}.
                  </>
                )}
              </p>
            </div>
          ) : (
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
              Nothing is claimable today. {accountName} takes a cut off every invoice paid by the
              tenth of the month after you buy.
            </p>
          )}

          {claimable.rows.length > 0 && (
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {(showAll.disc ? claimable.rows : claimable.rows.slice(0, LIST_LIMIT)).map(
                ({ invoice, reading }) => (
                  <li key={invoice.id} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-slate-800">
                        {invoice.invoiceNumber}
                        {invoice.jobNameRaw?.trim() ? ` · ${invoice.jobNameRaw.trim()}` : ""}
                      </span>
                      <span className="block truncate text-xs text-slate-400">
                        {formatCurrency(documentOpenAmount(invoice))} open · pay by{" "}
                        {formatDate(reading.by)}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-green-700">
                      {formatCurrency(reading.amount)} off
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
          {more(
            "disc",
            claimable.rows.length,
            r2(claimable.rows.slice(LIST_LIMIT).reduce((s, r) => s + r.reading.amount, 0)),
            "Worth Another",
          )}

          {/* WHAT IT HAS COST SO FAR. Nothing can be done about either number, which is exactly
              why they are on the screen: together they are the only honest argument for paying
              the next batch by the tenth. */}
          {(missed.total > 0.005 || interest.charged > 0.005) && (
            <p className="mt-2 text-xs leading-relaxed text-amber-900">
              {missed.total > 0.005
                ? `${formatCurrency(missed.total)} of discount has already run out on invoices still sitting open. `
                : ""}
              {interest.charged > 0.005
                ? `${accountName} has charged you ${formatCurrency(interest.charged)} of interest for paying late${
                    interest.stillOpen > 0.005
                      ? `, ${formatCurrency(interest.stillOpen)} of it still on this balance`
                      : ""
                  }.`
                : ""}
            </p>
          )}

          {/* THE ONE ACTION. Paying is how a discount gets claimed, and the sheet that does it is
              on the account card above - so this opens that, rather than growing a second way to
              record a payment that could drift from the first. */}
          {onRecordPayment && claimable.total > 0.005 && (
            <Button className="mt-2 h-12 w-full" disabled={pending} onClick={onRecordPayment}>
              Record A Payment
            </Button>
          )}
        </section>
      )}

      {/* ── 4. THE LEDGER ───────────────────────────────────────────────────────────────────────
          Their open documents, newest first, the way the portal lists them. A credit memo and a
          service charge are NOT invoices, so each one says what it is and what that means. */}
      <section>
        <h3 className="text-sm font-semibold text-slate-900">
          What {accountName} Has Open ({documents.length})
        </h3>
        {documents.length === 0 ? (
          <p className="mt-1 text-sm text-slate-400">
            {accountName} has nothing open on this account.
          </p>
        ) : (
          <>
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {(showAll.docs ? documents : documents.slice(0, LIST_LIMIT)).map((invoice) => {
                const disc = discountReading(invoice, today);
                const explain = explainKind(invoice.kind);
                const amount = documentOpenAmount(invoice);
                return (
                  <li key={invoice.id} className="px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-slate-900">
                            {invoice.invoiceNumber}
                          </span>
                          {invoice.kind !== "invoice" && (
                            <Badge tone={KIND_TONE[invoice.kind]}>{sayKind(invoice.kind)}</Badge>
                          )}
                        </span>
                        <span className="block truncate text-xs text-slate-400">
                          {invoice.invoiceDate ? formatDate(invoice.invoiceDate) : "No date"}
                          {invoice.jobName
                            ? ` · ${invoice.jobName}`
                            : isUsableJobName(invoice.jobNameRaw)
                              ? ` · “${invoice.jobNameRaw!.trim()}” (no job yet)`
                              : ""}
                          {(invoice.billCount ?? 0) > 0 ? " · scanned here" : " · not in your bills"}
                        </span>
                        {explain && (
                          <span className="mt-0.5 block text-xs text-slate-500">{explain}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-right">
                        <span
                          className={`block text-sm font-semibold tabular-nums ${
                            amount < 0 ? "text-green-700" : "text-slate-900"
                          }`}
                        >
                          {formatCurrency(amount)}
                        </span>
                        {/* Both halves of the discount or neither: the money is useless without
                            the day it stops. */}
                        {disc.state === "live" && (
                          <span className="block text-xs text-green-700">
                            {formatCurrency(disc.amount)} off by {formatDate(disc.by)}
                          </span>
                        )}
                        {disc.state === "expired" && (
                          <span className="block text-xs text-slate-400">
                            {formatCurrency(disc.amount)} off expired {formatDate(disc.by)}
                          </span>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {more(
              "docs",
              documents.length,
              r2(documents.slice(LIST_LIMIT).reduce((s, d) => s + documentOpenAmount(d), 0)),
            )}
          </>
        )}
      </section>
      {shelfSheet && actions.recordToShelf && (
        <ShelfTicketSheet
          title={`Record ${shelfSheet.number} To The Shelf`}
          lines={shelfSheet.lines}
          total={shelfSheet.total}
          fileLabel="Record To Shelf"
          onClose={() => setShelfSheet(null)}
          onFile={async (choices) => {
            const res = await actions.recordToShelf!({
              invoiceId: shelfSheet.invoiceId,
              differentPurchase: shelfSheet.differentPurchase,
              toShelf: choices,
            });
            if (!res.ok) return { ok: false, error: res.error };
            setShelfSheet(null);
            setDone(res.message ?? `${shelfSheet.number} is on the shop shelf now.`);
            router.refresh();
            return { ok: true };
          }}
        />
      )}
    </Card>
  );
}
