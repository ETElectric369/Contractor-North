import Link from "next/link";
import { notFound } from "next/navigation";
import { User, FileText, Printer } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { canAcceptPayments, connectStateFromOrg } from "@/lib/stripe-connect";
import { PayNowButton, RecordPaymentButton } from "@/components/settle-up-button";
import { qboConfigured } from "@/lib/quickbooks";
import { QboInvoiceButton } from "./qbo-button";
import { createClient } from "@/lib/supabase/server";
import { firstThatWorks, kitsSelectRungs } from "@/lib/kit-line";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { clockDoorWords } from "@/lib/long-shift";
import { InvoiceDetail } from "./invoice-detail";
import { CreditButton } from "./credit-button";
import { ShareIconButton } from "@/components/share-icon-button";
import { EmailButton } from "@/components/email-button";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import { invoiceSectionTree } from "@/lib/nav-tree";
import { deleteInvoice, invoiceShareText } from "../actions";
import { getOrgSettings } from "@/lib/org-settings";
import { smsReadiness } from "@/lib/sms";
import { jobProgressFinancials, receivedBeforeThisInvoice } from "@/lib/job-financials";
import { invoiceBalance, isDrawKind, invoiceOverpayment } from "@/lib/invoice-math";
import { listCustomerOptions } from "@/lib/schedule-options";
/* THE ONE DEFINITION OF "THEY'RE HOLDING AN OLDER BILL" (0269). The same function the server's
   revision stamp is written against, asked here so the sentence on the page and the rule in the
   database can never drift apart. It is server-only, which is why the ANSWER crosses to the
   client component and the rule does not. */
