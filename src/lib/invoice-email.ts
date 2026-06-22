import "server-only";
import { sendEmail, renderDocEmail } from "@/lib/email";

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
    .select("*, customers(name, email)")
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
    supabase.from("organizations").select("name, brand_color, phone, email").eq("id", (invoice as any).org_id).maybeSingle(),
  ]);
  // Never email an empty invoice (a blank $0 mis-send) — protects every caller.
  if (!items || items.length === 0) return { ok: false, error: "This invoice has no line items to send." };

  const link = `${process.env.NEXT_PUBLIC_SITE_URL || ""}/i/${(invoice as any).public_token}`;
  const balance = Number(invoice.total) - Number(invoice.amount_paid);
  const html = renderDocEmail({
    docType: "Invoice",
    number: invoice.invoice_number,
    company: {
      name: org?.name ?? "Contractor North",
      brand: org?.brand_color ?? "#0b57c4",
      phone: org?.phone,
      email: org?.email,
    },
    customerName: customer.name,
    title: invoice.title,
    items: (items ?? []).map((i: any) => ({
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      price: i.unit_price,
      total: i.line_total,
    })),
    subtotal: invoice.subtotal,
    tax: invoice.tax,
    total: invoice.total,
    balance,
    notes: invoice.notes,
    link,
  });

  const res = await sendEmail({
    to: customer.email,
    subject: `Invoice ${invoice.invoice_number} from ${org?.name ?? "us"}`,
    html,
    replyTo: org?.email ?? undefined,
  });
  if (!res.ok) return res;
  if (invoice.status === "draft") {
    await supabase.from("invoices").update({ status: "sent" }).eq("id", id);
  }
  return { ok: true };
}
