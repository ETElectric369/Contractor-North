"use server";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";

/**
 * THE LEAD FORM'S SOURCE LIST, READ WHEN THE FORM IS OPENED (cn-v1170). The form has three doors (the
 * Leads header, a lead's Edit Details, the estimate's lead card), so it reads the company's list itself,
 * once per opening and never per row, through getOrgSettings (cleaned, the default when empty). A read
 * that fails says so; the form then still offers the lead's own current source and a blank.
 */
export async function readLeadSources(): Promise<{ ok: true; sources: string[] } | { ok: false }> {
  const ctx = await requireStaff();
  if ("error" in ctx || !ctx.orgId) return { ok: false };
  const { data, error } = await ctx.supabase.from("organizations").select("settings").eq("id", ctx.orgId).maybeSingle();
  if (error || !data) return { ok: false };
  return { ok: true, sources: getOrgSettings((data as { settings?: unknown }).settings).lead_sources };
}
