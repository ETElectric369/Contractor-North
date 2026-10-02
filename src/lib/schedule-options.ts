// Single source of truth for the jobs/customers/staff option lists that feed
// AppointmentButton (and NewJobButton). The label SHAPE lived inline in three
// places and drifted; keep the mappers here so they can't.

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatFullAddress } from "@/lib/utils";

export type PickerOption = { id: string; label: string; address?: string | null };

/** THE job display label — "J-0012 · Panel swap". The one shape every job dropdown,
 *  chip and toast uses (toJobOptions builds its option labels with it too), so the
 *  label can't drift per surface. Client-safe (pure). */
/**
 * THE job label — used on 52 surfaces, so this one function decides how a job reads everywhere.
 *
 * It used to lead with the number: "J-030 · 13631 Nightshade — Garage Subpanel". Both owners
 * navigate by ADDRESS, and in a picker or a pill the number ate the width the address needed —
 * "J-030 · 13631 Nightshade — Garag". Erik: "he needs all these labels to be the job name (address
 * number and street) not J-xxx on all the windows, thats what we see the most guiding us, and it
 * doesnt work for me either."
 *
 * So the NAME leads and stands alone. The number still exists — it's on documents, it's
 * searchable, and it's the fallback for a job that was never named — it just stops being the first
 * thing you read on a screen where you're looking for a house.
 */
export const jobLabel = (j: { job_number?: string | null; name?: string | null }): string => {
  const name = (j.name ?? "").trim();
  const num = (j.job_number ?? "").trim();
  return name || num || "Job";
};

/** Number AND name, for the surfaces that genuinely need the reference: printed documents, the
 *  invoice/quote header, an export somebody reconciles against. Never a picker. */
export const jobLabelWithNumber = (j: { job_number?: string | null; name?: string | null }): string => {
  const name = (j.name ?? "").trim();
  const num = (j.job_number ?? "").trim();
  return num && name ? `${num} · ${name}` : name || num || "Job";
};

/** The CODES-OFF job identity label — "Smith · 123 Main St" (customer · street address).
 *  Orgs that turn timeclock_job_codes off identify work by whose house the crew is at,
 *  not by a number/code; every codes-off timeclock picker/chip uses THIS shape (same
 *  SSOT rule as jobLabel — no per-surface forks). Falls back to jobLabel when the job
 *  carries neither part, so a bare row still labels. Client-safe (pure). */
