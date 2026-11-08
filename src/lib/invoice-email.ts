import "server-only";
import { sendEmail, renderInvoiceNoticeEmail, money } from "@/lib/email";
import { copyMeAddress, type SendMessage } from "@/lib/send-review";
import { logSend } from "@/lib/sent-messages";
import { getOrgSettings, accentHex, orgDocUrl, orgPublicBaseUrl } from "@/lib/org-settings";
import { rowPlace } from "@/lib/doc-place";
import { companyFromOrg } from "@/components/doc-letterhead";
import { companyBlock } from "@/lib/company-lines";
import { invoiceBalance } from "@/lib/invoice-math";
import { recalcInvoice } from "@/lib/invoice-recalc";
import { markInvoiceResent, markInvoiceSent } from "@/lib/invoice-sent-stamp";
import { featureOn, type FeatureMap } from "@/lib/features";

/**
 * THE PORTAL BUTTON IN AN INVOICE EMAIL: a live link the office hasn't turned off, and a company
 * whose Customer Portal is on (the switch board, 0352, rule f). Off, and the email carries the
 * invoice alone; the invoice link (/i, pay included) never depends on it. On, or no switches stored,
 * exactly the link it always was.
 */
export function invoicePortalLink(
  site: string,
  portal: { token: string | null; enabled: boolean } | null,
  features: FeatureMap | null | undefined,
): string | undefined {
  if (!featureOn(features, "customer_portal")) return undefined;
  return portal?.token && portal.enabled ? `${site}/portal/${portal.token}` : undefined;
}

/**
 * THE WORDS AN INVOICE GOES OUT WITH, IN ONE PLACE (cn-v1155). The review sheet's prefill
 * (previewInvoiceSend), the email (deliverInvoiceEmail), the text (textInvoice) and the sent-messages
 * log all read this, so what the owner reviewed, what the customer got and what the log keeps can
 * never drift. Plain text, English (it is customer-bound). `body` is what follows the fixed greeting
 * in the email and mirrors the renderer's own default sentence; `smsBody` is today's text minus the
 * link, which goes after it as the fixed tail.
 */
export function invoiceSendWords(input: {
  orgName: string | null | undefined;
  number: string;
  title?: string | null;
  balance: number;
}): { subject: string; body: string; smsBody: string } {
  const due = input.balance > 0;
  return {
    subject: `Invoice ${input.number} from ${input.orgName ?? "us"}`,
    body: `Your invoice ${input.number}${input.title ? ` — ${input.title}` : ""} is ready${due ? `. Balance due: ${money(input.balance)}.` : " — paid in full. Thank you!"}`,
    smsBody: `${input.orgName ?? "Your contractor"}: Invoice ${input.number}, balance $${input.balance.toFixed(2)}.`,
  };
}

/** What the person sent from the review sheet, and who sent it. Absent (the recurring cron), every
 *  default stands and the send is logged as automatic. */
export type InvoiceSendOpts = {
  message?: SendMessage;
  sentBy?: string;
  senderEmail?: string | null;
  kind?: "invoice" | "receipt";
};

/**
 * Render + send an invoice email to the customer and mark a draft "sent".
 * No auth gate: the staff action `emailInvoice` runs requireStaff before calling
 * this, and the recurring/cron path (service client, no auth context) calls it
 * directly. Returns the same {ok, error?} shape either way. Best-effort by design —
 * a customer with no email or an empty invoice returns an error the caller can ignore.
 */
