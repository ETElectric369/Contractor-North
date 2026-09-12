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
import { formatDate } from "@/lib/utils";
import { InvoiceDetail } from "./invoice-detail";
import { CreditButton } from "./credit-button";
import { ShareIconButton } from "@/components/share-icon-button";
import { EmailButton } from "@/components/email-button";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import { invoiceSectionTree } from "@/lib/nav-tree";
import { deleteInvoice, invoiceShareText } from "../actions";
import { getOrgSettings } from "@/lib/org-settings";
import { jobProgressFinancials, receivedBeforeThisInvoice } from "@/lib/job-financials";
import { invoiceBalance, isDrawKind, invoiceOverpayment } from "@/lib/invoice-math";
import { listCustomerOptions } from "@/lib/schedule-options";
import { ProgressReportCard } from "@/components/progress-report-card";
import type { Invoice, InvoiceItem, Payment } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

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

  // A deposit/progress/final invoice on a job carries a progress-report summary
  // so the payment request doubles as a running-balance statement.
  const drawKind = (inv as any).invoice_kind as string | undefined;
  const isDraw = !!(inv as any).job_id && isDrawKind(drawKind);
  const fin = isDraw ? await jobProgressFinancials(supabase, (inv as any).job_id) : null;

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
            <PayNowButton source="invoice" invoiceId={inv.id} balance={invoiceBalance(inv.total, inv.amount_paid)} cardEnabled={cardEnabled} />
          )}
          <EmailButton
            id={inv.id}
            kind="invoice"
            customerName={inv.customers?.name ?? null}
            amount={Number(inv.total)}
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
                confirm: `Delete ${inv.invoice_number}? Only allowed while no payments are recorded.`,
              },
            )}
          >
            <CreditButton
              menuItem
              invoiceId={inv.id}
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

      {fin && (
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
      />
    </div>
  );
}
