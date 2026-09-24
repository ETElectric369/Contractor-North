import Link from "next/link";
import { Receipt, Send, FileText, AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { getMoneyPipeline } from "@/lib/billing-pipeline";
import { InvoiceAmount, InvoiceAmountDetail } from "@/components/invoice-amount";
/* THE rule, imported, never re-derived. `revised_at > sent_at` is one sentence and it already has
   one home (lib/invoice-revision.ts) — the same function the server stamps by and the invoice page
   banners by. A second copy of it on this board is exactly the shape of the draft gate this wave
   spent a day untangling, where one of nine copies had been wrong for months. */
import { customerHoldsOlderCopy } from "@/lib/invoice-revision";
import { getCollected } from "@/lib/analytics/money-metrics";
import { listCustomerOptions } from "@/lib/schedule-options";
import { NewInvoiceButton } from "./new-invoice-button";
import { InvoiceJobButton } from "./invoice-job-button";

export const dynamic = "force-dynamic";

const money = (n: number) => formatCurrency(n);

export default async function BillingPage() {
  const supabase = await createClient();

  const [pipeline, { data: quotes }, { data: customers }, { data: jobs }, collectedTotals, { data: allInv }, { data: revisedInv }] =
    await Promise.all([
      getMoneyPipeline(supabase),
      supabase.from("quotes").select("id, quote_number, total, customers(name)").in("status", ["sent", "accepted"]).order("created_at", { ascending: false }).limit(100),
      listCustomerOptions(supabase),
      supabase.from("jobs").select("id, name, job_number, customer_id").not("status", "in", "(cancelled)").order("created_at", { ascending: false }).limit(300),
      // "Collected" = cash that landed (the payments table net of voids and refunds), NOT
      // sum(amount_paid) — that field folds in account credits, so writing off a disputed
      // invoice used to RAISE this tile above what /payments, /analytics and Nort report.
      getCollected(supabase),
      // Bounded (audit v921): PostgREST silently truncates at its max-rows cap, so an unbounded
      // list quietly stops showing older rows with nothing on screen saying so. An explicit high
      // limit fails visibly at a known number instead of invisibly at the server's.
      supabase.from("invoices").select("id, invoice_number, total, amount_paid, status, due_date, customers(name)").order("created_at", { ascending: false }).limit(2000),
      // THE QUESTION 0269 BUILT AN INDEX FOR, AND NOBODY EVER ASKED (audit v966).
      //
      // 0269 says it in its own words: the "needs re-sending" question "is asked per org on the
      // billing board", and it shipped invoices_revised_at_idx on (org_id, revised_at) where
      // revised_at is not null to answer it cheaply. It was never wired up. The whole workflow
      // 0269 exists to allow — fix a line on a bill the customer already has, then get on with
      // the day — showed up on no list, no count and no badge anywhere in the app. The only way
      // to learn that INV-071 needed re-sending was to already be looking at INV-071.
      // This board's own tagline is "nothing slips through". That was the case that slipped.
      //
      // Asked as its own narrow read rather than by widening the list above, because that is what
      // the partial index covers and it is the only projection on this page that needs the two
      // stamps. VOID is excluded: a voided document is not a bill any more, so there is nothing
      // to re-send. `revised_at is not null` alone is not the answer — a re-send moves sent_at
      // forward and leaves revised_at standing (that fact is worth keeping), so the rule below
      // decides, not this filter.
      // amount_paid and each payment's date ride along for the one case that settles a revision
      // without a re-send: the customer paid the corrected bill in full after it changed (INV-071).
      supabase.from("invoices").select("id, invoice_number, total, amount_paid, status, sent_at, revised_at, customers(name), payments(paid_at)").not("revised_at", "is", null).neq("status", "void").order("revised_at", { ascending: false }).limit(1000),
    ]);

  const list = (allInv ?? []) as any[];
  const collected = collectedTotals.allTime;

  const { doneNotInvoiced, drafts, unpaid } = pipeline;
  // Built from EVERY revised invoice, not from `unpaid`. A revision that lowers a paid invoice's
  // total leaves its status 'paid' and its balance at zero — and that is the exact case Erik's
  // client wrote in about (a settled bill reissued in the property owner's name). Filtering this
  // lane by money owed would miss the one it was built for.
  const needsResend = ((revisedInv ?? []) as any[]).filter((i) =>
    customerHoldsOlderCopy(i.sent_at, i.revised_at, {
      total: i.total,
      amountPaid: i.amount_paid,
      paidAt: ((i.payments ?? []) as { paid_at?: string | null }[]).map((p) => p.paid_at),
    }),
  );
  // ONE INVOICE, ONE ROW. A revised bill with money owed used to sit in Revised AND in Sent, so
  // the board listed it twice. It lives in Revised now (the verb it needs first is "send the
  // corrected copy"), and Sent shows the rest. The tiles still read `unpaid`, so the Outstanding
  // count is every open invoice exactly once.
  const resendIds = new Set(needsResend.map((i) => String(i.id)));
  const awaiting = unpaid.filter((i) => !resendIds.has(String(i.id)));
  const heldAbove = unpaid.length - awaiting.length;
  const unpaidById = new Map(unpaid.map((i) => [String(i.id), i]));
  // "All caught up" may not be printed over a customer holding the wrong bill.
  const caughtUp = doneNotInvoiced.length === 0 && drafts.length === 0 && unpaid.length === 0 && needsResend.length === 0;

  return (
    <div>
      <PageHeader title="Billing" description="Your money pipeline — nothing slips through.">
        <NewInvoiceButton quotes={(quotes as any) ?? []} customers={customers ?? []} jobs={(jobs as any) ?? []} />
      </PageHeader>

      {/* The three numbers that matter */}
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Card className="border-rose-200">
          <CardContent className="py-3">
            <div className="text-xl font-bold text-slate-900">{money(pipeline.toInvoiceTotal)}</div>
            <div className="text-xs text-slate-500">To Invoice · {doneNotInvoiced.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xl font-bold text-slate-900">{money(pipeline.outstandingTotal)}</div>
            <div className="text-xs text-slate-500">Outstanding · {unpaid.length}</div>
          </CardContent>
        </Card>
        <Card className={pipeline.overdueTotal > 0 ? "border-red-300 bg-red-50/40" : ""}>
          <CardContent className="py-3">
            <div className={`text-xl font-bold ${pipeline.overdueTotal > 0 ? "text-red-700" : "text-slate-900"}`}>{money(pipeline.overdueTotal)}</div>
            <div className="text-xs text-slate-500">Overdue · {pipeline.overdueCount}</div>
          </CardContent>
        </Card>
      </div>

      {caughtUp && (
        <Card className="mb-4 border-emerald-200 bg-emerald-50/50">
          <CardContent className="flex items-center gap-2 py-4 text-sm font-medium text-emerald-800">
            <CheckCircle2 className="h-5 w-5" /> All caught up. Every finished job is invoiced, every invoice is paid, and nobody is holding an older copy of one.
          </CardContent>
        </Card>
      )}

      {/* STAGE 1 — done, not invoiced (the silent gap) */}
      {doneNotInvoiced.length > 0 && (
        <Stage tone="rose" icon={<Receipt className="h-4 w-4" />} title="Done - Not Invoiced" count={doneNotInvoiced.length} sub="Finished jobs with no invoice — or a payment schedule not fully drawn. Bill them before they slip.">
          {doneNotInvoiced.map((j) => (
            <li key={j.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <Link href={`/jobs/${j.id}`} className="min-w-0 hover:underline">
                <div className="truncate text-sm font-medium text-slate-900">{j.customer ?? "—"}</div>
                <div className="truncate text-xs text-slate-500">{j.name ?? j.job_number}{j.value > 0 ? ` · est. ${money(j.value)}` : ""}</div>
              </Link>
              {j.draw ? (
                // Schedule job → draws bill via "Request next payment" on the job's payment
                // schedule, not a standard invoice (createInvoiceForJob rejects schedule jobs).
                <Link href={`/jobs/${j.id}?tab=invoices`} className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark">
                  Request Payment →
                </Link>
              ) : (
                <InvoiceJobButton jobId={j.id} />
              )}
            </li>
          ))}
        </Stage>
      )}

      {/* STAGE 2 — drafts not sent */}
      {drafts.length > 0 && (
        <Stage tone="amber" icon={<FileText className="h-4 w-4" />} title="Draft - Not Sent" count={drafts.length} sub="Invoices written up but not sent to the customer yet.">
          {drafts.map((inv) => (
            <li key={inv.id}>
              <Link href={`/billing/${inv.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-amber-50">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900">{inv.customer ?? "—"}</div>
                  <div className="truncate text-xs text-slate-500">{inv.job ?? inv.invoice_number}</div>
                  <InvoiceAmountDetail total={inv.total} paid={inv.paid} />
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <InvoiceAmount total={inv.total} paid={inv.paid} />
                  <Verb>Review &amp; Send</Verb>
                </div>
              </Link>
            </li>
          ))}
        </Stage>
      )}

      {/* STAGE 2B — sent, then changed: the copy in their inbox is not this one.
          Exclusive now, like every other stage: a revised bill with money owed sits only in
          Revised, which carries its due date and overdue flag, and the Sent lane below leaves it
          out and says how many it left out. The tiles above still count it once, from `unpaid`.
          Amber on purpose: the same colour as the banner on the invoice's own page, so the board
          and the page can never look like they are talking about two different problems. */}
      {needsResend.length > 0 && (
        <Stage tone="amber" icon={<Send className="h-4 w-4" />} title="Revised - Send Again" count={needsResend.length} sub="You changed these after they went out, so the customer is holding an older bill. Open one to send the corrected copy.">
          {needsResend.map((inv: any) => {
            const u = unpaidById.get(String(inv.id));
            return (
              <li key={inv.id}>
                {/* A DOOR TO SOMETHING THAT EXISTS. This row does not send anything — it opens the
                    invoice, where the amber notice and the one Send Invoice button already live. A
                    second send path written here is how two doors drift apart. */}
                <Link href={`/billing/${inv.id}`} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${u?.overdue ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-amber-50"}`}>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900">{inv.customers?.name ?? "—"}</div>
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      {u?.overdue && <span className="inline-flex items-center gap-0.5 font-semibold text-red-600"><AlertTriangle className="h-3 w-3" /> Overdue</span>}
                      <span className="truncate">
                        {inv.invoice_number} · changed {formatDate(inv.revised_at)}
                        {u?.due_date ? ` · due ${formatDate(u.due_date)}` : ""}
                      </span>
                    </div>
                    <InvoiceAmountDetail total={Number(inv.total) || 0} paid={Number(inv.amount_paid) || 0} overdue={!!u?.overdue} />
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {/* The same amount language as every row: what is due, and what it is due
                        against. A paid revised bill still belongs here and reads "$0.00 due of
                        $T" over "paid in full", so the figure on the corrected copy is on screen. */}
                    <InvoiceAmount total={Number(inv.total) || 0} paid={Number(inv.amount_paid) || 0} overdue={!!u?.overdue} />
                    <Verb>Review &amp; Send</Verb>
                  </div>
                </Link>
              </li>
            );
          })}
        </Stage>
      )}

      {/* STAGE 3 — sent, not paid (overdue first), less the ones Revised already holds */}
      {awaiting.length > 0 && (
        <Stage
          tone="sky"
          icon={<Send className="h-4 w-4" />}
          title="Sent - Awaiting Payment"
          count={awaiting.length}
          sub={`Out the door, money not in yet. Overdue ones are flagged.${heldAbove > 0 ? ` ${heldAbove} more ${heldAbove === 1 ? "is" : "are"} in Revised - Send Again above.` : ""}`}
        >
          {awaiting.map((inv) => (
            <li key={inv.id}>
              <Link href={`/billing/${inv.id}`} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${inv.overdue ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-sky-50"}`}>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900">{inv.customer ?? "—"}</div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    {inv.overdue && <span className="inline-flex items-center gap-0.5 font-semibold text-red-600"><AlertTriangle className="h-3 w-3" /> Overdue</span>}
                    <span className="truncate">{inv.invoice_number}{inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ""}</span>
                  </div>
                  <InvoiceAmountDetail total={inv.total} paid={inv.paid} overdue={inv.overdue} />
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <InvoiceAmount total={inv.total} paid={inv.paid} overdue={inv.overdue} />
                  <Verb>Record Payment</Verb>
                </div>
              </Link>
            </li>
          ))}
        </Stage>
      )}

      {/* Reference: every invoice + lifetime collected */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-500">All Invoices</h3>
          <Link href="/payments" className="text-xs font-medium text-slate-500 hover:text-brand">Collected (All Time) {money(collected)} · Payments →</Link>
        </div>
        {list.length === 0 ? (
          <EmptyState icon={Receipt} title="No invoices yet" description="Turn an accepted quote into an invoice, or start a blank one.">
            <NewInvoiceButton quotes={(quotes as any) ?? []} customers={customers ?? []} jobs={(jobs as any) ?? []} />
          </EmptyState>
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-slate-100">
              {list.map((inv: any) => (
                <li key={inv.id}>
                  <Link href={`/billing/${inv.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                    <div className="min-w-0">
                      <div className="truncate">
                        <span className="text-sm font-medium text-slate-900">{inv.invoice_number}</span>
                        <span className="ml-2 text-sm text-slate-500">{inv.customers?.name ?? "—"}</span>
                      </div>
                      <InvoiceAmountDetail total={Number(inv.total) || 0} paid={Number(inv.amount_paid) || 0} />
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      <InvoiceAmount total={Number(inv.total) || 0} paid={Number(inv.amount_paid) || 0} />
                      <Badge tone={statusTone(inv.status)}>{inv.status}</Badge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

/* The amount on every row is <InvoiceAmount> + <InvoiceAmountDetail> (components/invoice-amount):
   "$D due of $T" on one line, what is paid beneath, and the phone rule that keeps the customer
   readable at 375px. */

/** A row's verb: the words from `sm` up, the chevron always (the whole row is the link). */
function Verb({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center text-xs font-semibold text-brand">
      <span className="hidden sm:inline">{children}&nbsp;</span><ChevronRight className="h-3.5 w-3.5" />
    </span>
  );
}

const TONES: Record<string, string> = {
  rose: "border-rose-200 bg-rose-50/40 text-rose-800",
  amber: "border-amber-200 bg-amber-50/40 text-amber-800",
  sky: "border-sky-200 bg-sky-50/40 text-sky-800",
};

function Stage({ tone, icon, title, count, sub, children }: { tone: string; icon: React.ReactNode; title: string; count: number; sub: string; children: React.ReactNode }) {
  return (
    <Card className={`mb-3 ${TONES[tone].split(" ").slice(0, 2).join(" ")}`}>
      <CardContent className="py-4">
        <div className={`mb-1 flex items-center gap-2 text-sm font-semibold ${TONES[tone].split(" ").slice(2).join(" ")}`}>
          {icon} {title} · {count}
        </div>
        <p className="mb-3 text-xs text-slate-500">{sub}</p>
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-100 bg-white">{children}</ul>
      </CardContent>
    </Card>
  );
}
