"use server";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";
import { formatPhone, formatState, formatZip, titleCase } from "@/lib/utils";
import { requireStaff } from "@/lib/staff-guard";
import { sendEmail, renderReminderEmail, ownerBcc } from "@/lib/email";
import { getOrgSettings } from "@/lib/org-settings";

export type ActionResult = { ok: boolean; error?: string; id?: string };

/** Email the customer their passwordless portal link (invoices, contracts, quotes,
 *  project status). The link is their unguessable portal_token — bookmark, no login. */
export async function emailPortalLink(customerId: string): Promise<ActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: c } = await supabase
    .from("customers")
    .select("name, email, portal_token")
    .eq("id", customerId)
    .maybeSingle();
  if (!c) return { ok: false, error: "Customer not found." };
  if (!c.email) return { ok: false, error: "This customer has no email address." };

  const { data: org } = await supabase.from("organizations").select("name, brand_color, phone, email, settings").maybeSingle();
  // Always an absolute origin so the emailed link is clickable even if the env var is unset.
  const site = process.env.NEXT_PUBLIC_SITE_URL || "https://contractor-north.vercel.app";
  const link = `${site}/portal/${c.portal_token}`;
  const html = renderReminderEmail({
    company: { name: org?.name ?? "Contractor North", brand: org?.brand_color ?? "#0b57c4", phone: org?.phone, email: org?.email },
    customerName: c.name,
    heading: "Your customer portal",
    message: "Here's your private link to view your invoices, contracts, quotes, and project status anytime — no password needed. Bookmark it for easy access.",
    cta: { label: "Open my portal", link },
  });
  const res = await sendEmail({
    to: c.email,
    subject: `Your ${org?.name ?? "customer"} portal`.trim(),
    html,
    replyTo: org?.email ?? undefined,
    bcc: ownerBcc(getOrgSettings((org as any)?.settings).copy_owner_on_emails, org?.email),
  });
  return res.ok ? { ok: true } : res;
}

