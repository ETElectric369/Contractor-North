"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDate, formatDuration } from "@/lib/utils";
import type { UnbilledWork } from "@/lib/unbilled-work";
import { createInvoiceForJob } from "../actions";
import { createProgressReportInvoice } from "../../billing/actions";
import { openFigure, unbilledCardDoor, type CardDoor, type OpenDraft } from "@/lib/actuals-draw";

/**
 * What this card is allowed to know, by role. The page builds it (projection law): staff get
 * the whole UnbilledWork; a tech's view carries HOURS ONLY — no rate, no amount, no bills, no
 * crew (a tech reads only his own time rows, so the hours are his) — so the money never
 * serializes onto his page. A UI gate is not a boundary; the prop shape is.
 */
export type UnbilledView =
  | ({ kind: "staff" } & UnbilledWork)
  | {
      kind: "tech";
      hours: number;
      lastInvoiceNumber: string | null;
      lastInvoiceAt: string | null;
    };

/**
 * THE RUNNING TOTAL (Erik, 2026-09-11: "we should have a running total of open time and
 * materials on the overview"). Sits at the top of Overview: every closed hour and every bill
 * that no non-void invoice has claimed yet, at the person's bill rate and the org's markup —
 * the SAME arithmetic Nort's job-numbers tool speaks (unbilledWorkForJob; if the two ever
 * differ that is a defect there, not here). It leads with ONE figure, "Open: $X" (Erik,
 * 2026-09-26: "the only thing i was looking for was the amount open"), and $X is exactly what the
 * button bills (openFigure): the figure is never re-derived on the client.
 *
 * THE BUTTON IS THE DOOR THAT REALLY BILLS IT ON THIS JOB: "Add to INV-0xx" onto an open draft
 * that takes new work; on a job that already bills with draws (a deposit, a progress payment),
 * "Create Progress Payment", which is createProgressReportInvoice - the Progress Payment → Actual
 * T&M door, netting the deposit (never the standard New Invoice, which reopened Tao's paid
 * deposit); otherwise "Create Invoice" (createInvoiceForJob, the Invoices tab's New Invoice).
 *
 * EVERY T&M JOB (jobBillsItsActuals), estimate or not: on Time & Material the estimate is a guide,
 * never a block (Erik, Tao J-002, where an accepted estimate hid the card). A payment schedule or a
 * fixed-price job bills something else - a figure here would be a number no door produces (MONEY
 * law) - so there the card doesn't exist.
 *
 * `view` null = the total couldn't be computed; the card says so and names the tabs that hold
 * the rows, instead of vanishing (nothing silent).
 */
