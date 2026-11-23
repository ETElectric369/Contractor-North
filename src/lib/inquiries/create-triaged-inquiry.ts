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
import { classifyLead, leadBucketWords, projectTypeLabel, type LeadBucket, type LeadIntake, type LeadTriage } from "@/lib/lead-triage";
import { getOrgSettings } from "@/lib/org-settings";
import { requestHref, requestOpensLead } from "@/lib/feature-doors";
import { formatCurrency } from "@/lib/utils";
import { todayStrInTz, tzLocalHourUtc } from "@/lib/tz";
import { createNotifications } from "@/lib/notifications";
import { STAFF_ROLES } from "@/lib/actions/perms";
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
 * A PUBLIC DOOR BOOKS NO INSPECTION BY ITSELF (cn-v1180; the owner, 2026-11-22: "stop the auto
 * booking until that feature is turned on in each account when there are inspection days set and
 * calendar can corroborate open times and specified days").
 *
 * The hold below put a big web lead on the company's real calendar at 9 AM two days out: a time
 * nobody agreed to, on a calendar nobody looked at, with nobody telling the customer. It also took
 * the lead off the Leads list (a standing visit does) while the alert said "new lead". It is OFF for
 * every company. The lead still lands, flagged as needing a site inspection, and still alerts; the
 * office books it or sends times.
 *
 * THE FEATURE THE OWNER ASKED FOR IS BUILT ELSEWHERE (cn-v1185), and not in this form: a company that
 * turns on its Inspection Days (settings › Crew & Time) has its website visitor SHOWN the open times on
 * those days, read from the calendar, and the visitor taps one (lib/actions/public-schedule.ts,
 * publicScheduleInspection and publicPickInspectionTime). The app still never books by itself. This
 * hold is not coming back as that feature; it stays false and is NOT a switch to flip, because what it
 * would turn back on is the blind hold. The branch is left in place: removing it is the owner's call.
 */
const AUTO_BOOK_FROM_PUBLIC_DOORS: boolean = false;

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
export const TERMINAL_LEAD_STATUSES: readonly string[] = ["won", "lost", "archived", "declined", "spam"];
/** How long a submitter is still "the same lead coming back" (a duration, not a calendar day —
 *  ms arithmetic is correct here; no day boundary is being decided). */
const REPEAT_WINDOW_MS = 30 * 86_400_000;
/** A repeat this soon after the last touch MAY be a double-submit, not news: the office is already
 *  looking at the alert it fired minutes ago. It is quiet only when nothing the office reads changed
 *  and nothing new was typed (repeatIsQuiet, cn-v1180); otherwise it alerts like any lead coming back. */
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
  // What the office reads off a lead, compared with the new submission (repeatIsQuiet): the read
  // that finds the lead must carry them, or every repeat would look changed (or none would).
  project_type: string | null;
  lead_bucket: string | null;
  estimate_total: number | string | null;
  site_inspection_required: boolean | null;
  priority: number | null;
};

/** What a submission says the office reads: the five columns the triage writes. */
export type LeadAnswer = {
  project_type: string | null;
  lead_bucket: string | null;
  estimate_total: number | string | null;
  site_inspection_required: boolean | null;
  priority: number | null;
};

/** A figure in cents; no figure and zero are the same "no estimate" (the write stores `|| null`). */
const cents = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/**
 * DID ANYTHING THE OFFICE READS CHANGE? (cn-v1180, audit A4). The newest submission replaces the
 * lead's triage and estimate (audit v921, kept), and the quiet hour hid that from everybody: anyone
 * with a person's phone or e-mail could rewrite their open lead and nobody was told. A repeat that
 * moves the project type, the bucket, the estimate to the cent, the site-inspection flag or the
 * priority is news, whenever it lands.
 */
export function answerChanged(before: LeadAnswer, after: LeadAnswer): boolean {
  return (
    (before.project_type ?? null) !== (after.project_type ?? null) ||
    (before.lead_bucket ?? null) !== (after.lead_bucket ?? null) ||
    cents(before.estimate_total) !== cents(after.estimate_total) ||
    siteTurnedOn(before, after) ||
    Number(before.priority ?? 0) !== Number(after.priority ?? 0)
  );
}

