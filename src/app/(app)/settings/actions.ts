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
    glass_tint: String(formData.get("glass_tint") ?? "#1b9488") || "#1b9488",
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

/**
 * Create an employee login directly — no email invite. Needs the
 * service-role key (SUPABASE_SERVICE_ROLE_KEY) on the server. The owner
 * hands the email + password to the employee; they can log in immediately.
 */
export async function createEmployee(input: {
  full_name: string;
  email: string;
  password: string;
  role: string;
  hourly_rate: number | null;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase
    .from("profiles")
    .select("role, org_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!me || !["owner", "admin"].includes(me.role)) return { ok: false, error: "Not allowed." };
  if (!me.org_id) return { ok: false, error: "No organization." };

  const name = input.full_name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name) return { ok: false, error: "Name is required." };
  if (!email.includes("@")) return { ok: false, error: "Enter a valid email." };
  if (input.password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
  const role = ["admin", "office", "tech"].includes(input.role) ? input.role : "tech";

  const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
  if (!adminConfigured()) {
    return {
      ok: false,
      error: "Direct employee creation needs SUPABASE_SERVICE_ROLE_KEY set on the server. Use an email invite instead, or add the key in Vercel.",
    };
  }

  const admin = createAdminClient();
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (authErr || !created.user) return { ok: false, error: authErr?.message ?? "Could not create the login." };

  // The on-signup trigger created the profile — attach it to this org.
  const { error: profErr } = await admin
    .from("profiles")
    .update({
      org_id: me.org_id,
      full_name: name,
      role,
      hourly_rate: input.hourly_rate,
      active: true,
    })
    .eq("id", created.user.id);
  if (profErr) return { ok: false, error: profErr.message };

  revalidatePath("/settings");
  return { ok: true };
}

/** Push upcoming scheduled jobs (next 60 days) to the connected Google
 *  Calendar — updates existing events, creates the rest. */
export async function syncScheduleToGoogle(): Promise<Result & { synced?: number }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { gcalAccessToken, gcalUpsertJobEvent } = await import("@/lib/google-calendar");
  let auth;
  try {
    auth = await gcalAccessToken(supabase);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Token refresh failed." };
  }
  if (!auth) return { ok: false, error: "Google Calendar isn't connected yet." };

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, job_number, name, address, description, scheduled_start, scheduled_end, google_event_id")
    .gte("scheduled_start", new Date().toISOString())
    .lte("scheduled_start", new Date(Date.now() + 60 * 86400_000).toISOString())
    .not("scheduled_start", "is", null)
    .in("status", ["estimate", "scheduled", "in_progress", "on_hold"]);
  if (!jobs?.length) return { ok: true, synced: 0 };

  let synced = 0;
  for (const j of jobs as any[]) {
    try {
      const eventId = await gcalUpsertJobEvent(auth.token, auth.calendarId, j);
      if (eventId !== j.google_event_id) {
        await supabase.from("jobs").update({ google_event_id: eventId }).eq("id", j.id);
      }
      synced++;
    } catch {
      /* keep going — report what synced */
    }
  }
  revalidatePath("/settings");
  return { ok: true, synced };
}

export async function disconnectGoogleCalendar(): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("calendar_connections").delete().eq("provider", "google");
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

/** Set (or clear) the signed-in user's avatar. */
export async function setAvatarUrl(url: string | null): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { error } = await supabase.from("profiles").update({ avatar_url: url }).eq("id", user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Owner/admin edits a team member's profile (name, role, active, rate). */
export async function updateMember(
  id: string,
  patch: { full_name?: string; phone?: string; role?: string; active?: boolean; hourly_rate?: number | null; home_address?: string | null },
): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!me || !["owner", "admin"].includes(me.role)) return { ok: false, error: "Not allowed." };
  if (id === user.id && patch.role && patch.role !== "owner") {
    return { ok: false, error: "You can't change your own owner role." };
  }

  const clean: Record<string, unknown> = {};
  if (patch.full_name !== undefined) clean.full_name = patch.full_name.trim() || null;
  if (patch.phone !== undefined) clean.phone = patch.phone.trim() || null;
  if (patch.role !== undefined && ["admin", "office", "tech"].includes(patch.role)) clean.role = patch.role;
  if (patch.active !== undefined) clean.active = patch.active;
  if (patch.hourly_rate !== undefined) clean.hourly_rate = patch.hourly_rate;
  if (patch.home_address !== undefined) clean.home_address = patch.home_address?.trim() || null;
  if (!Object.keys(clean).length) return { ok: true };

  const { error } = await supabase.from("profiles").update(clean).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

/** Owner/admin resets a member's login email and/or password (needs the
 *  service-role key). The owner hands the new password to the employee. */
export async function updateMemberAuth(
  id: string,
  patch: { email?: string; password?: string },
): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase.from("profiles").select("role, org_id").eq("id", user.id).maybeSingle();
  if (!me || !["owner", "admin"].includes(me.role)) return { ok: false, error: "Not allowed." };

  // The target must be in the same org.
  const { data: target } = await supabase.from("profiles").select("org_id").eq("id", id).maybeSingle();
  if (!target || target.org_id !== me.org_id) return { ok: false, error: "Member not found." };

  const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
  if (!adminConfigured()) {
    return { ok: false, error: "Changing logins needs SUPABASE_SERVICE_ROLE_KEY on the server. Add it in Vercel, then redeploy." };
  }
  const attrs: Record<string, unknown> = {};
  if (patch.email?.trim()) attrs.email = patch.email.trim().toLowerCase();
  if (patch.password) {
    if (patch.password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
    attrs.password = patch.password;
  }
  if (!Object.keys(attrs).length) return { ok: true };

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(id, attrs);
  if (error) return { ok: false, error: error.message };
  if (attrs.email) await admin.from("profiles").update({ email: attrs.email }).eq("id", id);
  revalidatePath("/settings");
  return { ok: true };
}

/** Owner/admin sets a team member's billable hourly rate. */
export async function updateMemberRate(
  id: string,
  hourlyRate: number | null,
  billRate?: number | null,
): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!me || !["owner", "admin"].includes(me.role)) return { ok: false, error: "Not allowed." };

  const patch: Record<string, unknown> = { hourly_rate: hourlyRate };
  if (billRate !== undefined) patch.bill_rate = billRate;
  const { error } = await supabase.from("profiles").update(patch).eq("id", id);
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

export async function createPricingLevel(input: {
  name: string;
  markup_pct: number;
  is_default?: boolean;
}): Promise<Result> {
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  if (input.is_default) {
    await supabase.from("pricing_levels").update({ is_default: false }).eq("org_id", orgId);
  }
  const { error } = await supabase.from("pricing_levels").insert({
    name: input.name.trim(),
    markup_pct: Number.isFinite(input.markup_pct) ? input.markup_pct : 0,
    is_default: !!input.is_default,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export async function setDefaultPricingLevel(id: string): Promise<Result> {
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };
  await supabase.from("pricing_levels").update({ is_default: false }).eq("org_id", orgId);
  const { error } = await supabase.from("pricing_levels").update({ is_default: true }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export async function deletePricingLevel(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("pricing_levels").delete().eq("id", id);
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
