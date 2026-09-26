"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Fold, WhyFold } from "@/components/why-fold";
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
 * WHAT THE SUPPLIER'S OWN PAPER SAYS, INSIDE THAT SUPPLIER'S LINE (Bills plan, Wave B).
 *
 * This was its own long card (0273): CED's balance a second time, then four lists of the SAME 51
 * documents, each opening with a paragraph. Erik: "it looks like one big run-on sentence". Now it
 * lives inside the supplier's detail on /bills, and:
 *
 *  · THE DECISIONS HAPPEN ON NEEDS YOU. A paper waiting there (supplierPaperFeed, the same cards
 *    My Day shows) is not listed again here: one paper, one place to answer it. What is left in
 *    these lists is what the cards never carry - a credit memo with no job, a paper CED booked to
 *    STOCK (Record To Shelf), a $0.00 line - so every door this card had still has one home.
 *  · EACH LIST IS ONE LINE until he opens it: its name, its count, its money.
 *  · THE BALANCE IS SAID ONCE, on the supplier's line above. Its working sits in a Why? fold.
 *  · THE DISCOUNT'S "Record A Payment" IS GONE: the supplier's own Record A Payment sits right
 *    above these lists, and two doors to one payment sheet is one too many.
 *
 * Every judgement still comes out of supplier-reconcile.ts, which is pure and tested.
 */
