/**
 * THE OFFER, NEVER A GUESS (cn-v1175, R5).
 *
 * The owner's own case: an inspection nobody ever tied to the job it became. The visit carries only its
 * customer; the work was done and billed on a job for the same customer, and the visit kept asking. A
 * customer can have two pieces of work, so the app may not decide that this job is that visit's: that
 * is a guess. It may ASK. A visit that is still open (an inspection to write up, or one whose day went
 * by) whose CUSTOMER RECORD (the visit's customer_id, else its lead's: a link, never a name match) has a
 * job made after the visit offers that job as the row's one boxed button, "Done as <job>?". One tap asks
 * in place; the yes goes through the visit's own attach door (linkAppointmentTo: the job attached, the
 * visit Won), and the row leaves by the one visit rule.
 *
 * More than one candidate: the newest is the button, the others are behind the row's dots. None: the
 * row is as it was. A visit that already has a job, has no day, or has no customer record and no exact
 * match (below) is offered nothing. Pure; the reader hands the candidates.
 *
 * ESTIMATES ARE NOT OFFERED HERE. "Written Up as <estimate>?" needs a door that ties an existing
 * estimate to a visit, and the only such tie is made inside the estimate's own save (saveQuote's
 * capture backlink). No door was added in this release; the rule takes estimate candidates so the day
 * one exists the offer is one line away, and `kind` already says which.
 *
 * A VISIT FINDS ITS JOB BY NAME AND STREET, EXACTLY (cn-v1181, I3). The owner, 2026-11-22: "it has an
 * address on it for the job it belongs to [...] shouldnt it have automatically filed having a name and
 * address on it that match exactly the job". A visit booked with no customer record and no lead
 * ("Site inspection: Dana Rook", at 410 Larkspur Lane) offered nothing, because the offer read a
 * RECORD only. exactJobMatch below is the one rule for "this job is that visit's": the same street,
 * and the same person (the record, or with no record at all the job's customer's full name in the
 * visit's own words). The offer takes it beside the same-record jobs; the by-hand New Job door ties
 * by it alone only when exactly one open visit matches (lib/appointments/tie-matching-visit).
 */
import { streetKey } from "@/lib/paperwork";
import { findCustomerMatch } from "@/lib/crm/duplicates";

export type OfferKind = "job" | "estimate";

export type OfferCandidate = {
  kind: OfferKind;
  id: string;
  customer_id: string | null;
  created_at: string | null;
  /** What the button names it by: the job's number and name, the estimate's number or title. */
  label: string;
  /** The job's street line (jobs.address), for the exact match. */
  address?: string | null;
  /** The job's unit (jobs.unit), for the exact match. */
  unit?: string | null;
  /** The job's customer's name as on file, for the exact match. */
  customer_name?: string | null;
};

export type VisitOffer = {
  kind: OfferKind;
  id: string;
  label: string;
  /** The other candidates, newest first: behind the row's dots. */
  others: { kind: OfferKind; id: string; label: string }[];
};

export type OfferVisit = {
  starts_at: string | null;
  job_id: string | null;
  customer_id?: string | null;
  /** The visit's lead's customer record, when the visit has none of its own. */
  lead_customer_id?: string | null;
  /** The visit's place, its title and its lead's name: read only by the exact match. */
  location?: string | null;
  title?: string | null;
  lead_name?: string | null;
};

/** The job as the exact match reads it. */
export type MatchJob = {
  created_at: string | null;
  address?: string | null;
  /** The job's unit (jobs.unit), when it is kept apart from its street line. */
  unit?: string | null;
  customer_id: string | null;
  customer_name?: string | null;
};

/** Words of a name or a title, case-blind, punctuation and apostrophes never splitting or joining two
 *  people: "O'Brien" is one word, "Rook," is "rook". */
