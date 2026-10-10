"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { createNotifications } from "@/lib/notifications";
import { revalidatePath } from "next/cache";
import { reportError } from "@/lib/observe";
import { bornWithTasks } from "@/lib/estimate/born-with-tasks";
import { workOrderFromQuote } from "@/lib/estimate/work-order-from-quote";
import { takeOffFromQuote } from "@/lib/estimate/take-off-from-quote";

/**
 * Fire-and-forget: ping office staff that a customer accepted a quote. Called by
 * the public accept button AFTER accept_public_quote succeeds. Reads the real
 * quote by its unguessable share token and only fires when it is actually
 * accepted — so the hook can't be used to send arbitrary notifications.
 */
export async function notifyQuoteAccepted(token: string): Promise<void> {
  try {
    if (!token) return;
    const sb = createServiceClient();
    const { data: q } = await sb
      .from("quotes")
      .select("id, quote_number, status, org_id, accepted_at, job_id, customers(name)")
      .eq("public_token", token)
      .maybeSingle();
    if (!q || q.status !== "accepted" || !q.org_id) return;
    // Only push within 2 min of the actual acceptance — bounds replay of this hook
    // to a real, fresh acceptance (matches the inquiry hook's freshness guard).
    if (!q.accepted_at || Date.now() - new Date(q.accepted_at).getTime() > 120_000) return;

    const name = (q as any).customers?.name;
    const who = name ? ` from ${name}` : "";
    const jobId = (q as { job_id?: string }).job_id;
    const staff = await orgStaffIds(q.org_id);
    const payload = {
      title: "Estimate accepted",
      body: `${q.quote_number || "An estimate"} was accepted${who} — schedule the job.`,
      // Deep-link straight to the job so "schedule it right there" is one tap.
      url: jobId ? `/jobs/${jobId}` : "/quotes",
    };
    await createNotifications(q.org_id, staff, { type: "quote_accepted", ...payload }); // the bell
    await sendPushToProfiles(staff, "quote_accepted", payload); // + push if enabled
  } catch {
    /* best-effort */
  }
}

/**
 * FINISH WHAT THE CUSTOMER'S ACCEPT STARTED (W3, cn-v1075). accept_public_quote (SQL, 0369) makes
 * the job and nothing else, while the office's accept (createJobFromQuote) also births the job's
 * tasks, its work order and its materials take-off. Two doors, one thing: this runs the same three
 * rules behind the public door, with the service client and the company's own id, so a job is the
 * same job whichever door it came through.
 *
 * SAFE TO CALL BY ANYONE WHO HOLDS THE LINK: it reads the quote by its unguessable token, does
 * nothing unless the quote is accepted and already has its job, and every piece is idempotent by
 * key (tasks by source_key, one work order and one list per quote) — a replay births nothing twice.
 * Best-effort and never silent: a piece that fails is reported to the ops sink; the job stands.
 */
export async function finishPublicAcceptance(token: string): Promise<void> {
  try {
    if (!token) return;
    const sb = createServiceClient();
    const { data: q } = await sb
      .from("quotes")
      .select("id, status, org_id, job_id, created_by")
      .eq("public_token", token)
      .maybeSingle();
    if (!q || q.status !== "accepted" || !q.org_id || !q.job_id) return;
    const who = { orgId: q.org_id as string, userId: (q.created_by as string | null) ?? null };
    const jobId = q.job_id as string;
    const born = await bornWithTasks(sb, { jobId, quoteId: q.id, orgId: who.orgId, createdBy: who.userId });
    if (born.error) reportError("finishPublicAcceptance:tasks", new Error(born.error), { quoteId: q.id, jobId });
    const wo = await workOrderFromQuote(sb, { quoteId: q.id, ...who });
    if (!wo.ok) reportError("finishPublicAcceptance:workOrder", new Error(wo.error ?? "refused"), { quoteId: q.id, jobId });
    const list = await takeOffFromQuote(sb, { quoteId: q.id, ...who });
    if (!list.ok) reportError("finishPublicAcceptance:materials", new Error(list.error ?? "refused"), { quoteId: q.id, jobId });
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/work-orders");
    revalidatePath("/materials");
  } catch (e) {
    reportError("finishPublicAcceptance", e);
  }
}
