"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { formatPhone, formatState, formatZip, titleCase } from "@/lib/utils";

export async function disconnectQuickbooks(): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("org_id, role")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  if (!me?.org_id || !["owner", "admin"].includes(me.role)) {
    return { ok: false, error: "Not allowed." };
  }
  const svc = createServiceClient();
  await svc.from("accounting_connections").delete().eq("org_id", me.org_id);
  revalidatePath("/settings");
  return { ok: true };
}

export type Result = { ok: boolean; error?: string };

async function myOrgId(supabase: any): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", user.id)
    .maybeSingle();
  return data?.org_id ?? null;
}

export async function updateOrganization(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };

  const taxPct = Number(formData.get("default_tax_pct"));

  // Currency / timezone / tax number live in the settings JSONB — merge them in.
  const { data: existing } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .single();
  const mergedSettings = {
    ...(existing?.settings ?? {}),
    currency: String(formData.get("currency") ?? "USD") || "USD",
    timezone: String(formData.get("timezone") ?? "America/Los_Angeles"),
    tax_number: String(formData.get("tax_number") ?? "").trim(),
  };

  const { error } = await supabase
    .from("organizations")
    .update({
      name: String(formData.get("name") ?? "").trim() || "My Company",
      address_line1: emptyToNull(formData.get("address_line1")),
      address_line2: emptyToNull(formData.get("address_line2")),
      city: norm(titleCase(String(formData.get("city") ?? ""))),
      state: norm(formatState(String(formData.get("state") ?? ""))),
      zip: norm(formatZip(String(formData.get("zip") ?? ""))),
      phone: norm(formatPhone(String(formData.get("phone") ?? ""))),
      email: emptyToNull(formData.get("email")),
      license: emptyToNull(formData.get("license")),
      brand_color: String(formData.get("brand_color") ?? "#0b57c4") || "#0b57c4",
      default_tax_rate: Number.isFinite(taxPct) ? taxPct / 100 : 0,
      settings: mergedSettings,
    })
    .eq("id", orgId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function setLanguage(language: string): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const lang = ["en", "es"].includes(language) ? language : "en";
  const { error } = await supabase
    .from("profiles")
    .update({ language: lang })
    .eq("id", user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function setLogoUrl(url: string | null): Promise<Result> {
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };
  const { error } = await supabase
    .from("organizations")
    .update({ logo_url: url })
    .eq("id", orgId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: true };
}

const ALLOWED_TEMPLATES = ["classic", "modern", "minimal"];
const DOC_TYPES = ["quote", "invoice", "change_order", "work_order"];

export async function setDocTemplateFor(
  docType: string,
  template: string,
): Promise<Result> {
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };
  if (!DOC_TYPES.includes(docType)) return { ok: false, error: "Unknown document type." };
  const t = ALLOWED_TEMPLATES.includes(template) ? template : "classic";

  const { data: org } = await supabase
    .from("organizations")
    .select("doc_templates")
    .eq("id", orgId)
    .single();
  const map = { ...(org?.doc_templates ?? {}), [docType]: t };

  const { error } = await supabase
    .from("organizations")
    .update({ doc_templates: map })
    .eq("id", orgId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export async function setDocTemplate(template: string): Promise<Result> {
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };
  const allowed = ["classic", "modern", "minimal"];
  const t = allowed.includes(template) ? template : "classic";
  const { error } = await supabase
    .from("organizations")
    .update({ doc_template: t })
    .eq("id", orgId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export async function createInvitation(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "tech");
  if (!email) return { ok: false, error: "Email is required." };

  const { error } = await supabase.from("invitations").insert({
    org_id: orgId,
    email,
    role,
    invited_by: user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export async function deleteInvitation(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("invitations").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

/** Merge a partial settings patch into organizations.settings (JSONB). */
export async function updateOrgSettings(
  patch: Record<string, unknown>,
): Promise<Result> {
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };

  const { data: org } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .single();
  const merged = { ...(org?.settings ?? {}), ...patch };

  const { error } = await supabase
    .from("organizations")
    .update({ settings: merged })
    .eq("id", orgId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function createTaxRate(input: {
  name: string;
  rate: number;
  is_default?: boolean;
}): Promise<Result> {
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };
  if (!input.name.trim()) return { ok: false, error: "Name is required." };

  if (input.is_default) {
    await supabase.from("tax_rates").update({ is_default: false }).eq("org_id", orgId);
  }
  const { error } = await supabase.from("tax_rates").insert({
    name: input.name.trim(),
    rate: Number.isFinite(input.rate) ? input.rate : 0,
    is_default: !!input.is_default,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export async function setDefaultTaxRate(id: string): Promise<Result> {
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };
  await supabase.from("tax_rates").update({ is_default: false }).eq("org_id", orgId);
  const { error } = await supabase.from("tax_rates").update({ is_default: true }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export async function deleteTaxRate(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("tax_rates").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

function norm(s: string): string | null {
  const t = s.trim();
  return t.length ? t : null;
}
