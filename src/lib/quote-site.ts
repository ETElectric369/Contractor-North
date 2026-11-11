/**
 * THE ESTIMATE'S JOB SITE: which address it prints, and which addresses it can be set to (cn-v1158).
 *
 * The owner, 2026-11-10, pricing a unit for a customer that owns two complexes at two addresses: "i
 * think we already have a Site option on the jobs/customers so im thinking we need to have sites
 * available to pick from on the estimate sheet, it might already be in place just not visible".
 *
 * It was half in place. An estimate has had its own five address columns since 0177 / 0187, and every
 * reader ranks them FIRST: the print page, the customer's /q page, the customer's Accept and
 * createJobFromQuote, so the job born from the estimate starts at that address. But no screen wrote
 * them, so not one estimate carried one, and an estimate for a customer with no job yet printed the
 * customer's own address as the job site, with no unit, even when the work was somewhere else.
 *
 * This file is the rule both ends share, with no words in it (a file under src/lib imports no
 * catalog) and no database:
 *
 *   quoteSiteCandidates  THE ONE ORDERED LIST: the estimate's own, the job's, the lead's, the
 *                        customer's. The print page and the estimate page both read it, so the
 *                        screen can never say one address while the paper prints another.
 *   quoteSiteView        what the paper prints and where it came from.
 *   quoteSiteChoices     what the picker offers: the record the estimate falls back to, the
 *                        customer's own address, and the addresses of that customer's other jobs.
 *   siteChoicesShort     whether that list was cut short, so the sheet can say so.
 *   siteBoxes…           A Different Address while it is being typed: how the boxes open, what a
 *                        keystroke and a pick do to them, when there is something to save.
 *   cleanQuoteSite       what the server accepts as a typed site.
 *   commitQuoteSite      the tap, kept out of the component so it can be driven without a DOM.
 *   siteWritten…         a save the page has not drawn yet: the line and the sheet read what was
 *                        just saved until the page's own read arrives.
 *
 * THERE IS NO SAVED LIST OF SITES ON A CUSTOMER. A customer has one address; each job has its own.
 * The picker's list is read from the jobs already done for that customer, which is where a second
 * complex's address already lives.
 */

import { pickSite, siteIsIncomplete, siteLines, type ResolvedSite, type SiteParts } from "@/lib/site-address";

/** Which record an estimate's printed site came from. */
export type QuoteSiteSource = "quote" | "job" | "lead" | "customer";

/** The four records an estimate can take its site from. Each is that record's own five columns. */
export interface QuoteSiteRecords {
  /** The estimate's own address (quotes.address, unit, city, state, zip). */
  quote?: SiteParts | null;
  /** The job the estimate is on, when it has one. */
  job?: SiteParts | null;
  /** The lead it was started from. */
  lead?: SiteParts | null;
  /** The customer it is made out to. */
  customer?: SiteParts | null;
}

/**
 * THE ONE ORDERED LIST, most specific first: the estimate is about THIS work, the job is where the
 * work is, the lead was about this work, and the customer is a person who may own several buildings.
 * Hand it to pickSite (lib/site-address), which takes the first record that has an address, whole.
 *
 * Each record is passed through untouched, so a caller may hand in a whole row or an embed exactly
 * as it read it: the print page did that with its own inline list, and what it prints did not change
 * by one byte when that list moved here.
 */
export function quoteSiteCandidates(of: QuoteSiteRecords): { source: QuoteSiteSource; parts?: SiteParts | null }[] {
  return [
    { source: "quote", parts: of.quote },
    { source: "job", parts: of.job },
    { source: "lead", parts: of.lead },
    { source: "customer", parts: of.customer },
  ];
}

/** Which record a paper born from an estimate took its site from. */
export type BornSiteSource = "job" | "quote" | "lead" | "customer";