export async function deliverInvoiceEmail(
  supabase: any,
  id: string,
  opts?: InvoiceSendOpts,
): Promise<{ ok: boolean; error?: string }> {
  const message = opts?.message;
  const { data: invoice } = await supabase
    .from("invoices")
    .select("*, customers(name, email, address), jobs(address)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const customer = (invoice as any).customers;
  const to: string | undefined = message?.to ?? customer?.email ?? undefined;
  if (!to) return { ok: false, error: "This customer has no email address." };

  const [{ data: items }, { data: org }, { data: portalRow, error: portalError }] = await Promise.all([
    supabase.from("invoice_items").select("*").eq("invoice_id", id).order("sort_order"),
    // Scope to THIS invoice's org explicitly — under the RLS-bypassing service client
    // (the recurring cron) an unfiltered query sees every org and would error on
    // .maybeSingle() or leak another tenant's branding/reply-to to this customer.
    supabase.from("organizations").select("name, phone, email, address_line1, address_line2, city, state, zip, license, logo_url, settings").eq("id", (invoice as any).org_id).maybeSingle(),
    // The customer's portal link lives in customer_portal_access (0298), readable by office staff
    // and the service role only — the two kinds of caller this function has. Scoped to the
    // invoice's org for the same reason as the read above. A link the office turned off is left
    // out of the email rather than sent to open on "this link was turned off".
    supabase
      .from("customer_portal_access")
      .select("token, enabled")
      .eq("customer_id", (invoice as any).customer_id)
      .eq("org_id", (invoice as any).org_id)
      .maybeSingle(),
  ]);
  // The app deploys before 0298 is applied. In that window customer_portal_access doesn't exist
  // and the read above errors, which would send every invoice email (the recurring cron included)
  // without the portal link and say nothing. Only for a missing table, read the link where it
  // lived before 0298. Any other error leaves the link out, as a turned-off link does.
  let portal: { token: string | null; enabled: boolean } | null = portalRow ?? null;
  if (portalError && isMissingTable(portalError)) {
    const { data: legacy } = await supabase
      .from("customers")
      .select("portal_token")
      .eq("id", (invoice as any).customer_id)
      .eq("org_id", (invoice as any).org_id)
      .maybeSingle();
    portal = legacy?.portal_token ? { token: legacy.portal_token, enabled: true } : null;
  } else if (portalError) {
    console.error("[invoice-email] portal link read failed; sending without it", portalError);
  }
  // Never email an empty invoice (a blank $0 mis-send) — protects every caller.
  if (!items || items.length === 0) return { ok: false, error: "This invoice has no line items to send." };

  const site = orgPublicBaseUrl(getOrgSettings((org as any)?.settings));
  const link = orgDocUrl(getOrgSettings((org as any)?.settings), "i", (invoice as any).public_token, rowPlace(invoice as any));
  const portalLink = invoicePortalLink(site, portal, getOrgSettings((org as any)?.settings).features);
  const balance = invoiceBalance(invoice.total, invoice.amount_paid);
  // A basic greeting + the balance + a button to the ONE canonical invoice document
  // (viewable, printable, payable) and the portal — never a re-rendered copy of the
  // invoice, so the email can't drift from the print/portal view.
  const co = companyFromOrg(org as any);
  const words = invoiceSendWords({ orgName: org?.name, number: invoice.invoice_number, title: invoice.title, balance });
  const html = renderInvoiceNoticeEmail({
    company: {
      name: org?.name ?? "Contractor North",
      brand: accentHex(getOrgSettings((org as any)?.settings).glass_tint),
      tagline: co.tagline,
      phone: org?.phone,
      email: org?.email,
    },
    letterhead: companyBlock(co),
    customerName: customer?.name ?? "there",
    number: invoice.invoice_number,
    title: invoice.title,
    balance,
    invoiceLink: link,
    portalLink,
    // Only the owner's own words replace the default sentence; with none the HTML is what it always was.
    body: message?.body,
  });
  // Copy Me: the sheet's choice, else the company's standing switch. The copy goes to the sender's
  // own address, else the company's (no sender known, the cron, is the company's as it always was).
  const copyMe = message?.copyMe ?? getOrgSettings((org as any)?.settings).copy_owner_on_emails;
  const bcc = copyMe ? (copyMeAddress(opts?.senderEmail, org?.email) ?? undefined) : undefined;
  const subject = message?.subject ?? words.subject;

  const res = await sendEmail({
    to,
    subject,
    fromName: org?.name ?? undefined,
    html,
    replyTo: org?.email ?? undefined,
    bcc,
  });
  if (!res.ok) return res;
  // The words that went out, kept word for word (best-effort; the mail has already left).
  await logSend(supabase, {
    orgId: (invoice as any).org_id,
    docKind: opts?.kind ?? "invoice",
    docId: id,
    customerId: (invoice as any).customer_id ?? null,
    channel: "email",
    to,
    subject,
    body: message?.body ?? words.body,
    copyTo: bcc ?? null,
    sentBy: opts?.sentBy ?? null,
    auto: !opts?.sentBy,
  });
  // THE EMAIL IS THE DEED, SO THIS IS WHERE THE STAMP BELONGS (0267, INV-069). `status = 'sent'`
  // alone could be manufactured by a pay door that never showed anyone a bill; sent_at cannot,
  // and the demotion guard in billing/actions.ts now reads delivery off exactly this write.
  //
  // EVERY SEND STAMPS, NOT ONLY THE FIRST (0269, caught by all three reviewers of cn-v962). This
  // used to run only for a draft, which was right while a sent invoice could not be edited. Now
  // that it can, the page tells Erik when the customer paid on an older figure and the money has
  // changed since (lib/invoice-revision customerHoldsOlderCopy, narrowed to the money 2026-11-07)
  // and offers Send Invoice as the fix - and that button lands HERE. Stamping only on the first
  // send meant the one door the notice points at could never clear the notice: he would email the
  // corrected bill, watch it go, and be told again that they paid on the old figure. A banner you
  // cannot clear by doing what it asks is worse than no banner at all.
  //
  // The two halves are deliberately different functions. markInvoiceSent writes the STATUS as
  // well, which is what a first send needs; markInvoiceResent writes only the date, because
  // emailing someone a copy of a bill they have already paid must never demote 'paid' back to
  // 'sent' and chase them for money they handed over. A VOID invoice stamps nothing: it is not a
  // bill, and its link does not open (public_invoice is narrowed to sent/partial/paid/overdue).
  //
  // The mail is already gone by the time we get here, so a failure is NOT a failed send and must
  // not be reported as one - but it cannot be swallowed either, or the office sits on a Draft
  // badge over a bill the customer is reading, which is the whole shape of this incident.
  const first = invoice.status === "draft";
  const stamped = first
    ? await markInvoiceSent(supabase, id)
    : invoice.status === "void"
      ? { ok: true as const }
      : await markInvoiceResent(supabase, id);
  if (!stamped.ok) {
    return {
      ok: false,
      error: first
        ? `The email went out, but ${invoice.invoice_number ?? "this invoice"} didn't get marked as sent - reload and set its status to Sent. (${(stamped as { error?: string }).error ?? "try again"})`
        : `The email went out, but ${invoice.invoice_number ?? "this invoice"} didn't get recorded as sent again - reload and send it again. (${(stamped as { error?: string }).error ?? "try again"})`,
    };
  }
  if (first) {
    // Mirror textInvoice (audit 7): the recalc advances a PREPAID draft to paid/partial instead
    // of stranding it on 'sent', and its bustDocPdf drops the draft-era stored copy so the
    // send-time warm stores a fresh one the customer door will serve.
    await recalcInvoice(supabase, id);
  }
  return { ok: true };
}

/** Postgres undefined_table (42P01) or PostgREST's "table not in the schema cache" (PGRST205). */
function isMissingTable(error: unknown): boolean {
  const code = String((error as { code?: string })?.code ?? "");
  return code === "42P01" || code === "PGRST205";
}
