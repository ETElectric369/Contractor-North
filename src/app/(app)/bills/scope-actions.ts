"use server";

import { requireStaff } from "@/lib/staff-guard";
import { listJobScopes } from "@/lib/analytics/job-profitability";
import { jobInOrg } from "@/lib/job-in-org";
import { reportError } from "@/lib/observe";
import { scopeOptions } from "@/lib/bill-scope";

/**
 * THE PARTS OF A JOB A COST CAN BE PUT UNDER — the one read behind the one scope control (item C1).
 *
 * Every door that writes or edits a cost shows the SAME question, and the words it offers come from
 * here: the job's estimate scopes (quote_line_items.category, summed across the original and every
 * change order), minus the reserved buckets. Empty means the estimate isn't broken into parts, and
 * then no door is drawn at all — there is nothing to ask.
 *
 * STAFF ONLY. These words come off the estimate, which is the office's; a tech never sees prices and
 * never sees this control (TECHS NEVER SEE PRICES).
 *
 * A read that FAILS says so (`{ unread: true }`) rather than answering "no parts": a control that
 * quietly disappears would file every cost under nothing and never say why.
 */
export async function jobScopeOptions(jobId: string): Promise<{ scopes: string[]; unread?: true; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { scopes: [], unread: true, error: ctx.error };
  if (!jobId) return { scopes: [] };
  // THE JOB IS OURS, asked before its estimate is read: the id arrives from a browser, and RLS
  // scopes the quote reads, but a rule at one read path is a convention and not a boundary.
  if (!(await jobInOrg(ctx.supabase, ctx.orgId, jobId))) return { scopes: [] };
  try {
    return { scopes: scopeOptions(await listJobScopes(ctx.supabase, jobId)) };
  } catch (e) {
    reportError("bills.jobScopeOptions", e, { jobId });
    return { scopes: [], unread: true, error: "Couldn't read this job's estimate, so the parts of the job aren't listed." };
  }
}
