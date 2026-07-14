"use server";

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
 * finds the caller's just-created inquiry (or creates one so the tap is never
 * orphaned), stamps it as a site-inspection REQUEST (site_inspection_required —
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
 * re-requested — the customer gets "you're on the schedule" instead of the
 * office being asked to offer times over a real booking.
 */
import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
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
}

export interface PublicScheduleResult {
  ok: boolean;
  error?: string;
  /** An office-made inspection already exists — "you're on the schedule". */
  already?: boolean;
}

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
  const settings = getOrgSettings(org.settings);
  const tz = settings.timezone;

  // Find the inquiry this request belongs to: the most recent lead from the
  // SAME contact in the last 24h (both surfaces create one just before this
  // runs). Matched in JS on normalized phone digits / lowercased email — no
  // string-built .or() filters with user input.
  const digits = (s: string | null) => (s ?? "").replace(/\D/g, "");
  const wantPhone = digits(phone);
  const wantEmail = (email ?? "").toLowerCase();
  const { data: recent } = await supabase
    .from("inquiries")
    .select("id, name, phone, email, address, message")
    .eq("org_id", orgId)
    .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(25);
  let inquiry = ((recent ?? []) as any[]).find(
    (i) =>
      (wantPhone && digits(i.phone) && digits(i.phone) === wantPhone) ||
      (wantEmail && (i.email ?? "").toLowerCase() === wantEmail),
  ) as { id: string; name: string; address: string | null; message: string | null } | undefined;

  // No match (request tap without a submitted form) → land a lead so the tap
  // is never orphaned. Plain insert, same clamps as submit_inquiry.
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
      .select("id, name, address, message")
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
  if ((existing ?? []).some((a: any) => a.created_by)) {
    return { ok: true, already: true };
  }

  // Stamp the request — lights the 🚩 Site visit badge on the leads row — and
  // resurface the lead today so it can't sit unnoticed.
  await supabase
    .from("inquiries")
    .update({
      site_inspection_required: true,
      next_follow_up_at: todayStrInTz(tz),
      updated_at: new Date().toISOString(),
    })
    .eq("id", inquiry.id);

  // Tell the office — bell (always works) + push (if the recipient enabled it),
  // the same dual channel as quote-accept.
  const staff = await orgStaffIds(orgId);
  const payload = {
    title: `${inquiry.name || name} wants a site inspection — send them times`,
    body:
      [phone ?? email, inquiry.address ?? address].filter(Boolean).join(" · ") ||
      "Open the lead to send time options.",
    url: "/leads",
  };
  await createNotifications(orgId, staff, { type: "inquiry", ...payload });
  await sendPushToProfiles(staff, "inquiry", payload);

  revalidatePath("/leads");
  revalidatePath("/planner");
  return { ok: true };
}
