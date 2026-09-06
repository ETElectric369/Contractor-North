/**
 * THE one place a triaged lead is written to the inquiries pipeline. Both front doors call
 * it: the partner webhook (POST /api/inbound/lead) and the native public estimate
 * configurator (/estimate/[handle]). Triage (bucket / $-gate / priority) is computed HERE
 * from the intake, so no caller can hand-set a bucket or priority and game an instant price.
 *
 * org_id is ALWAYS passed explicitly because both callers use the service client (no auth
 * session → the set_org_id trigger has nothing to infer from). The intake jsonb keeps the
 * raw answers + the configurator estimate ({total, lines}) plus the triage reason, so the
 * office Leads row and the one-click convert→draft-quote path both read what they need.
 */
import { classifyLead, type LeadIntake, type LeadTriage } from "@/lib/lead-triage";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz, tzLocalHourUtc } from "@/lib/tz";
import { createNotifications } from "@/lib/notifications";
import { sendPushToProfiles } from "@/lib/push";
import { sendEmail } from "@/lib/email";
import { rateLimited } from "@/lib/rate-limit";
import { normEmail, normPhone } from "@/lib/crm/duplicates";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CreateTriagedInquiryInput {
  name: string;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
  /** THE JOB SITE — copied to jobs.address on conversion. See 0189. */
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  /** Where the PERSON is (0189). Fills customers.address on conversion; null falls back to
   *  `address`, which is how every door that only captures one address behaves. */
  contact_address?: string | null;
  contact_city?: string | null;
  contact_state?: string | null;
  contact_zip?: string | null;
  type?: string | null;
  message?: string | null;
  source: string;
  /** Drives triage + the project_type / estimate_total columns. */
  intake: LeadIntake;
  /** Persisted verbatim into the intake jsonb (raw project answers + estimate {total,lines});
   *  the triage `reason` is merged in. Must include `estimate` for the convert→quote path. */
  intakeJson: Record<string, unknown>;
  inspectionThreshold?: number;
  /**
   * May a big lead AUTO-BOOK a site inspection onto the org's live Schedule? Default true, which
   * is what the two SIZE-VERIFIED doors want: the partner webhook (shared-secret authenticated)
   * and the deck configurator (total recomputed server-side from the org's own catalog).
   * Pass FALSE from any door where the estimate total is model- or caller-authored — an anonymous
   * visitor must not be able to talk their way onto the contractor's calendar. The lead still
   * lands and still alerts; booking becomes a one-tap action on the Leads board.
   */
  autoBookInspection?: boolean;
}

/** Hard ceiling on AUTO-BOOKED inspections per org per day. Even an authorized flood (or a
 *  rotating-IP one that walks past a per-IP limiter) can't stack unbounded 9am holds on one
 *  Schedule slot. Real inbound volume is nowhere near this. */
const MAX_AUTOBOOK_PER_DAY = 10;

/**
 * ONE PERSON, ONE LEAD (audit v921).
 *
 * Every submit inserted a fresh row, so the deck configurator — where changing a railing and
 * pressing the button again is the normal way to use it — filed the same person two and three
 * times: three leads on one phone number in TAHOE DECK, two of them alerting the office within
 * two minutes of each other, and a pair the office worked twice (one marked lost while its twin
 * stayed open). A returning submitter is the SAME lead with newer answers.
 *
 * WHAT COUNTS AS THE SAME PERSON: a strong key only — the same phone (≥7 digits) or the same
 * email, the identical keys the CRM's duplicate finder and the win path already use. A name is
 * never enough (two "Chris Taylor"s are two people), so a nameless-key submission always files
 * a new lead, exactly as before.
 *
 * WHAT REOPENS THE QUESTION: a lead that has been CLOSED (won/lost/archived/declined/spam) or
 * already converted is finished — somebody who comes back after that is genuine new interest and
 * gets its own row. And a lead older than the window is a new job, not a second thought.
 */
const TERMINAL_LEAD_STATUSES = ["won", "lost", "archived", "declined", "spam"];
/** How long a submitter is still "the same lead coming back" (a duration, not a calendar day —
 *  ms arithmetic is correct here; no day boundary is being decided). */
const REPEAT_WINDOW_MS = 30 * 86_400_000;
/** A repeat this soon after the last touch is a double-submit, not news: the office is already
 *  looking at the alert it fired minutes ago, so the row updates in silence. */
const REPEAT_QUIET_MS = 60 * 60 * 1000;

type OpenLead = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  status: string | null;
  converted_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  intake: unknown;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

