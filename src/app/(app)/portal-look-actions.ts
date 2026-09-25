"use server";

import { requireStaff } from "@/lib/staff-guard";
import { dbError } from "@/lib/db-error";
import { getOrgSettings, orgPublicBaseUrl } from "@/lib/org-settings";
import { hashSecret, newSessionSecret } from "@/lib/portal/code";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SEE WHAT THEY SEE, WITHOUT THEIR CODE (0331). The customer's page now asks each new device for a
 * code emailed to the customer, and the office must never need it (nor send the customer an email
 * by looking). So the office's look goes through a one-use ticket: this action (office staff of the
 * customer's own org; portal_preview_ticket checks again) draws a ticket, stores only its sha256
 * with a 2-minute life, and hands back the URL on the business's own host. /portal/<token>/enter
 * spends the ticket for an 8-hour office session on that one link. The office's looks never count
 * as the customer opening it and are never counted as a signed-in device.
 */
export async function portalOfficeLookUrl(
  customerId: string,
  jobId?: string | null,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  if (!UUID.test(String(customerId ?? ""))) return { ok: false, error: "That customer isn't in your book." };
  if (jobId && !UUID.test(jobId)) return { ok: false, error: "That job isn't in your book." };

  const ticket = newSessionSecret();
  const [{ data: token, error }, { data: org }] = await Promise.all([
    ctx.supabase.rpc("portal_preview_ticket", { p_customer_id: customerId, p_ticket_hash: hashSecret(ticket) }),
    ctx.supabase.from("organizations").select("settings").eq("id", ctx.orgId ?? "").maybeSingle(),
  ]);
  if (error) return { ok: false, error: dbError(error) };
  if (typeof token !== "string" || !token) return { ok: false, error: "Their page couldn't be opened. Refresh and try again." };
  const base = orgPublicBaseUrl(getOrgSettings((org as { settings?: unknown } | null)?.settings));
  const qs = new URLSearchParams({ t: ticket, ...(jobId ? { job: jobId } : {}) });
  return { ok: true, url: `${base}/portal/${token}/enter?${qs.toString()}` };
}
