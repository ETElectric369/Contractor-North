"use server";

import { headers } from "next/headers";
import { clientIp, rateLimited } from "@/lib/rate-limit";

/**
 * PUBLIC "request a site visit" — the app's FIRST unauthenticated schedule-adjacent
 * write, so it mirrors submitEstimateLead's rigor end to end:
 *   • honeypot: bots get a silent fake success (the client just shows the thank-you)
 *   • every field clamped server-side; name + (phone or email) required
 *   • the ORG is resolved server-side from a public identifier only — the
 *     configurator passes its handle (settings->>public_handle), the inquiry
 *     splash its org uuid (the same identifier submit_inquiry already trusts);
 *     nothing else from the client is believed
 *   • service client writes carry org_id EXPLICITLY (no auth context for the
 *     set_org_id triggers)
 *
 * What it does (Erik's call — no more auto-offering the calendar "just whenever"):
 * finds the lead THIS BROWSER just sent, by the id its own submit returned (or creates
 * one so the tap is never orphaned), stamps it as a site-inspection REQUEST (site_inspection_required —
 * the cn-v377 triage flag the leads row already badges 🚩), resurfaces the lead
 * today, and pings office staff — bell + push — to send the customer time options.
 * The office reply half already exists: the leads convert-menu "Let them pick"
 * proposes 3 real slots and texts the /pick link.
 *
 * Deliberately office-in-the-loop: an availability-window automation (org-set
 * pickable days/hours that could auto-offer slots) is a possible future layer,
 * but for now a human decides which times get offered.
 *
 * Guard rail: an inspection a HUMAN already scheduled (created_by set) is never
 * re-requested — nothing is stamped and the office is not asked to offer times over a
 * real booking. The BROWSER IS NOT TOLD WHICH (cn-v1180, audit A6): it reads one sentence
 * that is true either way, because an answer that differs by whether a booking exists tells
 * a stranger something about somebody else's lead.
 */
import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { requestHref, requestOpensLead } from "@/lib/feature-doors";
import { createNotifications } from "@/lib/notifications";
import { orgStaffIds, sendPushToProfiles } from "@/lib/push";

export interface PublicScheduleInput {
  /** The configurator surface: org resolved by settings->>public_handle. */
  handle?: string;
  /** The inquiry-splash surface: the org uuid already in its public URL. */
  orgId?: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  message?: string;
  /** Honeypot — filled means bot. */
  hp?: string;
  /**
   * The lead THIS BROWSER'S submit just returned (submitPublicInquiry, submitEstimateLead). The
   * only key the tap attaches by: read by id AND company, touched in the last 24 hours. A typed
   * phone or e-mail is never a key here (cn-v1180, audit A6): anyone can type somebody's phone.
   */
  leadId?: string | null;
}

/**
 * ONE ANSWER EITHER WAY (cn-v1180, audit A6): `ok` and nothing about whether the lead was already
 * booked. The browser's sentence is true in both cases.
 */
export interface PublicScheduleResult {
  ok: boolean;
  error?: string;
}

/** How long after its own submit a browser's lead id still attaches a tap. */
const LEAD_ID_WINDOW_MS = 24 * 3600_000;