export async function createCustomer(formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { data, error } = await supabase
    .from("customers")
    .insert({
      name,
      company_name: emptyToNull(formData.get("company_name")),
      type: String(formData.get("type") ?? "residential"),
      status: String(formData.get("status") ?? "active"),
      email: emptyToNull(formData.get("email")),
      phone: orNull(formatPhone(String(formData.get("phone") ?? ""))),
      address: emptyToNull(formData.get("address")),
      city: orNull(titleCase(String(formData.get("city") ?? ""))),
      state: orNull(formatState(String(formData.get("state") ?? ""))),
      zip: orNull(formatZip(String(formData.get("zip") ?? ""))),
      notes: emptyToNull(formData.get("notes")),
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) {
    // Before migration 0087 adds the 'subcontractor' enum value, picking that type returns a raw
    // Postgres enum error — surface a clear nudge instead.
    if (/enum/i.test(error.message) && /subcontractor/i.test(error.message))
      return { ok: false, error: "Subcontractor type isn't set up yet — run migration 0087." };
    return { ok: false, error: error.message };
  }

  revalidatePath("/crm");
  return { ok: true, id: data.id };
}

export async function updateCustomer(
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createClient();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { error } = await supabase
    .from("customers")
    .update({
      name,
      company_name: emptyToNull(formData.get("company_name")),
      type: String(formData.get("type") ?? "residential"),
      status: String(formData.get("status") ?? "lead"),
      email: emptyToNull(formData.get("email")),
      phone: orNull(formatPhone(String(formData.get("phone") ?? ""))),
      address: emptyToNull(formData.get("address")),
      city: orNull(titleCase(String(formData.get("city") ?? ""))),
      state: orNull(formatState(String(formData.get("state") ?? ""))),
      zip: orNull(formatZip(String(formData.get("zip") ?? ""))),
      notes: emptyToNull(formData.get("notes")),
      pricing_level_id: emptyToNull(formData.get("pricing_level_id")),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/crm/${id}`);
  revalidatePath("/crm");
  return { ok: true };
}

/** Partial update — only the fields provided change (so the agent can fix a misspelled
 *  name or add a phone without wiping everything else). RLS scopes it to the org. */
export async function patchCustomer(
  id: string,
  patch: {
    name?: string; phone?: string | null; email?: string | null; company_name?: string | null;
    address?: string | null; city?: string | null; state?: string | null; zip?: string | null; notes?: string | null;
    type?: string;
  },
): Promise<ActionResult> {
  const supabase = await createClient();
  const upd: Record<string, unknown> = {};
  if (patch.type != null) upd.type = patch.type; // residential | commercial | industrial | subcontractor
  if (patch.name != null) { const n = String(patch.name).trim(); if (!n) return { ok: false, error: "Name can't be empty." }; upd.name = n; }
  if (patch.phone != null) upd.phone = orNull(formatPhone(String(patch.phone)));
  if (patch.email != null) upd.email = emptyToNull(patch.email);
  if (patch.company_name != null) upd.company_name = emptyToNull(patch.company_name);
  if (patch.address != null) upd.address = emptyToNull(patch.address);
  if (patch.city != null) upd.city = orNull(titleCase(String(patch.city)));
  if (patch.state != null) upd.state = orNull(formatState(String(patch.state)));
  if (patch.zip != null) upd.zip = orNull(formatZip(String(patch.zip)));
  if (patch.notes != null) upd.notes = emptyToNull(patch.notes);
  if (Object.keys(upd).length === 0) return { ok: false, error: "Nothing to update." };
  const { error } = await supabase.from("customers").update(upd).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

export interface CustomerImportRow {
  name: string;
  company_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  notes?: string;
}

/** Bulk-import customers from a CSV (skips rows with no name; dedupes on
 *  exact name+phone already present). */
export async function bulkImportCustomers(rows: CustomerImportRow[]): Promise<ActionResult & { imported?: number; skipped?: number }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const clean = rows
    .map((r) => ({
      name: String(r.name ?? "").trim(),
      company_name: orNull(String(r.company_name ?? "")),
      email: orNull(String(r.email ?? "")),
      phone: orNull(formatPhone(String(r.phone ?? ""))),
      address: orNull(String(r.address ?? "")),
      city: orNull(titleCase(String(r.city ?? ""))),
      state: orNull(formatState(String(r.state ?? ""))),
      zip: orNull(formatZip(String(r.zip ?? ""))),
      notes: orNull(String(r.notes ?? "")),
      type: "residential",
      status: "active",
      created_by: user.id,
    }))
    .filter((r) => r.name);
  if (!clean.length) return { ok: false, error: "No rows with a name to import." };
  if (clean.length > 2000) return { ok: false, error: "Max 2,000 rows per import." };

  // Skip exact duplicates already in the book.
  const { data: existing } = await supabase.from("customers").select("name, phone");
  const seen = new Set((existing ?? []).map((c: any) => `${(c.name ?? "").toLowerCase()}|${c.phone ?? ""}`));
  const fresh = clean.filter((r) => !seen.has(`${r.name.toLowerCase()}|${r.phone ?? ""}`));
  const skipped = clean.length - fresh.length;

  if (fresh.length) {
    const { error } = await supabase.from("customers").insert(fresh);
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath("/crm");
  return { ok: true, imported: fresh.length, skipped };
}

/** Delete a customer — blocked while jobs/quotes/invoices still reference it,
 *  so history can never disappear by accident. */
export async function deleteCustomer(id: string): Promise<ActionResult> {
  const supabase = await createClient();

  const [{ count: jobs }, { count: quotes }, { count: invoices }] = await Promise.all([
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("customer_id", id),
    supabase.from("quotes").select("id", { count: "exact", head: true }).eq("customer_id", id),
    supabase.from("invoices").select("id", { count: "exact", head: true }).eq("customer_id", id),
  ]);
  const linked: string[] = [];
  if (jobs) linked.push(`${jobs} job${jobs > 1 ? "s" : ""}`);
  if (quotes) linked.push(`${quotes} quote${quotes > 1 ? "s" : ""}`);
  if (invoices) linked.push(`${invoices} invoice${invoices > 1 ? "s" : ""}`);
  if (linked.length) {
    return {
      ok: false,
      error: `This customer has ${linked.join(", ")}. Reassign or delete those first, or mark the customer inactive instead.`,
    };
  }

  const { error } = await supabase.from("customers").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

export async function updateCustomerStatus(
  id: string,
  status: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update({ status })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  revalidatePath(`/crm/${id}`);
  return { ok: true };
}


function orNull(s: string): string | null {
  const t = s.trim();
  return t.length ? t : null;
}
