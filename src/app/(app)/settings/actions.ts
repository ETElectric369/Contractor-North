"use server";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { formatPhone, formatState, formatZip, titleCase } from "@/lib/utils";
import { reportError } from "@/lib/observe";

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
    weather_source: formData.get("weather_source") === "business" ? "business" : "device",
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
  revalidatePath("/team");
  revalidatePath("/settings");
  return { ok: true };
}

export async function deleteInvitation(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("invitations").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/team");
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
  requireReset?: boolean;
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
      must_reset_password: input.requireReset ?? true,
    })
    .eq("id", created.user.id);
  if (profErr) return { ok: false, error: profErr.message };

  revalidatePath("/team");
  revalidatePath("/settings");
  return { ok: true };
}

export type CrewImportRow = { full_name: string; email: string; phone?: string; role?: string; hourly_rate?: number | null };
export type CrewImportResult = { name: string; email: string; password?: string; status: "created" | "failed"; reason?: string };

/** Bulk-create employees from a roster (the migration importer). Each password is the
 *  employee's PHONE DIGITS (>=8); a no-phone row gets a temp default to reset. Owner/
 *  admin only; needs SUPABASE_SERVICE_ROLE_KEY. Returns the login+password per row so
 *  the office can hand them out. Best-effort per row — one failure doesn't stop the rest. */
export async function importCrew(rows: CrewImportRow[], requireReset = true): Promise<{ ok: boolean; error?: string; results?: CrewImportResult[] }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase.from("profiles").select("role, org_id").eq("id", user.id).maybeSingle();
  if (!me || !["owner", "admin"].includes(me.role)) return { ok: false, error: "Not allowed." };
  if (!me.org_id) return { ok: false, error: "No organization." };
  const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
  if (!adminConfigured()) return { ok: false, error: "Crew import needs SUPABASE_SERVICE_ROLE_KEY set on the server (it is, in production)." };
  const admin = createAdminClient();

  const results: CrewImportResult[] = [];
  for (const r of (rows ?? []).slice(0, 200)) {
    const name = (r.full_name || "").trim();
    const email = (r.email || "").trim().toLowerCase();
    if (!name || !email.includes("@")) {
      results.push({ name: name || email || "(blank)", email, status: "failed", reason: "Missing name or email." });
      continue;
    }
    const digits = (r.phone || "").replace(/\D/g, "");
    // Password = the phone digits (Erik's call — simplest for field crew the office texts).
    // No-phone rows get a RANDOM temp (NOT derived from the email, which was guessable from
    // a public address); it's shown once on the import screen for the office to hand out.
    const password = digits.length >= 8 ? digits : "deck-" + crypto.randomUUID().slice(0, 8);
    const role = ["admin", "office", "tech"].includes(r.role || "") ? (r.role as string) : "tech";
    const { data: created, error: authErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (authErr || !created?.user) {
      results.push({ name, email, status: "failed", reason: /already/i.test(authErr?.message ?? "") ? "Already has a login." : authErr?.message ?? "Could not create login." });
      continue;
    }
    const { error: profErr } = await admin
      .from("profiles")
      .update({ org_id: me.org_id, full_name: name, role, hourly_rate: r.hourly_rate ?? null, active: true, must_reset_password: requireReset })
      .eq("id", created.user.id);
    if (profErr) {
      // Roll back the just-created login so a failed profile attach can't leave an orphaned auth user
      // with no org. If the rollback ITSELF fails, don't swallow it — that's the exact invisible-orphan
      // state the rollback exists to prevent, so surface it for an operator to clean up.
      const rb = await admin.auth.admin.deleteUser(created.user.id).catch((e) => ({ error: e }));
      if ((rb as { error?: unknown })?.error) {
        reportError("crewImport.rollbackDeleteUser", (rb as { error?: unknown }).error, { email, userId: created.user.id });
      }
      results.push({ name, email, status: "failed", reason: profErr.message });
      continue;
    }
    results.push({ name, email, password, status: "created" });
  }
  revalidatePath("/team");
  revalidatePath("/settings");
  return { ok: true, results };
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
    } catch (e) {
      reportError("gcal-sync", e, { jobId: j.id }); // keep going, but don't vanish silently
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
  patch: { full_name?: string; phone?: string; role?: string; active?: boolean; hourly_rate?: number | null; home_address?: string | null; commute_baseline_miles?: number },
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
  if (patch.commute_baseline_miles !== undefined) clean.commute_baseline_miles = Math.max(0, Number(patch.commute_baseline_miles) || 0);
  if (!Object.keys(clean).length) return { ok: true };

  const { error } = await supabase.from("profiles").update(clean).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/team");
  revalidatePath("/settings");
  revalidatePath("/planner"); // role/active/rate feed the planner's assignee pickers
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
  revalidatePath("/team");
  revalidatePath("/settings");
  return { ok: true };
}

