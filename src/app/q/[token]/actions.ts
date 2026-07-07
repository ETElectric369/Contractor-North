"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { createNotifications } from "@/lib/notifications";

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
