"use server";
import { dbError } from "@/lib/db-error";
import { placeJobOnDay } from "../schedule/actions";

import { customerAddressFrom } from "@/lib/inquiries/lead-address";
import { findMatchingCustomerId, type DupCustomer } from "@/lib/crm/duplicates";
import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { requireStaff } from "@/lib/staff-guard";
import { spreadTimes } from "@/lib/schedule/place-by-town";
import {
  appointmentTypeFor,
  bookingTitle,
  isWorkKind,
  spanEnd,
  workKind,
} from "@/lib/schedule/work-shape";
import { carryFromCustomer, matchKnownCustomer, type KnownCustomer } from "@/lib/inquiries/known-customer";
import { createServiceClient } from "@/lib/supabase/server";
import { formatPhone, formatState, formatZip, titleCase } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { PROJECT_TYPES, estimateLinesFromIntake } from "@/lib/lead-triage";
import { tzDateTimeUtc, todayStrInTz } from "@/lib/tz";
import { createProposalCore, cleanSlots, type ProposalSlot } from "@/lib/appointments/proposal";
import { INQUIRY_STATUSES, INSPECTION_TYPES } from "@/lib/statuses";
import { saveQuote } from "../quotes/actions";
import type { SupabaseClient } from "@supabase/supabase-js";
import { INTAKE_BUCKET, intakePaths, isOwnIntakePath } from "@/lib/playbook/uploads";
import { hasCaptureData } from "@/lib/inspections";
import { playbookForForm } from "@/lib/playbook/parse";
import { briefNote, carriedNote, carryForInquiry } from "@/lib/inquiries/carry-intake-answers";
import { runPlanBrief } from "@/lib/plan-brief-run";
import { rateLimited } from "@/lib/rate-limit";

export type Result = {
  ok: boolean;
  error?: string;
  id?: string;
  redirect?: string;
  /** "Let them pick" inspection proposal: the /pick/<token> link… */
  token?: string;
  /** …and the lead's phone, so the UI can prefill the sms: handoff. */
  phone?: string | null;
};

function orNull(s: string): string | null {
  const t = s.trim();
  return t.length ? t : null;
}