/** Deactivate (lock out) or reactivate a team member. `active=false` now actually
 *  bars sign-in — the app layout redirects a signed-in profile with active===false to
 *  the deactivated screen (before it only hid them from assignee pickers). Reversible:
 *  flip active back and they're in again. Owner/admin only; you can't deactivate
 *  yourself (mirrors the updateMember self-guard so the owner can't lock themselves out).
 *  Revalidates /planner too — the assignee pickers there filter on active. */
export async function setMemberActive(id: string, active: boolean): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase.from("profiles").select("role, org_id").eq("id", user.id).maybeSingle();
  if (!me || !["owner", "admin"].includes(me.role)) return { ok: false, error: "Not allowed." };
  if (id === user.id && !active) return { ok: false, error: "You can't deactivate your own account." };

  // Same-org guard (defense-in-depth over RLS) + never deactivate the owner.
  const { data: target } = await supabase.from("profiles").select("org_id, role").eq("id", id).maybeSingle();
  if (!target || target.org_id !== me.org_id) return { ok: false, error: "Member not found." };
  if (target.role === "owner" && !active) return { ok: false, error: "The owner can't be deactivated." };

  const { error } = await supabase.from("profiles").update({ active }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/team");
  revalidatePath("/settings");
  revalidatePath("/planner"); // assignee pickers filter on active
  return { ok: true };
}

/** How much history a member carries — the remove-vs-deactivate signal. A member with
 *  time entries has a payroll/hours footprint (like Ryan/Danny) → DEACTIVATE keeps that
 *  history; a clean, never-used account (zero time entries) may be safely removed.
 *  Owner/admin only. Returns the time-entry count so the /team UI can pick the right verb. */
export async function memberFootprint(id: string): Promise<{ ok: boolean; error?: string; timeEntries?: number }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase.from("profiles").select("role, org_id").eq("id", user.id).maybeSingle();
  if (!me || !["owner", "admin"].includes(me.role)) return { ok: false, error: "Not allowed." };
  const { count, error } = await supabase
    .from("time_entries")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, timeEntries: count ?? 0 };
}

/** Remove a never-used team member — hard-delete the login + profile. ONLY safe for a
 *  clean account with zero footprint (mirrors how the operator removed Ryan/Danny: a
 *  member who ever clocked in is DEACTIVATED to keep history, only a never-used account
 *  is removed). Re-checks the footprint server-side so a stale client can't delete a
 *  member who logged time between load and click. Needs the service-role key to drop the
 *  auth user. Owner/admin only; never yourself/the owner. */
export async function removeMember(id: string): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase.from("profiles").select("role, org_id").eq("id", user.id).maybeSingle();
  if (!me || !["owner", "admin"].includes(me.role)) return { ok: false, error: "Not allowed." };
  if (id === user.id) return { ok: false, error: "You can't remove your own account." };

  const { data: target } = await supabase.from("profiles").select("org_id, role").eq("id", id).maybeSingle();
  if (!target || target.org_id !== me.org_id) return { ok: false, error: "Member not found." };
  if (target.role === "owner") return { ok: false, error: "The owner can't be removed." };

  // Footprint re-check — a member with logged time keeps their history (deactivate, don't delete).
  const { count } = await supabase.from("time_entries").select("id", { count: "exact", head: true }).eq("profile_id", id);
  if ((count ?? 0) > 0) {
    return { ok: false, error: "This person has logged time — deactivate them to keep their history instead of removing them." };
  }

  const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
  if (!adminConfigured()) {
    return { ok: false, error: "Removing an account needs SUPABASE_SERVICE_ROLE_KEY on the server. Deactivate them instead." };
  }
  const admin = createAdminClient();
  // Delete the profile first (org-scoped), then the auth user. If the auth delete fails,
  // the profile is already gone (they can't get back in); surface the error to clean up.
  const { error: profErr } = await admin.from("profiles").delete().eq("id", id).eq("org_id", me.org_id);
  if (profErr) return { ok: false, error: profErr.message };
  const { error: authErr } = await admin.auth.admin.deleteUser(id);
  if (authErr) {
    reportError("removeMember.deleteUser", authErr, { id });
    return { ok: false, error: "Profile removed, but clearing their login failed — contact support to finish." };
  }
  revalidatePath("/team");
  revalidatePath("/settings");
  revalidatePath("/planner");
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
  revalidatePath("/team");
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

/** Read the per-org document counters (current count per doc_type) for the "next #" pre-fill.
 *  Returns null when migration 0088 hasn't been applied yet (the RPC won't exist) — the UI
 *  uses that to show an "activate me" banner instead of a broken control. */
export async function getDocCounters(): Promise<Record<string, number> | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_doc_counters");
  if (error) return null;
  return (data && typeof data === "object" ? data : {}) as Record<string, number>;
}

