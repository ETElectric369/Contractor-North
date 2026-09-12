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
 * differ that is a defect there, not here). The door is the existing createInvoiceForJob flow
 * (the Invoices tab's New Invoice), so "Create Invoice for $X" lands on the draft that bills
 * exactly this — the figure is never re-derived on the client.
 *
 * T&M JOBS ONLY. The page mounts this card only where the door pulls the actuals (billing_type
 * tm, no live quote, no payment schedule — createInvoiceForJob's own rule). On a quoted or
 * fixed-bid job the draft is the contract, not these rows, so a figure here would be a number
 * the door never produces (MONEY law): there, the card doesn't exist.
 *
 * `view` null = the total couldn't be computed; the card says so and names the tabs that hold
 * the rows, instead of vanishing (nothing silent).
 */
export function UnbilledCard({
  jobId,
  customerId,
  view,
  viewerIsStaff,
}: {
  jobId: string;
  /** Presets the customer on the /billing New Invoice door (the "nothing new" sentence's link). */
  customerId: string | null;
  view: UnbilledView | null;
  /** Only read when `view` is null: the fallback sentence must name a tab THIS role has. */
  viewerIsStaff: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

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
  const nothingNew = w.total <= 0.005 && w.hours <= 0 && w.billsCount === 0;
  // THE OPEN DRAFT IS THE DOOR (85 Whitney's other half). createInvoiceForJob lands on the job's
  // open draft when there is one — one draft per job, never a second racing the first for the
  // same rows — and pulls what's new into it. Said up front, "Add to INV-062 ($X)", not "Create
  // Invoice": a click that then opens INV-062 must never read as "it made a new one". The draft
  // is known from the SAME read the figure came from — the job's newest non-void invoice — and
  // that is enough here because this card mounts only where every invoice on the job is a
  // standard one (no draws without a schedule) and the door keeps a single open draft, so
  // newest-is-draft IS "there is a draft". $X stays true either way: a draft claims its rows
  // like any non-void invoice, so the total is exactly what the draft doesn't hold yet — what
  // the click adds to it, or what the next invoice would carry.
  const draft = w.lastInvoiceStatus === "draft" ? (w.lastInvoiceNumber ?? "the open draft") : null;
  // THE DOOR THAT WORKS when there is nothing new: the job's own New Invoice (this card's button,
  // the Invoices tab's) is createInvoiceForJob, which refuses a second invoice with nothing to
  // carry — by design (never mint an empty invoice silently). A blank invoice for something else
  // (a referral, a fee) is the /billing New Invoice, opened straight onto this customer.
  const blankInvoiceHref = `/billing?new=1${customerId ? `&customer=${encodeURIComponent(customerId)}` : ""}`;

  function go() {
    start(async () => {
      const res = await createInvoiceForJob(jobId);
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

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {draft ? `Not yet on ${draft} (draft)` : since ? `Unbilled since ${since}` : "Unbilled — no invoice yet"}
            </div>
            <div className="mt-1 text-2xl font-bold text-slate-900">{formatCurrency(w.total)}</div>
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
                    {/* The markup is stated, not hidden in the total: the customer is billed the
                        marked-up figure and the office should see both numbers. */}
                    {w.billsCount > 0 && w.markupPct > 0 && (
                      <span className="text-slate-500">
                        {" "}+ {w.markupPct}% = {formatCurrency(w.billsBilled)}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            )}
          </div>
          {w.total > 0.005 && (
            <Button type="button" onClick={go} disabled={pending} className="shrink-0">
              <FileText />{" "}
              {pending
                ? draft ? "Adding…" : "Opening…"
                : draft
                  ? `Add to ${draft} (${formatCurrency(w.total)})`
                  : `Create Invoice for ${formatCurrency(w.total)}`}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
