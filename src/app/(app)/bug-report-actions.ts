"use server";

import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { resolveSiteContext } from "@/lib/site-editor-guard";

export type BugReport = {
  id: string;
  note: string;
  page: string | null;
  status: string;
  created_at: string;
  reporter: string | null;
  screenshot_path: string | null;
};

/** File a bug report (any org member, or an external site collaborator from /content).
 *  Tagged with the page, captured console errors, browser/viewport, and the reporter.
 *  Org members: org_id comes from the set_org_id trigger + RLS, exactly as before.
 *  Collaborators pass `orgId` (their profile has org_id NULL, so the trigger can't stamp):
 *  verified here via the same resolution /content's actions use, and re-checked by the
 *  extended bug_reports_insert policy (migration 0135) — RLS stays the real boundary. */
export async function createBugReport(input: {
  page: string;
  note: string;
  console: { level: string; msg: string; at: number }[];
  userAgent: string;
  viewport: string;
  screenshotPath?: string;
  orgId?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const note = (input.note || "").trim();
  if (!note) return { ok: false, error: "Tell me what happened." };

  let collabOrgId: string | null = null;
  if (input.orgId) {
    const ctx = await resolveSiteContext(input.orgId);
    if ("error" in ctx) return { ok: false, error: ctx.error };
    collabOrgId = ctx.orgId;
  }

  const { error } = await supabase.from("bug_reports").insert({
    // Explicit org only on the /content path; otherwise the trigger stamps it as before.
    ...(collabOrgId ? { org_id: collabOrgId } : {}),
    reported_by: user.id,
    page: (input.page || "").slice(0, 300) || null,
    note: note.slice(0, 4000),
    console: (input.console || []).slice(0, 20),
    user_agent: (input.userAgent || "").slice(0, 300) || null,
    viewport: (input.viewport || "").slice(0, 50) || null,
    // The documents bucket denies collaborators (storage RLS keys on auth_org_id), so the
    // /content path never carries a screenshot — drop any client-sent path there.
    screenshot_path: collabOrgId ? null : input.screenshotPath || null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** The org's recent reports (staff only via RLS). */
export async function listBugReports(): Promise<BugReport[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("bug_reports")
    .select("id, note, page, status, created_at, screenshot_path, profiles:reported_by(full_name)")
    .order("created_at", { ascending: false })
    .limit(30);
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    note: r.note,
    page: r.page,
    status: r.status,
    created_at: r.created_at,
    reporter: r.profiles?.full_name ?? null,
    screenshot_path: r.screenshot_path ?? null,
  }));
}

const BUG_STATUSES = new Set(["open", "fixed", "wontfix"]);

export async function setBugReportStatus(id: string, status: string): Promise<{ ok: boolean; error?: string }> {
  // Defense-in-depth: app-layer staff gate ON TOP of the RLS staff policy (the same belt-and-
  // suspenders pattern as the billing actions — RLS alone is the single-layer class we've
  // already had to retro-fix once).
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  // The status column is unconstrained text; whitelist here so a stray value can't write a
  // status the /bugs tabs don't know how to surface.
  if (!BUG_STATUSES.has(status)) return { ok: false, error: "Unknown status." };
  await ctx.supabase.from("bug_reports").update({ status }).eq("id", id);
  return { ok: true };
}