/** Save per-doc-type number PREFIXES (ride on the settings jsonb, read by next_doc_number)
 *  plus any changed NEXT-NUMBERS (through the staff-gated set_doc_counter RPC). The caller
 *  sends only the next-numbers the owner actually changed, so a prefix-only save never
 *  touches a counter and has no migration dependency at write time. */
export async function saveNumbering(
  prefixes: Record<string, string>,
  nextNumbers: Record<string, number>,
): Promise<Result> {
  const guard = await requireStaff();
  if ("error" in guard) return { ok: false, error: guard.error };
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };

  // Validate + normalize prefixes (1–10 chars, trimmed).
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(prefixes)) {
    const p = String(v ?? "").trim();
    if (!p) return { ok: false, error: "Each prefix needs at least one character." };
    if (p.length > 10) return { ok: false, error: "Prefixes are limited to 10 characters." };
    clean[k] = p;
  }

  // Store prefixes in the org settings jsonb (merged over any existing doc_prefixes).
  const { data: org } = await supabase.from("organizations").select("settings").eq("id", orgId).single();
  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  const mergedPrefixes = { ...((settings.doc_prefixes as Record<string, string>) ?? {}), ...clean };
  const { error: upErr } = await supabase
    .from("organizations")
    .update({ settings: { ...settings, doc_prefixes: mergedPrefixes } })
    .eq("id", orgId);
  if (upErr) return { ok: false, error: upErr.message };

  // Apply any changed next-numbers via the staff-gated, org-scoped RPC.
  for (const [type, next] of Object.entries(nextNumbers)) {
    if (!Number.isFinite(next) || next < 1) continue;
    const { error } = await supabase.rpc("set_doc_counter", { p_type: type, p_next: Math.floor(next) });
    if (error) {
      if (error.code === "PGRST202" || /set_doc_counter/i.test(error.message)) {
        return { ok: false, error: "Prefixes saved. The next-number control needs migration 0088 applied to take effect." };
      }
      return { ok: false, error: error.message };
    }
  }

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

export async function updateTaxRate(
  id: string,
  patch: { name: string; rate: number },
): Promise<Result> {
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };
  if (!patch.name.trim()) return { ok: false, error: "Name is required." };
  const { error } = await supabase
    .from("tax_rates")
    .update({
      name: patch.name.trim(),
      rate: Number.isFinite(patch.rate) ? patch.rate : 0,
    })
    .eq("id", id)
    .eq("org_id", orgId);
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

export async function updatePricingLevel(
  id: string,
  patch: { name: string; markup_pct: number },
): Promise<Result> {
  const supabase = await createClient();
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };
  if (!patch.name.trim()) return { ok: false, error: "Name is required." };
  const { error } = await supabase
    .from("pricing_levels")
    .update({
      name: patch.name.trim(),
      markup_pct: Number.isFinite(patch.markup_pct) ? patch.markup_pct : 0,
    })
    .eq("id", id)
    .eq("org_id", orgId);
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

/** Create or update a job code (the cost/labor codes the timeclock uses).
 *  Staff only — RLS also scopes it to the caller's org. Inserts when no id,
 *  updates when id present. Codes show on /timeclock, so revalidate it too. */
export async function saveJobCode(input: {
  id?: string | null;
  code: string;
  description: string;
  billable?: boolean;
  active?: boolean;
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase } = ctx;
  // job_codes has NO set_org_id trigger (unlike tax_rates/pricing_levels), so the
  // org_id must be set explicitly on insert — otherwise the new code lands org-less
  // and is invisible under RLS. Also scope the update to the org for defense-in-depth.
  const orgId = await myOrgId(supabase);
  if (!orgId) return { ok: false, error: "No organization." };

  const code = (input.code || "").trim();
  const description = (input.description || "").trim();
  if (!code) return { ok: false, error: "Code is required." };
  if (!description) return { ok: false, error: "Description is required." };
  const billable = input.billable ?? true;
  const active = input.active ?? true;

  if (input.id) {
    const { error } = await supabase
      .from("job_codes")
      .update({ code, description, billable, active })
      .eq("id", input.id)
      .eq("org_id", orgId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase
      .from("job_codes")
      .insert({ org_id: orgId, code, description, billable, active });
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath("/settings");
  revalidatePath("/timeclock");
  return { ok: true };
}

/** Flip a job code's active flag (soft enable/disable — inactive codes drop out
 *  of the timeclock picker). Staff only; RLS scopes it to the org. */
export async function setJobCodeActive(id: string, active: boolean): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase.from("job_codes").update({ active }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/timeclock");
  return { ok: true };
}

/** Hard-delete a job code. Staff only; RLS scopes it to the org. */
export async function deleteJobCode(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase.from("job_codes").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/timeclock");
  return { ok: true };
}


function norm(s: string): string | null {
  const t = s.trim();
  return t.length ? t : null;
}