/**
 * A PAPER BORN FROM AN ESTIMATE (an invoice, a work order, a materials list) owns no address of its
 * own (cn-v1160). It prints its own JOB's site first: the job is where the work is. With no job (a
 * bill made straight from an estimate that never became one) it prints the place the ESTIMATE prints,
 * in the estimate's own order: the estimate's own site, then the lead's, then the customer's. Until
 * now the list skipped the estimate and its lead, so such a bill printed the customer's own address
 * under "Job site" while the estimate it came from printed the building the work is in (skeptic #61).
 *
 * A caller hands in what it read and leaves out what it has not got: a missing record is skipped by
 * pickSite exactly as an empty one is. The SQL twin is the site_candidates list of
 * public.invoice_document_projection (migration 0409), read by the customer's page for its title; a
 * database suite holds the two to this order.
 */
export function bornFromEstimateCandidates(of: {
  /** The paper's own job. */
  job?: SiteParts | null;
  /** The estimate it was made from: that estimate's own address. */
  quote?: SiteParts | null;
  /** The lead that estimate was started from. */
  lead?: SiteParts | null;
  /** The customer it is made out to. */
  customer?: SiteParts | null;
}): { source: BornSiteSource; parts?: SiteParts | null }[] {
  return [
    { source: "job", parts: of.job },
    { source: "quote", parts: of.quote },
    { source: "lead", parts: of.lead },
    { source: "customer", parts: of.customer },
  ];
}

/** A row's five address columns and nothing else, so a client component is never handed a whole row. */
export function sitePartsOf(row: SiteParts | null | undefined): SiteParts | null {
  if (!row) return null;
  return { address: row.address ?? null, unit: row.unit ?? null, city: row.city ?? null, state: row.state ?? null, zip: row.zip ?? null };
}

/** A part as it is on file, trimmed: what is shown and what is copied. Never re-spelled. */
const text = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "").trim();
/** A part as it is COMPARED: a run of spaces read as one. Only ever inside a key. */
const flat = (v: unknown): string => text(v).replace(/\s+/g, " ");

/**
 * WHEN TWO ADDRESSES ARE THE SAME ADDRESS: the street, the unit, the city and the zip, each trimmed
 * and lower-cased, with a run of spaces read as one (a browser draws two spaces as one, so two rows
 * that differ only there would look like a duplicate). "" when there is no street.
 *
 * EXACT ON PURPOSE. This never matches two SPELLINGS of one place ("Ct" and "Court", "#4" and "Unit
 * 4"): a guess that two different strings are one address would hide a real second site from the
 * picker, and a guess the other way costs only a second row a person can read for themselves. The
 * state is left out because a row often carries the city and zip without it.
 */
export function siteKey(parts: SiteParts | null | undefined): string {
  const address = flat(parts?.address).toLowerCase();
  if (!address) return "";
  return JSON.stringify([address, flat(parts?.unit).toLowerCase(), flat(parts?.city).toLowerCase(), flat(parts?.zip).toLowerCase()]);
}

/** An address on one line, the way siteLines breaks it (the unit after the street, the town last,
 *  and no second town when the street line already ends in one). "" when there is no street. */
export function siteOneLine(parts: SiteParts | null | undefined): string {
  return siteLines(pickSite([{ source: "site", parts }])).join(", ");
}

export interface QuoteSiteView {
  /** What the paper prints: pickSite over the one list. null = no job site anywhere. */
  site: ResolvedSite | null;
  /** Which record that came from. */
  source: QuoteSiteSource | null;
  /** The printed address is short of a whole town: a city, a state or a zip is missing, and the
   *  street line does not carry them itself (lib/site-address siteIsIncomplete). */
  incomplete: boolean;
  /**
   * The estimate has its own address AND its job has a different one. The estimate's own outranks the
   * job's on the paper, so the paper and the job disagree: a job born from an estimate starts with the
   * estimate's address, and the two part ways the day somebody corrects the address on the job.
   */
  jobDiffers: boolean;
}