export const jobSiteLabel = (j: {
  job_number?: string | null;
  name?: string | null;
  address?: string | null;
  customer_name?: string | null;
}): string => {
  const parts = [j.customer_name, j.address].map((s) => (s ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(" · ") : jobLabel(j);
};

export const toJobOptions = (rows: any[] | null | undefined): PickerOption[] =>
  // SAME FILE, SAME PURPOSE, AND IT USED TO BEHAVE THE OPPOSITE WAY to toCustomerOptions right
  // below: prefilling an appointment from a CUSTOMER gave a full line, from a JOB gave a bare
  // street — because this one passed j.address straight through while that one ran
  // formatFullAddress. Every downstream picker inherited the difference for free.
  (rows ?? []).map((j) => ({
    id: j.id,
    label: jobLabel(j),
    address: formatFullAddress(j.address, j.city, j.state, j.zip) || j.address || null,
  }));
export const toCustomerOptions = (rows: any[] | null | undefined): PickerOption[] =>
  // `address` rides along ONLY when the query fetched the parts (listNewJobCustomerOptions).
  // Optional by design: the plain pickers keep shipping two columns, and a surface that wants
  // the site-address prefill just asks for the richer query — see getSchedulePickerOptions.
  (rows ?? []).map((c) => ({
    id: c.id,
    label: c.name,
    ...(c.address !== undefined ? { address: formatFullAddress(c.address, c.city, c.state, c.zip) || null } : {}),
  }));
export const toStaffOptions = (rows: any[] | null | undefined): PickerOption[] =>
  (rows ?? []).map((s) => ({ id: s.id, label: s.full_name ?? "Unnamed" }));

/** THE active-tech roster query — every assignee picker / crew list reads the same
 *  active profiles, id+full_name, sorted by name, so the roster can't drift across
 *  surfaces. Returns the Supabase query builder: await it, or drop it into a Promise.all. */
export const listActiveTechs = (supabase: SupabaseClient) =>
  supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name");

/** THE customer-picker query — id+name, alphabetical. Pass `limit` for the big billing
 *  picker; omit it for the common short lists. Same drift-proofing as listActiveTechs. */
export const listCustomerOptions = (supabase: SupabaseClient, limit?: number) => {
  const q = supabase.from("customers").select("id, name").order("name");
  return limit ? q.limit(limit) : q;
};

/** The new-job form's customer options — name plus the ONE-LINE site-address prefill
 *  (a job stores a single address string; formatFullAddress is the canonical shape). The company name
 *  and the kind ride along so the form's "It'll Be Called" line names a business by its name when
 *  there is no street (defaultJobName). */
export type NewJobCustomerOption = {
  id: string;
  name: string;
  address: string | null;
  company_name?: string | null;
  type?: string | null;
  /** The address in its parts: the street goes in New Job's street box and the rest into their own
   *  columns, never the one-line blob into the street (address-autocomplete's streetOnly rule). */
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

export const toNewJobCustomerOptions = (rows: any[] | null | undefined): NewJobCustomerOption[] =>
  (rows ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    address: formatFullAddress(c.address, c.city, c.state, c.zip) || null,
    ...(c.company_name !== undefined ? { company_name: c.company_name ?? null } : {}),
    ...(c.type !== undefined ? { type: c.type ?? null } : {}),
    ...(c.address !== undefined ? { street: c.address ?? null, city: c.city ?? null, state: c.state ?? null, zip: c.zip ?? null } : {}),
  }));

/** listCustomerOptions + the address parts — ONLY for surfaces that prefill a site
 *  address from the pick (NewJobButton). A separate query so the plain pickers
 *  (e.g. billing's 2000-row list) don't ship four extra columns to the client. */
export const listNewJobCustomerOptions = (supabase: SupabaseClient) =>
  supabase.from("customers").select("id, name, company_name, type, address, city, state, zip").order("name");

/** New-job form: what the site-address field should become when the customer pick
 *  changes. Returns the string to apply (possibly "" — dropping a stale prefill when
 *  the new pick has no address), or null to leave the field alone. The pick's address
 *  applies only while the field is empty or still holds the PREVIOUS pick's prefill,
 *  so typed input is never clobbered. */
export function addressPrefillOnCustomerPick(
  current: string,
  prevPrefill: string,
  nextPrefill: string,
): string | null {
  const untouched = current.trim() === "" || current === prevPrefill;
  if (!untouched || nextPrefill === current) return null;
  return nextPrefill;
}

// ── NEW JOB IN FOUR FIELDS (W1-22) ────────────────────────────────────────────────────────────────
// The form asks Customer, Address, Date and Description; the server works out the rest the same way
// the form's live line says it will. Pure (no clock, no timezone of their own): every caller hands in
// the company's today, so a phone in another zone and a server on UTC agree.

export type NewJobStatus = "in_progress" | "scheduled" | "to_be_scheduled";

/** A new job's status from its date, against the company's today (YYYY-MM-DD): today or earlier is
 *  In Progress (he's usually already working it, Erik 2026-07), a later day is Scheduled, and no day
 *  is To Be Scheduled (the waiting room). */
export function statusFromDate(day: string | null | undefined, todayStr: string): NewJobStatus {
  const d = String(day ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "to_be_scheduled";
  return d <= todayStr ? "in_progress" : "scheduled";
}

/** Who, in a job's name, as written: the company's own name, else the customer's whole name ("Marla
 *  Finch", never cut to a last name). Erik 2026-09-28: with no address his jobs have always been
 *  named for the person, "Marla Finch", "Jason Wexley". */
export function customerNamePart(c: { name?: string | null; company_name?: string | null; type?: string | null } | null | undefined): string {
  const company = String(c?.company_name ?? "").trim().replace(/\s+/g, " ");
  if (company) return company;
  return String(c?.name ?? "").trim().replace(/\s+/g, " ");
}

/** "Sep 27" for a YYYY-MM-DD, the same in every timezone. */
function monthDay(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The unit as it rides on a job's name, without its own designator: "56", "#56", "Unit 56",
 *  "Apt 56" → "56" (the name adds the "#"). Blank → "". */
export function unitForName(unit: string | null | undefined): string {
  return String(unit ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:#|(?:unit|apt|apartment|ste|suite)\b\.?)\s*#?\s*/i, "")
    .trim();
}

/** The most work words a job's name carries (rule 3): about 40 characters, cut at a word. */
const WORK_WORDS_MAX = 40;

/** A source's work words cut to fit a job's name: whole words up to 40 characters, no dangling
 *  separator ("Replace the panel, add two circuits, move the…" → "Replace the panel, add two circuits"). */
export function workWordsForName(words: string | null | undefined): string {
  let w = String(words ?? "").trim().replace(/\s+/g, " ");
  // Counted in characters (code points), the way the SQL twin's length()/left() count them: an emoji
  // is one character, and a cut never splits one in half.
  const chars = Array.from(w);
  if (chars.length > WORK_WORDS_MAX) {
    const cut = chars.slice(0, WORK_WORDS_MAX + 1).lastIndexOf(" ");
    w = (cut > 0 ? chars.slice(0, cut) : chars.slice(0, WORK_WORDS_MAX)).join("");
  }
  return w.replace(/[\s,;:.\-–—·|/]+$/, "");
}

/** Does the street line already carry this unit ("12 Elm St #5", "12 Elm St Apt 5", "12 Elm St Suite
 *  5", "12 Elm St # 5")? Then the name adds no " #5": the unit is never on it twice. */
function streetCarriesUnit(street: string, unit: string): boolean {
  const s = street.toLowerCase();
  const u = unit.toLowerCase();
  if (!u || !s.endsWith(u)) return false;
  return /(?:#|\b(?:unit|apt|apartment|ste|suite)\.?\s*#?)\s*$/.test(s.slice(0, s.length - u.length));
}

/** A mailing-only line ("PO Box 123", "P.O. Box 44", "Post Office Box 9") has no street number and
 *  street name: a job is never named for it (rule 3 names it for who instead). */
const PO_BOX = /^(?:p\.?\s*o\.?\s*box|post\s+office\s+box)(?![a-z])/i;

/**
 * THE NAME A NEW JOB GETS WHEN NONE IS TYPED (Erik 2026-09-28, final: "street number and name as
 * always"). The way his company has always named jobs:
 *   - with a street, the street number and name, and " #<unit>" when the job has one: "3245 West Garnet
 *     Boulevard", "300 West Garnet Boulevard #56" (never twice: "12 Elm St Apt 5" stays). Never
 *     the person, never the town (a one-line address is cut to its street), never a PO box;
 *   - no street: who, as written ("Marla Finch", a company by its name), then " · " and the work
 *     words a source carried when there are any ("Marla Finch · Panel Upgrade");
 *   - neither: "New Job · Sep 28" on the company's today (the work words alone when that is all).
 * The New Job form shows the same line live ("It'll Be Called: …") and the server builds it from the
 * same function (lib/job-name jobNameFrom), so they can't differ.
 */
export function defaultJobName(p: {
  customer?: { name?: string | null; company_name?: string | null; type?: string | null } | null;
  street?: string | null;
  unit?: string | null;
  /** The work words a source carried, its tag already off (lib/job-name): only used with no street. */
  work?: string | null;
  todayStr: string;
}): string {
  const line = String(p.street ?? "").split(",")[0].trim().replace(/\s+/g, " ");
  const street = PO_BOX.test(line) ? "" : line;
  if (street) {
    const unit = unitForName(p.unit);
    return unit && !streetCarriesUnit(street, unit) ? `${street} #${unit}` : street;
  }
  const who = customerNamePart(p.customer);
  const work = workWordsForName(p.work);
  if (who) return work ? `${who} · ${work}` : who;
  return work || `New Job · ${monthDay(p.todayStr)}`;
}

/** The kind of billing most of this company's jobs use; Time & Material on a tie or with none yet. */
export function usualBillingKind(counts: { tm?: number | null; fixed?: number | null }): "tm" | "fixed" {
  return (Number(counts.fixed) || 0) > (Number(counts.tm) || 0) ? "fixed" : "tm";
}

/** How many of the company's jobs bill each way: two head-only counts (RLS scopes them to the org).
 *  A read that fails counts as none, so the answer falls back to Time & Material, never a guess. */
export async function readUsualBillingKind(supabase: SupabaseClient): Promise<"tm" | "fixed"> {
  const count = (kind: "tm" | "fixed") =>
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("billing_type", kind)
      .then(
        (r: { count: number | null; error: unknown }) => (r.error ? 0 : (r.count ?? 0)),
        () => 0,
      );
  const [tm, fixed] = await Promise.all([count("tm"), count("fixed")]);
  return usualBillingKind({ tm, fixed });
}

/** A street line as a key: case, spacing and punctuation don't make two addresses different. */
export function streetKey(street: string | null | undefined): string {
  return String(street ?? "")
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The street lines of the jobs that carry a unit, as keys: the New Job form's "another job here has
 *  a unit" hint reads these. */
export function unitStreetKeys(jobs: readonly { address?: string | null; unit?: string | null }[] | null | undefined): string[] {
  const keys = new Set<string>();
  for (const j of jobs ?? []) {
    if (!String(j.unit ?? "").trim()) continue;
    const k = streetKey(j.address);
    if (k) keys.add(k);
  }
  return Array.from(keys);
}

/** Does another job at this street line have a unit? Then this one probably wants one too. */
export function streetHasUnits(street: string | null | undefined, unitStreets: readonly string[] | null | undefined): boolean {
  const k = streetKey(street);
  return !!k && (unitStreets ?? []).includes(k);
}

/** Fetch the jobs/customers/staff rows and map them to picker options — for
 *  callers that don't already have the rows on hand. */
export async function getSchedulePickerOptions(supabase: SupabaseClient) {
  const [{ data: jobs }, { data: customers }, { data: staff }] = await Promise.all([
    supabase.from("jobs").select("id, job_number, name, address, city, state, zip").order("created_at", { ascending: false }).limit(200),
    // The richer query: an appointment IS a place you have to drive to, so its picker needs the
    // address the same way the new-job form does. Bounded by the org's own customer count.
    listNewJobCustomerOptions(supabase),
    listActiveTechs(supabase),
  ]);
  return {
    jobOpts: toJobOptions(jobs),
    custOpts: toCustomerOptions(customers),
    staffOpts: toStaffOptions(staff),
    customers: (customers ?? []) as { id: string; name: string }[],
    staff: (staff ?? []) as { id: string; full_name: string | null }[],
  };
}