export function UnbilledCard({
  jobId,
  customerId,
  view,
  viewerIsStaff,
  openDraft,
  lumpToNet = 0,
  drawBilled = false,
}: {
  jobId: string;
  /** Presets the customer on the /billing New Invoice door (the "nothing new" sentence's link). */
  customerId: string | null;
  view: UnbilledView | null;
  /** Only read when `view` is null: the fallback sentence must name a tab THIS role has. */
  viewerIsStaff: boolean;
  /** The job's open draft of ANY kind and whether new work can go on it (lib/actuals-draw,
   *  openDraftOnJob — the server's own rule). Undefined = the page didn't read it: the card falls
   *  back to "the newest invoice is a draft", which is only right when that draft is standard. */
  openDraft?: Pick<OpenDraft, "id" | "number" | "refreshable"> | null;
  /** Deposit / set-amount draw money no bill has taken off yet (the page reads
   *  fixedBillingsNotYetNetted). With no draft open, the next bill nets it, so the button names the
   *  net - or no button, when the deposit still covers the work. */
  lumpToNet?: number;
  /** The job carries a live draw: with no draft open, its next bill is a progress payment. */
  drawBilled?: boolean;
}) {
  const router = useRouter();
  const { pending, go } = useBillIt(jobId);

  if (!view) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-slate-500">
          {viewerIsStaff
            ? "Couldn't total the work since the last invoice right now — the Time tab has the hours and the Costs tab has the bills."
            : "Couldn't total your time since the last invoice right now — the Time tab has the hours."}
        </CardContent>
      </Card>
    );
  }

  const since = view.lastInvoiceNumber
    ? `${view.lastInvoiceNumber}${view.lastInvoiceAt ? ` (${formatDate(view.lastInvoiceAt)})` : ""}`
    : null;

  if (view.kind === "tech") {
    return (
      <Card>
        <CardContent className="py-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            {since ? `Your time since ${since}` : "Your time not yet invoiced"}
          </div>
          <div className="mt-1 text-2xl font-bold text-slate-900">{formatDuration(view.hours)}</div>
          {view.hours <= 0 && <p className="mt-1 text-sm text-slate-500">No new time yet — clock in on the Time tab.</p>}
        </CardContent>
      </Card>
    );
  }

  const w = view;
  const { returns, takes, newWork, workPending, theDraft, door } = cardDoorFor(w, openDraft, lumpToNet, drawBilled);
  const nothingNew = w.total <= 0.005 && w.hours <= 0 && w.billsCount === 0 && takes === 0 && returns === 0;
  const owedBack = returns > 0 && w.total < -0.005;
  // Named only when new work GOES on it — the sentences below that say "is on {draft}" are true
  // only of a draft that takes it.
  const draft = theDraft?.refreshable ? (theDraft.number ?? "the open draft") : null;
  /** An open draft that bills a set part of the contract: the work waits for the next bill. */
  const heldDraft = theDraft && !theDraft.refreshable ? (theDraft.number ?? "the open draft") : null;
  // THE DOOR THAT WORKS when there is nothing new: the job's own New Invoice (this card's button,
  // the Invoices tab's) is createInvoiceForJob, which refuses a second invoice with nothing to
  // carry — by design (never mint an empty invoice silently). A blank invoice for something else
  // (a referral, a fee) is the /billing New Invoice, opened straight onto this customer.
  const blankInvoiceHref = `/billing?new=1${customerId ? `&customer=${encodeURIComponent(customerId)}` : ""}`;

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {draft
                ? `Not yet on ${draft} (draft)`
                : heldDraft
                  ? "Not on a bill yet"
                  : since
                    ? `Unbilled since ${since}`
                    : "Unbilled — no invoice yet"}
            </div>
            {/* THE ONE NUMBER: what the button bills, and nothing else competes with it. */}
            <div className="mt-1 text-2xl font-bold text-slate-900">Open: {formatCurrency(openFigure(door, w.total))}</div>
            {nothingNew && draft ? (
              // Everything is on the draft: the door that works is the draft itself (anything
              // else goes on it too), and the strip follows an in-page ?tab= link.
              <p className="mt-1 text-sm text-slate-500">
                {`Nothing new — every hour and bill so far is on ${draft}, still a draft. Anything else goes on it too: open it from the `}
                <Link href="?tab=invoices" scroll={false} className="font-medium text-brand hover:underline">
                  Invoices tab
                </Link>
                .
              </p>
            ) : nothingNew ? (
              <p className="mt-1 text-sm text-slate-500">
                {since
                  ? `Nothing new since ${w.lastInvoiceNumber} — every hour and bill so far is on it. To bill something else (a referral, a fee), start a `
                  : "Nothing to bill yet — hours land here from the Time tab, bills from the Costs tab. For an invoice with no work behind it, start a "}
                <Link href={blankInvoiceHref} className="font-medium text-brand hover:underline">
                  New Invoice
                </Link>
                {" "}from Billing.
              </p>
            ) : (
              <dl className="mt-2 space-y-1.5 text-sm">
                <div className="flex gap-2">
                  <dt className="w-12 shrink-0 text-slate-400">Labor</dt>
                  <dd className="min-w-0">
                    <span className="text-slate-800">
                      {formatDuration(w.hours)} · {formatCurrency(w.laborAmount)}
                    </span>
                    {w.laborByPerson.length > 0 && (
                      <div className="text-xs text-slate-500">
                        {w.laborByPerson
                          .map((p) => `${p.name} ${formatDuration(p.hours)} · ${formatCurrency(p.amount)}`)
                          .join(" · ")}
                      </div>
                    )}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-12 shrink-0 text-slate-400">Bills</dt>
                  <dd className="text-slate-800">
                    {w.billsCount} · {formatCurrency(w.billsAmount)}
                    {/* WHAT CAME OFF, NAMED (review of the audit fix wave, 2026-09-20). The bills
                        figure is now NET of the lines he switched off - his own snacks, the part
                        of a container that went on the shelf - and a receipt reading $6.50 when
                        the paper says $16.28 looks like a typo unless the screen says why. The
                        field was computed for exactly this sentence and nothing was drawing it. */}
                    {w.excluded > 0.005 && (
                      <span className="text-slate-500">
                        {" "}({formatCurrency(w.excluded)} of it your own cost)
                      </span>
                    )}
                    {/* The markup is stated, not hidden in the total: the customer is billed the
                        marked-up figure and the office should see both numbers. */}
                    {w.billsCount > 0 && w.markupPct > 0 && (
                      <span className="text-slate-500">
                        {" "}+ {w.markupPct}% = {formatCurrency(w.billsBilled)}
                      </span>
                    )}
                  </dd>
                </div>
                {/* PIECES TAKEN FROM STOCK (Took From Stock): what they cost the company, and the
                    same markup as the bills, so the office sees both figures. One line each on the
                    next bill. */}
                {takes > 0 && (
                  <div className="flex gap-2">
                    <dt className="w-12 shrink-0 text-slate-400">Stock</dt>
                    <dd className="text-slate-800">
                      {takes === 1 ? "1 take" : `${takes} takes`} · {formatCurrency(w.stockAmount ?? 0)}
                      {w.markupPct > 0 && (
                        <span className="text-slate-500">
                          {" "}+ {w.markupPct}% = {formatCurrency(w.stockBilled ?? 0)}
                        </span>
                      )}
                    </dd>
                  </div>
                )}
                {/* A SUPPLIER RETURN, IN PLAIN WORDS (INV-078). Parts went back to the supplier and
                    the customer was billed for them, so the credit is theirs - at the same markup
                    they were charged. Only the part of the return that was ever the customer's is
                    here; a return whose lines are all his own cost is not counted, exactly as the
                    importer credits nothing for it. */}
                {returns > 0 && (
                  <div className="flex gap-2">
                    <dt className="w-12 shrink-0 text-slate-400">Credit</dt>
                    <dd className="text-slate-800">
                      {returns === 1 ? "A supplier return" : `${returns} supplier returns`} · {formatCurrency(w.returnsAmount)} back from the supplier
                      <span className="text-slate-500">
                        {w.markupPct > 0 ? ` + ${w.markupPct}% = ` : ", so "}
                        {formatCurrency(w.returnsCredit)} comes off the customer&apos;s bill
                      </span>
                    </dd>
                  </div>
                )}
              </dl>
            )}
            {w.stockShortsWords && (
              // TAKEN PAST THE SHELF: said before the invoice is built, never discovered after it
              // went out short. The importer leaves these off and says the same sentence.
              <p className="mt-1 text-sm text-amber-700">{w.stockShortsWords}</p>
            )}
            {heldDraft && (workPending || returns > 0) && (
              // WHY THE BUTTON OPENS INSTEAD OF ADDS. Said, so "Open" never reads as the card
              // giving up: the server would refuse to put hours on a slice of the contract.
              <p className="mt-1 text-sm text-slate-500">
                {`${heldDraft} is an open draft for a set part of the contract, so this can't go on it. Send it (or delete it), then bill this on the next progress payment.`}
              </p>
            )}
            {(door?.kind === "covered" || ((door?.kind === "create" || door?.kind === "draw") && door.note)) && (
              // THE DEPOSIT, SAID (review, 2026-09-24): the figure on the button is the work less
              // what the next bill takes off, or there is no button because the deposit covers it.
              <p className="mt-1 text-sm text-slate-500">{door.note}</p>
            )}
            {owedBack && (
              <p className="mt-1 text-sm text-slate-500">
                {draft
                  ? `The return is worth more than the new work. It comes off ${draft} only if that invoice still bills more than the ${formatCurrency(w.returnsCredit)} credit; if not, it waits for the next invoice on this job that does.`
                  : workPending
                    ? `The return is worth more than the new work, so the invoice bills the ${formatCurrency(newWork)} of work and the ${formatCurrency(w.returnsCredit)} credit waits for the next invoice on this job that bills more than it.`
                    : `The ${formatCurrency(w.returnsCredit)} credit waits for the next invoice on this job that bills more than it - an invoice below zero would settle with the credit lost.`}
              </p>
            )}
          </div>
          {/* THE DOOR FOLLOWS WHAT IS PENDING, NOT THE SIGN OF THE NET (review of this wave). Hours
              or bills always get a door, even when a bigger return makes the net negative - that
              work is real and unbilled. The open draft takes a pending return too (it may already
              bill enough to hold it). With no draft, a credit alone never mints an invoice. The
              figure is named only when it is what the click bills. */}
          <DoorButton door={door} pending={pending} go={go} onOpen={(href) => router.push(href)} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * THE CARD'S DOOR, DECIDED ONCE. The Overview card and the Costs tab's Not Billed Yet both show
 * it, so both read this: the same draft, the same figure, the same label.
 *
 * THE OPEN DRAFT IS THE DOOR (85 Whitney's other half). createInvoiceForJob lands on the job's
 * open draft when there is one — one draft per job, never a second racing the first for the same
 * rows — and pulls what's new into it. Said up front, "Add to INV-062 ($X)", not "Create Invoice":
 * a click that then opens INV-062 must never read as "it made a new one". $X stays true either
 * way: a draft claims its rows like any non-void invoice, so the total is exactly what the draft
 * doesn't hold yet — what the click adds to it, or what the next bill carries.
 *
 * WHICH DRAFT, AND WHETHER IT TAKES NEW WORK, IS THE SERVER'S ANSWER (J-011, 2026-09-24). A
 * time-and-materials progress report is a draw with no schedule, and INV-078 is one: the page
 * hands over openDraftOnJob's answer. An actuals draw takes the work like a standard draft; a
 * contract draw (a %, a fixed $) can't, so the button says "Open INV-0xx" and goes there.
 */
function cardDoorFor(
  w: UnbilledWork,
  openDraft: Pick<OpenDraft, "id" | "number" | "refreshable"> | null | undefined,
  lumpToNet: number,
  drawBilled: boolean,
) {
  // A pending supplier return is something new: money the customer is owed back (INV-078).
  const returns = w.returnsCount ?? 0;
  // Takes from stock no invoice holds yet (one line each on the next bill). Pieces taken past the
  // shelf that wait for a roll are never in it (never billed until settled - the card says so).
  const takes = w.stockCount ?? 0;
  // The hours, bills and takes on their own, before any return comes off - what an invoice built
  // now bills at the least. A return lands on it only when it bills more than the credit
  // (importCostsIntoInvoice holds it otherwise, because an invoice below zero loses the rest).
  const newWork = Math.round((w.laborAmount + w.billsBilled + (w.stockBilled ?? 0)) * 100) / 100;
  const workPending = w.hours > 0 || w.billsCount > 0 || takes > 0;
  const fallbackDraft =
    w.lastInvoiceStatus === "draft" ? { id: "", number: w.lastInvoiceNumber, refreshable: true } : null;
  const theDraft = openDraft === undefined ? fallbackDraft : openDraft;
  const door = unbilledCardDoor({
    openDraft: theDraft,
    workPending,
    returns,
    total: w.total,
    newWork,
    lumpToNet,
    drawBilled,
    money: formatCurrency,
  });
  return { returns, takes, newWork, workPending, theDraft, door };
}

/** The click behind the card's button, then the invoice. "Create Progress Payment" is the draw
 *  door itself (createProgressReportInvoice), answered in the same shape as the others. */
function useBillIt(jobId: string) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  function go(door: CardDoor) {
    start(async () => {
      const res = door?.kind === "draw" ? fromDraw(await createProgressReportInvoice(jobId, "progress")) : await createInvoiceForJob(jobId);
      if (!res.ok || !res.id) {
        // A "nothing new" refusal names the invoice that already holds the work — that IS the
        // door, so the toast carries it (the Invoices tab's New Invoice does the same).
        const door = res.billedOn;
        toast(
          res.error ?? "Could not create the invoice.",
          "error",
          door ? { label: `Open ${door.number}`, onClick: () => router.push(`/billing/${door.id}`) } : undefined,
        );
        return;
      }
      // The action's own sentence ("Pulled 3 new lines into INV-062", "Started INV-063 for
      // what's new since INV-061…") goes in front of the person BEFORE the redirect; it knows
      // the count, this card doesn't. `partial` = something did NOT happen (an import failed) —
      // that is a heads-up, not a receipt, and its tone says so.
      if (res.importWarning) toast(res.importWarning, res.partial ? "error" : "info");
      router.push(`/billing/${res.id}`);
    });
  }
  return { pending, go };
}

