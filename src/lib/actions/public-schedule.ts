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
 * OPEN TIMES (cn-v1185, the owner's "offer open times"): when the company has turned on its
 * Inspection Days (settings › Crew & Time) the same tap ANSWERS WITH THE OPEN TIMES instead of asking
 * the office, and the visitor taps one (publicPickInspectionTime, below). Never the app booking by
 * itself: the old 9-AM-two-days-out hold stays off (create-triaged-inquiry). With the offer off, no day
 * ticked, nothing open, or the calendar unreadable, this door is exactly what it was: office in the loop.
 *
 * Guard rail: a lead with a live scheduled inspection is never re-requested — nothing is stamped and
 * the office is not asked to offer times over a real booking. Since cn-v1185 ANY live scheduled
 * inspection counts, not only one a person made (created_by set): a time the customer picked has no
 * created_by and is a real booking. The BROWSER IS NOT TOLD WHICH (cn-v1180, audit A6): it reads one
 * sentence that is true either way, because an answer that differs by whether a booking exists tells
 * a stranger something about somebody else's lead.
 */
import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getOrgSettings, type OrgSettings } from "@/lib/org-settings";
import { requestHref, requestOpensLead } from "@/lib/feature-doors";
import { createNotifications } from "@/lib/notifications";
import { orgStaffIds, sendPushToProfiles } from "@/lib/push";
import { reportError } from "@/lib/observe";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import {
  INSPECTION_SLOT_MIN,
  offersOpenTimes,
  openInspectionTimes,
  openTimeLabel,
  openTimesOnDay,
  type OpenTime,
} from "@/lib/schedule/open-times";
import { carryForInquiry } from "@/lib/inquiries/carry-intake-answers";
import { LEAD_VISIT_TYPE, leadInspectionRow } from "@/lib/inquiries/lead-visit-row";
import { withdrawLeadPicks } from "@/lib/leads/withdraw-picks";
import { TERMINAL_LEAD_STATUSES } from "@/lib/inquiries/create-triaged-inquiry";

/** One open time as the browser sees it: the instant to send back, and the words on its button. */
export interface OfferedTime {
  at: string;
  label: string;
}

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
  /** "None of These Work" (cn-v1185): no open times, ask the office to send some. */
  noOffer?: boolean;
}

/**
 * ONE ANSWER EITHER WAY (cn-v1180, audit A6): `ok` and nothing about whether the lead was already
 * booked. The browser's sentence is true in both cases. `times` only when the company offers open
 * times and some are open (cn-v1185); a lead that already has a visit never gets them.
 */
export interface PublicScheduleResult {
  ok: boolean;
  error?: string;
  times?: OfferedTime[];
}

export interface PublicPickInput {
  handle?: string;
  orgId?: string;
  /** The lead THIS BROWSER'S submit returned: the same key, and the same rule, as the request door. */
  leadId?: string | null;
  /** The instant of the time tapped (an OfferedTime's `at`). Checked against the calendar again. */
  at: string;
  hp?: string;
  /**
   * Where to come, typed at the pick (cn-v1185, skeptic #87 S10) by a visitor whose lead has no
   * address (the hosted site's contact form asks none). Used ONLY when the lead's own address is
   * blank: the visit is built with it and the lead's blank is filled. An address the lead already has
   * is never replaced.
   */
  address?: string;
}

/**
 * `booked`: the visit is on the calendar at that label. `taken` + `times`: that time is no longer
 * open, here are the open ones now. `ok` with neither: the generic sentence (SITE_VISIT_REQUESTED),
 * true whether the lead already had a visit or the office was asked to send times.
 */
export interface PublicPickResult {
  ok: boolean;
  error?: string;
  booked?: { label: string };
  taken?: boolean;
  times?: OfferedTime[];
}

/** How long after its own submit a browser's lead id still attaches a tap. */
const LEAD_ID_WINDOW_MS = 24 * 3600_000;

