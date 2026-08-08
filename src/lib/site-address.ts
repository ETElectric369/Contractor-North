/**
 * THE JOB SITE — one place that decides which address a document is about.
 *
 * Erik: "everything has to have a full address on it somewhere and inserted automatically" and,
 * a minute later, the sharper version: "just making sure its the right address from the start,
 * the job name is derived from the address."
 *
 * ── WHAT WAS ACTUALLY MISSING ───────────────────────────────────────────────────────────────
 *
 * Not a broken address renderer. A missing SLOT. Every document in this app has exactly one
 * address block — DocParty, "Prepared for" / "Bill to" — and that is the CUSTOMER'S MAILING
 * ADDRESS. There is no job-site line on a quote, an invoice, or a change order. It was never
 * built. So a full site address prints only when the person you bill happens to live at the work.
 *
 * For Tahoe Tavern Properties that fails four times over: J-009 "TTP #11", J-013 "TTP #56",
 * J-017 "TTP #224" and J-035 are four different dwellings at 300 W Lake Blvd, and the unit number
 * exists ONLY in the job name. Two of them are already paid.
 *
 * ── WHY THERE IS NO ADDRESS PARSER IN THIS FILE ─────────────────────────────────────────────
 *
 * The obvious fix — split "1871 Apache Ct Olympic Valley CA 96146 United States" into parts and
 * backfill — was killed on two independent grounds, and it is worth writing down so nobody
 * rebuilds it:
 *
 *   1. A city splitter FABRICATES. Against 45 real-shaped strings it wrote a false value 8 times
 *      and destroyed the street 6 more. "1420 Nevada St Truckee" yields state=NV. "1200 Industrial
 *      Way NE" yields Nebraska. In this county Nevada, Washington and Ohio are street names.
 *   2. Even a PERFECT splitter has nowhere to put the answer. DocParty renders `address` and then
 *      city/state/zip on the next line, so filling the parts without shortening the blob prints
 *      the tail twice — and shortening the blob overwrites what he typed. FILL HOLES NEVER
 *      OVERWRITE and "no duplicated tail" cannot both hold. Both branches lose.
 *
 * So exactly one splitter ships and it returns a BOOLEAN. It tells a RENDER whether the address
 * line already ends in a city/state/zip. A wrong answer costs one blank display line; it can never
 * cost a wrong address, because nothing here writes anything.
 */

import { formatCityStateZip } from "@/lib/utils";

export interface SiteParts {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface ResolvedSite extends SiteParts {
  /** Which record won — for the office copy's "(from contact on file)" note. */
  source: string;
  /** Enough to hand a driver. See siteIsIncomplete for the inverse. */
  complete: boolean;
}

/** Columns every select list must carry. Import it instead of retyping four names. */
export const SITE_COLS = "address, city, state, zip";

const t = (v: unknown): string => String(v ?? "").trim();

/**
 * DOES THIS ADDRESS LINE ALREADY END IN A CITY/STATE/ZIP?
 *
 * DISPLAY ONLY. Never gate a write on this — see the file header. End-anchored, and it requires a
 * two-letter state IMMEDIATELY before a trailing ZIP, because that pair is the only shape that
 * cannot be a street name.
 */
export function addressHasCityStateZipTail(s: string | null | undefined): boolean {
  const v = t(s);
  if (!v) return false;
  // Canadian postcodes refuse EXPLICITLY rather than by accident, so that "let's add provinces"
  // can never quietly turn a refusal into an invention.
  if (/[A-Z]\d[A-Z] ?\d[A-Z]\d/i.test(v)) return false;
  // NE/NW/SE/SW/N/S/E/W are directionals on a street, never the state. "1200 Industrial Way NE".
  if (/\b(?:N|S|E|W|NE|NW|SE|SW)\s+\d{5}(?:-\d{4})?\s*,?\s*(?:United States|USA|US)?\s*$/i.test(v)) return false;
  return /\b[A-Z]{2}\s*,?\s+\d{5}(?:-\d{4})?\s*,?\s*(?:United States|USA|US)?\s*\.?\s*$/i.test(v);
}

/**
 * PICK THE SITE, MOST-SPECIFIC FIRST, ALL-OR-NOTHING PER RECORD.
 *
 * Never a per-field COALESCE. Merging J-018's street with Jason Waldow's city would produce
 * "1871 Apache Ct, Olympic Valley" against the job's own "Tahoe City" — an address that exists on
 * no record and in no town. A candidate wins whole or it doesn't win.
 */
export function pickSite(candidates: { source: string; parts?: SiteParts | null }[]): ResolvedSite | null {
  for (const c of candidates) {
    const address = t(c.parts?.address);
    if (!address) continue;
    const city = t(c.parts?.city);
    const state = t(c.parts?.state);
    const zip = t(c.parts?.zip);
    return {
      address,
      city: city || null,
      state: state || null,
      zip: zip || null,
      source: c.source,
      // A blob that carries its own tail IS complete — Jason Waldow's row prints fine today and
      // must not be flagged as a gap just because its parts columns are empty.
      complete: (!!city && !!state && !!zip) || addressHasCityStateZipTail(address),
    };
  }
  return null;
}

/** The lines a site block renders. Second line suppressed when the first already carries it. */
export function siteLines(site: ResolvedSite | null): string[] {
  if (!site?.address) return [];
  const out = [site.address];
  if (!addressHasCityStateZipTail(site.address)) {
    const tail = formatCityStateZip(site.city, site.state, site.zip);
    if (tail) out.push(tail);
  }
  return out;
}

/** Drives the amber "no city on file" chip. A visible gap beats a silent partial on signed paper. */
export const siteIsIncomplete = (site: ResolvedSite | null): boolean => !!site?.address && !site.complete;
