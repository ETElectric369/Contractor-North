"use server";

/**
 * PUBLIC "schedule your site visit" — the app's FIRST unauthenticated schedule
 * write, so it mirrors submitEstimateLead's rigor end to end:
 *   • honeypot: bots get a silent fake success (no token → the client just no-ops)
 *   • every field clamped server-side; name + (phone or email) required
 *   • the ORG is resolved server-side from a public identifier only — the
 *     configurator passes its handle (settings->>public_handle), the inquiry
 *     splash its org uuid (the same identifier submit_inquiry already trusts);
 *     nothing else from the client is believed
 *   • service client writes carry org_id EXPLICITLY (no auth context for the
 *     set_org_id triggers — an unstamped proposal row renders a dead link)
 *
 * What it does: finds the caller's just-created inquiry (or creates one), then
 * offers 3 auto slots (next 3 weekdays, 9 AM org-local) as a 'proposed'
 * inspection appointment + schedule_proposals row, and hands back the /pick
 * token so the customer chooses their own time on the spot.
 *
 * Guard rails around the existing machinery:
 *   • createTriagedInquiry auto-books a big lead's inspection with created_by
 *     NULL — that tentative hold is REUSED (flipped to 'proposed') instead of
 *     double-booking the calendar.
 *   • an inspection a HUMAN already scheduled (created_by set) is never touched:
 *     the customer gets "you're on the schedule" instead of a picker that would
 *     silently move a real booking.
 *
 * Follow-up (deliberately not built here): a Calendly webhook to pull external
 * bookings back into the Schedule — orgs with calendly_url set never reach this
 * action; their button opens Calendly directly.
 */
import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz, tzDateTimeUtc } from "@/lib/tz";
import { createProposalCore, type ProposalSlot } from "@/lib/appointments/proposal";

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
  /** The /pick/<token> link to send the customer to. */
  token?: string;
  /** An office-made inspection already exists — don't offer a picker over it. */
  already?: boolean;
}

const clampStr = (v: unknown, max: number): string | null => {
  const s = String(v ?? "").trim().slice(0, max);
  return s || null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Next `n` weekdays after today (org-local), as YYYY-MM-DD. */
function nextWeekdays(tz: string, n: number): string[] {
  const out: string[] = [];
  let t = new Date(`${todayStrInTz(tz)}T12:00:00Z`).getTime();
  while (out.length < n) {
    t += 86_400_000;
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export async function publicScheduleInspection(
  input: PublicScheduleInput,
): Promise<PublicScheduleResult> {
  // Bot trap — pretend success, write nothing (no token → the client no-ops).
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

  // Find the inquiry this schedule tap belongs to: the most recent lead from
  // the SAME contact in the last 24h (both surfaces create one just before this
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

  // No match (schedule tap without a submitted form) → land a lead so the tap
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

  // 3 auto slots: next 3 weekdays, 9 AM org-local.
  const slots: ProposalSlot[] = nextWeekdays(tz, 3).map((date) => ({ date, time: "09:00" }));
  const startsAtIso = tzDateTimeUtc(slots[0].date, slots[0].time, tz);

  // Existing inspections for this lead decide the path (see header):
  //   human-scheduled → hands off; auto-booked hold → reuse; proposed → the
  //   core's dedup withdraws it before creating the fresh link.
  const { data: existing } = await supabase
    .from("appointments")
    .select("id, status, created_by")
    .eq("org_id", orgId)
    .eq("inquiry_id", inquiry.id)
    .eq("type", "inspection")
    .in("status", ["scheduled", "proposed"]);
  const scheduled = (existing ?? []).filter((a: any) => a.status === "scheduled");
  if (scheduled.some((a: any) => a.created_by)) {
    return { ok: true, already: true };
  }
  const hold = scheduled.find((a: any) => !a.created_by) as { id: string } | undefined;

  let token: string | null = null;
  if (hold) {
    // Reuse the auto-booked tentative hold: flip it to 'proposed' on the first
    // offered slot and hang the pick link off it (no second calendar entry).
    const { error: uErr } = await supabase
      .from("appointments")
      .update({ status: "proposed", starts_at: startsAtIso, updated_at: new Date().toISOString() })
      .eq("id", hold.id);
    if (uErr) return { ok: false, error: "Couldn't set that up — please call us instead." };
    // Withdraw any pending link on other proposed appointments for this lead.
    const proposedIds = (existing ?? []).filter((a: any) => a.status === "proposed").map((a: any) => a.id);
    if (proposedIds.length) {
      await supabase.from("schedule_proposals").update({ status: "cancelled" }).in("appointment_id", proposedIds).eq("status", "pending");
      await supabase.from("appointments").update({ status: "cancelled", updated_at: new Date().toISOString() }).in("id", proposedIds);
    }
    const { data: prop, error: pErr } = await supabase
      .from("schedule_proposals")
      .insert({ org_id: orgId, appointment_id: hold.id, dates: slots, created_by: null })
      .select("token")
      .single();
    if (pErr || !prop) return { ok: false, error: "Couldn't set that up — please call us instead." };
    token = prop.token as string;
  } else {
    const res = await createProposalCore(supabase, {
      type: "inspection",
      title: `Site inspection: ${inquiry.name || name}`,
      slots,
      inquiryId: inquiry.id,
      customerId: null, // deferred-customer doctrine — no contact row before the win
      location: inquiry.address ?? address,
      notes: inquiry.message ?? message,
      createdBy: null,
      orgId,
      startsAtIso,
    });
    if (!res.ok) return { ok: false, error: "Couldn't set that up — please call us instead." };
    token = res.token;
  }

  // Resurface the lead around the offered dates.
  await supabase
    .from("inquiries")
    .update({ next_follow_up_at: slots[0].date, updated_at: new Date().toISOString() })
    .eq("id", inquiry.id);

  revalidatePath("/schedule");
  revalidatePath("/planner");
  revalidatePath("/leads");
  return { ok: true, token: token ?? undefined };
}
