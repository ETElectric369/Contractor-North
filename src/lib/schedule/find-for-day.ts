import { nameSays, streetOf } from "@/lib/schedule/block-info";
import { streetCarriesUnit, unitForName } from "@/lib/schedule-options";

/**
 * WHAT ADD TO SCHEDULE CAN FIND BESIDES THE JOBS IN FLIGHT (Erik, 2026-11-10, on the Schedule: "it wont
 * let me add to schedule unless its already a job and [a street] is a job already so why cant it find
 * it?", then "or rather is an address of a previous job i need to go back to for more work", then "it
 * wont let me add to schedule unless its an open job not even an address or a person as it states it
 * can find").
 *
 * The sheet's box said "Find a job: street, name, customer" and searched one list: the jobs still in
 * flight. A street whose job was finished, and a customer with no open job, were on file and could not
 * be found, so the day could not be given to either. The box now looks through two more things, on the
 * server and only once something is typed (a company's finished jobs are every job it ever did: they
 * are never shipped to the page):
 *
 *   · FINISHED JOBS (complete, or called off): a place to go back to. Picking one asks how: a new job
 *     at that address for the same customer, or the old job reopened. Nothing is guessed.
 *   · CUSTOMERS: a person. Picking one starts a new job for them at their address.
 *
 * This file is the rule both ends share: the words a search is made of, the one word the database is
 * asked for, and the every-word match that decides what is shown (the same match the in-flight list
 * has always used, lib-side so the route and the sheet cannot differ). Pure: no clock, no database.
 */

/** A finished job as the search hands it over. No money: the office and nothing else reads it. */
export type PastJob = {
  id: string;
  job_number?: string | null;
  name: string;
  status: string;
  address?: string | null;
  unit?: string | null;
  city?: string | null;
  /** Its size and crew, for the sheet's time and crew controls when it is reopened. */
  planned_minutes?: number | null;
  assigned_to?: string[] | null;
  customers?: { name: string } | null;
};

/** A customer as the search hands it over: who, and the address a new job for them would take. */
export type FoundCustomer = {
  id: string;
  name: string;
  company_name?: string | null;
  address?: string | null;
  unit?: string | null;
  city?: string | null;
};

/** The shortest word the database is asked for: one letter matches nearly every row. */
export const FIND_MIN_CHARS = 2;
/** The most the sheet lists of each kind; past it, the sheet says there are more. */
export const FIND_PAST_CAP = 12;
export const FIND_CUSTOMER_CAP = 8;
/** The most rows one read brings back before the every-word match (the newest first). */
export const FIND_READ_LIMIT = 60;
const MAX_WORDS = 6;
const MAX_WORD_CHARS = 40;

/**
 * The words of a search: lower case, split on spaces, with the characters a PostgREST filter reads as
 * its own grammar taken out (comma, brackets, the wildcards, quotes, backslash, dot, colon), so a typed
 * line can never close a filter or open another. "12 Elm St." and "12 elm st" are the same search.
 */
export function findWords(query: string | null | undefined): string[] {
  return String(query ?? "")
    .toLowerCase()
    .replace(/[,()%*"\\.:]/g, " ")
    .split(/\s+/)
    .map((w) => w.slice(0, MAX_WORD_CHARS))
    .filter(Boolean)
    .slice(0, MAX_WORDS);
}

/** The ONE word the database is asked for: the longest (the most telling), the first of equals. Null
 *  when nothing typed is long enough to ask with. Every other word is matched on what comes back. */
export function likeWord(words: readonly string[]): string | null {
  let best = "";
  for (const w of words) if (w.length > best.length) best = w;
  return best.length >= FIND_MIN_CHARS ? best : null;
}

/** Is every word somewhere in these parts? The match the in-flight list uses, for every list. */
export function saysEvery(parts: readonly unknown[], words: readonly string[]): boolean {
  if (!words.length) return true;
  const hay = parts.map((v) => String(v ?? "").toLowerCase()).join(" ").replace(/[,()%*"\\.:]/g, " ");
  return words.every((w) => hay.includes(w));
}

/** What a finished job is searched by: its name, street, unit, town, number and who it was for. */
export const pastJobSays = (j: PastJob, words: readonly string[]): boolean =>
  saysEvery([j.name, j.address, j.unit, j.city, j.job_number, j.customers?.name], words);

/** What a customer is searched by: the name, the company, the street and the town. */
export const customerSays = (c: FoundCustomer, words: readonly string[]): boolean =>
  saysEvery([c.name, c.company_name, c.address, c.unit, c.city], words);

/** The rows that match every word, cut to the cap, and how many were left off. */
export function capFound<T>(rows: readonly T[], says: (row: T) => boolean, cap: number): { rows: T[]; more: number } {
  const hit = rows.filter(says);
  return { rows: hit.slice(0, cap), more: Math.max(0, hit.length - cap) };
}

/** One list from two reads (by the job's own words, and by its customer's), each job once, in the
 *  order given: the first read's rows, then the second's that the first did not bring. */
export function mergeById<T extends { id: string }>(a: readonly T[], b: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of [...a, ...b]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/** The street and unit on one line, as a place is said in a sentence: "12 Elm St #5". Blank with no
 *  street. The unit by the job namer's own rules (lib/schedule-options): without its designator, and
 *  never twice when the street line already carries it ("12 Elm St Apt 5"). */
export function placeWords(p: { address?: string | null; unit?: string | null }): string {
  const street = streetOf(p.address);
  if (!street) return "";
  const unit = unitForName(p.unit);
  return unit && !streetCarriesUnit(street, unit) ? `${street} #${unit}` : street;
}

/** The line under a finished job's name: its street (unless the name already is it) and who. */
export function pastJobLine(j: PastJob): string {
  const street = placeWords(j);
  const who = j.customers?.name?.trim() ?? "";
  return [street && !nameSays(j.name, streetOf(j.address)) ? street : "", who && !nameSays(j.name, who) ? who : ""].filter(Boolean).join(" · ");
}

/** The line under a customer's name: the company (when the name is a person's), the street, the town. */
export function customerLine(c: FoundCustomer): string {
  const company = String(c.company_name ?? "").trim();
  const town = String(c.city ?? "").trim();
  return [company && !nameSays(c.name, company) ? company : "", placeWords(c), town].filter(Boolean).join(" · ");
}
