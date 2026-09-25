import { z } from "zod";
import { APPOINTMENT_TYPES } from "@/lib/statuses";
import {
  createAppointment,
  linkAppointmentTo,
  setAppointmentOutcome,
  setAppointmentStatus,
  rescheduleAppointment,
} from "@/app/(app)/appointments/actions";
import { createClient } from "@/lib/supabase/server";
import { localToInstant, orgTimezone, quotedData, spokenWhen } from "@/lib/org-local-time";
import { resolveCustomerId, resolveJobId } from "../resolve-id";
import type { ActionDef, ActionResult } from "../types";

/** The words every appointment tool says about time, once, so they can't drift apart. */
const LOCAL_TIME_RULE =
  "Times are the company's LOCAL wall-clock time, written YYYY-MM-DDTHH:MM with NO Z and NO offset ('tomorrow at 10 AM' = <tomorrow>T10:00); the app converts it to the stored instant. Confirm to the user from the result's `recorded` line (what was actually stored), never from your own words.";

type Db = Awaited<ReturnType<typeof createClient>>;

/** ANNOUNCE THE DEED: read the row back and say its time in the org timezone. A write that stored
 *  the wrong hour then SAYS the wrong hour; the old reply repeated the model's intent, which is how
 *  "Booked, tomorrow at 10 AM" went out over a row stored at 3 AM Pacific (2026-09-24). */
async function readBack(supabase: Db, id: string, tz: string, verb: string): Promise<string | null> {
  const { data } = await supabase
    .from("appointments")
    .select("title, starts_at, ends_at, customers(name)")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as {
    title?: string | null;
    starts_at?: string | null;
    ends_at?: string | null;
    customers?: { name?: string | null } | null;
  };
  return appointmentRecorded(verb, row, tz);
}

/** The `recorded` sentence for a stored appointment row (pure, so it is testable without a DB). */
export function appointmentRecorded(
  verb: string,
  row: { title?: string | null; starts_at?: string | null; ends_at?: string | null; customers?: { name?: string | null } | null },
  tz: string,
): string {
  const end = endSaid(row.starts_at, row.ends_at, tz);
  const who = row.customers?.name ? `, customer ${quotedData(row.customers.name)}` : ", no customer linked";
  // Title and name are database free text (a lead's name can reach the title): quoted, as data.
  return `${verb}: ${quotedData(row.title ?? "appointment")}, ${spokenWhen(row.starts_at, tz)}${end}${who}.`;
}

/** "until 10:00 AM PDT" on the same org-local day; the end's day too when it falls on another day;
 *  and a plain warning when the stored end is at or before the start, so the read-back never makes
 *  a broken row sound like a normal visit (audit v994 SI1). */
function endSaid(startIso: string | null | undefined, endIso: string | null | undefined, tz: string): string {
  if (!endIso) return "";
  const endWhen = spokenWhen(endIso, tz);
  const s = startIso ? new Date(startIso).getTime() : NaN;
  const e = new Date(endIso).getTime();
  if (Number.isFinite(s) && Number.isFinite(e) && e <= s) {
    return `, and its stored end (${endWhen}) is not after its start, so the end needs fixing`;
  }
  const day = (iso: string) => spokenWhen(iso, tz).replace(/ at .*$/, "");
  const sameDay = !!startIso && day(startIso) === day(endIso);
  return `, until ${sameDay ? endWhen.replace(/^.* at /, "") : endWhen}`;
}

/** Convert the model's start (and optional end) in the org timezone, or say why not. */
function convertSpan(
  startsAt: string,
  endsAt: string | null | undefined,
  tz: string,
): { start: string; end: string | null } | { error: string } {
  const start = localToInstant(startsAt, tz);
  if ("error" in start) return start;
  if (!endsAt) return { start: start.iso, end: null };
  const end = localToInstant(endsAt, tz);
  if ("error" in end) return end;
  return { start: start.iso, end: end.iso };
}