/**
 * Everything the Job Site line says, from the four records.
 *
 * NOTHING HERE IS COMPUTED FOR NOBODY: a statement on the line reads each of the four answers. It
 * used to carry three more (whether the estimate has its own address, and what it would fall back to
 * and from where) that nothing in the app read. A value nobody reads can go wrong with nobody to
 * notice, so they went. What the estimate falls back to is asked where it is used: quoteSiteChoices
 * (the row that follows) and siteBoxesFrom (how the boxes open).
 */
export function quoteSiteView(records: QuoteSiteRecords): QuoteSiteView {
  const site = pickSite(quoteSiteCandidates(records));
  const ownKey = siteKey(records.quote);
  const jobKey = siteKey(records.job);
  return {
    site,
    source: site ? (site.source as QuoteSiteSource) : null,
    incomplete: siteIsIncomplete(site),
    jobDiffers: ownKey !== "" && jobKey !== "" && ownKey !== jobKey,
  };
}

/** An address as it is written to the estimate: a street, and the rest or null. */
export interface QuoteSiteWrite {
  address: string;
  unit: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/** One of the customer's other jobs, as the estimate page reads it for the picker. */
export interface OtherJobSite extends SiteParts {
  id: string;
  job_number?: string | null;
  name?: string | null;
}

/** One row of the picker. */
export interface SiteChoice {
  /** siteKey of its address: no two rows share one. */
  key: string;
  /** Whose address it is. */
  from: "lead" | "customer" | "job";
  parts: QuoteSiteWrite;
  /**
   * True on the one row that is the record the estimate FALLS BACK to. Picking it clears the
   * estimate's own address, so the estimate follows that record and a later correction there reaches
   * this estimate. Every other row is a copy: its address is written onto the estimate.
   */
  follows: boolean;
  /** For a job's row: the newest of that customer's jobs at this address. */
  job?: { id: string; job_number: string | null; name: string | null };
}

/** How many of the customer's other addresses the picker lists. */
export const SITE_CHOICE_JOBS_CAP = 8;

/** How many of the customer's jobs the estimate's page reads for the picker, newest first. ONE
 *  number for the read's limit and for the test of whether the read came back full (siteJobsReadFull). */
export const SITE_JOBS_READ_LIMIT = 30;

/** What the picker is built from: the records the estimate can follow, and the customer's other jobs. */
export interface SiteChoiceSources {
  lead?: SiteParts | null;
  customer?: SiteParts | null;
  otherJobs?: readonly OtherJobSite[] | null;
  cap?: number;
}

/** The rows, and whether the cap left an address out. One pass, so the list and "was it cut" can
 *  never be counted two different ways. */
function siteChoiceRows(of: SiteChoiceSources): { rows: SiteChoice[]; cut: boolean } {
  const rows: SiteChoice[] = [];
  const seen = new Set<string>();
  // Through the one ordered list, so "what it falls back to" can never drift from what the paper prints.
  const fallback = pickSite(quoteSiteCandidates({ lead: of.lead, customer: of.customer }))?.source ?? null;
  const add = (from: SiteChoice["from"], parts: SiteParts | null | undefined, job?: SiteChoice["job"]): boolean => {
    const key = siteKey(parts);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    rows.push({
      key,
      from,
      // As it is on file, trimmed: a copy is that record's address, not a tidied version of it.
      parts: { address: text(parts?.address), unit: text(parts?.unit) || null, city: text(parts?.city) || null, state: text(parts?.state) || null, zip: text(parts?.zip) || null },
      follows: fallback === from,
      ...(job ? { job } : {}),
    });
    return true;
  };
  add("lead", of.lead);
  add("customer", of.customer);
  const cap = of.cap ?? SITE_CHOICE_JOBS_CAP;
  let jobs = 0;
  for (const j of of.otherJobs ?? []) {
    if (jobs >= cap) {
      // The list is full. It was CUT only if a job still to come has an address no row shows: more
      // jobs at addresses already listed (or with no street) leave nothing out.
      const key = siteKey(j);
      if (key && !seen.has(key)) return { rows, cut: true };
      continue;
    }
    if (add("job", j, { id: j.id, job_number: j.job_number ?? null, name: j.name ?? null })) jobs += 1;
  }
  return { rows, cut: false };
}

/**
 * WHAT THE PICKER OFFERS, for an estimate with no job (an estimate on a job has no picker: the job
 * owns its site).
 *
 *   1. The record the estimate falls back to when it has no address of its own: the lead's address
 *      when the lead has one (the lead outranks the customer on the paper), else the customer's.
 *      That row FOLLOWS: picking it clears the estimate's own address.
 *   2. The customer's own address when a lead outranks it: a copy.
 *   3. The addresses of that customer's other jobs, each with its unit, in the order handed in (the
 *      page reads them newest first), SITE_CHOICE_JOBS_CAP at most: copies.
 *
 * One row per address (siteKey: exact, never a guess at two spellings), so three jobs at one unit
 * are one row, named after the newest, and a job at the customer's own address adds none.
 */
export function quoteSiteChoices(of: SiteChoiceSources): SiteChoice[] {
  return siteChoiceRows(of).rows;
}

/** The page's read of the customer's jobs came back as long as it is allowed to be, so there may be
 *  older jobs, and other addresses, that it never reached. */
export const siteJobsReadFull = (rows: readonly unknown[] | null | undefined): boolean => (rows?.length ?? 0) >= SITE_JOBS_READ_LIMIT;

/**
 * A SHORT LIST SAYS IT IS SHORT. Two caps stand between a customer's jobs and the picker: the page
 * reads the SITE_JOBS_READ_LIMIT newest, and the picker lists SITE_CHOICE_JOBS_CAP different
 * addresses. Either can leave out the very address the sheet was opened for, and a list that looks
 * whole sends a person hunting for a row that was never going to be on it. True when either cut the
 * list: an address handed in found no row because the picker was full, or the read came back full
 * (`readFull`, which the page says with siteJobsReadFull). The sheet then says so in one quiet line
 * and points at the boxes under it, where any address can be typed.
 */
export function siteChoicesShort(of: SiteChoiceSources & { readFull?: boolean | null }): boolean {
  return !!of.readFull || siteChoiceRows(of).cut;
}

/**
 * The row that is in use now, by its key, or null. An estimate with no address of its own follows
 * the fallback row. One with its own is on the COPY row that has the same address; an address typed
 * by hand matches no row, and an own address that merely equals the fallback's is still a copy, so
 * the fallback row stays tappable (tapping it is how a copy goes back to following).
 */
export function siteChoiceInUse(choices: readonly SiteChoice[], own: SiteParts | null | undefined): string | null {
  const ownKey = siteKey(own);
  if (!ownKey) return choices.find((c) => c.follows)?.key ?? null;
  return choices.find((c) => !c.follows && c.key === ownKey)?.key ?? null;
}

/** What picking a row writes: null (clear the estimate's own address) for the row it follows, else that row's address. */
export const siteWriteFor = (choice: SiteChoice): QuoteSiteWrite | null => (choice.follows ? null : choice.parts);

/** A Different Address, as the sheet holds it while a person types: the street as typed, the town a
 *  pick resolved for it, and the unit. */
export interface SiteBoxes {
  street: string;
  unit: string;
  city: string;
  state: string;
  zip: string;
}

/**
 * THE BOXES AS THE SHEET OPENS: THE ADDRESS THE PAPER PRINTS NOW. The estimate's own when it has
 * one, else the one it falls back to (the lead's, else the customer's), picked whole through the one
 * ordered list; blank only when there is no address anywhere.
 *
 * The owner, 2026-11-10, about an estimate for a unit in a complex: "it auto-populated to both
 * positions with no other way to pick the site ... nor input a unit number other than the title".
 * The boxes used to open blank unless the estimate had an address of its own, on the thought that
 * the lead's and the customer's were rows to tap. But a unit is the commonest change there is, and
 * "same street, add a unit" then meant typing the street all over again: the merry-go-round. Now it
 * is Change Job Site, type the unit, Use This Address.
 *
 * NOTHING IS COPIED WITHOUT A CHANGE: siteBoxesReady still asks for a difference from how the boxes
 * opened, so an address that was only looked at writes nothing and the estimate goes on following
 * its lead or its customer.
 *
 * NEVER THE JOB'S. The sheet exists only for an estimate with no job (a job owns its site), so the
 * job's record is not read here even when one is handed in.
 */
export function siteBoxesFrom(records: QuoteSiteRecords): SiteBoxes {
  const printed = pickSite(quoteSiteCandidates({ quote: records.quote, lead: records.lead, customer: records.customer }));
  if (!printed) return { street: "", unit: "", city: "", state: "", zip: "" };
  return { street: text(printed.address), unit: text(printed.unit), city: text(printed.city), state: text(printed.state), zip: text(printed.zip) };
}

/**
 * A change in the street box. Typing over a street DROPS the city, state and zip it was picked with:
 * they describe the old line, and a town left behind from a different street is the false value 0177
 * forbids. Text that did not change changes nothing (the address box reports its value once on its
 * own when it mounts, and again after a pick; neither is typing).
 */
export function siteBoxesTyped(boxes: SiteBoxes, street: string): SiteBoxes {
  return street === boxes.street ? boxes : { ...boxes, street, city: "", state: "", zip: "" };
}

/** A pick from the address box's suggestions: the street and its town arrive together, so the text
 *  change that follows the pick is not read as typing over it. The unit is the person's and stays. */
export function siteBoxesPicked(boxes: SiteBoxes, picked: { line1: string; city?: string | null; state?: string | null; zip?: string | null }): SiteBoxes {
  return { ...boxes, street: picked.line1, city: picked.city ?? "", state: picked.state ?? "", zip: picked.zip ?? "" };
}

/** Whether the boxes say something other than what they opened with (space around a value is not a change). */
export function siteBoxesDiffer(boxes: SiteBoxes, start: SiteBoxes): boolean {
  return (["street", "unit", "city", "state", "zip"] as const).some((k) => boxes[k].trim() !== start[k].trim());
}

/** There is something to save: a street, and a difference from how the boxes opened. */
export const siteBoxesReady = (boxes: SiteBoxes, start: SiteBoxes): boolean => !!boxes.street.trim() && siteBoxesDiffer(boxes, start);

/** What the boxes write. The server cleans it again (cleanQuoteSite): this is not the gate. */
export const siteBoxesWrite = (boxes: SiteBoxes): QuoteSiteInput => ({
  address: boxes.street.trim(),
  unit: boxes.unit.trim(),
  city: boxes.city.trim(),
  state: boxes.state.trim(),
  zip: boxes.zip.trim(),
});

/** What a caller may send as a site. Every field is checked: a server action is a public door. */
export type QuoteSiteInput = { address?: unknown; unit?: unknown; city?: unknown; state?: unknown; zip?: unknown };

/** The longest each part may be. Generous on purpose: a row copied from a job or a customer already
 *  on file must never be refused here, and these only keep out a pasted page of text. */
export const QUOTE_SITE_CAPS = { address: 300, unit: 60, city: 120, state: 60, zip: 20 } as const;

/**
 * A SITE AS THE SERVER TAKES IT: each part trimmed, an empty one null, a street required. It answers
 * with a reason and no words (the action says them in the caller's language): "address" when there is
 * no street or the thing is not an address at all, "long" when a part is past its cap. A part is
 * refused whole when it is too long, never cut: a clipped address is a wrong address nobody was told about.
 */
export function cleanQuoteSite(input: unknown): { ok: true; site: QuoteSiteWrite } | { ok: false; why: "address" | "long" } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, why: "address" };
  const src = input as Record<string, unknown>;
  const site = { address: text(src.address), unit: text(src.unit), city: text(src.city), state: text(src.state), zip: text(src.zip) };
  for (const col of Object.keys(QUOTE_SITE_CAPS) as (keyof typeof QUOTE_SITE_CAPS)[]) {
    if (site[col].length > QUOTE_SITE_CAPS[col]) return { ok: false, why: "long" };
  }
  if (!site.address) return { ok: false, why: "address" };
  return { ok: true, site: { address: site.address, unit: site.unit || null, city: site.city || null, state: site.state || null, zip: site.zip || null } };
}