import { customerHoldsOlderCopy } from "@/lib/invoice-revision";
import { ProgressReportCard } from "@/components/progress-report-card";
import { isActualsDraw } from "@/lib/actuals-draw";
import { fixedBillingsNotYetNetted } from "@/lib/unbilled-work";
import { fetchSupplierNames } from "@/lib/supplier-names";
import type { Invoice, InvoiceItem, Payment } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  /* THE PROJECTION IS WHERE THIS PAGE'S TRUTH COMES FROM (the projection law). `*` means the two
     delivery stamps ride along without being named: 0267's `sent_at` (a real send, never a pay
     door's promotion to 'sent') and 0269's `revised_at` (money moved after that send). The detail
     component's notice reads both, so if this ever narrows to a field list, those two names have
     to be on it or the card goes quiet about the customer holding an older bill — the exact
     silence cn-v962 traded the edit lock for. */
  const { data: invoice, error: invoiceErr } = await supabase
    .from("invoices")
    .select("*, customers(id, name, pricing_levels(markup_pct)), quotes(id, quote_number)")
    .eq("id", id)
    .maybeSingle();

  if (invoiceErr) throw invoiceErr; // a real failure shouldn't masquerade as 404
  if (!invoice) notFound();
  const inv = invoice as Invoice & { customers: any; quotes: any };

  // The customer/job pickers only matter while the invoice is still an editable
  // draft, so only pay for those lookups then.
  const isDraft = inv.status === "draft";

  const [{ data: items }, { data: payments }, { data: priceItems }, { data: kits }, { data: taxRates }, { data: org }, { data: customers }, { data: jobs }] =
    await Promise.all([
      supabase
        .from("invoice_items")
        .select("*")
        .eq("invoice_id", id)
        .order("sort_order"),
      // `*` carries stripe_payment_intent and 0284's processor_fee, which the payment rows' card
      // fee line reads; a field list here has to name both or that line goes quiet.
      supabase.from("payments").select("*").eq("invoice_id", id).order("paid_at", { ascending: false }),
      supabase
        .from("price_list_items")
        // `category` rides along so the shared picker can match on it, exactly as the composer does.
        .select("id, code, description, category, unit, buy_price, markup_pct")
        .eq("archived", false)
        .order("description")
        .limit(2000),
      // Kits too — the invoice editor never offered them, so a line that exists as a saved list
      // had to be typed by hand here.
      // THE SHARED SELECT SHAPE (kit-line.ts): sizing + the 0240 price-list link, tolerant of
      // either migration not having landed — so a linked kit line prices live for this customer
      // here exactly as it does in the quote composer, never from its frozen snapshot.
      firstThatWorks(kitsSelectRungs("id, name").map((sel) => () => supabase.from("kits").select(sel).order("name"))),
      supabase.from("tax_rates").select("id, name, rate, is_default").order("created_at"),
      supabase.from("organizations").select("settings, stripe_account_id, stripe_account_status, stripe_charges_enabled").limit(1).maybeSingle(),
      isDraft
        ? listCustomerOptions(supabase, 2000)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      isDraft
        ? supabase.from("jobs").select("id, name, job_number, customer_id").order("created_at", { ascending: false }).limit(2000)
        : Promise.resolve({ data: [] as { id: string; name: string | null; job_number: string | null; customer_id: string | null }[] }),
    ]);
  const orgSettings = getOrgSettings((org as any)?.settings);
  const paymentMethods = orgSettings.payment_methods;
  // The card door is the ORG's Connect state, not merely "the platform has a Stripe key".
  const cardEnabled = canAcceptPayments(connectStateFromOrg((org ?? {}) as any));
  // Can this org text (lib/sms-readiness)? Every Text door on the page reads it BEFORE it promises a
  // send, so a tap never asks "Text this invoice to Nora?" only to say texting isn't set up.
  const textReady = smsReadiness(org as { settings?: unknown } | null).ready;

  /* TWO THINGS THE OFFICE IS TOLD ABOUT A LINE, THAT THE CUSTOMER NEVER SEES (audit v994).
     PL1: a materials line keeps the supplier's name here, and the customer's copy reads "Materials";
     the row says so, from the same rule the customer's doors run (customerLineWords).
     PL2: a labor line for someone with no bill rate was billed at the customer's level rate or the
     org's default labor rate, never at what they are paid; the row says so, so nobody mistakes it
     for that person's own rate. profile_pay is the staff-scoped view (0215/0286): an owner's figure
     is already folded into bill_rate there, so he is never "unrated". */
  const [supplierNames, { data: payRows }] = await Promise.all([
    fetchSupplierNames(supabase),
    supabase.from("profile_pay").select("id, bill_rate"),
  ]);
  const noBillRateIds = ((payRows ?? []) as { id: string; bill_rate: number | string | null }[])
    .filter((r) => !(Number(r.bill_rate) > 0))
    .map((r) => String(r.id));

  // A deposit/progress/final invoice on a job carries a progress-report summary
  // so the payment request doubles as a running-balance statement.
  const drawKind = (inv as any).invoice_kind as string | undefined;
  const isDraw = !!(inv as any).job_id && isDrawKind(drawKind);
  const [fin, scheduleRows] = isDraw
    ? await Promise.all([
        jobProgressFinancials(supabase, (inv as any).job_id),
        supabase.from("payment_milestones").select("id").eq("job_id", (inv as any).job_id).limit(1),
      ])
    : [null, null];
  /* WHAT THE IMPORT ROW MAY OFFER (lib/actuals-draw, J-011). A standard invoice: everything, as
     always. A draw built from actuals (INV-078): Labor, Materials with the % box, Change Orders -
     it is refreshed exactly like a standard invoice, and it was the only one that couldn't be.
     Any other draw bills a slice of the contract: no imports (the server refuses them too). The
     rule is the server's own; a failed schedule read counts as "scheduled", which only hides. */
  let importMode: "standard" | "actuals" | "none" = !isDrawKind(drawKind)
    ? "standard"
    : isActualsDraw({
          invoiceKind: drawKind,
          scheduleActive: !scheduleRows || !!scheduleRows.error || (scheduleRows.data ?? []).length > 0,
          lineSources: ((items ?? []) as { import_source?: string | null }[]).map((i) => i.import_source ?? null),
          dismissedKeys: (inv as { dismissed_import_keys?: string[] | null }).dismissed_import_keys ?? [],
        })
      ? "actuals"
      : "none";
  /* A DEPOSIT NOT YET TAKEN OFF A BILL CLOSES THE ROW ON AN ACTUALS DRAW (the server's same rule,
     contractDrawGuard): new work itemised here would sit on top of a lump that only the NEXT
     progress report nets. Said where the row would be, never a row that vanished in silence. A lost
     read closes it too - it only hides a door the server may refuse. */
  let importHeld: string | null = null;
  if (importMode === "actuals" && (inv as any).job_id) {
    const ownCredit = ((items ?? []) as { import_source?: string | null; line_total?: unknown }[])
      .filter((i) => i.import_source === "draw_credit")
      .reduce((t, i) => t + Math.abs(Number(i.line_total) || 0), 0);
    const lump = await fixedBillingsNotYetNetted(supabase, (inv as any).job_id, id).catch(() => null);
    const open = lump === null ? null : Math.round((lump - ownCredit) * 100) / 100;
    if (open === null || open > 0.005) {
      importMode = "none";
      importHeld =
        open === null
          ? "Couldn't check this job's deposits just now, so new work can't be added here - reload in a moment."
          : `${formatCurrency(open)} of deposit or set-amount billing on this job hasn't been taken off a bill yet, so new hours and bills go on the next progress payment (which takes it off), not on this one.`;
    }
  }

  /* A CLOCK STILL RUNNING ON THIS JOB IS HOURS THIS INVOICE DOES NOT HAVE (2026-09-24). Erik: "I
     had no way to stop it to set the time for the invoice". An open shift bills nothing (the labor
     import reads closed rows only, and that stays), so the invoice looked short with no reason
     given. The note names who and since when, with "Clock Out Brian" one tap away: the office may
     clock anybody out at any time, and the sheet asks when it really stopped if it was forgotten. */
  const invJobId = ((inv as { job_id?: string | null }).job_id ?? null) as string | null;
  const runningRows =
    invJobId && inv.status !== "void"
      ? (((
          await supabase
            .from("time_entries")
            .select("id, profile_id, clock_in, profiles:profile_id(full_name)")
            .eq("job_id", invJobId)
            .eq("status", "open")
        ).data ?? []) as unknown as {
          id: string;
          profile_id: string | null;
          clock_in: string;
          profiles?: { full_name?: string | null } | { full_name?: string | null }[] | null;
        }[]).map((r) => {
          const full = ((Array.isArray(r.profiles) ? r.profiles[0] : r.profiles)?.full_name ?? "").trim();
          return { id: r.id, profileId: r.profile_id, clockIn: r.clock_in, fullName: full, name: full || "Someone" };
        })
      : [];
  // Only asked when there is a clock to name: the viewer's own reads "You" and "Clock Out".
  const viewerId = runningRows.length ? ((await supabase.auth.getUser()).data.user?.id ?? null) : null;
  const runningClocks = runningRows.map((r) => {
    const self = !!viewerId && r.profileId === viewerId;
    return { id: r.id, clockIn: r.clockIn, name: self ? "You" : r.name, self, door: clockDoorWords(r.fullName, { self }).clockOut };
  });

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink fallback="/billing" fallbackLabel="Back to Billing" />

      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">
            {inv.invoice_number}
          </h1>
          <Badge tone={statusTone(inv.status)}>{inv.status}</Badge>
          {/* Text it, AirDrop it, WhatsApp it — the way a contractor in a driveway actually sends
              things. Sends the customer's own token link on this business's domain; before this
              existed the only path was the OS share sheet on the PDF preview, which shipped the
              app's marketing blurb and a login URL. It rides the RIGHT END OF THE TITLE LINE, not
              the verb row (Erik 2026-09-11: "super tiny box with arrow icon… positioned
              intuitively"): on a phone the verb row wraps under the title, so this corner is the
              page's true top-right, where every phone already puts Share. */}
          <ShareIconButton load={invoiceShareText.bind(null, inv.id)} className="ml-auto" />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
          {inv.title && <span className="text-slate-600">{inv.title}</span>}
          <span>Created {formatDate(inv.created_at)}</span>
          {inv.due_date && <span>Due {formatDate(inv.due_date)}</span>}
          {inv.customers && (
            <Link
              href={`/crm/${inv.customers.id}`}
              className="flex items-center gap-1 hover:text-brand"
            >
              <User className="h-3.5 w-3.5" /> {inv.customers.name}
            </Link>
          )}
          {inv.quotes && (
            <Link
              href={`/quotes/${inv.quotes.id}`}
              className="flex items-center gap-1 hover:text-brand"
            >
              <FileText className="h-3.5 w-3.5" /> {inv.quotes.quote_number}
            </Link>
          )}
        </div>
        </div>
        {/* The impulse row holds the frequent verbs (Send / Record payment / Print);
            the ⋯ Actions menu (last) is the seek door for the rare deliberate ones —
            Credit/refund, QuickBooks, the Job link, and Delete (danger, last). */}
        <div className="flex flex-wrap items-center gap-2 self-start">
          {/* PAY NOW — the card door, up here with the other verbs (Erik 2026-09-10: "the pay now
              button should have the credit card stuff"). It replaces the old Collect Payment link,
              which opened the customer's checkout in a new tab of the OFFICE's browser. Shown on a
              draft too: Pay Now sends the invoice the moment it builds the door, because putting a
              bill in front of a customer is sending it. */}
          {invoiceBalance(inv.total, inv.amount_paid) > 0.005 && (
            <PayNowButton source="invoice" invoiceId={inv.id} balance={invoiceBalance(inv.total, inv.amount_paid)} cardEnabled={cardEnabled} textReady={textReady} />
          )}
          <EmailButton
            id={inv.id}
            kind="invoice"
            customerName={inv.customers?.name ?? null}
            amount={Number(inv.total)}
            textReady={textReady}
          />
          {/* RECORD PAYMENT — everything that isn't a card, as a sheet the same size as Pay Now,
              in the same row. This used to be an anchor that scrolled to a form in the right
              column, so the page had two Record Payment buttons and Pay Now sat inside the form.
              Payments record on DRAFTS too (Erik 7/24): deposits and Venmo prepayments arrive
              before the invoice goes out, and blocking them forced a fake workflow. */}
          {invoiceBalance(inv.total, inv.amount_paid) > 0.005 && (
            <RecordPaymentButton
              source="invoice"
              invoiceId={inv.id}
              balance={invoiceBalance(inv.total, inv.amount_paid)}
              methods={paymentMethods}
              venmoConfigured={Boolean(orgSettings.venmo_handle?.trim())}
            />
          )}
          <Link
            href={`/print/pdf-preview?doc=invoice&id=${inv.id}&back=/billing/${inv.id}`}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white h-11 px-4 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            <Printer className="h-4 w-4" /> Preview / Print
          </Link>
          <SectionActionsMenu
            tree={invoiceSectionTree(
              inv.invoice_number,
              { jobId: (inv as any).job_id ?? null },
              {
                run: deleteInvoice.bind(null, inv.id),
                // The confirm copy now lives in invoiceSectionTree, beside the gate built from the
                // same rule, so the dialog and the rule cannot drift apart again. This string is
                // the fallback for callers that pass no invoice.
                confirm: `Delete ${inv.invoice_number}? Only allowed while no payments are recorded.`,
              },
              // WITHOUT THIS THE GATE IS DEAD CODE. invoiceSectionTree treats a missing invoice as
              // "unknown", and unknown is deliberately not "refused" — so an unpassed status left
              // Delete Invoice offered on every void, sent and paid bill exactly as before, while
              // the code above it read as though it had been fixed.
              { status: inv.status, hasPayments: Number(inv.amount_paid ?? 0) > 0 || (payments ?? []).length > 0 },
            )}
          >
            <CreditButton
              menuItem
              invoiceId={inv.id}
              // Void is the one state where this whole window can only refuse. Unpassed, the gate
              // inside it never fires and Credit / Refund keeps opening onto a wall.
              invoiceStatus={inv.status}
              // Deliberately the INVERSE of invoiceBalance: paid − total = the OVERPAYMENT
              // (the refund default). invoiceBalance floors at 0, so it can't express this —
              // not a bypass of the balance SSOT.
              // One definition of "how much too much", shared with the Stripe webhook that now
              // flags it — otherwise a refund gets computed one way and announced another.
              defaultAmount={invoiceOverpayment(inv.total, inv.amount_paid)}
            />
            {qboConfigured() && <QboInvoiceButton menuItem id={inv.id} />}
          </SectionActionsMenu>
        </div>
      </div>

      {/* No estimate, no progress to report: a progress bill on a T&M job with no quote showed
          "Estimate $0.00" here and on the customer's copy (INV-078). */}
      {fin && fin.estimate > 0 && (
        <div className="mb-6">
          <ProgressReportCard
            estimate={fin.estimate}
            workToDate={fin.workToDate}
            received={receivedBeforeThisInvoice(fin, inv.amount_paid)}
            thisAmount={Number(inv.total ?? 0)}
            billingType={fin.billingType}
          />
        </div>
      )}

      <InvoiceDetail
        invoice={inv}
        items={(items ?? []) as InvoiceItem[]}
        payments={(payments ?? []) as Payment[]}
        priceItems={(priceItems ?? []) as any}
        kits={(kits ?? []) as any}
        taxRates={(taxRates ?? []) as any}
        paymentMethods={paymentMethods}
        materialMarkup={(inv as any).customers?.pricing_levels?.markup_pct ?? orgSettings.material_markup_percent}
        levelMarkupPct={(inv as any).customers?.pricing_levels?.markup_pct ?? null}
        defaultMarkupPct={orgSettings.default_markup_pct}
        customers={(customers ?? []) as any}
        jobs={(jobs ?? []) as any}
        /* Who holds this bill — the same name the Send Invoice confirm spells out, so the notice
           about their copy being older says "Dave Gove", not "the customer". */
        customerName={inv.customers?.name ?? null}
        runningClocks={runningClocks}
        importMode={importMode}
        importHeld={importHeld}
        textReady={textReady}
        supplierNames={[...supplierNames]}
        noBillRateIds={noBillRateIds}
        tz={orgSettings.timezone}
        customerHoldsOlderCopy={customerHoldsOlderCopy(
          (inv as { sent_at?: string | null }).sent_at,
          (inv as { revised_at?: string | null }).revised_at,
          // Paid in full after the change = the customer has the current bill (the board's rule).
          { total: inv.total, amountPaid: inv.amount_paid, paidAt: ((payments ?? []) as { paid_at?: string | null }[]).map((p) => p.paid_at) },
        )}
      />
    </div>
  );
}