export function SupplierPaperLists({
  accountId,
  accountName,
  feed,
  today,
  onNeedsYou = [],
  actions,
}: {
  /** The supplier account: names the Not In Your Books fold, so Shop Stock's Record To Shelf door
   *  (shelf-plan waitingForShelf) lands on it. */
  accountId: string;
  /** What he calls them: "CED Truckee". Used in every sentence, so it is never "the supplier". */
  accountName: string;
  feed: SupplierReconcileFeed;
  /** The ORG's today (todayStrInTz), never the browser's day: it ages every deadline on here. */
  today: string;
  /** Papers answered on a Needs You card (supplierPaperFeed): never listed a second time here. */
  onNeedsYou?: string[];
  actions: SupplierInvoiceActions;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last thing that happened, in the SERVER'S own words - only it knows what actually landed
   *  in the database, and a screen guessing at that is how a man trusts a number nobody wrote. */
  const [done, setDone] = useState<string | null>(null);
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

  // Held steady across renders so the reads below are not redone on every keystroke in a picker.
  const invoices = useMemo(() => feed?.invoices ?? [], [feed]);
  const jobs = useMemo(() => feed?.jobs ?? [], [feed]);
  const cardIds = useMemo(() => new Set(onNeedsYou), [onNeedsYou]);

  const says = useMemo(() => supplierSaysOpen(invoices), [invoices]);
  const documents = useMemo(() => openDocuments(invoices), [invoices]);
  // Papers a bill already covers, and papers from before his books began, ask nothing (Wave A).
  const allNeedJob = useMemo(
    () => invoicesNeedingJob(invoices, jobs, { since: feed?.recordsSince ?? null }),
    [invoices, jobs, feed?.recordsSince],
  );
  // ONE PAPER, ONE PLACE: a paper on a Needs You card is answered there.
  const needJob = useMemo(() => allNeedJob.filter((r) => !cardIds.has(r.invoice.id)), [allNeedJob, cardIds]);
  const needJobTotals = useMemo(() => needsJobTotals(needJob), [needJob]);
  const needBill = useMemo(
    () => invoicesNeedingBill(invoices, { since: feed?.recordsSince ?? null }),
    [invoices, feed?.recordsSince],
  );
  const billRows = useMemo(() => needBill.rows.filter((r) => !cardIds.has(r.id)), [needBill, cardIds]);
  const billRowsTotal = r2(billRows.reduce((s, r) => s + (Number(r.total) || 0), 0));
  const claimable = useMemo(() => claimableDiscounts(invoices, today), [invoices, today]);
  const missed = useMemo(() => missedDiscounts(invoices, today), [invoices, today]);
  const interest = useMemo(() => lateInterest(invoices), [invoices]);
  const waitingOnCards = invoices.filter((i) => cardIds.has(i.id)).length;

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
        // AND WHERE HE WAS LOOKING WHEN IT HAPPENED: the same sentence under the row that asked.
        setFailedAt(key);
        return;
      }
      setDone(res.message ?? fallback);
      router.refresh();
    });
  }

  /**
   * A list's "Show All" switch. NOTHING IS EVER CUT SILENTLY: the button says how many rows are
   * behind it AND what they hold.
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

  const listLabel = (name: string, count: number, money?: string) => (
    <span className="text-sm font-semibold text-slate-900">
      {name} ({count}){money ? <span className="font-normal text-slate-500"> · {money}</span> : null}
    </span>
  );

  return (
    <div className="mt-3 space-y-1 border-t border-slate-100 pt-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{accountName}&apos;s Own Papers</p>
      {waitingOnCards > 0 && (
        <a href="#needs-you" className="flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
          {waitingOnCards} {waitingOnCards === 1 ? "Is" : "Are"} Waiting Under Needs You
        </a>
      )}
      <WhyFold label="Where This Comes From">
        <p>
          Read off {accountName}&apos;s portal. Where they disagree with your bills they are right: only the
          supplier knows which invoices a payment settled. {says.documents} open{" "}
          {says.documents === 1 ? "document" : "documents"}
          {says.asOf ? `, the newest dated ${formatDate(says.asOf)}` : ""}: {formatCurrency(says.charges)} charged
          {says.credits > 0.005 ? `, less ${formatCurrency(says.credits)} of credit coming back to you` : ""}.
        </p>
        {needBill.reversedRows > 0 && (
          <p>
            {needBill.reversedRows === 1
              ? `One purchase, ${formatCurrency(needBill.reversedTotal)}, went straight back on a credit memo`
              : `${needBill.reversedRows} purchases, ${formatCurrency(needBill.reversedTotal)}, went straight back on credit memos`}
            . Nothing kept, nothing owed, so nothing to record.
          </p>
        )}
        {needBill.olderRows > 0 && (
          <p>
            {needBill.olderRows} more {needBill.olderRows === 1 ? "purchase" : "purchases"} ({formatCurrency(needBill.olderTotal)})
            {" "}are from before your books here began{needBill.since ? ` on ${formatDate(needBill.since)}` : ""}, so they are not listed.
          </p>
        )}
      </WhyFold>

      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {done && <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">{done}</div>}

      {/* ── INVOICES WITH NO JOB, not on a card: a credit memo, a STOCK paper, a $0.00 one. ── */}
      {needJob.length > 0 && (
        <Fold summary={listLabel("Invoices With No Job", needJob.length, formatCurrency(needJobTotals.total))}>
          <WhyFold>
            <p>
              Buying no job is carrying yet. {accountName} wrote a job name on each one, and nothing is picked for you.
              {needJobTotals.stock > 0
                ? ` ${needJobTotals.stock} ${needJobTotals.stock === 1 ? "is" : "are"} shop stock (${formatCurrency(needJobTotals.stockTotal)}) and stay as overhead.`
                : ""}
            </p>
          </WhyFold>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {(showAll.job ? needJob : needJob.slice(0, LIST_LIMIT)).map(({ invoice, match }) => {
              const choice = picked[invoice.id] ?? "";
              const canPick = match.verdict !== "stock" && match.ranked.length > 0;
              return (
                <li key={invoice.id}>
                  <details>
                    <summary className="flex min-h-[60px] cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-900">
                          {isUsableJobName(invoice.jobNameRaw) ? `“${invoice.jobNameRaw!.trim()}”` : "No job name on it"}
                        </span>
                        <span className="block truncate text-xs text-slate-400">
                          {invoice.kind === "invoice" ? "" : `${sayKind(invoice.kind)} `}
                          {invoice.invoiceNumber}
                          {invoice.invoiceDate ? ` · ${formatDate(invoice.invoiceDate)}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-sm font-semibold tabular-nums text-slate-800">{formatCurrency(invoice.total)}</span>
                        <span className="block text-xs text-slate-400">{invoice.closed ? "settled" : "still open"}</span>
                      </span>
                    </summary>
                    <div className="border-t border-slate-100 bg-slate-50 px-3 py-3">
                      <p className="mb-2 text-xs leading-relaxed text-slate-600">{match.because}</p>
                      {/* A CONTROL THAT CAN ONLY REFUSE MUST NOT RENDER: STOCK is never a job. */}
                      {canPick ? (
                        <>
                          <Label htmlFor={`job-${invoice.id}`}>Which Job Was This For?</Label>
                          <Select
                            id={`job-${invoice.id}`}
                            value={choice}
                            className="min-h-11"
                            onChange={(e) => setPicked((p) => ({ ...p, [invoice.id]: e.target.value }))}
                          >
                            {/* NEVER PRESELECTED, on every row, including the ones the matcher is sure about. */}
                            <option value="">— Pick The Job —</option>
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
                                `Invoice ${invoice.invoiceNumber} is on ${match.ranked.find((g) => g.job.id === choice)?.job.name ?? "that job"}.`,
                              )
                            }
                          >
                            {busy === `job:${invoice.id}` ? "Filing It…" : "File It On This Job"}
                          </Button>
                        </>
                      ) : (
                        <p className="text-xs leading-relaxed text-slate-600">Shop stock: no job to put it on. It stays as overhead.</p>
                      )}
                      {failedAt === `job:${invoice.id}` && error && (
                        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
          {more("job", needJob.length, r2(needJob.slice(LIST_LIMIT).reduce((s, r) => s + (Number(r.invoice.total) || 0), 0)))}
        </Fold>
      )}

      {/* ── NOT IN YOUR BOOKS, not on a card: mostly what CED booked to STOCK. ── */}
      {billRows.length > 0 && (
        <Fold
          id={`supplier-not-in-books-${accountId}`}
          summary={listLabel("Not In Your Books", billRows.length, formatCurrency(billRowsTotal))}
        >
          <WhyFold>
            <p>
              Bought at {accountName} with no bill anywhere in here, so no job is carrying the cost. Shop stock goes
              in with Record To Shelf; a purchase with a job goes in with Record It As A Bill.
            </p>
          </WhyFold>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {(showAll.bill ? billRows : billRows.slice(0, LIST_LIMIT)).map((invoice) => (
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
                    <span className="block truncate text-xs text-slate-400">
                      {invoice.invoiceNumber}
                      {invoice.invoiceDate ? ` · ${formatDate(invoice.invoiceDate)}` : ""}
                      {invoice.jobId ? "" : " · no job yet"}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-semibold tabular-nums text-slate-800">{formatCurrency(invoice.total)}</span>
                    <span className={`block text-xs ${invoice.closed ? "text-amber-700" : "text-slate-400"}`}>
                      {invoice.closed ? "already paid for" : "still open"}
                    </span>
                  </span>
                </div>

                {/* MAYBE ALREADY IN HIS BOOKS (audit v994, DB1): a person says which it is. */}
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
                    ) : null}
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
                  <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-700">{error}</p>
                )}
                {actions.recordToShelf && actions.shelfLines && !(invoice.samePurchase?.length && actions.tieToBill) && (
                  <div className="mt-2 space-y-1">
                    {companyUseWord(invoice.jobNameRaw)?.shelf && (
                      <p className="text-xs text-sky-800">CED wrote &ldquo;{invoice.jobNameRaw!.trim()}&rdquo; on it: this reads like shop stock.</p>
                    )}
                    <Button variant="outline" className="h-11 w-full" disabled={pending} onClick={() => openShelf(invoice.id, invoice.invoiceNumber, false)}>
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
                  <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-700">{error}</p>
                )}
              </li>
            ))}
          </ul>
          {more("bill", billRows.length, r2(billRows.slice(LIST_LIMIT).reduce((s, r) => s + (Number(r.total) || 0), 0)))}
        </Fold>
      )}

      {/* ── THE DISCOUNT: a date, a number, what missing it costs. Paying is the account's own
             Record A Payment, just above: one door to the payment sheet. ── */}
      {(claimable.total > 0.005 || missed.total > 0.005 || interest.charged > 0.005) && (
        <Fold
          summary={
            // THE FIGURE IS SAID ONCE: the green sentence under the supplier's numbers, just above,
            // already says how much comes off and by when. This line is the list's name and count.
            claimable.total > 0.005 ? (
              listLabel("Discount Still On The Table", claimable.rows.length)
            ) : (
              <span className="text-sm font-semibold text-slate-900">The Discount You Are Missing</span>
            )
          }
        >
          <p className="text-xs leading-relaxed text-green-900">
            {claimable.total > 0.005
              ? claimable.dueOnNext >= claimable.total - 0.005
                ? `${formatCurrency(claimable.total)} comes off if ${accountName} is paid by ${formatDate(claimable.nextDeadline)}, ${sayDeadline(claimable.daysLeft)}, across ${claimable.rows.length} ${claimable.rows.length === 1 ? "invoice" : "invoices"}.`
                : `${formatCurrency(claimable.total)} across ${claimable.rows.length} ${claimable.rows.length === 1 ? "invoice" : "invoices"}; ${formatCurrency(claimable.dueOnNext)} of it goes if ${accountName} is not paid by ${formatDate(claimable.nextDeadline)}, ${sayDeadline(claimable.daysLeft)}.`
              : `Nothing is claimable today. ${accountName} takes a cut off every invoice paid by the tenth of the month after you buy.`}
          </p>
          {claimable.rows.length > 0 && (
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {(showAll.disc ? claimable.rows : claimable.rows.slice(0, LIST_LIMIT)).map(({ invoice, reading }) => (
                <li key={invoice.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-slate-800">
                      {invoice.invoiceNumber}
                      {invoice.jobNameRaw?.trim() ? ` · ${invoice.jobNameRaw.trim()}` : ""}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {formatCurrency(documentOpenAmount(invoice))} open · pay by {formatDate(reading.by)}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-green-700">{formatCurrency(reading.amount)} off</span>
                </li>
              ))}
            </ul>
          )}
          {more("disc", claimable.rows.length, r2(claimable.rows.slice(LIST_LIMIT).reduce((s, r) => s + r.reading.amount, 0)), "Worth Another")}
          {(missed.total > 0.005 || interest.charged > 0.005) && (
            <p className="mt-2 text-xs leading-relaxed text-amber-900">
              {missed.total > 0.005 ? `${formatCurrency(missed.total)} of discount already ran out on invoices still open. ` : ""}
              {interest.charged > 0.005
                ? `${formatCurrency(interest.charged)} of late interest charged${interest.stillOpen > 0.005 ? `, ${formatCurrency(interest.stillOpen)} still open` : ""}.`
                : ""}
            </p>
          )}
        </Fold>
      )}

      {/* ── WHAT THEY HAVE OPEN: their ledger, newest first, the way the portal lists it. ── */}
      <Fold summary={listLabel(`What ${accountName} Has Open`, documents.length)}>
        {documents.length === 0 ? (
          <p className="py-2 text-sm text-slate-400">{accountName} has nothing open on this account.</p>
        ) : (
          <>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {(showAll.docs ? documents : documents.slice(0, LIST_LIMIT)).map((invoice) => {
                const disc = discountReading(invoice, today);
                const explain = explainKind(invoice.kind);
                const amount = documentOpenAmount(invoice);
                return (
                  <li key={invoice.id} className="px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-slate-900">{invoice.invoiceNumber}</span>
                          {invoice.kind !== "invoice" && <Badge tone={KIND_TONE[invoice.kind]}>{sayKind(invoice.kind)}</Badge>}
                        </span>
                        <span className="block truncate text-xs text-slate-400">
                          {invoice.invoiceDate ? formatDate(invoice.invoiceDate) : "No date"}
                          {invoice.jobName
                            ? ` · ${invoice.jobName}`
                            : isUsableJobName(invoice.jobNameRaw)
                              ? ` · “${invoice.jobNameRaw!.trim()}” (no job yet)`
                              : ""}
                          {(invoice.billCount ?? 0) > 0
                            ? " · in your books"
                            : cardIds.has(invoice.id)
                              ? " · waiting under Needs You"
                              : " · not in your books"}
                        </span>
                        {explain && <span className="mt-0.5 block text-xs text-slate-500">{explain}</span>}
                      </span>
                      <span className="shrink-0 text-right">
                        <span className={`block text-sm font-semibold tabular-nums ${amount < 0 ? "text-green-700" : "text-slate-900"}`}>
                          {formatCurrency(amount)}
                        </span>
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
            {more("docs", documents.length, r2(documents.slice(LIST_LIMIT).reduce((s, d) => s + documentOpenAmount(d), 0)))}
          </>
        )}
      </Fold>

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
    </div>
  );
}