export type SiteResult = { ok: boolean; error?: string };

/**
 * THE TAP IS THE SAVE. A row, the typed address, or "use the job's": each is one write, and the
 * answer is the server's own sentence or the fallback, never a quiet nothing (a thrown call is a
 * dropped connection, and it is said too). null clears the estimate's own address.
 */
export async function commitQuoteSite(
  quoteId: string,
  site: QuoteSiteInput | null,
  deps: {
    setQuoteSite: (quoteId: string, site: QuoteSiteInput | null) => Promise<SiteResult>;
    /** The sentence used when the server refuses without saying why, or cannot be reached. */
    fallbackError: string;
  },
): Promise<SiteResult> {
  try {
    const res = await deps.setQuoteSite(quoteId, site);
    if (!res.ok) return { ok: false, error: res.error || deps.fallbackError };
    return { ok: true };
  } catch {
    return { ok: false, error: deps.fallbackError };
  }
}

/**
 * A SAVE THE PAGE HAS NOT DRAWN YET. A save closes the sheet and asks the page to read itself again,
 * and that read takes a moment to land. Until it does the page's records are the OLD ones: the line
 * said "Saved" beside the address just replaced, and Change Job Site, opened again in that moment,
 * filled its boxes from the old address (with Use This Address live on it). So the line remembers
 * the write and reads IT as the estimate's own address until the page's own read arrives.
 */
