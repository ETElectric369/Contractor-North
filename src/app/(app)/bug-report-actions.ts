"use server";

import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";

export type BugReport = {
  id: string;
  note: string;
  page: string | null;
  status: string;
  created_at: string;
  reporter: string | null;
  screenshot_path: string | null;
};

/** File a bug report (any org member). Tagged with the page, captured console errors,
 *  browser/viewport, and the reporter via the set_org_id trigger + RLS. */
export async function createBugReport(input: {
  page: string;
  note: string;
  console: { level: string; msg: string; at: number }[];
  userAgent: string;
  viewport: string;
  screenshotPath?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const note = (input.note || "").trim();
  if (!note) return { ok: false, error: "Tell me what happened." };

  const { error } = await supabase.from("bug_reports").insert({
    reported_by: user.id,
    page: (input.page || "").slice(0, 300) || null,
    note: note.slice(0, 4000),
    console: (input.console || []).slice(0, 20),
    user_agent: (input.userAgent || "").slice(0, 300) || null,
    viewport: (input.viewport || "").slice(0, 50) || null,
    screenshot_path: input.screenshotPath || null,
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

export async function setBugReportStatus(id: string, status: string): Promise<{ ok: boolean; error?: string }> {
  // Defense-in-depth: app-layer staff gate ON TOP of the RLS staff policy (the same belt-and-
  // suspenders pattern as the billing actions — RLS alone is the single-layer class we've
  // already had to retro-fix once).
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  await ctx.supabase.from("bug_reports").update({ status }).eq("id", id);
  return { ok: true };
}