const clampStr = (v: unknown, max: number): string | null => {
  const s = String(v ?? "").trim().slice(0, max);
  return s || null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An ISO instant with its zone: what openTimesOnDay hands out (tzDateTimeUtc). Nothing looser. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The pick door's words. Each refusal says what happened and names one action (call). */
const PICK_OFF = "Online booking isn't available right now. Call us to set a time.";
const PICK_FAILED = "That didn't go through. Call us to set a time.";
const PICK_BAD_TIME = "That time didn't come through. Call us to set a time.";
const PICK_TOO_MANY = "Too many tries. Call us to set a time.";

type Svc = ReturnType<typeof createServiceClient>;
type OrgRow = { id: string; settings?: unknown };

/**
 * THE COMPANY, from a public identifier only — by handle (configurator) or by uuid (inquiry
 * splash). Shared by both doors so they can never resolve it two ways.
 */
async function resolvePublicOrg(supabase: Svc, input: { handle?: string; orgId?: string }): Promise<OrgRow | null> {
  if (input?.handle) {
    const { data } = await supabase
      .from("organizations")
      .select("id, settings")
      .eq("settings->>public_handle", String(input.handle).slice(0, 100))
      .limit(1)
      .maybeSingle();
    return (data as OrgRow | null) ?? null;
  }
  if (input?.orgId && UUID_RE.test(String(input.orgId))) {
    const { data } = await supabase.from("organizations").select("id, settings").eq("id", input.orgId).maybeSingle();
    return (data as OrgRow | null) ?? null;
  }
  return null;
}

type Lead = {
  id: string;
  name: string;
  address: string | null;
  message: string | null;
  phone: string | null;
  email: string | null;
  status: string | null;
};
/** A lead the office ended (won, lost, archived, declined, spam): never booked, never re-opened. */
const ended = (l: { status?: string | null }) => TERMINAL_LEAD_STATUSES.includes(String(l.status ?? ""));
type PickLead = Lead & { notes: string | null; customer_id: string | null; intake: unknown };

/**
 * THE LEAD THIS BROWSER JUST SENT (cn-v1180, audit A6): by the id its own submit returned, read by id
 * AND company (the service client has no RLS), touched in the last 24 hours. Nothing typed is a key.
 * `failed` is a read that failed (never "no such lead" to a caller that must not guess).
 */
async function ownLead<T extends { id: string }>(
  supabase: Svc,
  orgId: string,
  leadIdRaw: unknown,
  cols: string,
): Promise<{ lead: T | null; failed?: boolean }> {
  const leadId = String(leadIdRaw ?? "");
  if (!UUID_RE.test(leadId)) return { lead: null };
  const { data, error } = await supabase
    .from("inquiries")
    .select(`${cols}, created_at, updated_at`)
    .eq("org_id", orgId)
    .eq("id", leadId)
    .maybeSingle();
  if (error) return { lead: null, failed: true };
  const row = data as (T & { created_at?: string | null; updated_at?: string | null }) | null;
  const touched = Math.max(Date.parse(row?.created_at ?? "") || 0, Date.parse(row?.updated_at ?? "") || 0);
  if (!row || Date.now() - touched > LEAD_ID_WINDOW_MS) return { lead: null };
  const { created_at: _c, updated_at: _u, ...lead } = row;
  return { lead: lead as unknown as T };
}

/** Does a live scheduled inspection stand for this lead (any, cn-v1185)? `null` = the read failed. */
async function liveInspection(supabase: Svc, orgId: string, leadId: string): Promise<boolean | null> {
  const { data, error } = await supabase
    .from("appointments")
    .select("id")
    .eq("org_id", orgId)
    .eq("inquiry_id", leadId)
    .eq("type", LEAD_VISIT_TYPE)
    .eq("status", "scheduled");
  if (error) return null;
  return (data ?? []).length > 0;
}

/** Stamp the request: the lead's 🚩, by id AND company, read back. */
async function stampRequest(supabase: Svc, orgId: string, leadId: string) {
  await supabase
    .from("inquiries")
    .update({
      site_inspection_required: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", leadId)
    .eq("org_id", orgId) // the company by hand on the write too
    .select("id");
}

/**
 * Tell the office to send times — bell (always works) + push (if the recipient enabled it), the same
 * dual channel as quote-accept. Built from the lead's OWN row (skeptic #83, S2), never from what was
 * typed; `typedName` only when the lead has no name.
 */
async function pingForTimes(orgId: string, settings: OrgSettings, inquiry: Lead, typedName: string | null) {
  const staff = await orgStaffIds(orgId);
  // Leads switched off (0352, rule d): My Day, where the request waits with Call Back, and the
  // words name where it opens.
  // Leads on: the lead's own file (cn-v1180, audit A2), not a list it may not be on.
  const url = requestHref(settings.features, inquiry.id);
  const payload = {
    title: `${inquiry.name || typedName} wants an inspection — send them times`,
    body:
      [inquiry.phone ?? inquiry.email, inquiry.address].filter(Boolean).join(" · ") ||
      (requestOpensLead(url) ? "Open the lead to send time options." : "Open My Day to send time options."),
    url,
  };
  await createNotifications(orgId, staff, { type: "inquiry", ...payload });
  await sendPushToProfiles(staff, "inquiry", payload);
}

/**
 * ASK THE OFFICE INSTEAD (cn-v1185, skeptic #87): stamp the request, ping the office to send times,
 * refresh the lists, and answer the generic `{ ok: true }` (SITE_VISIT_REQUESTED, true either way).
 * The ONE place both doors do it, so no path that books nothing can leave the office untold.
 */
async function askOffice(
  supabase: Svc,
  orgId: string,
  settings: OrgSettings,
  lead: Lead,
  typedName: string | null,
): Promise<{ ok: true }> {
  await stampRequest(supabase, orgId, lead.id);
  await pingForTimes(orgId, settings, lead, typedName);
  revalidatePath("/leads");
  revalidatePath("/planner");
  return { ok: true };
}

const offered = (ts: OpenTime[]): OfferedTime[] => ts.map((t) => ({ at: t.at, label: openTimeLabel(t) }));

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
  const org = await resolvePublicOrg(supabase, input);
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
  let inquiry: Lead | undefined =
    (await ownLead<Lead>(supabase, orgId, input?.leadId, "id, name, address, message, phone, email, status")).lead ?? undefined;
  // TIMES ONLY ON THE BROWSER'S OWN LEAD (skeptic #87, S2). A lead this call inserts below (no id, an
  // id past 24 hours, another company's id) is one the browser was never told the id of, so a pick
  // on it could never find it: it gets today's stamp and ping, and the office always hears of it.
  const foundOwn = !!inquiry;

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
      .select("id, name, address, message, phone, email, status")
      .single();
    if (cErr || !created) return { ok: false, error: "Couldn't submit — please call us instead." };
    inquiry = created as typeof inquiry;
  }
  if (!inquiry) return { ok: false, error: "Couldn't submit — please call us instead." };

  // An inspection already on the calendar wins — don't ask the office to send times over a real
  // booking, and never offer times beside it. ANY live scheduled inspection (cn-v1185): a visit the
  // customer picked has no created_by and is a booking all the same. A failed read is not "none":
  // no times are offered on it (below), only today's ping.
  const standing = await liveInspection(supabase, orgId, inquiry.id);
  // The same answer as the stamped path below, byte for byte: the browser is not told which.
  if (standing === true) {
    return { ok: true };
  }

  // Stamp the request (both ways below). No follow-up day (gone everywhere, cn-v1170): an open lead
  // with no standing visit is on the Leads list already, which is what keeps it from sitting unnoticed.

  // THE OFFER (cn-v1185). Only when the visitor did not just say none work, the lead is the one this
  // browser's own submit returned (S2) and the office has not ended it (S4), the company offers open
  // times, and the standing-visit read answered. Some open → the lead is stamped and the times come
  // back, and NO ping: the new-lead alert rang at the submit, the lead is flagged on the Leads list,
  // and the pick rings with the day and time. A calendar that could not be read is filed (ids only)
  // and never shown: today's ping.
  if (!input?.noOffer && foundOwn && !ended(inquiry) && standing === false && offersOpenTimes(settings)) {
    try {
      const times = await openInspectionTimes(supabase, orgId, settings);
      if (times.length) {
        await stampRequest(supabase, orgId, inquiry.id);
        revalidatePath("/leads");
        revalidatePath("/planner");
        return { ok: true, times: offered(times) };
      }
    } catch (e) {
      reportError("public-schedule:offer", e, { orgId, leadId: inquiry.id });
    }
  }

  return askOffice(supabase, orgId, settings, inquiry, name);
}

/**
 * THE VISITOR TAPS ONE OF THE OPEN TIMES (cn-v1185). Every guard the request door has, plus the
 * calendar asked AGAIN (a time shown is not held; the tap is checked instead) and a check after the
 * write for two visitors on one time in the same second, and for one lead booked twice.
 *
 * WHAT EACH FAILURE AFTER THE INSERT LEAVES, and what the browser reads (the law: never "booked" for
 * a visit that is not there, never a failure for a visit that is):
 *   • the insert fails: nothing written → PICK_FAILED.
 *   • the check-after-write read fails: the row is taken back off (by id AND company, read back) and
 *     the office is asked to send times → `{ ok: true }` (the generic sentence). If taking it off
 *     fails too, the visit stands → `booked`.
 *   • the check finds an earlier booking on that time: the row is taken off → `taken` with fresh times
 *     (or the office is asked, `{ ok: true }`, when none are open). If taking it off fails, the visit
 *     stands → `booked`, and the clash is filed for the office.
 *   • the check finds another visit for THIS lead written first (two tabs, a replayed call, a visit
 *     the office booked meanwhile; skeptic #87, S3): the row is taken off → `{ ok: true }`, the step-6
 *     answer (a visit already stands; no ping, no times). If taking it off fails, it stands → `booked`,
 *     filed with ids.
 *   • filling the lead's blank address, withdrawing an old pick link, moving the lead to contacted, or
 *     ringing the office fails: the visit stands → `booked`; each miss is filed (ids only).
 *
 * WHAT THE CHECK AFTER THE WRITE CANNOT SEE (skeptic #87, S7–S9), said here until a later release:
 *   • two inserts whose commits cross can BOTH stand. `created_at` is when a write BEGAN, not when it
 *     committed: a write that began first but committed after the other's check has run is invisible
 *     to that check, and sees the other as later. Only a unique index on the calendar closes that, and
 *     that is a migration, not this release.
 *   • it reads only visits STARTING within one slot (90 minutes) of the time: a long visit, or a job
 *     placed over the time, inside the window between step 7's read and the write, is not seen.
 *   • a visit that was `proposed` when `before` was read (a Let Them Pick time) and is confirmed inside
 *     that window, or a visit dragged near the time inside it, is "new" to the check and older than
 *     ours, so it can take back a pick the calendar would have called open (a visit ending as ours
 *     begins). Rare, and the visitor is shown the fresh times.
 */
export async function publicPickInspectionTime(input: PublicPickInput): Promise<PublicPickResult> {
  // 1. Bot trap — pretend success, write nothing. The instant must be one.
  if (input?.hp) return { ok: true };
  const atRaw = String(input?.at ?? "").trim();
  if (atRaw.length > 40 || !ISO_INSTANT_RE.test(atRaw) || !Number.isFinite(Date.parse(atRaw)))
    return { ok: false, error: PICK_BAD_TIME };
  const atMs = Date.parse(atRaw);

  // 2. Rate limits, the request door's shape: a write to a company's calendar from anyone. The two
  // per-address limits are here; the company's daily ceiling counts BOOKINGS and sits just before the
  // insert (skeptic #87, S5), so calls that could never book cannot use it up.
  const ip = clientIp(await headers());
  if (await rateLimited(`pick:${ip}`, 5, 60)) return { ok: false, error: PICK_TOO_MANY };
  if (await rateLimited(`pick-day:${ip}`, 6, 86400)) return { ok: false, error: PICK_TOO_MANY };

  const supabase = createServiceClient();
  // 3. The company, exactly as the request door resolves it.
  const org = await resolvePublicOrg(supabase, input);
  if (!org) return { ok: false, error: PICK_OFF };
  const orgId = org.id;
  const settings = getOrgSettings(org.settings);

  // 4. The company offers open times, or there is nothing to pick.
  if (!offersOpenTimes(settings)) return { ok: false, error: PICK_OFF };

  // 5. The lead THIS BROWSER sent: the same key and rule as the request door. No such lead is the
  // same refusal as 4, never "no such lead" (A6). A failed read is a failure, not "no lead".
  const found = await ownLead<PickLead>(
    supabase,
    orgId,
    input?.leadId,
    "id, name, address, message, notes, phone, email, status, customer_id, intake",
  );
  if (found.failed) return { ok: false, error: PICK_FAILED };
  const lead = found.lead;
  if (!lead) return { ok: false, error: PICK_OFF };

  // 6. A visit already stands: nothing written, the generic sentence. Never a time it did not pick.
  const standing = await liveInspection(supabase, orgId, lead.id);
  if (standing === null) return { ok: false, error: PICK_FAILED };
  if (standing) return { ok: true };

  // A LEAD THE OFFICE ENDED IS NEVER BOOKED (skeptic #87, S4): won, lost, archived, declined or spam
  // inside the 24 hours. No visit is written; the office is asked, so the sentence the visitor reads
  // ("we'll text you a few time options") is true, and the office decides.
  if (ended(lead)) return askOffice(supabase, orgId, settings, lead, null);

  /** Not open (any more): the fresh offer, or, with none open, the request door's ask. */
  const notOpen = async (): Promise<PublicPickResult> => {
    let fresh: OpenTime[] = [];
    try {
      fresh = await openInspectionTimes(supabase, orgId, settings);
    } catch (e) {
      reportError("public-schedule:pick-fresh", e, { orgId, leadId: lead.id });
    }
    if (fresh.length) return { ok: false, taken: true, times: offered(fresh) };
    return askOffice(supabase, orgId, settings, lead, null);
  };

  // 7. THE CALENDAR IS ASKED AGAIN, for the company day the tap falls on. Only a start it hands out
  // now is bookable; the server's own instant is written, never the browser's string.
  const tz = settings.timezone;
  const ymd = todayStrInTz(tz, new Date(atMs));
  // What already sits within one slot of the tap BEFORE the calendar is asked: those rows are judged
  // by the schedule's own rule (step 7), so the check after the write (step 9) looks only at rows that
  // appeared after this read. Without it a visit that ends before this one starts, but starts within
  // 90 minutes of it, would refuse a time the calendar calls open on every tap, forever.
  const before = await visitsNear(supabase, orgId, atMs, null);
  if (!before) {
    reportError("public-schedule:pick-near", new Error("the visits near the time could not be read"), { orgId, leadId: lead.id });
    return { ok: false, error: PICK_FAILED };
  }
  let onDay: OpenTime[];
  try {
    onDay = await openTimesOnDay(supabase, orgId, settings, ymd);
  } catch (e) {
    reportError("public-schedule:pick-day", e, { orgId, leadId: lead.id });
    return notOpen();
  }
  const slot = onDay.find((t) => Date.parse(t.at) === atMs);
  if (!slot) return notOpen();
  const label = openTimeLabel(slot);

  // THE COMPANY'S DAILY CEILING COUNTS BOOKINGS, NOT CALLS (skeptic #87, S5): ten a day, the old
  // hold's own ceiling, counted only once the calendar has handed out a real slot for a real, fresh,
  // own lead. Over it, the visitor is not blamed: no visit is written and the office is asked.
  if (await rateLimited(`pick-org:${orgId}`, 10, 86400)) return askOffice(supabase, orgId, settings, lead, null);

  // WHERE TO COME (skeptic #87, S10). The lead's own address, always, when it has one. Only when it is
  // blank does an address typed at the pick count: the visit is built with it, and the lead's blank is
  // filled once the visit stands. No address anywhere still books.
  const typed = clampStr(input?.address, 300);
  const leadHasAddress = !!String(lead.address ?? "").trim();
  const place = leadHasAddress ? lead.address : typed;
  const rowLead = leadHasAddress || !typed ? lead : { ...lead, address: typed };

  // 8. The visit, written exactly as the office's Book It writes one (ONE ROW SHAPE), plus the
  // company by hand and its status. No person made it: created_by is null. Read back.
  const carry = await carryForInquiry(supabase, lead as { intake?: { intake_answers?: unknown } | null }, { orgId });
  const { data: made, error: insErr } = await supabase
    .from("appointments")
    .insert({
      ...leadInspectionRow({ lead: rowLead, carry, startsAtIso: slot.at, customerId: lead.customer_id ?? null, createdBy: null }),
      org_id: orgId,
      status: "scheduled",
    })
    .select("id, created_at")
    .single();
  const mine = made as { id: string; created_at: string | null } | null;
  // Nothing written: the browser is told it failed.
  if (insErr || !mine?.id) {
    reportError("public-schedule:pick-insert", insErr ?? new Error("no row read back"), { orgId, leadId: lead.id });
    return { ok: false, error: PICK_FAILED };
  }

  /** Take the row just written back off, by id AND company, read back. True when it is gone. */
  const takeBack = async (): Promise<boolean> => {
    const { data, error } = await supabase.from("appointments").delete().eq("id", mine.id).eq("org_id", orgId).select("id");
    if (error || (data ?? []).length !== 1) {
      reportError("public-schedule:pick-takeback", error ?? new Error("the visit was not taken off"), { orgId, visitId: mine.id });
      return false;
    }
    return true;
  };

  // 9. CHECK AFTER WRITE: one lead, one visit; two visitors, one time, the same second. The earlier
  // write wins (created_at, then the smaller id); the later one is taken back off. The day is
  // re-counted the same way.
  const clash = await laterThanAnother(supabase, orgId, mine, {
    leadId: lead.id,
    atMs,
    ymd,
    tz,
    perDay: settings.inspection_days.per_day,
    before: new Set(before.map((r) => r.id)),
  });
  if (clash !== "clear") {
    if (await takeBack()) {
      if (clash === "unread") {
        // The check could not be made: no booking is claimed. The office is asked instead.
        reportError("public-schedule:pick-check", new Error("the check after write could not read"), { orgId, leadId: lead.id });
        return askOffice(supabase, orgId, settings, lead, null);
      }
      // Another visit for this lead was written first: it stands, and the answer is step 6's.
      if (clash === "dup") return { ok: true };
      return notOpen();
    }
    // The row could not be taken off: it stands, so the browser is told it is booked.
    if (clash === "later") reportError("public-schedule:pick-clash", new Error("two visits on one time"), { orgId, visitId: mine.id });
    if (clash === "dup") reportError("public-schedule:pick-dup", new Error("two visits for one lead"), { orgId, leadId: lead.id, visitId: mine.id });
  }

  // The visit stands. The lead's BLANK address is filled with the one typed at the pick, by id AND
  // company, and only while it is still exactly what was read (never an address somebody wrote
  // meanwhile). Read back; a miss is filed and the visit stands.
  if (!leadHasAddress && typed) {
    const fill = supabase.from("inquiries").update({ address: typed }).eq("id", lead.id).eq("org_id", orgId);
    const { data: filled, error: fErr } = await (lead.address == null ? fill.is("address", null) : fill.eq("address", lead.address)).select("id");
    if (fErr || (filled ?? []).length !== 1)
      reportError("public-schedule:pick-address", fErr ?? new Error("the lead's address was not filled"), { orgId, leadId: lead.id });
  }

  // 10. The visit just made closes any pick link of this lead (one door opens, the last one closes),
  // through a cancel that names the company by hand, then the lead goes to contacted, as Book It does.
  try {
    const w = await withdrawLeadPicks(supabase, { orgId, inquiryId: lead.id, exceptVisitId: mine.id }, async (visitId) => {
      const { data, error } = await supabase
        .from("appointments")
        .update({ status: "cancelled" })
        .eq("id", visitId)
        .eq("org_id", orgId)
        .eq("status", "proposed")
        .select("id");
      return { ok: !error && (data ?? []).length === 1 };
    });
    if (w.error || w.failed.length)
      reportError("public-schedule:pick-withdraw", w.error ?? new Error("a proposed visit was not cancelled"), { orgId, leadId: lead.id });
  } catch (e) {
    reportError("public-schedule:pick-withdraw", e, { orgId, leadId: lead.id });
  }
  // ONLY A NEW LEAD MOVES (skeptic #87, S4): a lead already contacted or quoted keeps its status, and
  // the write carries the status it read, so a lead the office moved meanwhile is never moved back.
  // Zero rows there is not a failure (somebody moved it first); an error is filed.
  if (lead.status === "new") {
    const now = new Date().toISOString();
    const { error: mErr } = await supabase
      .from("inquiries")
      .update({ status: "contacted", last_contacted_at: now, updated_at: now })
      .eq("id", lead.id)
      .eq("org_id", orgId)
      .eq("status", "new")
      .select("id");
    if (mErr) reportError("public-schedule:pick-lead", mErr, { orgId, leadId: lead.id });
  }

  // 11. Tell the office the day and time, from the lead's own row, and where: the lead's address, the
  // one typed at the pick when the lead had none, or plainly that nobody said.
  try {
    const staff = await orgStaffIds(orgId);
    const url = requestHref(settings.features, lead.id);
    const payload = {
      title: `${lead.name || "A website visitor"} picked ${label} for an inspection`,
      body: [lead.phone ?? lead.email, place || "No address given"].filter(Boolean).join(" · "),
      url,
    };
    await createNotifications(orgId, staff, { type: "inquiry", ...payload });
    await sendPushToProfiles(staff, "inquiry", payload);
  } catch (e) {
    reportError("public-schedule:pick-ring", e, { orgId, leadId: lead.id });
  }

  // 12.
  revalidatePath("/leads");
  revalidatePath("/planner");
  revalidatePath("/schedule");
  revalidatePath("/inspections");
  return { ok: true, booked: { label } };
}

type Written = { id: string; created_at: string | null };

/** Written first: the earlier created_at, then the smaller id. */
const writtenFirst = (a: Written, b: Written) => {
  const ca = String(a.created_at ?? "");
  const cb = String(b.created_at ?? "");
  return ca < cb ? -1 : ca > cb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * The company's scheduled visits that are not calls, starting within one slot (90 minutes) either
 * side of the instant, the company named by hand. `null` = the read failed (never "nothing there").
 */
async function visitsNear(supabase: Svc, orgId: string, atMs: number, exceptId: string | null): Promise<Written[] | null> {
  const slotMs = INSPECTION_SLOT_MIN * 60_000;
  let q = supabase
    .from("appointments")
    .select("id, created_at")
    .eq("org_id", orgId)
    .eq("status", "scheduled")
    .neq("type", "call");
  if (exceptId) q = q.neq("id", exceptId);
  const { data, error } = await q
    .gt("starts_at", new Date(atMs - slotMs).toISOString())
    .lt("starts_at", new Date(atMs + slotMs).toISOString());
  if (error) return null;
  return (data ?? []) as Written[];
}

/**
 * CHECK AFTER WRITE: must the visit just written go? "clear" when it stands; "dup" when another
 * scheduled visit for THE SAME LEAD was written first (one lead, one visit; skeptic #87, S3); "later"
 * when it is the later of two on one time, or past the day's ceiling; "unread" when a read failed
 * (never read as "nothing there"). A clash on the time is a visit near it that was NOT there before
 * the calendar was asked (`before`) and was written first. The day: the company's scheduled
 * inspections starting that company day; with more than per_day, those past the first per_day in
 * order of writing go.
 */
async function laterThanAnother(
  supabase: Svc,
  orgId: string,
  mine: Written,
  w: { leadId: string; atMs: number; ymd: string; tz: string; perDay: number; before: Set<string> },
): Promise<"clear" | "later" | "dup" | "unread"> {
  const { data: same, error: sErr } = await supabase
    .from("appointments")
    .select("id, created_at")
    .eq("org_id", orgId)
    .eq("inquiry_id", w.leadId)
    .eq("type", LEAD_VISIT_TYPE)
    .eq("status", "scheduled")
    .neq("id", mine.id);
  if (sErr) return "unread";
  if (((same ?? []) as Written[]).some((o) => writtenFirst(o, mine) < 0)) return "dup";

  const near = await visitsNear(supabase, orgId, w.atMs, mine.id);
  if (!near) return "unread";
  if (near.some((o) => !w.before.has(o.id) && writtenFirst(o, mine) < 0)) return "later";

  const next = new Date(Date.parse(`${w.ymd}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const { data: day, error: dErr } = await supabase
    .from("appointments")
    .select("id, created_at")
    .eq("org_id", orgId)
    .eq("type", LEAD_VISIT_TYPE)
    .eq("status", "scheduled")
    .gte("starts_at", tzDayStartUtc(w.ymd, w.tz).toISOString())
    .lt("starts_at", tzDayStartUtc(next, w.tz).toISOString());
  if (dErr) return "unread";
  const ordered = [...((day ?? []) as Written[])].sort(writtenFirst);
  const rank = ordered.findIndex((r) => r.id === mine.id);
  // Its own row not found on its own day is a read that cannot be trusted.
  if (rank < 0) return "unread";
  return rank >= Math.max(1, w.perDay) ? "later" : "clear";
}