/** The open lead this submission belongs to, or null when it is genuinely new. */
async function openLeadFor(
  supabase: SupabaseClient,
  orgId: string,
  input: CreateTriagedInquiryInput,
): Promise<OpenLead | null> {
  const phone = normPhone(input.phone);
  const email = normEmail(input.email);
  if (phone.length < 7 && !email) return null;
  // Normalized in JS, not SQL: these doors store whatever the visitor typed ("(530) 555-1212",
  // "5305551212"), so a column comparison would miss the very duplicates this exists to catch.
  const { data } = await supabase
    .from("inquiries")
    .select("id, name, email, phone, message, status, converted_at, updated_at, created_at, intake, address, city, state, zip")
    .eq("org_id", orgId) // explicit org scope — this runs on the service client, which has no RLS
    .gte("created_at", new Date(Date.now() - REPEAT_WINDOW_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (data ?? []) as OpenLead[];
  return (
    rows.find(
      (r) =>
        !r.converted_at &&
        !TERMINAL_LEAD_STATUSES.includes(String(r.status ?? "")) &&
        ((phone.length >= 7 && normPhone(r.phone) === phone) || (!!email && normEmail(r.email) === email)),
    ) ?? null
  );
}

/** Does this lead already hold a live spot on the calendar? (Repeat submissions only.) */
async function hasAppointment(supabase: SupabaseClient, inquiryId: string): Promise<boolean> {
  if (!inquiryId) return false;
  const { data } = await supabase
    .from("appointments")
    .select("id")
    .eq("inquiry_id", inquiryId)
    .neq("status", "cancelled")
    .limit(1);
  return !!(data ?? []).length;
}

export async function createTriagedInquiry(
  supabase: SupabaseClient,
  orgId: string,
  input: CreateTriagedInquiryInput,
): Promise<{ id: string; triage: LeadTriage }> {
  const triage = classifyLead(input.intake, { inspectionThreshold: input.inspectionThreshold });

  // THE SAME PERSON COMING BACK IS THE SAME LEAD (audit v921) — see openLeadFor. The newest
  // submission is the truth about what they want, so the triage/estimate fields are replaced;
  // what they said before is kept in the message and the intake, because a second submission is
  // usually a change of mind and the office needs to see both halves.
  const repeat = await openLeadFor(supabase, orgId, input);
  let cameBack = false;
  let quiet = false;
  let id = "";
  if (repeat) {
    const stamp = new Date().toISOString();
    // The divider carries the ORG's calendar day, not the server's — after 5 PM Pacific a
    // toISOString() slice reads tomorrow, and this line is something the office reads back.
    const { data: tzRow } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
    const dayStr = todayStrInTz(getOrgSettings((tzRow as { settings?: unknown } | null)?.settings).timezone);
    const priorIntake = repeat.intake && typeof repeat.intake === "object" ? (repeat.intake as Record<string, unknown>) : {};
    // The chain is FLAT and capped: keeping `previous` inside each archived copy would nest the
    // whole history inside itself on every submit, and a jsonb column that doubles per press is
    // its own outage. Last five, oldest dropped.
    const { previous: priorChain, ...priorAnswers } = priorIntake;
    const prior = Array.isArray(priorChain) ? (priorChain as unknown[]) : [];
    const said = String(input.message ?? "").trim();
    const message =
      [repeat.message, said ? `— Came back ${dayStr} —\n${said}` : ""].filter(Boolean).join("\n\n") || null;
    const { data: hit, error: uErr } = await supabase
      .from("inquiries")
      .update({
        // Blanks fill; what they told us the FIRST time is never overwritten by a later form —
        // a second submission with an empty field is not an instruction to erase the first one.
        ...(repeat.name ? {} : { name: input.name }),
        ...(repeat.email || !input.email ? {} : { email: input.email }),
        ...(repeat.phone || !input.phone ? {} : { phone: input.phone }),
        ...(repeat.address || !input.address ? {} : { address: input.address, city: input.city ?? null, state: input.state ?? null, zip: input.zip ?? null }),
        message,
        // Derived from THIS submission — an old $9k bucket on a lead that just priced $40k is
        // worse than no triage at all.
        project_type: input.intake.projectType ?? null,
        lead_bucket: triage.bucket,
        estimate_total: input.intake.estimateTotal || null,
        site_inspection_required: triage.siteInspectionRequired,
        priority: triage.priority,
        // THE UPLOADED FILES MUST STAY AT THE TOP LEVEL (audit v921 review blocker). Every reader
        // — intakePaths (lib/playbook/uploads), carryForInquiry, the quote builder, the signed-URL
        // door on /leads — looks ONLY at intake.intake_answers, and NOTHING reads `previous`. So
        // burying the prior submission there detached the customer's plan PDFs: storage-sweep
        // builds its reference set from intakePaths, so after its 48h grace the nightly cron
        // PERMANENTLY DELETED files belonging to a live lead. Worse across doors — a later
        // "Contact us" or site-chat submission carries no intake_answers at all, so the key
        // vanished from the top level entirely. Merge the answers FORWARD (new wins per key, the
        // prior submission's keys survive) and keep `previous` as the human history it was for.
        intake: {
          ...input.intakeJson,
          intake_answers: {
            ...((priorAnswers as { intake_answers?: Record<string, unknown> }).intake_answers ?? {}),
            ...((input.intakeJson as { intake_answers?: Record<string, unknown> }).intake_answers ?? {}),
          },
          reason: triage.reason,
          previous: [...prior, priorAnswers].slice(-5),
        },
        updated_at: stamp,
      })
      .eq("id", repeat.id)
      .select("id");
    // THE SILENT-WRITE LAW: a zero-row update is a 204 — if the lead vanished between the read
    // and here, fall through and file the submission as a new lead rather than losing it.
    if (!uErr && hit?.length) {
      cameBack = true;
      id = repeat.id;
      const lastTouch = Date.parse(repeat.updated_at || repeat.created_at || "") || 0;
      quiet = Date.now() - lastTouch < REPEAT_QUIET_MS;
    }
  }

  // A repeat already has its row — only a genuinely new lead is inserted.
  if (!cameBack) {
    const { data, error } = await supabase
      .from("inquiries")
      .insert({
        org_id: orgId, // explicit — service client has no auth context for the set_org_id trigger
        name: input.name,
        company_name: input.company_name ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        zip: input.zip ?? null,
        // Written only when a door actually captured a second address (0189). Every other door
        // leaves these null, and the conversion reads `contact_address ?? address` — so a lead from
        // /inquire, the partner webhook or the deck configurator behaves exactly as it always did.
        contact_address: input.contact_address ?? null,
        contact_city: input.contact_city ?? null,
        contact_state: input.contact_state ?? null,
        contact_zip: input.contact_zip ?? null,
        type: input.type ?? "residential",
        message: input.message ?? null,
        source: String(input.source).slice(0, 40),
        project_type: input.intake.projectType ?? null,
        lead_bucket: triage.bucket,
        estimate_total: input.intake.estimateTotal || null,
        site_inspection_required: triage.siteInspectionRequired,
        priority: triage.priority,
        intake: { ...input.intakeJson, reason: triage.reason },
      })
      .select("id")
      .single();

    if (error) throw error;
    id = data.id as string;
  }

  // A >$20k lead flagged for a site inspection gets one AUTO-BOOKED onto the Schedule, so a big
  // inbound lead never sits with no scheduled action. Service client → org_id explicit (no auth
  // session for the set_org_id trigger). Best-effort: a booking failure must not stop the lead.
  // TWO GUARDS, because this writes to the contractor's REAL calendar from public doors:
  //   · autoBookInspection === false — the caller's total isn't size-verified (site-chat).
  //   · a per-org/day ceiling — bounds a flood from ANY door, whatever its IP.
  // Either guard failing only skips the HOLD; the lead itself always lands and always alerts.
  const mayAutoBook =
    triage.siteInspectionRequired &&
    input.autoBookInspection !== false &&
    // A lead that came back must not stack a SECOND hold on top of the one its first submission
    // already put on the calendar — but a lead that grew past the threshold on this pass still
    // gets its first (audit v921).
    !(cameBack && (await hasAppointment(supabase, id))) &&
    !(await rateLimited(`autobook:${orgId}`, MAX_AUTOBOOK_PER_DAY, 86400));
  if (mayAutoBook) {
    try {
      // 9 AM in the ORG's timezone, two days out — NOT server-local setHours(9), which on
      // Vercel (UTC) stored 9 AM UTC = 1-2 AM Pacific (the exact class cn-v498 fixed in
      // leads/actions.ts). Same tz idiom as recurring/actions' defaultDueDateIso.
      const { data: orgTz } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
      const tz = getOrgSettings((orgTz as { settings?: unknown } | null)?.settings).timezone;
      // +2 days on the CALENDAR, not by ms (audit v921): a fall-back night is 25h, so adding
      // 2*86_400_000 landed a day early. Add to the date string, then stamp 9 AM org-local.
      const todayStr = todayStrInTz(tz);
      const dayStr = new Date(Date.parse(todayStr + "T00:00:00Z") + 2 * 86_400_000).toISOString().slice(0, 10);
      const when = tzLocalHourUtc(dayStr, 9, tz);
      await supabase.from("appointments").insert({
        org_id: orgId,
        type: "inspection",
        title: `Site inspection: ${input.name}`,
        starts_at: when.toISOString(),
        location: input.address ?? null,
        notes: input.message ?? null,
        status: "scheduled",
        // Provenance (0129): lets the customer's "schedule your site visit" tap
        // REUSE this tentative hold (flip to proposed + pick link) instead of
        // double-booking a second inspection onto the calendar.
        inquiry_id: id,
      });
    } catch {
      /* auto-booking is best-effort — the lead still lands even if it fails */
    }
  }

  // A double-submit minutes after the last touch alerts nobody a second time; a real return does.
  if (!quiet) await notifyNewLead(supabase, orgId, input, { cameBack });
  return { id, triage };
}

/**
 * FIRE THE ALARM — an inbound lead is money walking in the door, and speed-to-lead wins the job.
 * Alert the sales/office crew on THREE channels so it can't be missed: the in-app bell (always
 * works), web push (buzzes the phone), and an email to the office. All best-effort — a notify
 * failure must NEVER stop the lead from landing in the pipeline.
 *
 * Extracted (audit v921) so a lead that came back can use the identical fan-out under its own
 * headline instead of a second copy drifting away from this one.
 */
async function notifyNewLead(
  supabase: SupabaseClient,
  orgId: string,
  input: CreateTriagedInquiryInput,
  opts: { cameBack?: boolean } = {},
): Promise<void> {
  try {
    const [{ data: staff }, { data: orgRow }] = await Promise.all([
      // `.eq("active", true)` — 0158 made deactivation a real BOUNDARY, but this reads on the
      // SERVICE client, which never runs RLS, so the boundary has to be applied by hand (the same
      // reason push.ts:34 does it). Without it a new lead's email could go to an offboarded
      // ex-employee — and if the org has no email on file, ONLY to them. `role` comes along so the
      // recipient below is chosen rather than picked at random from an unordered set.
      supabase.from("profiles").select("id, email, role").eq("org_id", orgId).eq("active", true).in("role", ["owner", "admin", "office"]),
      supabase.from("organizations").select("email, name").eq("id", orgId).maybeSingle(),
    ]);
    const staffIds = ((staff ?? []) as { id: string }[]).map((s) => s.id);
    const money = input.intake.estimateTotal
      ? `est. $${Math.round(input.intake.estimateTotal).toLocaleString()}`
      : "quote request";
    const where = [input.city, input.state].filter(Boolean).join(", ");
    // The office needs to know WHICH this is: a fresh lead, or the same person back with new
    // answers on the lead they already have.
    const title = opts.cameBack ? `🔁 Lead came back — ${input.name}` : `🔥 New lead — ${input.name}`;
    const body = [input.intake.projectType, money, where].filter(Boolean).join(" · ") || "New quote request";

    await createNotifications(orgId, staffIds, { type: "inquiry", title, body, url: "/leads" });
    await sendPushToProfiles(staffIds, "inquiry", { title, body, url: "/leads" });

    // A DETERMINISTIC recipient. sendEmail takes one address, and `.find(Boolean)` over an
    // unordered query was a coin flip between whoever Postgres happened to return first. Order:
    // the org's own address, then the OWNER, then any active admin/office — the owner is the only
    // defensible default for "the lead notification went to exactly one person".
    const contacts = ((staff ?? []) as { email?: string; role?: string }[]).filter((x) => x.email);
    const to = (orgRow as { email?: string } | null)?.email
      || contacts.find((x) => x.role === "owner")?.email
      || contacts.find((x) => x.role === "admin")?.email
      || contacts[0]?.email;
    if (to) {
      const site = process.env.NEXT_PUBLIC_SITE_URL || "https://contractor-north.vercel.app";
      const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
      await sendEmail({
        to,
        fromName: (orgRow as { name?: string } | null)?.name || undefined,
        subject: `${opts.cameBack ? "Lead came back" : "New lead"}: ${input.name}${input.intake.estimateTotal ? ` (est. $${Math.round(input.intake.estimateTotal).toLocaleString()})` : ""}`,
        html: `<div style="font-family:ui-sans-serif,system-ui,Arial,sans-serif;max-width:520px;color:#0f172a">
          <h2 style="margin:0 0 6px">${opts.cameBack ? "🔁 Lead came back" : "🔥 New lead"} — ${esc(input.name)}</h2>
          <p style="color:#475569;margin:0 0 12px">${esc(body)}</p>
          ${input.email ? `<p style="margin:2px 0">📧 ${esc(input.email)}</p>` : ""}
          ${input.phone ? `<p style="margin:2px 0">📞 ${esc(input.phone)}</p>` : ""}
          ${input.message ? `<p style="color:#334155;margin:12px 0;border-left:3px solid #cbd5e1;padding-left:10px">${esc(input.message)}</p>` : ""}
          <p style="margin:18px 0"><a href="${site}/leads" style="background:#0b57c4;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;display:inline-block">Open the lead →</a></p>
          <p style="color:#94a3b8;font-size:12px">Reach out fast — speed-to-lead wins the job.</p>
        </div>`,
      });
    }
  } catch {
    /* notifications are best-effort — the lead must still land even if alerts fail */
  }
}