/** The draw door's answer in the card's shape: its sentence is the note, a named draft the door. */
function fromDraw(r: Awaited<ReturnType<typeof createProgressReportInvoice>>): Awaited<ReturnType<typeof createInvoiceForJob>> {
  if (r.ok && r.id) return { ok: true, id: r.id, ...(r.note ? { importWarning: r.note } : {}), ...(r.partial ? { partial: true as const } : {}) };
  return { ok: false, error: r.error ?? "Could not bill the new work.", ...(r.openDraft ? { billedOn: r.openDraft } : {}) };
}

function DoorButton({
  door,
  pending,
  go,
  onOpen,
}: {
  door: CardDoor;
  pending: boolean;
  go: (door: CardDoor) => void;
  onOpen: (href: string) => void;
}) {
  if (door?.kind === "open") {
    return (
      <Button type="button" onClick={() => onOpen(door.href)} className="min-h-11 shrink-0">
        <FileText /> {door.label}
      </Button>
    );
  }
  if (door && door.kind !== "covered") {
    return (
      <Button type="button" onClick={() => go(door)} disabled={pending} className="min-h-11 shrink-0">
        <FileText /> {pending ? (door.kind === "add" ? "Adding…" : "Opening…") : door.label}
      </Button>
    );
  }
  return null;
}

/**
 * THE SAME DOOR, ON THE COSTS TAB (Erik, 2026-09-25). Not Billed Yet leads that tab, and the way
 * to bill what is on it is this card's button, not a second one. It bills the open time too, and
 * the tab says so beside it. With nothing to add (or a deposit that still covers it) it renders
 * the card's own sentence instead of a button, so the tab never shows a door the server refuses.
 */
export function UnbilledDoorButton({
  jobId,
  work,
  openDraft,
  lumpToNet = 0,
  drawBilled = false,
}: {
  jobId: string;
  work: UnbilledWork;
  openDraft?: Pick<OpenDraft, "id" | "number" | "refreshable"> | null;
  lumpToNet?: number;
  drawBilled?: boolean;
}) {
  const router = useRouter();
  const { pending, go } = useBillIt(jobId);
  const { door } = cardDoorFor(work, openDraft, lumpToNet, drawBilled);
  if (door?.kind === "covered") return <p className="text-sm text-slate-500">{door.note}</p>;
  return <DoorButton door={door} pending={pending} go={go} onOpen={(href) => router.push(href)} />;
}
