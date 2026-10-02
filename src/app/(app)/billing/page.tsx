import Link from "next/link";
import { redirect } from "next/navigation";
import { Receipt, Send, FileText, CheckCircle2, ChevronRight, ChevronDown } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { formatCurrency, formatDate } from "@/lib/utils";
import { daysLateWords, getMoneyPipeline, owedByCustomer, owedByLateness } from "@/lib/billing-pipeline";
import { InvoiceAmount, InvoiceAmountDetail } from "@/components/invoice-amount";
/* THE rule, imported, never re-derived. `revised_at > sent_at` is one sentence and it already has
   one home (lib/invoice-revision.ts) — the same function the server stamps by and the invoice page
   banners by. A second copy of it on this board is exactly the shape of the draft gate this wave
   spent a day untangling, where one of nine copies had been wrong for months. */
import { customerHoldsOlderCopy } from "@/lib/invoice-revision";
import { computeCollected } from "@/lib/analytics/money-metrics";
import { listCustomerOptions } from "@/lib/schedule-options";
import { NewInvoiceButton } from "./new-invoice-button";
import { featureOn } from "@/lib/features";
import { viewerSwitches } from "@/lib/viewer-switches";
import { InvoiceJobButton } from "./invoice-job-button";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import { paymentMethodLabel } from "@/lib/payment-method";
import { canAcceptPayments, connectStateFromOrg } from "@/lib/stripe-connect";
import { smsReadiness } from "@/lib/sms";
import { pendingTransfers, transferOnItsWaySentence } from "@/lib/bank-transfer";
import { GetPaidPickButton } from "./record-payment-button";
import { PullToRefresh } from "@/components/pull-to-refresh";

export const dynamic = "force-dynamic";

const money = (n: number) => formatCurrency(n);

/** The red chip on a late row: how many days past its due date (the pipeline's daysLate). */
function LateChip({ days }: { days: number }) {
  return <span className="shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-700">{daysLateWords(days)}</span>;
}

/**
 * ONE INVOICES PAGE (W1-29): who owes you, and what came in. Accounts Receivable and Payments folded
 * in here (/billing/ar and /payments redirect), so the Money menu has one row for the money coming in.
 *
 *   · OWED TO YOU: the one figure (the pipeline's outstanding: sent or partly paid, a balance above
 *     zero, never a draft), what of it is late in red, and one thin bar of current against late. Its
 *     By Customer fold is the old Accounts Receivable, built from the same open invoices.
 *   · THE STAGES: done and not invoiced (with the dollars the To Invoice tile used to carry), drafts,
 *     revised, sent; a late row wears its "N Days Late".
 *   · PAYMENTS IN: a link, never a fold, because a server page can't see a <details> open: its line
 *     ("$X This Month", its own small read that always runs) opens ?open=payments, and only then is the
 *     ledger read, with Get Paid… for a check that arrives without its bill.
 *
 * Lifetime money (the old "Collected (All Time)") is Analytics'.
 */