function wordsOf(s: string | null | undefined): string[] {
  return String(s ?? "")
    .toLocaleLowerCase("en")
    .normalize("NFC")
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** True when `needle`'s words stand in `hay`'s words, whole and in order. */
function hasWholeWords(hay: string | null | undefined, needle: readonly string[]): boolean {
  const h = wordsOf(hay);
  if (!needle.length || h.length < needle.length) return false;
  for (let i = 0; i + needle.length <= h.length; i += 1) {
    if (needle.every((w, k) => h[i + k] === w)) return true;
  }
  return false;
}

/**
 * A name the app may link on: the SURE-MATCH rule of cn-v1178 itself (lib/crm/duplicates
 * findCustomerMatch, whose name arm refuses a placeholder: "Unknown caller", a bare phone number),
 * asked of the name against itself, so this file never keeps a second copy of that list; and two words
 * or more, so a first name alone ("Dana") never names a job.
 */
export function linkableFullName(name: string | null | undefined): string[] | null {
  const words = wordsOf(name);
  if (words.length < 2) return null;
  const self = { id: "self", name: String(name), company_name: null, email: null, phone: null };
  return findCustomerMatch({ name: String(name) }, [self]) ? words : null;
}

/**
 * THE EXACT MATCH (cn-v1181, I3): is this job that visit's? All of:
 *   · THE SAME STREET, both written, by lib/paperwork streetKey: the house number, the street's own
 *     words and its street type in one spelling ("410 Larkspur Lane, Town, CA" is "410 LARKSPUR LN",
 *     the job's "410 Larkspur Ln" too). Not lib/schedule-options streetKey, which only folds case and
 *     spacing over the WHOLE line: a visit's place carries its town and zip and a job's street line does
 *     not, so that key would never meet.
 *   · THE JOB WAS MADE AFTER THE VISIT (its start): a job that was already there is not what it became.
 *   · THE SAME PERSON: the visit's customer record (its own, else its lead's) is the job's customer;
 *     or, when the visit has NO record at all, the job's customer's full name (linkableFullName) stands
 *     as whole words, case-blind, in the visit's title or its lead's name.
 * Pure. Anything missing is no match, never a guess.
 */
export function exactJobMatch(visit: OfferVisit, job: MatchJob): boolean {
  const vs = streetKey(visit.location);
  const js = streetKey(job.address);
  if (!vs || !js || vs !== js) return false;
  // THE SAME UNIT (skeptic #84, M5): the street key stops at the street type, so a landlord's Unit 2
  // and Unit 5 are one street. Both sides name a unit and they differ: no match. A side with no unit
  // still matches (a job's street line often leaves it to its own column, or out).
  const vu = unitOf(visit.location);
  const ju = jobUnitOf(job);
  if (vu && ju && vu !== ju) return false;
  const since = visit.starts_at ? Date.parse(visit.starts_at) : NaN;
  const made = job.created_at ? Date.parse(job.created_at) : NaN;
  if (!Number.isFinite(since) || !Number.isFinite(made) || made <= since) return false;
  const record = offerCustomerOf(visit);
  if (record) return job.customer_id === record;
  if (!job.customer_id) return false;
  const name = linkableFullName(job.customer_name);
  if (!name) return false;
  return hasWholeWords(visit.title, name) || hasWholeWords(visit.lead_name, name);
}

/** "Unit 2", "Apt 2B", "Apartment 2b", "Suite 300", "Ste. 300", "#2": the unit's token, folded; or null. */
const UNIT_WORDS = /(?:^|[\s,])(?:unit|apt|apartment|suite|ste)\.?\s*#?\s*([a-z0-9][a-z0-9-]*)|(?:^|[\s,])#\s*([a-z0-9][a-z0-9-]*)/i;
export function unitOf(text: string | null | undefined): string | null {
  const m = UNIT_WORDS.exec(String(text ?? ""));
  const token = m ? (m[1] ?? m[2]) : null;
  return token ? token.toLowerCase().replace(/-/g, "") : null;
}

/** The job's unit: its own column (a bare "5" or "Unit 5"), else one written in its street line. */
function jobUnitOf(job: Pick<MatchJob, "address" | "unit">): string | null {
  const own = String(job.unit ?? "").trim();
  if (own) return unitOf(own) ?? (/^[a-z0-9][a-z0-9-]*$/i.test(own) ? own.toLowerCase().replace(/-/g, "") : null);
  return unitOf(job.address);
}

/** The customer record a visit is offered by: its own, else its lead's. Never a name. */
export function offerCustomerOf(v: Pick<OfferVisit, "customer_id" | "lead_customer_id">): string | null {
  return v.customer_id || v.lead_customer_id || null;
}

/** The offer for one visit, or null. `kinds` limits what is offered (the doors that exist: jobs). */
export function visitOffer(
  visit: OfferVisit,
  candidates: readonly OfferCandidate[],
  kinds: readonly OfferKind[] = ["job"],
): VisitOffer | null {
  if (visit.job_id) return null;
  const customer = offerCustomerOf(visit);
  const since = visit.starts_at ? Date.parse(visit.starts_at) : NaN;
  if (!Number.isFinite(since)) return null;
  const made = (c: OfferCandidate) => (c.created_at ? Date.parse(c.created_at) : NaN);
  // The same record, made after the visit; with no record at all, only an exact match (cn-v1181, I3).
  const theirs = (c: OfferCandidate) => (customer ? c.customer_id === customer && made(c) > since : exactJobMatch(visit, c));
  const fit = candidates
    .filter((c) => kinds.includes(c.kind) && !!c.id && !!c.label.trim() && theirs(c))
    .sort((a, b) => made(b) - made(a));
  if (!fit.length) return null;
  const [first, ...rest] = fit;
  return { kind: first.kind, id: first.id, label: first.label, others: rest.map((c) => ({ kind: c.kind, id: c.id, label: c.label })) };
}

/** A job's words on the button: its number and its name, as every other screen says a job. */
export function offerJobLabel(j: { job_number?: string | null; name?: string | null }): string {
  return [j.job_number, j.name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
}