/**
 * THE SITE-VISIT FLAG ONLY EVER TURNS ON (skeptic #83, S3). The site-visit tap stamps it true too
 * (public-schedule), and a later configurator repeat whose triage computes false read that stamp as
 * "changed" on every press, a true double-submit included. So it is news only when THIS submission
 * turns it on (false or none, to true), and the repeat's write never turns a true flag back off.
 */
function siteTurnedOn(before: LeadAnswer, after: LeadAnswer): boolean {
  return !before.site_inspection_required && !!after.site_inspection_required;
}

/**
 * QUIET IS ONLY A TRUE DOUBLE-SUBMIT (cn-v1180): inside the hour of the last touch, AND nothing the
 * office reads changed, AND no new words. Words already at the end of the lead's message are the
 * same press again, not new text.
 */
export function repeatIsQuiet(opts: { sinceLastTouchMs: number; changed: boolean; said: string; priorMessage: string | null }): boolean {
  const newWords = !!opts.said && !String(opts.priorMessage ?? "").trimEnd().endsWith(opts.said);
  return opts.sinceLastTouchMs < REPEAT_QUIET_MS && !opts.changed && !newWords;
}

/**
 * BOTH HALVES WHERE THE OFFICE ALREADY READS (cn-v1180): the lead's message. One English line with
 * the earlier and the new answer, the type and the figure; `previous` in the intake is read by no
 * screen, so it is not where the office would find the half that was replaced.
 */
export function answerLine(before: LeadAnswer, after: LeadAnswer): string {
  // THE LINE NAMES WHAT MOVED (skeptic #83, S3): a repeat that moved only the readiness bucket, the
  // priority or the site-visit flag printed two identical halves. When type and figure are the same
  // in both, each of those that differs is said in both halves; an ordinary change (the priority
  // follows the figure) still reads as type and figure alone.
  const sameHead =
    (before.project_type ?? null) === (after.project_type ?? null) && cents(before.estimate_total) === cents(after.estimate_total);
  const bucketMoved = sameHead && (before.lead_bucket ?? null) !== (after.lead_bucket ?? null);
  const priorityMoved = sameHead && Number(before.priority ?? 0) !== Number(after.priority ?? 0);
  const siteMoved = sameHead && siteTurnedOn(before, after);
  const bucketWords = (b: string | null) =>
    b === "A" || b === "B" || b === "C" ? leadBucketWords(b as LeadBucket).label : "no readiness bucket";
  const half = (a: LeadAnswer) => {
    const type = a.project_type ? projectTypeLabel(a.project_type) : "no project type";
    const money = cents(a.estimate_total) ? formatCurrency(Number(a.estimate_total)) : "no estimate";
    return [
      type,
      money,
      ...(bucketMoved ? [bucketWords(a.lead_bucket ?? null)] : []),
      ...(priorityMoved ? [a.priority == null ? "no priority" : `priority ${Number(a.priority)}`] : []),
      ...(siteMoved ? [a.site_inspection_required ? "site visit needed" : "no site visit"] : []),
    ].join(", ");
  };
  return `Earlier answer: ${half(before)}. New answer: ${half(after)}.`;
}

/** How many "Came back" blocks a lead's message keeps, and the most it may hold in all. */
export const CAME_BACK_KEEP = 5;
export const MESSAGE_MAX = 6000;
const CAME_BACK_SPLIT = /\n\n(?=— Came back \d{4}-\d{2}-\d{2} —\n)/;

/**
 * A LEAD'S MESSAGE CANNOT BE GROWN WITHOUT LIMIT FROM A PUBLIC FORM (skeptic #83, S4). Every changed
 * repeat appends a divider and a line, and anyone with a lead's phone or e-mail can press again
 * (5 a minute). The FIRST submission's own words are never dropped; the newest five "Came back"
 * blocks are kept, older ones go; and the whole stays under MESSAGE_MAX by dropping the oldest blocks
 * first (the last block standing is cut only if it alone would still be over).
 */