export default async function BillingPage({ searchParams }: { searchParams?: Promise<{ open?: string }> }) {
  const { open } = (await searchParams) ?? {};
  const paymentsOpen = open === "payments";
  const supabase = await createClient();

  // THE ORG, READ ONCE HERE: its timezone dates "This Month", and its card, texting and Venmo facts
  // go to Get Paid… exactly as the invoice page hands them to its own Get Paid.
  // (A real promise, awaited twice below: a query builder would run its request again on each await.)
  const orgP = (async () =>
    await supabase.from("organizations").select("id, settings, stripe_account_id, stripe_account_status, stripe_charges_enabled").limit(1).maybeSingle())();
  // PAYMENTS IN THIS MONTH, its own small read that always runs: this company-month's payments (a
  // voided invoice's dropped) less its refunds, from the org's own month start (the old /payments
  // tile's rule: tzDayStartUtc + computeCollected). It starts the moment the org answers, beside the
  // pipeline, never after it. null = it couldn't be read, and the line says so.
  const monthP = (async (): Promise<number | null> => {
    try {
      const { data: org } = await orgP;
      const tz = getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
      const monthStart = tzDayStartUtc(`${todayStrInTz(tz).slice(0, 7)}-01`, tz);
      const [pays, refunds] = await Promise.all([
        supabase.from("payments").select("amount, paid_at, invoices(status)").gte("paid_at", monthStart.toISOString()).limit(5000),
        supabase.from("customer_credits").select("amount, created_at").eq("disposition", "refund").gte("created_at", monthStart.toISOString()).limit(5000),
      ]);
      if (pays.error || refunds.error) return null;
      return computeCollected((pays.data ?? []) as any[], (refunds.data ?? []) as any[], monthStart);
    } catch {
      return null;
    }
  })();

  const [staff, pipeline, { data: customers }, { data: jobRows }, { data: allInv }, { data: revisedInv }, viewer, { data: org }, monthTotal, ledgerRead] =
    await Promise.all([
      // Accounts Receivable's door, kept: this page is the office's (a tech lands on My Day).
      (async () => {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return false;
        const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
        return !!me && isStaffRole((me as { role?: string }).role ?? "");
      })(),
      getMoneyPipeline(supabase),
      listCustomerOptions(supabase),
      // NEW INVOICE ASKS "WHICH JOB OR CUSTOMER?" (W1-28): the jobs that aren't cancelled, newest
      // first, each with its customer's name so a row reads "J-011 · Thistlewood · Tess Zane". A job
      // is billed through its own door, which finds its estimate itself - so no quotes are read here.
      supabase.from("jobs").select("id, name, job_number, customer_id, customers(name)").not("status", "in", "(cancelled)").order("created_at", { ascending: false }).limit(300),
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
      // The switches (0352): Sales Tax off means a new invoice starts untaxed, with no tax field.
      viewerSwitches(),
      orgP,
      monthP,
      // THE LEDGER, ONLY WITH THE FOLD OPEN: the most-opened money page never pays for a list it
      // isn't showing. Newest first, 500 at most (the old /payments ledger).
      paymentsOpen
        ? supabase
            .from("payments")
            .select("id, amount, method, note, paid_at, invoices(id, invoice_number, status, customers(name))")
            .order("paid_at", { ascending: false })
            .limit(500)
        : Promise.resolve(null),
    ]);
  if (!staff) redirect("/planner");

  const salesTax = featureOn(viewer.features, "sales_tax");
  const jobs = ((jobRows ?? []) as { id: string; name: string | null; job_number: string | null; customer_id: string | null; customers?: { name?: string | null } | { name?: string | null }[] | null }[]).map((j) => ({
    id: j.id,
    name: j.name,
    job_number: j.job_number,
    customer_id: j.customer_id,
    customer_name: (Array.isArray(j.customers) ? j.customers[0] : j.customers)?.name ?? null,
  }));

  const list = (allInv ?? []) as any[];

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
  // corrected copy"), and Sent shows the rest. Owed To You still reads `unpaid`, so every open
  // invoice is counted exactly once.
  const resendIds = new Set(needsResend.map((i) => String(i.id)));
  const awaiting = unpaid.filter((i) => !resendIds.has(String(i.id)));
  const heldAbove = unpaid.length - awaiting.length;
  const unpaidById = new Map(unpaid.map((i) => [String(i.id), i]));
  // "All caught up" may not be printed over a customer holding the wrong bill.
  const caughtUp = doneNotInvoiced.length === 0 && drafts.length === 0 && unpaid.length === 0 && needsResend.length === 0;

  // OWED TO YOU: the one figure, what of it is late, and the bar of current against late. The same
  // open invoices build By Customer, so its balances add up to this figure to the cent.
  const owed = pipeline.outstandingTotal;
  const owesAnything = owed > 0.005;
  const lateness = owedByLateness(unpaid);
  const byCustomer = owedByCustomer(unpaid);
  const BAR: { key: keyof typeof lateness; label: string; cls: string }[] = [
    { key: "current", label: "Not Late", cls: "bg-slate-400" },
    { key: "d30", label: "1–30 Days Late", cls: "bg-red-300" },
    { key: "d60", label: "31–60 Days Late", cls: "bg-red-500" },
    { key: "d90", label: "Over 60 Days Late", cls: "bg-red-700" },
  ];
  const barParts = BAR.filter((b) => lateness[b.key] > 0.005);

  // PAYMENTS IN, OPEN: the ledger (a voided invoice means the money was reversed, Erik's rule, so its
  // payments leave the list; a payment with no invoice stays), and Get Paid…'s facts.
  const orgSettings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const ledgerFailed = !!ledgerRead?.error;
  const payments = ((ledgerRead?.data ?? []) as any[]).filter((p) => (p.invoices?.status ?? "") !== "void");
  let onTheirWay = new Map<string, string>();
  if (paymentsOpen && unpaid.length) {
    const inFlight = await pendingTransfers(supabase, String((org as { id?: string } | null)?.id ?? ""), unpaid.map((i) => String(i.id))).catch(() => null);
    onTheirWay = new Map([...(inFlight?.byInvoice ?? new Map()).entries()].map(([id, list]) => [id, transferOnItsWaySentence(list, orgSettings.timezone)]));
  }

  return (
    <div>
      {/* PULL DOWN TO REFRESH (44aeec9c, Erik on this page: "can we pull down to refresh?"). One
          shared component, mounted here; every other screen gets it the same way. */}
      <PullToRefresh />
      <PageHeader title="Invoices" description="Who owes you, what's late, and what came in.">
        <NewInvoiceButton customers={customers ?? []} jobs={jobs} salesTax={salesTax} />
      </PageHeader>

      {/* OWED TO YOU: one figure, what of it is late, and one thin bar of current against late. */}
      <Card className="mb-4">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-slate-600">Owed To You</span>
            <span className="text-2xl font-bold tabular-nums text-slate-900">{owesAnything ? money(owed) : "$0"}</span>
          </div>
          {pipeline.overdueTotal > 0.005 && (
            <p className="mt-1 text-sm font-semibold text-red-700">
              {money(pipeline.overdueTotal)} late · {pipeline.overdueCount}
            </p>
          )}
          {owesAnything && (
            <>
              <div
                className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-slate-100"
                role="img"
                aria-label={barParts.map((b) => `${b.label} ${money(lateness[b.key])}`).join(", ")}
              >
                {barParts.map((b) => (
                  <span key={b.key} className={`h-full ${b.cls}`} style={{ width: `${(lateness[b.key] / owed) * 100}%` }} />
                ))}
              </div>
              {/* Named, never colour alone. */}
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600">
                {barParts.map((b) => (
                  <li key={b.key} className="flex items-center gap-1">
                    <span className={`inline-block h-2 w-2 rounded-sm ${b.cls}`} aria-hidden="true" />
                    {b.label} <span className="tabular-nums text-slate-800">{money(lateness[b.key])}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {/* BY CUSTOMER (Accounts Receivable, folded in): who owes, worst lateness first. Closed until
              tapped; ?open=customers (the old /billing/ar) opens it. */}
          {byCustomer.length > 0 && (
            <details id="customers" open={open === "customers" || undefined} className="group mt-3 scroll-mt-20 border-t border-slate-100 pt-1">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium text-slate-800 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90" />
                By Customer · {byCustomer.length}
              </summary>
              <div className="space-y-3 pb-2 pt-1">
                {byCustomer.map((c) => (
                  <div key={c.key} className="overflow-hidden rounded-lg border border-slate-200">
                    <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-900">{c.customer}</span>
                        {c.worstDaysLate > 0 && <LateChip days={c.worstDaysLate} />}
                      </div>
                      <span className="shrink-0 text-sm font-bold tabular-nums text-slate-900">{money(c.balance)}</span>
                    </div>
                    <ul className="divide-y divide-slate-50">
                      {c.invoices.map((inv) => (
                        <li key={inv.id}>
                          <Link href={`/billing/${inv.id}`} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-50">
                            {/* The same amount as every other invoice row: "$D due of $T", what is paid
                                beneath (on the right from sm up, under the number on a phone). */}
                            <div className="min-w-0">
                              <div className="truncate text-slate-600">{inv.invoice_number ?? "Invoice"}</div>
                              <InvoiceAmountDetail total={inv.total} paid={inv.paid} overdue={inv.overdue} />
                            </div>
                            <span className="flex shrink-0 items-center gap-3">
                              {inv.daysLate > 0 ? <LateChip days={inv.daysLate} /> : <span className="text-xs text-slate-400">Not late</span>}
                              <InvoiceAmount total={inv.total} paid={inv.paid} overdue={inv.overdue} />
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      {caughtUp && (
        <Card className="mb-4 border-emerald-200 bg-emerald-50/50">
          <CardContent className="flex items-center gap-2 py-4 text-sm font-medium text-emerald-800">
            <CheckCircle2 className="h-5 w-5" /> All caught up. Every finished job is invoiced, every invoice is paid, and nobody is holding an older copy of one.
          </CardContent>
        </Card>
      )}

      {/* STAGE 1 — done, not invoiced (the silent gap). Its dollars ride its header: the To Invoice
          figure moved here, it didn't vanish. */}
      {doneNotInvoiced.length > 0 && (
        <Stage
          tone="rose"
          icon={<Receipt className="h-4 w-4" />}
          title="Done - Not Invoiced"
          count={doneNotInvoiced.length}
          dollars={pipeline.toInvoiceTotal}
          sub="Finished jobs with no invoice — or a payment schedule not fully drawn. Bill them before they slip."
        >
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
          Revised, which carries its due date and its days late, and the Sent lane below leaves it
          out and says how many it left out. Owed To You still counts it once, from `unpaid`.
          Amber on purpose: the same colour as the banner on the invoice's own page, so the board
          and the page can never look like they are talking about two different problems. */}
      {needsResend.length > 0 && (
        <Stage tone="amber" icon={<Send className="h-4 w-4" />} title="Revised - Send Again" count={needsResend.length} sub="You changed these after they went out, so the customer is holding an older bill. Open one to send the corrected copy.">
          {needsResend.map((inv: any) => {
            const u = unpaidById.get(String(inv.id));
            return (
              <li key={inv.id}>
                {/* A DOOR TO SOMETHING THAT EXISTS. This row does not send anything — it opens the
                    invoice, where the amber notice and the one Send button already live. A
                    second send path written here is how two doors drift apart. */}
                <Link href={`/billing/${inv.id}`} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${u?.overdue ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-amber-50"}`}>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900">{inv.customers?.name ?? "—"}</div>
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      {u?.overdue && <LateChip days={u.daysLate} />}
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

      {/* STAGE 3 — sent, not paid (late first), less the ones Revised already holds */}
      {awaiting.length > 0 && (
        <Stage
          tone="sky"
          icon={<Send className="h-4 w-4" />}
          title="Sent - Awaiting Payment"
          count={awaiting.length}
          sub={`Out the door, money not in yet. Late ones say how late.${heldAbove > 0 ? ` ${heldAbove} more ${heldAbove === 1 ? "is" : "are"} in Revised - Send Again above.` : ""}`}
        >
          {awaiting.map((inv) => (
            <li key={inv.id}>
              <Link href={`/billing/${inv.id}`} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${inv.overdue ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-sky-50"}`}>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900">{inv.customer ?? "—"}</div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    {inv.overdue && <LateChip days={inv.daysLate} />}
                    <span className="truncate">{inv.invoice_number}{inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ""}</span>
                  </div>
                  <InvoiceAmountDetail total={inv.total} paid={inv.paid} overdue={inv.overdue} />
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <InvoiceAmount total={inv.total} paid={inv.paid} overdue={inv.overdue} />
                  <Verb>Get Paid</Verb>
                </div>
              </Link>
            </li>
          ))}
        </Stage>
      )}

      {/* PAYMENTS IN (the old /payments, folded in). A LINK, never a <details>: a server page can't
          see a fold open, so its line opens ?open=payments (and closes back to /billing), and only
          then is the ledger read. */}
      <Card id="payments" className="mb-4 mt-6 scroll-mt-20 overflow-hidden">
        <Link
          href={paymentsOpen ? "/billing" : "/billing?open=payments#payments"}
          scroll={!paymentsOpen}
          aria-expanded={paymentsOpen}
          className="flex min-h-11 items-center gap-2 px-4 py-2 text-sm hover:bg-slate-50"
        >
          {paymentsOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
          <span className="min-w-0 flex-1 font-semibold text-slate-900">
            Payments In
            <span className="font-normal text-slate-600">{monthTotal == null ? " · This Month Couldn't Be Read" : ` · ${money(monthTotal)} This Month`}</span>
          </span>
        </Link>
        {paymentsOpen && (
          <div className="border-t border-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <p className="text-sm text-slate-500">Every payment, newest first. A check with no bill in hand? Get Paid… asks which invoice.</p>
              <GetPaidPickButton
                invoices={unpaid.map((i) => ({ id: String(i.id), invoice_number: i.invoice_number, customer: i.customer, balance: i.balance, transferPending: onTheirWay.get(String(i.id)) ?? null }))}
                cardEnabled={canAcceptPayments(connectStateFromOrg((org ?? {}) as any))}
                methods={orgSettings.payment_methods}
                venmoConfigured={Boolean(orgSettings.venmo_handle?.trim())}
                textReady={smsReadiness(org as { settings?: unknown } | null).ready}
              />
            </div>
            {ledgerFailed ? (
              <p className="px-4 pb-4 text-sm text-amber-800" role="alert">
                Couldn&apos;t read your payments just now. Reload to try again.
              </p>
            ) : payments.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-slate-500">No payments yet. Get Paid on an invoice, or Get Paid… above, and each one lands here.</p>
            ) : (
              <DataTable<any>
                rows={payments}
                rowKey={(p) => p.id}
                rowHref={(p) => (p.invoices ? `/billing/${p.invoices.id}` : "/billing")}
                mobileCols={2}
                columns={[
                  { header: "Date", span: 3, className: "text-sm text-slate-600", cell: (p) => formatDate(p.paid_at) },
                  { header: "Customer", span: 4, className: "text-sm font-medium text-slate-900", cell: (p) => p.invoices?.customers?.name ?? "—" },
                  { header: "Invoice", span: 2, className: "text-sm text-slate-500", cell: (p) => p.invoices?.invoice_number ?? "—" },
                  { header: "Method", span: 1, className: "text-xs text-slate-500", cell: (p) => paymentMethodLabel(p.method) },
                  { header: "Amount", span: 2, align: "right", className: "text-sm font-semibold text-green-700", cell: (p) => money(Number(p.amount) || 0) },
                ]}
              />
            )}
          </div>
        )}
      </Card>

      {/* Reference: every invoice. */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-500">All Invoices</h3>
        </div>
        {list.length === 0 ? (
          <EmptyState icon={Receipt} title="No invoices yet" description="Pick a job to bill it, or a customer for a blank invoice.">
            <NewInvoiceButton customers={customers ?? []} jobs={jobs} salesTax={salesTax} />
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
                      <InvoiceAmountDetail total={Number(inv.total) || 0} paid={Number(inv.amount_paid) || 0} status={inv.status} />
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      <InvoiceAmount total={Number(inv.total) || 0} paid={Number(inv.amount_paid) || 0} status={inv.status} />
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

/** A lane: its title, how many, and (for the one that carries it) the dollars waiting in it. */
function Stage({ tone, icon, title, count, dollars, sub, children }: { tone: string; icon: React.ReactNode; title: string; count: number; dollars?: number; sub: string; children: React.ReactNode }) {
  return (
    <Card className={`mb-3 ${TONES[tone].split(" ").slice(0, 2).join(" ")}`}>
      <CardContent className="py-4">
        <div className={`mb-1 flex items-center gap-2 text-sm font-semibold ${TONES[tone].split(" ").slice(2).join(" ")}`}>
          {icon} {title} · {count}
          {dollars != null && ` · ${money(dollars)}`}
        </div>
        <p className="mb-3 text-xs text-slate-500">{sub}</p>
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-100 bg-white">{children}</ul>
      </CardContent>
    </Card>
  );
}