export const appointmentActions: Record<string, ActionDef> = {
  "appointment.update": {
    name: "appointment.update",
    group: "appointment",
    label: "Reschedule appointment",
    description:
      "Reschedule an appointment / inspection to a new time — e.g. 'move the Smith inspection to Thursday at 9am'. Find it first with schedule_overview (it returns the id), then pass that id plus the new starts_at (optionally ends_at). Without ends_at the visit keeps its length and the end moves with it. Keeps everything else; no cancel+recreate. " +
      LOCAL_TIME_RULE,
    input: z.object({ id: z.string(), starts_at: z.string().min(1), ends_at: z.string().nullable().optional() }),
    auth: "staff",
    effect: "write",
    // Moving a real appointment by VOICE is Erik's "swap days while driving" hazard: a stray
    // spoken word must not silently reschedule. Gate the AGENT route so Nort PROPOSES the new
    // day/time and waits for the spoken yes (the UI drag/edit path is exempt — a human tap IS
    // the consent). "destructive", not "financial" — no money, but it clobbers a scheduled time.
    confirm: "destructive",
    // Read the day/time straight off the string the model passed: its wall-clock time, which the
    // handler converts in the org timezone. A string carrying its own offset (a stamped Z) says so
    // out loud ("at 10am UTC"), because that one is stored as given and is not company-local.
    describe: (i) => `Move this appointment to ${readbackWhen(i.starts_at)}? Check the details below before you confirm.`,
    handler: async (i) => {
      const supabase = await createClient();
      const tz = await orgTimezone(supabase);
      const span = convertSpan(i.starts_at, i.ends_at, tz);
      if ("error" in span) return { ok: false, error: span.error };
      const r = await rescheduleAppointment(i.id, span.start, span.end);
      if (!r.ok) return r;
      const recorded = await readBack(supabase, i.id, tz, "Moved");
      return { ...r, ...(recorded ? { recorded } : {}) };
    },
  },
  "appointment.create": {
    name: "appointment.create",
    group: "appointment",
    label: "Add appointment",
    description:
      "Create an appointment or inspection with a title and a start time (starts_at). Optionally capture whatever else was given: job_id (resolve with list_jobs), customer_id (resolve with list_customers), location, ends_at, notes. " +
      LOCAL_TIME_RULE +
      " When the person isn't in the contacts yet, book it without a customer; if you then add them with customer.create, its result offers the link.",
    // Fragment-first: the columns are nullable and createAppointment already reads every
    // one of these — the old 3-field schema silently DROPPED a spoken job/location/end time.
    // Only starts_at stays required (an appointment without a time isn't schedulable).
    input: z.object({
      title: z.string().trim().min(1),
      type: z.enum(APPOINTMENT_TYPES as unknown as [string, ...string[]]).default("appointment"), // spine-derived (statuses.ts) — was a hand-rolled 2-value list that dropped meeting/final_inspection
      starts_at: z.string().min(1),
      ends_at: z.string().nullable().optional(),
      job_id: z.string().nullable().optional(),
      customer_id: z.string().nullable().optional(),
      location: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    // Wrap the canonical createAppointment (trim+validate, revalidate, the nullable fields) via a
    // FormData — no duplicated write-path. createAppointment trusts starts_at_iso as an INSTANT
    // (the browser computes it), so the model's wall-clock time is converted HERE first: handing
    // it "2026-09-25T10:00" stored 10:00 UTC, 3 AM Pacific (Tom Goodman, 2026-09-24).
    handler: async (i) => {
      const supabase = await createClient();
      const tz = await orgTimezone(supabase);
      const span = convertSpan(i.starts_at, i.ends_at, tz);
      if ("error" in span) return { ok: false, error: span.error };
      // Forgive a job/customer NAME where an id belongs — resolve each to a single match first.
      const job = await resolveJobId(supabase, i.job_id ?? null);
      if ("error" in job) return { ok: false, error: job.error };
      const cust = await resolveCustomerId(supabase, i.customer_id ?? null);
      if ("error" in cust) return { ok: false, error: cust.error };
      const fd = new FormData();
      fd.set("title", i.title);
      fd.set("type", i.type);
      fd.set("starts_at_iso", span.start);
      if (span.end) fd.set("ends_at_iso", span.end);
      if (job.id) fd.set("job_id", job.id);
      if (cust.id) fd.set("customer_id", cust.id);
      if (i.location) fd.set("location", i.location);
      if (i.notes) fd.set("notes", i.notes);
      const r = await createAppointment(fd);
      if (!r.ok || !r.id) return r;
      const recorded = await readBack(supabase, r.id, tz, "Booked");
      return { ...r, data: { id: r.id }, ...(recorded ? { recorded } : {}) };
    },
  },
  /** The door the Tom Goodman conversation was missing (2026-09-24): Nort booked the inspection,
   *  added him as a customer, asked "Want me to link him to tomorrow's inspection?", and had no
   *  verb to do it with. The same weight as appointment.create, which can already set customer_id
   *  itself; it wraps the inspector's own link door (linkAppointmentTo), so it fills an empty
   *  address and never overwrites one. */
  "appointment.linkCustomer": {
    name: "appointment.linkCustomer",
    group: "appointment",
    label: "Link appointment to customer",
    description:
      "Attach a customer to an appointment / inspection ('link Tom to tomorrow's inspection'). Pass the appointment id (from customer.create's link_offer, or schedule_overview) and customer_id (an id, or the exact name). ONLY call this after the user said yes to linking: offering is your job, deciding is theirs. Confirm from the result's `recorded` line.",
    input: z.object({ id: z.string().min(1), customer_id: z.string().min(1) }),
    auth: "staff",
    effect: "write",
    handler: async (i): Promise<ActionResult> => {
      const supabase = await createClient();
      const cust = await resolveCustomerId(supabase, i.customer_id);
      if ("error" in cust) return { ok: false, error: cust.error };
      if (!cust.id) return { ok: false, error: "Which customer should I link?" };
      const r = await linkAppointmentTo(i.id, "customer", cust.id);
      if (!r.ok) return r;
      const tz = await orgTimezone(supabase);
      const recorded = await readBack(supabase, i.id, tz, "Linked");
      return { ...r, ...(recorded ? { recorded } : {}) };
    },
  },
  "appointment.setStatus": {
    name: "appointment.setStatus",
    group: "appointment",
    label: "Set appointment status",
    description: "Set an appointment's status (e.g. completed, cancelled, scheduled).",
    input: z.object({ id: z.string(), status: z.string() }),
    auth: "staff", // appointments are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    // Cancelling/completing a real appointment by voice is the same "one stray word" hazard as a
    // move — gate the AGENT route so Nort reads the change back and waits for the yes. Cancelling
    // also withdraws the live pick-a-time link, so this is not a cheap undo. UI is exempt.
    confirm: "destructive",
    describe: (i) => `${statusVerb(i.status)} this appointment? Check the details below before you confirm.`,
    handler: (i) => setAppointmentStatus(i.id, i.status),
  },
  /** How a walk-through ended (0205) — the exit the inbox was missing. */
  "appointment.setOutcome": {
    name: "appointment.setOutcome",
    group: "appointment",
    label: "Record how it ended",
    description:
      "Record how a walk-through ended: 'lost' (didn't win the bid), 'no_bid' (decided not to quote it), or 'won'. Use it when the user says they lost a bid, aren't pursuing it, or already handled the work — it clears the visit from Needs action without inventing an estimate.",
    input: z.object({ id: z.string(), outcome: z.enum(["won", "lost", "no_bid"]) }),
    auth: "staff",
    effect: "write",
    handler: (i) => setAppointmentOutcome(i.id, i.outcome),
  },
};

/** Read an ISO datetime back as a spoken day + time WITHOUT a tz conversion — pull the fields
 *  straight off the string the model passed (the user's stated local wall-clock), the same way
 *  time.fixEntry's describe avoids a shifted hour. Falls back to the raw string if it's not ISO.
 *  A string carrying its own offset is NOT company-local (the handler stores it as given), so the
 *  offset is spoken too: "at 10am UTC" is a question a person can say no to. */
export function readbackWhen(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, hh, mm] = m;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Date-only math for the weekday name (noon UTC dodges any DST edge); the CLOCK comes from the
  // raw hh:mm above, never from this Date, so no tz shift reaches the read-back time.
  const dow = days[new Date(Date.UTC(+y, +mo - 1, +d, 12)).getUTCDay()];
  let h = +hh;
  const ampm = h < 12 ? "am" : "pm";
  h = h % 12 || 12;
  const time = +mm === 0 ? `${h}${ampm}` : `${h}:${mm}${ampm}`;
  const off = iso.trim().match(/(Z|[+-]\d{2}:?\d{2})$/i);
  const zone = !off ? "" : off[1].toUpperCase() === "Z" ? " UTC" : ` UTC${off[1]}`;
  return `${dow} ${+mo}/${+d} at ${time}${zone}`;
}

/** The verb for a setStatus read-back — "Cancel" / "Mark complete" / a generic "Set … to <status>". */
function statusVerb(status: string): string {
  const s = status.toLowerCase();
  if (s === "cancelled" || s === "canceled") return "Cancel";
  if (s === "completed") return "Mark complete";
  if (s === "scheduled") return "Re-open (mark scheduled)";
  return `Set the status to "${status}" on`;
}