export function boundedMessage(prior: string | null, block: string | null): string | null {
  const parts = String(prior ?? "").split(CAME_BACK_SPLIT).filter((p) => p !== "");
  const head = parts.length && !parts[0].startsWith("— Came back ") ? parts.shift()! : "";
  const blocks = [...parts, ...(block ? [block] : [])].slice(-CAME_BACK_KEEP);
  const join = () => [head, ...blocks].filter(Boolean).join("\n\n");
  while (blocks.length > 1 && Array.from(join()).length > MESSAGE_MAX) blocks.shift();
  const out = Array.from(join());
  return (out.length > MESSAGE_MAX ? out.slice(0, MESSAGE_MAX) : out).join("") || null;
}

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
    .select(
      "id, name, email, phone, message, status, converted_at, updated_at, created_at, intake, address, city, state, zip, project_type, lead_bucket, estimate_total, site_inspection_required, priority",
    )
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
): Promise<{
  id: string;
  triage: LeadTriage;
  /**
   * TRUE WHEN `id` IS A LEAD THIS CALL CAME BACK TO, not one it wrote (skeptic #87, S1). That lead was
   * found by a TYPED phone or e-mail, and anyone can type somebody's phone: a public door may use the
   * id inside the call, but must never hand it to a browser.
   */
  cameBack: boolean;
}> {
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
    const after: LeadAnswer = {
      project_type: input.intake.projectType ?? null,
      lead_bucket: triage.bucket,
      estimate_total: input.intake.estimateTotal || null,
      site_inspection_required: triage.siteInspectionRequired,
      priority: triage.priority,
    };
    // NEVER SILENT (cn-v1180, audit A4): when the answer the office reads moved, the divider is
    // written even if the visitor typed nothing, with the earlier and the new answer under it.
    const changed = answerChanged(repeat, after);
    const cameBackNote = [changed ? answerLine(repeat, after) : "", said].filter(Boolean).join("\n");
    const message = boundedMessage(repeat.message, cameBackNote ? `— Came back ${dayStr} —\n${cameBackNote}` : null);
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
        // worse than no triage at all. The site-visit flag only ever turns on (siteTurnedOn): a
        // site-visit request the visitor tapped is not undone by a later form's triage.
        ...after,
        site_inspection_required: !!repeat.site_inspection_required || !!after.site_inspection_required,
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
      .eq("org_id", orgId) // the service client: the company named by hand on the write too
      .select("id");
    // THE SILENT-WRITE LAW: a zero-row update is a 204 — if the lead vanished between the read
    // and here, fall through and file the submission as a new lead rather than losing it.
    if (!uErr && hit?.length) {
      cameBack = true;
      id = repeat.id;
      const lastTouch = Date.parse(repeat.updated_at || repeat.created_at || "") || 0;
      quiet = repeatIsQuiet({ sinceLastTouchMs: Date.now() - lastTouch, changed, said, priorMessage: repeat.message });
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

  // OFF SINCE cn-v1180 (AUTO_BOOK_FROM_PUBLIC_DOORS, above): what follows is the old hold, kept for
  // the feature that replaces it. As it was written:
  // A >$20k lead flagged for a site inspection gets one AUTO-BOOKED onto the Schedule, so a big
  // inbound lead never sits with no scheduled action. Service client → org_id explicit (no auth
  // session for the set_org_id trigger). Best-effort: a booking failure must not stop the lead.
  // TWO GUARDS, because this writes to the contractor's REAL calendar from public doors:
  //   · autoBookInspection === false — the caller's total isn't size-verified (site-chat).
  //   · a per-org/day ceiling — bounds a flood from ANY door, whatever its IP.
  // Either guard failing only skips the HOLD; the lead itself always lands and always alerts.
  const mayAutoBook =
    AUTO_BOOK_FROM_PUBLIC_DOORS &&
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
        // The site visit's one word (lib/statuses), the same stock title every booking door gives an
        // inspection (lib/schedule/work-shape bookingTitle).
        title: `Inspection: ${input.name}`,
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

  // A true double-submit alerts nobody a second time; a real return, or a changed answer, does.
  if (!quiet) await notifyNewLead(supabase, orgId, input, { cameBack, leadId: id });
  return { id, triage, cameBack };
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
/**
 * THE ALERT'S WORDS FOLLOW WHERE IT LANDS (the switch board, 0352). With Leads on it is a lead and
 * opens the lead (its own file since cn-v1180; the list when no id is known), word for word as always. With Leads off it opens My Day, where the card
 * reads "New Request from …", so the bell, the push and the email call it a request and the
 * email's button names My Day instead of a lead list that isn't there.
 */
export function requestAlertWords(lands: string, cameBack = false) {
  const lead = requestOpensLead(lands);
  const noun = lead ? "lead" : "request";
  const Noun = lead ? "Lead" : "Request";
  const headline = cameBack ? `${Noun} came back` : `New ${noun}`;
  return {
    /** "🔥 New lead" / "🔁 Lead came back": the bell's and push's title, and the email's heading. */
    head: `${cameBack ? "🔁" : "🔥"} ${headline}`,
    subject: headline,
    button: lead ? "Open the lead →" : "Open My Day →",
    footer: lead ? "Reach out fast — speed-to-lead wins the job." : "Reach out fast — a quick reply wins the job.",
  };
}

async function notifyNewLead(
  supabase: SupabaseClient,
  orgId: string,
  input: CreateTriagedInquiryInput,
  opts: { cameBack?: boolean; leadId?: string } = {},
): Promise<void> {
  try {
    const [{ data: staff }, { data: orgRow }] = await Promise.all([
      // `.eq("active", true)` — 0158 made deactivation a real BOUNDARY, but this reads on the
      // SERVICE client, which never runs RLS, so the boundary has to be applied by hand (the same
      // reason push.ts:34 does it). Without it a new lead's email could go to an offboarded
      // ex-employee — and if the org has no email on file, ONLY to them. `role` comes along so the
      // recipient below is chosen rather than picked at random from an unordered set.
      // Who is office is lib/actions/perms, the one answer every door reads (W2).
      supabase.from("profiles").select("id, email, role").eq("org_id", orgId).eq("active", true).in("role", STAFF_ROLES),
      // settings: where the alert lands (Leads switched off → My Day, the switch board 0352).
      supabase.from("organizations").select("email, name, settings").eq("id", orgId).maybeSingle(),
    ]);
    const staffIds = ((staff ?? []) as { id: string }[]).map((s) => s.id);
    // LEADS OFF, THE REQUEST STILL LANDS (rule d): the bell, the push and the email open My Day,
    // where it waits as "New Request from …" with Call Back, instead of the switched-off list.
    // Leads on: THE LEAD'S OWN FILE (cn-v1180, audit A2) — an auto-booked inspection takes a lead
    // off the Leads list, so the list was the one place the alert could not find it.
    const url = requestHref(getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).features, opts.leadId);
    const money = input.intake.estimateTotal
      ? `est. $${Math.round(input.intake.estimateTotal).toLocaleString()}`
      : "quote request";
    const where = [input.city, input.state].filter(Boolean).join(", ");
    // The office needs to know WHICH this is: a fresh lead, or the same person back with new
    // answers on the lead they already have.
    const words = requestAlertWords(url, !!opts.cameBack);
    const title = `${words.head} — ${input.name}`;
    const body = [input.intake.projectType, money, where].filter(Boolean).join(" · ") || "New quote request";

    await createNotifications(orgId, staffIds, { type: "inquiry", title, body, url });
    await sendPushToProfiles(staffIds, "inquiry", { title, body, url });

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
        subject: `${words.subject}: ${input.name}${input.intake.estimateTotal ? ` (est. $${Math.round(input.intake.estimateTotal).toLocaleString()})` : ""}`,
        html: `<div style="font-family:ui-sans-serif,system-ui,Arial,sans-serif;max-width:520px;color:#0f172a">
          <h2 style="margin:0 0 6px">${words.head} — ${esc(input.name)}</h2>
          <p style="color:#475569;margin:0 0 12px">${esc(body)}</p>
          ${input.email ? `<p style="margin:2px 0">📧 ${esc(input.email)}</p>` : ""}
          ${input.phone ? `<p style="margin:2px 0">📞 ${esc(input.phone)}</p>` : ""}
          ${input.message ? `<p style="color:#334155;margin:12px 0;border-left:3px solid #cbd5e1;padding-left:10px">${esc(input.message)}</p>` : ""}
          <p style="margin:18px 0"><a href="${site}${url}" style="background:#0b57c4;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;display:inline-block">${words.button}</a></p>
          <p style="color:#94a3b8;font-size:12px">${words.footer}</p>
        </div>`,
      });
    }
  } catch {
    /* notifications are best-effort — the lead must still land even if alerts fail */
  }
}