const clampStr = (v: unknown, max: number): string | null => {
  const s = String(v ?? "").trim().slice(0, max);
  return s || null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function publicScheduleInspection(
  input: PublicScheduleInput,
): Promise<PublicScheduleResult> {
  // Bot trap — pretend success, write nothing.
  if (input?.hp) return { ok: true };

  const name = clampStr(input?.name, 200);
  if (!name) return { ok: false, error: "Please enter your name." };
  const phone = clampStr(input?.phone, 50);
  const email = clampStr(input?.email, 200);
  if (!phone && !email) return { ok: false, error: "Add a phone or email so we can reach you." };
  const address = clampStr(input?.address, 300);
  const message = clampStr(input?.message, 2000);

  // ── THE RATE LIMIT THIS DOOR NEVER HAD ────────────────────────────────────────────────────
  // Every sibling public door limits (site/actions.ts contact form, the estimate lead form) and
  // this one — a service-client write that fans out a notification AND a push to every office
  // phone on each call — did not. Attaching to the browser's own lead suppresses only the extra
  // INSERT, never the notify.
  // Anyone with a tenant's public handle or org uuid (both are URL path segments) could have run
  // every office phone flat.
  const ip = clientIp(await headers());
  if (await rateLimited(`inspect:${ip}`, 5, 60))
    return { ok: false, error: "Too many requests — please try again in a moment." };

  const supabase = createServiceClient();

  // Server-side org resolution — by handle (configurator) or by uuid (inquiry splash).
  type OrgRow = { id: string; settings?: unknown };
  let org: OrgRow | null = null;
  if (input?.handle) {
    const { data } = await supabase
      .from("organizations")
      .select("id, settings")
      .eq("settings->>public_handle", String(input.handle).slice(0, 100))
      .limit(1)
      .maybeSingle();
    org = (data as OrgRow | null) ?? null;
  } else if (input?.orgId && UUID_RE.test(String(input.orgId))) {
    const { data } = await supabase
      .from("organizations")
      .select("id, settings")
      .eq("id", input.orgId)
      .maybeSingle();
    org = (data as OrgRow | null) ?? null;
  }
  if (!org) return { ok: false, error: "Scheduling isn't available right now — please call us." };
  const orgId = org.id;
  // The per-IP key alone fails open against rotating addresses; the estimate door carries a daily
  // per-org ceiling for that reason and so does this one. A real contractor never sees it — fifty
  // site-visit requests in a day for one company is not a good week, it is somebody hammering.
  if (await rateLimited(`inspect-org:${orgId}`, 50, 86400))
    return { ok: false, error: "Too many requests — please try again later." };
  const settings = getOrgSettings(org.settings);

  // THE LEAD THIS BROWSER JUST SENT (cn-v1180, audit A6). The tap used to attach to the newest lead
  // whose phone or e-mail equalled what was TYPED, so a stranger with somebody's phone filed a
  // request under that person, pinged the office with their name and street, and was told whether
  // they were booked. Now the only key is the id the same browser's submit returned, read by id AND
  // company (the service client has no RLS), touched in the last 24 hours. Nothing typed is a key.
  // The lead's OWN contact rides with it (skeptic #83, S2): the office's ping is built from the lead's
  // row, never from what was typed, so an id held by somebody else cannot tell the office to send
  // that person's times to the stranger who typed. On a new lead its own contact IS what was typed.
  type Lead = { id: string; name: string; address: string | null; message: string | null; phone: string | null; email: string | null };
  let inquiry: Lead | undefined;
  const leadId = String(input?.leadId ?? "");
  if (UUID_RE.test(leadId)) {
    const { data: mine } = await supabase
      .from("inquiries")
      .select("id, name, address, message, phone, email, created_at, updated_at")
      .eq("org_id", orgId)
      .eq("id", leadId)
      .maybeSingle();
    const row = mine as (Lead & { created_at: string | null; updated_at: string | null }) | null;
    const touched = Math.max(Date.parse(row?.created_at ?? "") || 0, Date.parse(row?.updated_at ?? "") || 0);
    if (row && Date.now() - touched <= LEAD_ID_WINDOW_MS)
      inquiry = { id: row.id, name: row.name, address: row.address, message: row.message, phone: row.phone, email: row.email };
  }

  // No id, or no such lead of this company in the window (request tap without a submitted form, or
  // an id that is not this browser's) → land a lead so the tap is never orphaned. Plain insert,
  // same clamps as submit_inquiry.
  if (!inquiry) {
    const { data: created, error: cErr } = await supabase
      .from("inquiries")
      .insert({
        org_id: orgId, // explicit — service client has no auth context for set_org_id
        name,
        phone,
        email,
        address,
        city: clampStr(input?.city, 100),
        state: clampStr(input?.state, 50),
        zip: clampStr(input?.zip, 20),
        message,
        source: "schedule_button",
        status: "new",
        type: "residential",
      })
      .select("id, name, address, message, phone, email")
      .single();
    if (cErr || !created) return { ok: false, error: "Couldn't submit — please call us instead." };
    inquiry = created as typeof inquiry;
  }
  if (!inquiry) return { ok: false, error: "Couldn't submit — please call us instead." };

  // An inspection a human already put on the calendar wins — don't ask the
  // office to send times over a real booking.
  const { data: existing } = await supabase
    .from("appointments")
    .select("id, created_by")
    .eq("org_id", orgId)
    .eq("inquiry_id", inquiry.id)
    .eq("type", "inspection")
    .eq("status", "scheduled");
  // The same answer as the stamped path below, byte for byte: the browser is not told which.
  if ((existing ?? []).some((a: any) => a.created_by)) {
    return { ok: true };
  }

  // Stamp the request. No follow-up day (gone everywhere, cn-v1170): an open lead with no standing
  // visit is on the Leads list already, which is what keeps it from sitting unnoticed.
  await supabase
    .from("inquiries")
    .update({
      site_inspection_required: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", inquiry.id)
    .eq("org_id", orgId) // the company by hand on the write too
    .select("id");

  // Tell the office — bell (always works) + push (if the recipient enabled it),
  // the same dual channel as quote-accept.
  const staff = await orgStaffIds(orgId);
  // Leads switched off (0352, rule d): My Day, where the request waits with Call Back, and the
  // words name where it opens.
  // Leads on: the lead's own file (cn-v1180, audit A2), not a list it may not be on.
  const url = requestHref(settings.features, inquiry.id);
  const payload = {
    title: `${inquiry.name || name} wants an inspection — send them times`,
    body:
      [inquiry.phone ?? inquiry.email, inquiry.address].filter(Boolean).join(" · ") ||
      (requestOpensLead(url) ? "Open the lead to send time options." : "Open My Day to send time options."),
    url,
  };
  await createNotifications(orgId, staff, { type: "inquiry", ...payload });
  await sendPushToProfiles(staff, "inquiry", payload);

  revalidatePath("/leads");
  revalidatePath("/planner");
  return { ok: true };
}
