import "server-only";
import { sendEmail, renderInvoiceNoticeEmail, ownerBcc } from "@/lib/email";
import { getOrgSettings, accentHex } from "@/lib/org-settings";
import { companyFromOrg } from "@/components/doc-letterhead";
import { companyBlock } from "@/lib/company-lines";
import { invoiceBalance } from "@/lib/invoice-math";

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
    .select("*, customers(name, email, portal_token)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const customer = (invoice as any).customers;
  if (!customer?.email) return { ok: false, error: "This customer has no email address." };

  const [{ data: items }, { data: org }] = await Promise.all([
    supabase.from("invoice_items").select("*").eq("invoice_id", id).order("sort_order"),
    // Scope to THIS invoice's org explicitly — under the RLS-bypassing service client
    // (the recurring cron) an unfiltered query sees every org and would error on
    // .maybeSingle() or leak another tenant's branding/reply-to to this customer.
    supabase.from("organizations").select("name, phone, email, address_line1, address_line2, city, state, zip, license, logo_url, settings").eq("id", (invoice as any).org_id).maybeSingle(),
  ]);
  // Never email an empty invoice (a blank $0 mis-send) — protects every caller.
  if (!items || items.length === 0) return { ok: false, error: "This invoice has no line items to send." };

  const site = process.env.NEXT_PUBLIC_SITE_URL || "https://contractor-north.vercel.app";
  const link = `${site}/i/${(invoice as any).public_token}`;
  const portalLink = customer.portal_token ? `${site}/portal/${customer.portal_token}` : undefined;
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
    html,
    replyTo: org?.email ?? undefined,
    bcc: ownerBcc(getOrgSettings((org as any)?.settings).copy_owner_on_emails, org?.email),
  });
  if (!res.ok) return res;
  if (invoice.status === "draft") {
    await supabase.from("invoices").update({ status: "sent" }).eq("id", id);
  }
  return { ok: true };
}