export interface SiteWritten {
  /** siteKey of the estimate's own address as the page had it when the save was tapped ("" = none). */
  was: string;
  /** What the save left on the estimate: the address as the server stores it, or null for a clear. */
  own: QuoteSiteWrite | null;
}

/**
 * Remember a save that landed. `pageOwn` is the estimate's own address as the page had it AT THE TAP;
 * `site` is what was sent (null clears). The address is kept as the server stores it (cleanQuoteSite,
 * the one rule both ends share), so what the line shows is what the next read will bring. Null when
 * what was sent is not an address the server would have taken: then there is nothing to read from,
 * and the line waits for the page as it used to.
 */
export function siteWritten(pageOwn: SiteParts | null | undefined, site: QuoteSiteInput | null): SiteWritten | null {
  if (site === null) return { was: siteKey(pageOwn), own: null };
  const clean = cleanQuoteSite(site);
  return clean.ok ? { was: siteKey(pageOwn), own: clean.site } : null;
}

/**
 * Whether a remembered save still stands in for the page's read: only while the page's own address
 * is still the one it had at the tap. ANY other address arriving from the page ends it, whether it
 * is the one written or somebody else's later change: the page's own read is the truth, and the
 * write only ever covered for its absence.
 */
export function siteWrittenStands(pageOwn: SiteParts | null | undefined, written: SiteWritten | null | undefined): written is SiteWritten {
  return !!written && siteKey(pageOwn) === written.was;
}

/**
 * THE RECORDS AS THE SCREEN READS THEM NOW: the page's own, with the estimate's own address taken
 * from a save that still stands (siteWrittenStands). Everything on the line reads these (the address
 * shown, the row marked In Use, how the boxes open), so no part of it can still be on the old
 * address while another has moved on. The very records handed in when no save stands.
 */
export function quoteSiteRecordsNow(records: QuoteSiteRecords, written: SiteWritten | null | undefined): QuoteSiteRecords {
  return siteWrittenStands(records.quote, written) ? { ...records, quote: written.own } : records;
}
