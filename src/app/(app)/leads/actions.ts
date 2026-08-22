"use server";
import { dbError } from "@/lib/db-error";

import { customerAddressFrom } from "@/lib/inquiries/lead-address";
import { findMatchingCustomerId, type DupCustomer } from "@/lib/crm/duplicates";
import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { requireStaff } from "@/lib/staff-guard";
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
  };
}

export async function createInquiry(formData: FormData): Promise<Result> {
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
  const { data, error } = await supabase
    .from("inquiries")
    .insert({
      name,
      ...fields,
      source: "manual",
      status: "new",
      next_follow_up_at: ymdAddDays(todayStrInTz(tz), 1),
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  revalidatePath("/leads");
  // /schedule no longer needs waking: a new lead doesn't put anything on the calendar any more.
  // My Day does — the Needs-action inbox feeds off inquiries and their follow-up date.
  revalidatePath("/planner");
  return { ok: true, id: data.id };
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
        type: "inspection",
        title: `Site inspection: ${inq.name}`,
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

    // "Book it": a firm 9 AM slot — built in the ORG timezone (the old
    // `new Date(date+"T00:00:00"); setHours(9)` parsed as SERVER-local UTC,
    // landing the inspection at 2 AM Pacific).
    const startDate = opts.startDate || ymdAddDays(todayStrInTz(tz), 2);
    const startsAtIso = tzDateTimeUtc(startDate, "09:00", tz);
    if (!startsAtIso) return { ok: false, error: "Pick a valid inspection date." };
    const carry = await carryForInquiry(supabase, inq);
    const { error: aErr } = await supabase.from("appointments").insert({
      type: "inspection",
      title: `Site inspection: ${inq.name}`,
      starts_at: startsAtIso,
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