/** "YYYY-MM-DD" + n calendar days (tz-stable — noon UTC anchor). */
function ymdAddDays(ymd: string, n: number): string {
  return new Date(new Date(`${ymd}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

// When "contacted" is tapped with no explicit follow-up, schedule the next touch this
// many days out — enough to leave the My Day inbox, soon enough that the lead doesn't slip.
const FOLLOW_UP_DEFAULT_DAYS = 3;

/** The org timezone, for building "9 AM local" instants server-side. */
async function orgTimezone(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  return getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone;
}

/** Fields shared by create + update, read from a FormData. */
function inquiryFields(formData: FormData) {
  return {
    company_name: emptyToNull(formData.get("company_name")),
    type: String(formData.get("type") ?? "residential"),
    email: emptyToNull(formData.get("email")),
    phone: orNull(formatPhone(String(formData.get("phone") ?? ""))),
    address: emptyToNull(formData.get("address")),
    city: orNull(titleCase(String(formData.get("city") ?? ""))),
    state: orNull(formatState(String(formData.get("state") ?? ""))),
    zip: orNull(formatZip(String(formData.get("zip") ?? ""))),
    message: emptyToNull(formData.get("message")),
    notes: emptyToNull(formData.get("notes")),
    // Both nullable by design — "Not sure yet" is a real answer and the default (0230).
    work_kind: emptyToNull(formData.get("work_kind")),
    planned_minutes: Number(formData.get("planned_minutes")) || null,
  };
}

export async function createInquiry(formData: FormData): Promise<Result & { note?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const fields = inquiryFields(formData);
  // Fragment-first: a bare phone number is a valid lead (the missed-call case) —
  // default the name instead of blocking the capture.
  let name = String(formData.get("name") ?? "").trim();
  if (!name && (fields.phone || fields.message)) name = fields.phone ?? "Unknown caller";
  if (!name) return { ok: false, error: "Add a name, phone, or note to save the lead." };

  // A NEW LEAD IS A LEAD, NOT A BOOKING.
  //
  // This used to insert an appointments row — "Follow up: <name>", tomorrow at 9am — for every
  // lead created, so it would "land on the calendar instead of slipping through the cracks".
  // The intent was right and the mechanism was wrong. Nobody made that appointment with a
  // customer, so nobody ever completes it: five of them are sitting in production right now,
  // every one still status='scheduled', the oldest from Jul 20.
  //
  // Worse, it is indistinguishable from real work. Erik created ONE lead and did ONE
  // walk-through for Sarah Cain, and the system showed him three appointment rows — his
  // cancelled phone attempt, his completed one, and this phantom — all looking alike:
  // "i had a lead sarah cain and started an inspection and theres only one string and all this
  // other stuff is recorded and im completely confused by it."
  //
  // `inquiries.next_follow_up_at` already IS the follow-up list: /leads orders by it and the
  // Needs-action inbox feeds off it. So the lead carries its own date, and the calendar keeps
  // meaning "things I agreed to be somewhere for".
  const tz = await orgTimezone(supabase);

  /**
   * THE APP ALREADY KNOWS THIS PERSON (Erik, entering his real lead list: "lack of fluidity and
   * connectivity"). Measured on what he typed in one sitting: 12 leads, 5 already customers, 2
   * linked. For two of them the CUSTOMER row held a phone and an email and the lead came back
   * with neither — he typed a name and got a lead he could not call.
   *
   * RLS scopes this read to his org, so a name can only ever match his own customers. See
   * known-customer for why what he typed always wins, why the place carries all-or-nothing, and
   * why two people with one name link to neither.
   */
  let linkedCustomerId: string | null = null;
  let carried: Record<string, string> = {};
  let link_note: string | undefined;
  try {
    const { data: known } = await supabase
      .from("customers")
      .select("id, name, phone, email, address, city, state, zip, company_name")
      .limit(5000);
    const m = matchKnownCustomer(name, (known ?? []) as KnownCustomer[]);
    if (m.kind === "one") {
      linkedCustomerId = m.customer.id;
      const c = carryFromCustomer(fields as never, m.customer);
      carried = c.patch as Record<string, string>;
      link_note = c.note || `Linked to ${m.customer.name ?? "an existing customer"}.`;
    } else if (m.kind === "ambiguous") {
      // Deliberately unlinked — but say so, or he silently gets a duplicate he never notices.
      link_note = `You have ${m.count} customers named "${name}" — this lead wasn't linked to either. Open it and pick the right one.`;
    }
  } catch {
    // Never let the convenience break the capture. Fragment-first: the lead saves regardless.
  }

  const { data, error } = await supabase
    .from("inquiries")
    .insert({
      name,
      ...fields,
      ...carried,
      customer_id: linkedCustomerId,
      source: "manual",
      status: "new",
      // NO INVENTED DEADLINE. Erik: "this auto follow up one day later should default to open …
      // have it just say follow up and leave it on a list of follow ups."
      // Stamping tomorrow made every lead overdue the day after it was entered — twelve leads, all
      // red, about a date nobody chose. A lead needing a follow-up is a STATE, not a missed
      // appointment. Null means "on the follow-up list, no date promised"; the office sets a real
      // date when there is a real reason.
      next_follow_up_at: null,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  revalidatePath("/leads");
  // /schedule no longer needs waking: a new lead doesn't put anything on the calendar any more.
  // My Day does — the Needs-action inbox feeds off inquiries and their follow-up date.
  revalidatePath("/planner");
  return { ok: true, id: data.id, note: link_note };
}

export async function updateInquiry(id: string, formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const fields = inquiryFields(formData);
  // Fragment-first: same defaulting as create — a phone-only lead stays editable.
  let name = String(formData.get("name") ?? "").trim();
  if (!name && (fields.phone || fields.message)) name = fields.phone ?? "Unknown caller";
  if (!name) return { ok: false, error: "Add a name, phone, or note to save the lead." };

  const { error } = await supabase
    .from("inquiries")
    .update({ name, ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: dbError(error) };

  revalidatePath("/leads");
  return { ok: true };
}

/** Log contact now; optionally set/update the next follow-up date. */
export async function markInquiryContacted(id: string, nextFollowUp?: string | null): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const patch: Record<string, unknown> = {
    last_contacted_at: new Date().toISOString(),
    status: "contacted",
    updated_at: new Date().toISOString(),
  };
  if (nextFollowUp !== undefined) {
    // Caller passed an explicit date (or null to clear).
    patch.next_follow_up_at = nextFollowUp || null;
  } else {
    // The bare "contacted" checkbox (My Day inbox) passes no date. Contacting must
    // still MOVE the lead: the inbox re-includes any lead whose next_follow_up_at is
    // null or due (query.ts), so leaving it null pulled the just-contacted lead right
    // back — the "checking the box resets" report (Erik 2026-07-20). A contacted lead
    // must always carry a next touch, so default one a few days out — but only when the
    // lead has no FUTURE follow-up already, so an explicit snooze is never shortened.
    const { data: row } = await supabase
      .from("inquiries")
      .select("next_follow_up_at")
      .eq("id", id)
      .maybeSingle();
    const tz = await orgTimezone(supabase);
    const todayStr = todayStrInTz(tz);
    const cur = (row as { next_follow_up_at?: string | null } | null)?.next_follow_up_at ?? null;
    if (!cur || cur <= todayStr) patch.next_follow_up_at = ymdAddDays(todayStr, FOLLOW_UP_DEFAULT_DAYS);
  }
  const { error } = await supabase.from("inquiries").update(patch).eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/leads");
  // My Day's "Needs action" inbox lists open leads — mark-contacted from THERE (Alexa
  // 2026-07-20: "checking the box resets") needs the planner to re-fetch too, else the
  // lead reappears un-contacted. The My-Day-refresh law.
  revalidatePath("/planner");
  return { ok: true };
}

export async function setInquiryStatus(id: string, status: string): Promise<Result> {
  // inquiries.status is free text in the DB, so the spine is the only guard — an
  // unlisted value would vanish from every filtered leads view (same idiom as
  // setJobStatus / updateQuoteStatus).
  if (!(INQUIRY_STATUSES as readonly string[]).includes(status))
    return { ok: false, error: `Status must be one of: ${INQUIRY_STATUSES.join(", ")}.` };
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase
    .from("inquiries")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/leads");
  revalidatePath("/planner"); // My Day shows inquiry counts — keep it in sync
  return { ok: true };
}

export async function deleteInquiry(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Read the lead FIRST (RLS-scoped — proves it's this caller's own): its file paths and org id
  // are needed for the cleanup below, and they're unreadable after the row goes.
  const { data: inq } = await supabase.from("inquiries").select("id, org_id, intake").eq("id", id).maybeSingle();
  if (!inq) return { ok: false, error: "Lead not found." };
  // "Delete keeps nothing" has to include the lead's OUTSTANDING BOOKING LINKS (audit 7): a
  // deleted spam lead's /pick/<token> stayed live, and the recipient could still confirm a
  // "Site inspection" onto the org's real calendar. Cancel this lead's un-scheduled proposals
  // first; a proposal already CONFIRMED is a real appointment and deliberately survives.
  const { error: aErr } = await supabase
    .from("appointments")
    .delete()
    .eq("inquiry_id", id)
    .eq("status", "proposed");
  if (aErr) return { ok: false, error: dbError(aErr) };
  // AND ITS EMPTY WALK-THROUGHS (Erik: "we shouldnt hold onto old orphaned data anyway").
  // Andrew's first test lead left a blank "Site inspection: andrew cohen" behind — inquiry_id
  // nulled by the FK, no answers, no capture — a duplicate that later read as "the inspector
  // is empty". An inspection with FIELD DATA (photos, notes, measurements — hasCaptureData) or
  // already completed is real work and survives, link severed, exactly as before; one that was
  // only ever the lead's container dies with the lead. Answers alone don't save it: they were
  // carried FROM this lead, and the delete confirm says so.
  const { data: linkedInsp } = await supabase
    .from("appointments")
    .select("id, status, capture")
    .eq("inquiry_id", id)
    .in("type", [...INSPECTION_TYPES]);
  const emptyIds = (linkedInsp ?? [])
    .filter((a) => a.status !== "completed" && !hasCaptureData(a.capture))
    .map((a) => a.id);
  if (emptyIds.length) {
    const { error: eErr } = await supabase.from("appointments").delete().in("id", emptyIds);
    if (eErr) return { ok: false, error: dbError(eErr) };
  }
  // AND ITS UPLOADED FILES. The intake bucket only ever grew — a deleted lead's plan set sat in
  // storage forever with nothing pointing at it. Paths are minted per-upload (epoch+uuid), so no
  // other lead can reference them; the service client does the remove because the bucket is
  // private (no member delete policy), gated by the same own-org path check as every other
  // intake-file door. Best-effort AFTER validation: a storage hiccup shouldn't block the delete,
  // and once the row is gone there is no second chance to learn the paths.
  const orgId = String((inq as { org_id?: string }).org_id ?? "");
  const filePaths = intakePaths((inq as { intake?: unknown }).intake).filter((p) => isOwnIntakePath(orgId, p));
  if (filePaths.length) {
    await createServiceClient()
      .storage.from(INTAKE_BUCKET)
      .remove(filePaths)
      .then(
        () => undefined,
        () => undefined,
      );
  }
  const { error } = await supabase.from("inquiries").delete().eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/leads");
  revalidatePath("/schedule");
  revalidatePath("/inspections");
  return { ok: true };
}

/**
 * WHAT THE CUSTOMER ALREADY ANSWERED, READY TO GO ONTO THE WALK-THROUGH.
 *
 * Booking an inspection copied the lead's `message` — a flattened "Label: answer" summary — into
 * the appointment's notes and stopped there. The customer's structured answers, sitting in
 * `intake.intake_answers` since they filled the form on the contractor's website, were never
 * carried, so the inspector asked every one of them again on site and the estimator was handed
 * them back as a paragraph to re-read. See lib/inquiries/carry-intake-answers for which answers
 * may cross and why a measured one may not.
 *
 * Returns nulls when there is nothing to carry, so both booking paths can spread it unconditionally.
 */
// The lead → walk-through carry (intake answers + plan brief, person outranks machine) lives in
// lib/inquiries/carry-intake-answers so the one-tap Inspect-now door inherits the identical seed.

/**
 * Explicitly convert an inquiry. Nothing happens automatically — the caller
 * picks the target AND whether to link an existing customer or create one
 * from the inquiry's details. We stamp the inquiry so it leaves the open list
 * but stays as history.
 */
export async function convertInquiry(
  id: string,
  target: "inspection" | "customer" | "quote" | "estimate" | "job",
  opts: {
    customerId?: string | null;
    startDate?: string;
    /** Inspection "Let them pick": up to 3 date+time options → a proposed
     *  appointment + a public /pick link instead of a firm booking. */
    slots?: ProposalSlot[];
    /** Optional arrival-window note shown on the pick page ("8–10 AM"). */
    timeNote?: string | null;
    /** Firm booking only: the org-local time, default 09:00. Several visits placed on ONE day
     *  need different times — a customer expects "Tuesday around 10", and four walk-throughs all
     *  stamped 9:00 tells nobody anything. See scheduleLeadsOnDay. */
    startTime?: string;
  } = {},
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: inq } = await supabase.from("inquiries").select("*").eq("id", id).maybeSingle();
  if (!inq) return { ok: false, error: "Lead not found." };

  // Idempotency: a lead that's already been converted (customer/quote/estimate/job all stamp
  // converted_at) must not be re-converted, or a SECOND customer + estimate/job would be created.
  // This matters now because the provenance backlink deliberately re-surfaces converted leads on
  // /leads with a live Convert menu — so this is the backstop. Inspection is exempt: it leaves the
  // lead OPEN (converted_at stays null) so an inspected lead can still go on to become an estimate.
  // "Save as contact" on an already-converted lead just OPENS the card it already has — the
  // guard below exists to stop double-minting, and opening isn't minting.
  if (target === "customer" && inq.customer_id) {
    return { ok: true, id: inq.customer_id, redirect: `/crm/${inq.customer_id}` };
  }
  if (inq.converted_at && target !== "inspection" && target !== "customer") {
    return { ok: false, error: "This lead was already converted — open its customer or estimate instead." };
  }

  // INSPECTION — the pre-sale nerve, parallel to estimate. Books a site inspection onto the
  // Schedule and leaves the lead OPEN (converted_at stays null) so it can still become an
  // estimate afterward. No customer is forced — an inspection happens before the deal is won.
  // Two modes: "Book it" (a firm date, the original flow) and "Let them pick" (opts.slots →
  // a proposed appointment + a public /pick link the office texts to the lead).
  if (target === "inspection") {
    const tz = await orgTimezone(supabase);

    // "Let them pick": tentative appointment + pick-a-time link (shared core —
    // it also withdraws any earlier still-pending link for this same lead).
    const slots = cleanSlots(opts.slots, "09:00");
    if (slots.length) {
      const carry = await carryForInquiry(supabase, inq);
      const res = await createProposalCore(supabase, {
        // The SAME kind rule as "Book it" — which booking door the office pressed must never
        // change what the calendar says the visit is.
        type: appointmentTypeFor((inq as { work_kind?: string | null }).work_kind),
        title: bookingTitle(
          workKind({ kind: "lead", workKind: (inq as { work_kind?: string | null }).work_kind }),
          String(inq.name ?? ""),
        ),
        slots,
        timeNote: opts.timeNote ?? null,
        inquiryId: id,
        customerId: null, // deferred-customer doctrine: no contact row before the win
        location: inq.address,
        notes:
          [inq.message ?? inq.notes ?? null, carriedNote(carry.carried), briefNote(carry.briefCarried)]
            .filter(Boolean)
            .join("\n\n") || null,
        inspectionTemplateId: carry.inspectionTemplateId,
        inspectionAnswers: carry.inspectionAnswers,
        createdBy: ctx.userId,
        // 9 AM org-local tentative instant from the first offered slot.
        startsAtIso: tzDateTimeUtc(slots[0].date, slots[0].time, tz),
      });
      if (!res.ok) return { ok: false, error: res.error };
      const earliest = slots.map((s) => s.date).sort()[0];
      await supabase
        .from("inquiries")
        .update({
          status: "contacted",
          last_contacted_at: new Date().toISOString(),
          next_follow_up_at: earliest,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      revalidatePath("/leads");
      revalidatePath("/schedule");
      revalidatePath("/planner");
      return { ok: true, token: res.token, phone: inq.phone ?? null };
    }

    /* A SERVICE CALL IS A JOB. Erik, after paying Nora out through an appointment page: "nora is
       set as a service call which means im in and out and all the inspection estimate and all that
       stuff in the way... i dont need a pay now button on the inspection page i need a job page
       for the job that was done with a pay button."
       So a lead tagged JOB or SERVICE, given a firm day, doesn't book a visit at all — it BECOMES
       the job, placed on that day (multi-day spans and the start time included), with the job
       page's Done and Pay now waiting at the end. The inspection machinery never enters the
       picture, because nothing is being inspected: the work is sold and somebody is going to go do
       it. "Let them pick" keeps the appointment shape — a job can't be placed on an unchosen day. */
    const declaredKind = String((inq as { work_kind?: string | null }).work_kind ?? "");
    if ((declaredKind === "job" || declaredKind === "service") && opts.startDate) {
      const conv = await convertInquiry(id, "job", {});
      const jobId = conv.ok ? /^\/jobs\/(.+)$/.exec(conv.redirect ?? "")?.[1] : undefined;
      if (!conv.ok || !jobId) {
        return conv.ok ? { ok: false, error: "Couldn't turn this into a job." } : conv;
      }
      const placed = await placeJobOnDay(jobId, opts.startDate, opts.startTime);
      if (!placed.ok) {
        return { ok: false, error: placed.error ?? "The job was created but didn't land on the day — place it from the board." };
      }
      return { ok: true, redirect: `/jobs/${jobId}` };
    }

    // "Book it": a firm 9 AM slot — built in the ORG timezone (the old
    // `new Date(date+"T00:00:00"); setHours(9)` parsed as SERVER-local UTC,
    // landing the inspection at 2 AM Pacific).
    const startDate = opts.startDate || ymdAddDays(todayStrInTz(tz), 2);
    const startsAtIso = tzDateTimeUtc(startDate, /^\d{2}:\d{2}$/.test(opts.startTime ?? "") ? opts.startTime! : "09:00", tz);
    if (!startsAtIso) return { ok: false, error: "Pick a valid inspection date." };
    const carry = await carryForInquiry(supabase, inq);
    const kindChosen = workKind({ kind: "lead", workKind: (inq as { work_kind?: string | null }).work_kind });

    /* HOW LONG HE SAID, DRAWN AS HOW LONG HE SAID.
       Erik: "i just scheduled Matt warren for monday for a whole day as a job and it showed up as
       an inspection for an hour."

       planned_minutes was written faithfully — and nothing draws it. The calendar sizes a block
       from ends_at, and this insert never set one, so TimeGrid fell back to its `startMin + 60`
       default and every booking became a one-hour pill no matter what the office entered. A full
       day and a half-hour service call rendered identically, which makes the number he was asked
       for pointless at the exact moment it was supposed to pay off.

       Clamped to one working day: planned_minutes is a WORK-LOAD figure, and spending 960 ("2
       days") as wall clock from 8am ends the appointment at midnight. A multi-day visit is a span
       of days, not one very long block. */
    const sized = Number((inq as { planned_minutes?: number | null }).planned_minutes ?? 0);
    const startHm = /^\d{2}:\d{2}$/.test(opts.startTime ?? "") ? opts.startTime! : "09:00";
    /* A WEEK ENDS ON FRIDAY. Clamping a multi-day size to one working day is how "a week" showed up
       as a Monday; spending it as wall clock would end it at 2am. spanEnd walks the working days
       and finishes at the same hour on the last one. */
    const span = spanEnd(startDate, startHm, sized);
    const endsAtIso = span
      ? tzDateTimeUtc(span.lastYmd, span.endHHMM, tz)
      : null;

    const { error: aErr } = await supabase.from("appointments").insert({
      // THE TAG THE OFFICE PICKED ON THE LEAD, not a hard-coded "inspection". Erik: "if we enter
      // that data on the lead view itself and editable on the schedule page we might be getting
      // somewhere." One choice, made once, at the moment somebody knew — and it survives to the
      // calendar chip instead of being re-decided here. Falls back to inspection, which is what a
      // lead's next step is when nobody has said otherwise.
      type: appointmentTypeFor((inq as { work_kind?: string | null }).work_kind),
      // …and how long they said it would take, so the day it lands on knows its own load.
      planned_minutes: (inq as { planned_minutes?: number | null }).planned_minutes ?? null,
      // The name follows the kind. "Site inspection: Matt Warren" on a day booked as a full day of
      // work is the app describing what he did back to him, wrongly, where he goes to check.
      title: bookingTitle(kindChosen, String(inq.name ?? "")),
      starts_at: startsAtIso,
      ends_at: endsAtIso,
      location: inq.address,
      notes:
        [inq.message ?? inq.notes ?? null, carriedNote(carry.carried), briefNote(carry.briefCarried)]
          .filter(Boolean)
          .join("\n\n") || null,
      // The customer's own answers, on the walk-through, so the inspector CONFIRMS rather than
      // re-asks — which is what the Tahoe Deck starter has claimed since it was written.
      inspection_template_id: carry.inspectionTemplateId,
      inspection_answers: carry.inspectionAnswers,
      customer_id: opts.customerId || inq.customer_id || null,
      inquiry_id: id, // provenance: the calendar entry knows its lead
      created_by: ctx.userId,
    });
    if (aErr) return { ok: false, error: aErr.message };
    // Engaged, not closed: mark contacted and resurface the lead around the inspection date.
    await supabase
      .from("inquiries")
      .update({
        status: "contacted",
        last_contacted_at: new Date().toISOString(),
        next_follow_up_at: startDate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    revalidatePath("/leads");
    revalidatePath("/schedule");
    revalidatePath("/planner");
    return { ok: true, redirect: `/schedule?view=day&date=${startDate}` };
  }

  // ESTIMATE — the deferred-customer path (Erik's flow: a prospect becomes a saved Contact ONLY when
  // the estimate is ACCEPTED, not when it's drafted). We create NO customer here — the estimate
  // carries inquiry_id, and updateQuoteStatus('accepted') / accept_public_quote materialize the
  // customer (with a dedup crosscheck against the existing book) at the win. The lead is stamped
  // 'quoted' so it leaves the open list (exactly as before), but its customer_id stays null until the
  // estimate is accepted. (An org that explicitly links an existing customer still can, via opts.)
  if (target === "quote") {
    // A contact SAVED FROM THIS LEAD rides along (audit 7: 'Save as contact' then 'Create
    // estimate' nulled the very link the first button minted — acceptance then fell back to
    // fuzzy dedup and could mint a duplicate). Mirrors the inspection branch's pattern.
    const linkedCustomer = opts.customerId ?? inq.customer_id ?? null;
    let redirect: string;
    const lines = estimateLinesFromIntake(inq.intake);
    if (lines.length) {
      // Lead arrived with a priced estimate (Tahoe Deck configurator) → seed a real draft and open it.
      const { data: orgRow } = await supabase.from("organizations").select("settings").maybeSingle();
      const validUntil = new Date();
      validUntil.setDate(validUntil.getDate() + (getOrgSettings(orgRow?.settings).quote_expiry_days || 30));
      const label = PROJECT_TYPES.find((p) => p.value === inq.project_type)?.label;
      const reason = typeof (inq.intake as { reason?: unknown } | null)?.reason === "string"
        ? (inq.intake as { reason: string }).reason
        : null;
      const res = await saveQuote({
        customer_id: linkedCustomer, // null → the estimate stands alone until accepted
        inquiry_id: id, // provenance: this estimate traces back to the lead
        title: label ? `${label} — ${inq.name}` : `Estimate — ${inq.name}`,
        notes: reason ? `From lead — ${reason}` : "From lead.",
        tax_rate: 0, // never infer tax on a seeded draft; the office sets it on review
        valid_until: validUntil.toISOString().slice(0, 10),
        items: lines,
      });
      if (!res.ok) return { ok: false, error: res.error };
      redirect = `/quotes/${res.id}`;
    } else {
      // Manual lead → open the blank builder threaded to the inquiry (no customer forced).
      redirect = linkedCustomer
        ? `/quotes/new?customer=${linkedCustomer}&inquiry=${id}`
        : `/quotes/new?inquiry=${id}`;
    }
    // NO STAMP HERE. The lead converts when the estimate actually LANDS — saveQuote stamps it
    // (converted_to/at + status, first-deed-only). Andrew's lead was stamped 'quoted' at this
    // click, then the blank builder was abandoned: no quote existed, the lead had left the
    // inbox, and the plan set he'd uploaded became unreachable. The seeded branch above already
    // went through saveQuote; the blank branch converts on the builder's own save.
    revalidatePath("/leads");
    revalidatePath("/quotes");
    return { ok: true, redirect };
  }

  // Resolve the customer: link the chosen existing one, or create from inquiry.
  // (Reached only by the commit-now targets: customer / estimate-job / job.)
  // A lead that already carries a contact opens it — "save as contact" twice must never mean
  // two cards for one person.
  if (target === "customer" && inq.customer_id) {
    return { ok: true, id: inq.customer_id, redirect: `/crm/${inq.customer_id}` };
  }
  let customerId = opts.customerId || null;
  if (!customerId) {
    // CROSSCHECK THE BOOK before minting (audit 7): "Save as contact" on a lead from an
    // EXISTING customer silently minted a second card — future jobs then split across the two.
    // Same phone/email/normalized-name keys the CRM's duplicate finder and acceptance use.
    const { data: book } = await supabase.from("customers").select("id, name, company_name, email, phone");
    customerId = findMatchingCustomerId(
      { name: inq.name, email: inq.email, phone: inq.phone },
      (book ?? []) as DupCustomer[],
    );
  }
  if (!customerId) {
    const { data: cust, error: cErr } = await supabase
      .from("customers")
      .insert({
        name: inq.name,
        company_name: inq.company_name,
        type: inq.type ?? "residential",
        status: "active",
        email: inq.email,
        phone: inq.phone,
        // THE PERSON'S ADDRESS, not the site (0189) — one helper, both directions, so the write
        // side and this read side cannot drift into printing a home address as a job site.
        ...customerAddressFrom(inq),
        notes: inq.message ? `From inquiry: ${inq.message}` : inq.notes,
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (cErr) return { ok: false, error: cErr.message };
    customerId = cust.id;
  }

  let redirect = `/crm/${customerId}`;
  let newStatus = "won";

  if (target === "estimate" || target === "job") {
    // An estimate is still in the pipeline; a scheduled job means the inquiry is won.
    newStatus = target === "estimate" ? "quoted" : "won";
    const { data: job, error: jErr } = await supabase
      .from("jobs")
      .insert({
        customer_id: customerId,
        inquiry_id: id, // provenance: this estimate/job traces back to the lead
        name: `Job — ${inq.name}`,
        description: inq.message ?? null,
        // The size he set on the lead — the flow's whole point is that a fact stated once
        // survives every step (the appointment path already carries it; the job path dropped it).
        planned_minutes: (inq as { planned_minutes?: number | null }).planned_minutes ?? null,
        // Lifecycle rework (2026-07): "estimate" is a QUOTE stage, not a job status — a job
        // born from a lead starts in the to_be_scheduled waiting room either way.
        status: "to_be_scheduled",

        address: inq.address,
        city: inq.city,
        state: inq.state,
        zip: inq.zip,
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (jErr) return { ok: false, error: jErr.message };
    redirect = `/jobs/${job.id}`;
  }

  /**
   * SAVING A CONTACT IS NOT WINNING THE LEAD. Erik: "a lead can convert to a contact anytime if
   * the person wants to create one, but if its a lead that doesnt accept then its wasted space so
   * it shouldnt be required, and should auto convert when the lead gets accepted."
   *
   * The three legs of that ruling, and where each lives:
   *   · AUTO on acceptance — already the law (cn-v477): updateQuoteStatus('accepted') and
   *     accept_public_quote mint the customer, with dedup.
   *   · NEVER REQUIRED — every picker got an inline create in cn-v721, and estimates/invoices
   *     work customerless, carrying inquiry_id.
   *   · ANYTIME, WITHOUT CLOSING — this branch. It used to stamp converted_at and force status
   *     "won", so making a contact card ended the lead's life in the pipeline. A contact is a
   *     card, not a verdict: the lead stays open, keeps its follow-ups, and can still lose —
   *     at which point the card is just a person you know, which is what a contact book is for.
   */
  const isContactOnly = target === "customer";
  const { error: uErr } = await supabase
    .from("inquiries")
    .update({
      customer_id: customerId,
      updated_at: new Date().toISOString(),
      ...(isContactOnly
        ? {}
        : { converted_to: target, converted_at: new Date().toISOString(), status: newStatus }),
    })
    .eq("id", id);
  if (uErr) return { ok: false, error: uErr.message };

  revalidatePath("/leads");
  revalidatePath("/crm");
  return { ok: true, id: customerId ?? undefined, redirect };
}

/**
 * A SHORT-LIVED LINK to something a customer uploaded through the public intake door.
 *
 * The paths live in the lead's `intake.intake_answers`; the bucket is private (0186), so nothing
 * is readable without one of these. Staff-only and re-checked against the CALLER'S OWN org — the
 * lead row is read through the caller's RLS client first and the path must sit inside that org's
 * folder, so a guessed path from another tenant resolves to nothing. Ten minutes is enough to open
 * a drawing and short enough that a copied URL dies before it travels.
 */
/**
 * READ (or re-read) a lead's plans into the preliminary report — the staff door to the same
 * runner the intake submit kicks in the background. Covers every lead the automatic pass missed:
 * uploads from before the feature shipped, a run that died mid-read, a re-read after the
 * customer sends a corrected set.
 *
 * Synchronous on purpose: the person tapping the button wants the report, and an honest wait
 * with a result beats a fire-and-forget that may have failed. Membership is proven by the
 * RLS-scoped read; the runner itself re-pins org_id on every query.
 */
export async function refreshPlanBrief(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  const { data: inq } = await ctx.supabase.from("inquiries").select("id, org_id").eq("id", id).maybeSingle();
  if (!inq) return { ok: false, error: "Lead not found." };
  if (await rateLimited(`plan-brief-manual:${ctx.userId}`, 10, 900, { failClosed: true })) {
    return { ok: false, error: "A lot of readings in a row — give it a few minutes." };
  }
  const r = await runPlanBrief(String((inq as { org_id?: string }).org_id ?? ""), id);
  revalidatePath("/leads");
  revalidatePath("/planner");
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function intakeFileUrl(
  inquiryId: string,
  path: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };

  // Authorize through the caller's own RLS-scoped read, then trust only what it returned.
  const { data: inq } = await ctx.supabase.from("inquiries").select("id, org_id, intake").eq("id", inquiryId).maybeSingle();
  if (!inq) return { ok: false, error: "Not found." };
  const orgId = String((inq as { org_id?: string }).org_id ?? "");
  if (!orgId) return { ok: false, error: "Not found." };
  if (!isOwnIntakePath(orgId, path)) return { ok: false, error: "Not found." };

  // And the path must be one this lead actually carries — not merely one shaped like it.
  const answers = ((inq as { intake?: { intake_answers?: Record<string, unknown> } }).intake?.intake_answers ?? {}) as Record<string, unknown>;
  const known = Object.values(answers).some((v) => Array.isArray(v) && v.includes(path));
  if (!known) return { ok: false, error: "Not found." };

  const { data, error } = await createServiceClient()
    .storage.from(INTAKE_BUCKET)
    .createSignedUrl(path, 600);
  if (error || !data?.signedUrl) return { ok: false, error: "Couldn't open that file." };
  return { ok: true, url: data.signedUrl };
}


/**
 * PUT SEVERAL LEADS ON ONE DAY.
 *
 * Erik: "i want to be able to schedule them together" — after his bug report "how do I put these
 * on the schedule is the big denny". He had 32 open leads, 27 with addresses, and ZERO future
 * appointments, because the only route was one lead at a time and nothing ever showed him that
 * five of them are in Truckee.
 *
 * ONE PATH, N TIMES. This does not write appointments itself: it calls convertInquiry's firm
 * booking once per lead. A second way to put something on the calendar is how two surfaces start
 * disagreeing about what a booking is — the carry-forward of intake answers, the provenance
 * backlink, the lead being marked contacted and resurfaced on the visit date, all of it happens
 * here for free because it is the same code.
 *
 * The times spread across the day in the ORDER GIVEN, so the caller's sort (town, then urgency)
 * survives into the day itself — the rail's order is the driving order.
 *
 * NOTHING SILENT: every lead's outcome comes back. Booking four and having one fail while the UI
 * says "done" is exactly the failure that makes somebody stop trusting a batch action, so the
 * result names which ones landed and which didn't.
 */
export async function scheduleLeadsOnDay(
  leadIds: string[],
  date: string,
  opts: { startTime?: string; stepMinutes?: number } = {},
): Promise<{ ok: boolean; error?: string; booked: number; failures: { id: string; error: string }[] }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error, booked: 0, failures: [] };
  const ids = [...new Set(leadIds.filter(Boolean))];
  if (!ids.length) return { ok: false, error: "Pick at least one lead.", booked: 0, failures: [] };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Pick a day.", booked: 0, failures: [] };

  /* ── ONE VISIT PER LEAD, ON THIS PATH ──────────────────────────────────────────────────────
     convertInquiry's inspection branch is deliberately exempt from the already-converted guard —
     an inspected lead can still become an estimate — and it has no existence check, so calling it
     twice mints a second walk-through. That is correct for the single "Inspect" button, where a
     person deliberately asks for another visit. It is NOT correct here: this is the BATCH path
     behind "put these on Thursday", where a repeat is a slip (a stale tab, a double tap, a page
     that hadn't refreshed) and never an intention.
     Belt to the rail's braces — the schedule page already drops booked leads from the board, but a
     filter at one read path is a convention; refusing the write is the boundary. And it is a
     refusal with a reason, not a silent skip: he is told the visit already exists. */
  const { data: existing } = await ctx.supabase
    .from("appointments")
    .select("inquiry_id")
    .in("inquiry_id", ids)
    // Any non-cancelled booking counts — a lead placed as a job (0231) is just as booked as one
    // placed as a walk-through.
    .neq("status", "cancelled")
    .limit(500);
  const alreadyBooked = new Set(
    ((existing ?? []) as { inquiry_id: string | null }[]).map((r) => String(r.inquiry_id)),
  );

  const times = spreadTimes(ids.length, opts.startTime ?? "09:00", opts.stepMinutes ?? 90);
  const failures: { id: string; error: string }[] = [];
  let booked = 0;
  // Sequential on purpose: each booking reads its lead and carries its intake answers, and firing
  // them in parallel would race the same org's numbering and revalidation for no real gain at
  // the sizes this is used at (a day is a handful of stops, not a hundred).
  for (let i = 0; i < ids.length; i++) {
    if (alreadyBooked.has(ids[i])) {
      failures.push({ id: ids[i], error: "This one already has a visit booked — move that one instead." });
      continue;
    }
    // The job/service fork lives INSIDE convertInquiry's firm-booking branch now — one fork,
    // every door (this rail, the lead modal's "Book it") behaves identically.
    const res = await convertInquiry(ids[i], "inspection", { startDate: date, startTime: times[i] });
    if (res.ok) booked++;
    else failures.push({ id: ids[i], error: res.error ?? "Couldn't book this one." });
  }
  revalidatePath("/leads");
  revalidatePath("/schedule");
  revalidatePath("/planner");
  return { ok: booked > 0, booked, failures, error: booked ? undefined : failures[0]?.error };
}

/**
 * SIZE THE WORK FROM WHEREVER YOU ARE.
 *
 * Erik: "if we enter that data on the lead view itself and editable on the schedule page we might
 * be getting somewhere." The lead form is where the answer usually arrives — on the call — but the
 * moment you actually NEED the number is while filling a day, and making him leave the schedule,
 * find the lead, edit it, and come back is the round trip he says costs him the most.
 *
 * Both fields independently optional: sizing something you already tagged must not force you to
 * re-pick the tag, and vice versa. Passing neither is a no-op rather than an error.
 */
export async function sizeLead(
  id: string,
  patch: { workKind?: string | null; plannedMinutes?: number | null },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const clean: Record<string, unknown> = {};
  if (patch.workKind !== undefined) {
    const k = String(patch.workKind ?? "").trim();
    // Against the ONE list (lib/schedule/work-shape), not a copy of it. The copy that used to live
    // here is what refused "Phone call" the hour it was added.
    if (k && !isWorkKind(k) && k !== "other") return { ok: false, error: "That isn't a kind of work." };
    clean.work_kind = k || null; // "" clears it back to "not sure yet"
  }
  if (patch.plannedMinutes !== undefined) {
    const m = Number(patch.plannedMinutes) || 0;
    if (m < 0 || m > 60 * 24 * 30) return { ok: false, error: "That duration isn't sensible." };
    clean.planned_minutes = m > 0 ? m : null; // 0 means "not sure yet", never a zero-length job
  }
  if (!Object.keys(clean).length) return { ok: true };
  clean.updated_at = new Date().toISOString();
  // THE SILENT-WRITE LAW: a zero-row update is a 204, not an error.
  const { data, error } = await ctx.supabase.from("inquiries").update(clean).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That lead isn't available." };
  revalidatePath("/leads");
  revalidatePath("/schedule");
  return { ok: true };
}
