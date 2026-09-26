import "server-only";
import { sendEmail, renderInvoiceNoticeEmail, ownerBcc } from "@/lib/email";
import { getOrgSettings, accentHex, orgDocUrl, orgPublicBaseUrl } from "@/lib/org-settings";
import { rowPlace } from "@/lib/doc-place";
import { companyFromOrg } from "@/components/doc-letterhead";
import { companyBlock } from "@/lib/company-lines";
import { invoiceBalance } from "@/lib/invoice-math";
import { recalcInvoice } from "@/lib/invoice-recalc";
import { markInvoiceResent, markInvoiceSent } from "@/lib/invoice-sent-stamp";

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
): Promise<{ ok: boolean; error?: string }> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("*, customers(name, email, address), jobs(address)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const customer = (invoice as any).customers;
  if (!customer?.email) return { ok: false, error: "This customer has no email address." };

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
  const portalLink = portal?.token && portal.enabled ? `${site}/portal/${portal.token}` : undefined;
  const balance = invoiceBalance(invoice.total, invoice.amount_paid);
  // A basic greeting + the balance + a button to the ONE canonical invoice document
  // (viewable, printable, payable) and the portal — never a re-rendered copy of the
  // invoice, so the email can't drift from the print/portal view.
  const co = companyFromOrg(org as any);
  const html = renderInvoiceNoticeEmail({
    company: {
      name: org?.name ?? "Contractor North",
      brand: accentHex(getOrgSettings((org as any)?.settings).glass_tint),
      tagline: co.tagline,
      phone: org?.phone,
      email: org?.email,
    },
    letterhead: companyBlock(co),
    customerName: customer.name,
    number: invoice.invoice_number,
    title: invoice.title,
    balance,
    invoiceLink: link,
    portalLink,
  });

  const res = await sendEmail({
    to: customer.email,
    subject: `Invoice ${invoice.invoice_number} from ${org?.name ?? "us"}`,
    fromName: org?.name ?? undefined,
    html,
    replyTo: org?.email ?? undefined,
    bcc: ownerBcc(getOrgSettings((org as any)?.settings).copy_owner_on_emails, org?.email),
  });
  if (!res.ok) return res;
  // THE EMAIL IS THE DEED, SO THIS IS WHERE THE STAMP BELONGS (0267, INV-069). `status = 'sent'`
  // alone could be manufactured by a pay door that never showed anyone a bill; sent_at cannot,
  // and the demotion guard in billing/actions.ts now reads delivery off exactly this write.
  //
  // EVERY SEND STAMPS, NOT ONLY THE FIRST (0269, caught by all three reviewers of cn-v962). This
  // used to run only for a draft, which was right while a sent invoice could not be edited. Now
  // that it can, the page tells Erik when the customer is holding an older bill than his and
  // offers Send Invoice as the fix - and that button lands HERE. Stamping only on the first send
  // meant the one door the notice points at could never clear the notice: he would email the
  // corrected bill, watch it go, and be told again that they have the old one. A banner you
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
        : `The email went out, but ${invoice.invoice_number ?? "this invoice"} still shows the customer holding an older copy - reload and send it again. (${(stamped as { error?: string }).error ?? "try again"})`,
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
