"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";

/**
 * Fire-and-forget: ping office staff that a new public inquiry just landed.
 * Called by the public inquiry form AFTER submit_inquiry succeeds. The form is
 * anonymous, so this reads the real just-created row with the service client
 * (content can't be spoofed by the caller) and only fires for an inquiry created
 * in the last 2 minutes — bounding any replay of this hook to a real submission.
 */
export async function notifyNewInquiry(orgId: string): Promise<void> {
  try {
    if (!orgId) return;
    const sb = createServiceClient();
    const { data: inq } = await sb
      .from("inquiries")
      .select("id, name, message, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!inq?.created_at) return;
    if (Date.now() - new Date(inq.created_at).getTime() > 120_000) return;

    const who = (inq.name || "Someone").trim();
    const snippet = (inq.message || "").trim().slice(0, 80);
    await sendPushToProfiles(await orgStaffIds(orgId), "inquiry", {
      title: "New inquiry",
      body: snippet ? `${who}: ${snippet}` : `${who} sent a new request`,
      url: "/leads",
    });
  } catch {
    /* best-effort — never surface to the public form */
  }
}
