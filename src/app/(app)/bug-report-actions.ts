"use server";
import { dbError } from "@/lib/db-error";

import { createClient, createServiceClient } from "@/lib/supabase/server";
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
  /** WHICH TENANT filed it. Null for everyone except a platform admin running the beta —
   *  and it is the whole point of the cross-tenant view: "both of them hit this" is a
   *  product bug, "only he hits this" may just be his workflow. You cannot tell those
   *  apart without the name. */
  org: string | null;
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
  if (error) return { ok: false, error: dbError(error) };
  return { ok: true };
}

/** The org's recent reports. Staff-gated in the app layer (belt) on top of the RLS staff
 *  read policy (suspenders) — this action also does a narrow service-role name lookup, so
 *  the gate must hold even if the RLS policy ever loosens. */
export async function listBugReports(): Promise<BugReport[]> {
  const ctx = await requireStaff();
  if ("error" in ctx) return [];
  const supabase = ctx.supabase;
  const { data } = await supabase
    .from("bug_reports")
    .select("id, note, page, status, created_at, screenshot_path, reported_by, org_id, profiles:reported_by(full_name)")
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (data ?? []) as any[];

  // Collaborator reporters: their profile (org_id NULL) is INVISIBLE under profiles RLS —
  // deliberately. Migration 0135 briefly opened the whole profile row (pay fields included)
  // to client-org staff just to label these reports; 0138 dropped that policy. Resolve the
  // display name here instead: verify each nameless reporter holds a site grant for THIS
  // org (site_collaborators read runs under the caller's RLS, which only shows the org's
  // own grants), then fetch full_name ONLY via the service client. Nothing else of the
  // profile ever reaches the caller.
  const nameless = [...new Set(rows.filter((r) => !r.profiles?.full_name && r.reported_by).map((r) => r.reported_by as string))];
  const collabNames = new Map<string, string>();
  if (nameless.length && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { data: grants } = await supabase
      .from("site_collaborators")
      .select("user_id")
      .in("user_id", nameless);
    const grantedIds = [...new Set((grants ?? []).map((g: any) => g.user_id as string))];
    if (grantedIds.length) {
      const svc = createServiceClient();
      const { data: names } = await svc
        .from("profiles")
        .select("id, full_name")
        .in("id", grantedIds)
        .is("org_id", null); // collaborators only — never a member of some other org
      for (const n of (names ?? []) as { id: string; full_name: string | null }[]) {
        if (n.full_name) collabNames.set(n.id, n.full_name);
      }
    }
  }

  // Tenant labels, for a platform admin only. platform_org_label (0176) returns the NAME and
  // nothing else, and returns null to everyone else — so an ordinary owner calling this gets
  // no signal about who else exists. One round trip for the distinct orgs on the page.
  const orgIds = [...new Set(rows.map((r) => r.org_id).filter(Boolean))] as string[];
  const orgNames = new Map<string, string>();
  if (orgIds.length > 1) {
    for (const id of orgIds) {
      const { data: label } = await supabase.rpc("platform_org_label", { p_org: id });
      if (label) orgNames.set(id, label as string);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    note: r.note,
    page: r.page,
    status: r.status,
    created_at: r.created_at,
    reporter: r.profiles?.full_name ?? collabNames.get(r.reported_by) ?? null,
    screenshot_path: r.screenshot_path ?? null,
    org: orgNames.get(r.org_id) ?? null,
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
