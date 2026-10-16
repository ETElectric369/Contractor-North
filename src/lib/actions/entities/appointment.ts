import { z } from "zod";
import { PICKABLE_APPOINTMENT_TYPES } from "@/lib/statuses";
import {
  createAppointment,
  linkAppointmentTo,
  setAppointmentOutcome,
  setAppointmentPlace,
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

/** A text the model may leave EMPTY. It says the emptiness as a WORD — "null", "none", "" — not as
 *  JSON null (ends_at: "null", 2026-10-16: the confirm card read "ends at: null" and the yes failed
 *  with "I couldn't read "null" as a date and time"). The words become null before the card is
 *  built: the card shows only what will run. */
const EMPTY_WORDS = new Set(["", "null", "none", "undefined", "n/a"]);
const nullableText = () =>
  z.preprocess((v) => (typeof v === "string" && EMPTY_WORDS.has(v.trim().toLowerCase()) ? null : v), z.string().nullable().optional());

type Db = Awaited<ReturnType<typeof createClient>>;

/** ANNOUNCE THE DEED: read the row back and say its time in the org timezone. A write that stored
 *  the wrong hour then SAYS the wrong hour; the old reply repeated the model's intent, which is how
 *  "Booked, tomorrow at 10 AM" went out over a row stored at 3 AM Pacific (2026-09-24). */
async function readBack(supabase: Db, id: string, tz: string, verb: string, withPlace = false): Promise<string | null> {
  const { data } = await supabase
    .from("appointments")
    .select("title, starts_at, ends_at, location, customers(name)")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as {
    title?: string | null;
    starts_at?: string | null;
    ends_at?: string | null;
    location?: string | null;
    customers?: { name?: string | null } | null;
  };
  return appointmentRecorded(verb, row, tz, withPlace);
}

/** The `recorded` sentence for a stored appointment row (pure, so it is testable without a DB). */
export function appointmentRecorded(
  verb: string,
  row: { title?: string | null; starts_at?: string | null; ends_at?: string | null; location?: string | null; customers?: { name?: string | null } | null },
  tz: string,
  /** Say the stored address too — when the deed was an address change, so the read-back names it. */
  withPlace = false,
): string {
  const end = endSaid(row.starts_at, row.ends_at, tz);
  const at = withPlace && row.location ? `, at ${quotedData(row.location)}` : "";
  const who = row.customers?.name ? `, customer ${quotedData(row.customers.name)}` : ", no customer linked";
  // Title, address and name are database free text (a lead's name can reach the title): quoted, as data.
  return `${verb}: ${quotedData(row.title ?? "appointment")}, ${spokenWhen(row.starts_at, tz)}${end}${at}${who}.`;
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
    label: "Change appointment",
    description:
      "Reschedule an appointment / inspection to a new time, change its address, or both — e.g. 'move the Smith inspection to Thursday at 9am', 'that inspection is at 123 Main Street, not Pine'. Find it first with schedule_overview (it returns the id), then pass that id plus the new starts_at (optionally ends_at) and/or the new location — the WHOLE address line (street and town, zip if said); given only a street, ask which town before proposing. Without ends_at the visit keeps its length and the end moves with it. Keeps everything else; no cancel+recreate. Leave a field OUT rather than passing 'null'. " +
      LOCAL_TIME_RULE,
    // The address came with cn-v1112 (2026-10-16): asked to "fix the location", Nort had only a
    // time door, re-proposed the move it had just made, and the address stayed in his sentence.
    input: z
      .object({ id: z.string(), starts_at: nullableText(), ends_at: nullableText(), location: nullableText() })
      .refine((i) => !!i.starts_at || !!i.location, { message: "Say the new time or the new address.", path: ["starts_at"] })
      .refine((i) => !i.ends_at || !!i.starts_at, { message: "An end time needs the start time with it.", path: ["ends_at"] }),
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
    describe: (i) => {
      const when = i.starts_at ? `Move this appointment to ${readbackWhen(i.starts_at)}` : "";
      const where = i.location ? (when ? ` and change its address to ${quotedData(i.location)}` : `Change this appointment's address to ${quotedData(i.location)}`) : "";
      return `${when}${where}? Check the details below before you confirm.`;
    },
    handler: async (i) => {
      const supabase = await createClient();
      const tz = await orgTimezone(supabase);
      // The address goes FIRST, so the move's own calendar push carries the new place and title.
      if (i.location) {
        // The form's own address door: a typed line that no longer says a stored city or zip takes
        // those parts with it, a stock title becomes the address, and Google gets the new place.
        const p = await setAppointmentPlace(i.id, i.location);
        if (!p.ok) return p;
      }
      let r: ActionResult = { ok: true };
      if (i.starts_at) {
        const span = convertSpan(i.starts_at, i.ends_at, tz);
        const moved: ActionResult = "error" in span ? { ok: false, error: span.error } : await rescheduleAppointment(i.id, span.start, span.end);
        if (!moved.ok) {
          // A PARTIAL DEED IS SAID: the address is already changed when the move fails.
          return i.location ? { ok: false, error: `The address was changed, but the time wasn't moved: ${moved.error ?? "That didn't work."}` } : moved;
        }
        r = moved;
      }
      const recorded = await readBack(supabase, i.id, tz, i.starts_at ? "Moved" : "Updated", !!i.location);
      return { ...r, ...(recorded ? { recorded } : {}) };
    },
  },
  "appointment.create": {
    name: "appointment.create",
    group: "appointment",
    label: "Add appointment",
    description:
      "Create an appointment or inspection with a title and a start time (starts_at). Its type is one of five kinds: 'inspection' is an Inspection (the site visit before a price), 'job' is the work itself on a day, 'service_call' a service call, 'call' a phone call somebody has to make, and 'other' anything else (the default; a meeting books as other). THE CITY'S INSPECTION IS NOT THIS: it is the separate type 'final_inspection' and it goes on the job's permit, never here. Title a site visit \"Inspection: <customer or place>\". Optionally capture whatever else was given: job_id (resolve with list_jobs), customer_id (resolve with list_customers), location, ends_at, notes. " +
      LOCAL_TIME_RULE +
      " When the person isn't in the contacts yet, book it without a customer; if you then add them with customer.create, it links this visit in the same action when it's the one visit booked for that name (its result says `linked`), and otherwise offers the link.",
    // Fragment-first: the columns are nullable and createAppointment already reads every
    // one of these — the old 3-field schema silently DROPPED a spoken job/location/end time.
    // Only starts_at stays required (an appointment without a time isn't schedulable).
    input: z.object({
      title: z.string().trim().min(1),
      // THE FIVE A PERSON PICKS (W2-06, statuses.ts): spine-derived, so Nort can book exactly what the
      // New Appointment form offers and createAppointment accepts. No kind is Other, never an inspection.
      type: z.enum(PICKABLE_APPOINTMENT_TYPES).default("other"),
      starts_at: z.string().min(1),
      ends_at: nullableText(),
      job_id: nullableText(),
      customer_id: nullableText(),
      location: nullableText(),
      notes: nullableText(),
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
      "Attach a customer to an appointment / inspection ('link Tom to tomorrow's inspection'). Pass the appointment id (from customer.create's or customer.update's link_offer, or schedule_overview) and customer_id (an id, or the exact name). ONLY call this after the user said yes to linking: offering is your job, deciding is theirs. Confirm from the result's `recorded` line.",
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
    // No "details below": the card has no row to show for a status change (its id is not a detail).
    describe: (i) => `${statusVerb(i.status)} this appointment?`,
    handler: (i) => setAppointmentStatus(i.id, i.status),
  },
  /** How an inspection ended (0205) — the exit the inbox was missing. */
  "appointment.setOutcome": {
    name: "appointment.setOutcome",
    group: "appointment",
    label: "Record how it ended",
    description:
      "Record how an inspection ended: 'lost' (didn't win the bid), 'no_bid' (decided not to quote it), or 'won'. Use it when the user says they lost a bid, aren't pursuing it, or already handled the work — it clears the visit from Needs You without inventing an estimate.",
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
