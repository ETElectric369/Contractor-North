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
 * For Alder Ridge Rentals that fails four times over: J-009 "ARR #11", J-013 "ARR #56",
 * J-017 "ARR #224" and J-035 are four different dwellings at 300 W Garnet Blvd, and the unit number
 * exists ONLY in the job name. Two of them are already paid.
 *
 * ── WHY THERE IS NO ADDRESS PARSER IN THIS FILE ─────────────────────────────────────────────
 *
 * The obvious fix — split "1871 Acacia Ct Olympic Valley CA 96146 United States" into parts and
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

import { formatCityStateZip, unitLine } from "@/lib/utils";

export interface SiteParts {
  address?: string | null;
  /** The dwelling. Four ARR jobs share 300 W Garnet Blvd and only this tells them apart. */
  unit?: string | null;
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
export const SITE_COLS = "address, unit, city, state, zip";

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
 * Never a per-field COALESCE. Merging J-018's street with Jason Wexley's city would produce
 * "1871 Acacia Ct, Olympic Valley" against the job's own "Tahoe City" — an address that exists on
 * no record and in no town. A candidate wins whole or it doesn't win.
 */
export function pickSite(candidates: { source: string; parts?: SiteParts | null }[]): ResolvedSite | null {
  for (const c of candidates) {
    // A CANDIDATE CAN BE NULL. public_quote builds its list with json_build_array, and a
    // sub-select with no matching row lands in that array as a literal null — verified against
    // the live function, not assumed. Reading c.parts on it throws inside a server component,
    // which is a blank 500 on a customer's estimate.
    const address = t(c?.parts?.address);
    if (!address) continue;
    const city = t(c.parts?.city);
    const state = t(c.parts?.state);
    const zip = t(c.parts?.zip);
    return {
      address,
      unit: t(c.parts?.unit) || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
      source: c.source,
      // A blob that carries its own tail IS complete — Jason Wexley's row prints fine today and
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
  // ITS OWN LINE, DIRECTLY UNDER THE STREET — never appended to the address string. More than
  // half the live job rows are blobs ending in ", Tahoe City, CA 96145, USA", so appending would
  // put the dwelling after the ZIP; and inserting it before that tail would mean parsing the
  // blob, which is the one thing this file exists to refuse.
  const u = unitLine(site.unit);
  if (u) out.push(u);
  if (!addressHasCityStateZipTail(site.address)) {
    const tail = formatCityStateZip(site.city, site.state, site.zip);
    if (tail) out.push(tail);
  }
  return out;
}

/**
 * A TYPED LINE KEEPS THE PARTS A PICK ONCE RESOLVED ONLY WHILE IT STILL SAYS THEM.
 *
 * The Inspector's Where writes a typed line WITHOUT parts (0177: guessing a city from a line is
 * how a wrong address gets on a record), and the stored city/state/zip stayed as they were. On
 * 2026-10-13 that left a Georgia pick's state GA / zip 30014 standing under "3812 Dinah" in Tahoe
 * City after Erik typed over the pick — a record that says two places. So: each stored part must
 * still appear in the typed line as a whole word ("CA" is not the "ca" in Cathedral City); any
 * part the line no longer carries means the pick is gone, and the parts go with it (the amber
 * "no city on file" chip then asks, which is honest). Nothing stored → nothing to keep. Pure.
 */
export function typedLineKeepsParts(
  line: string,
  parts: { city?: string | null; state?: string | null; zip?: string | null } | null | undefined,
): boolean {
  const word = (p: string | null | undefined) => (p ?? "").trim().toLowerCase();
  const says = (p: string) => new RegExp(`(^|[^a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(line.toLowerCase());
  // THE STATE AND THE ZIP ARE THE JUDGES. The stored city is Google's locality, which a formatted
  // line does not always repeat (a borough under "New York", a neighbourhood under a postal city),
  // so a full picked line could fail a city test and lose the parts it had just been given. A US
  // formatted line always carries its state and zip; only when neither is stored does the city judge.
  const anchors = [word(parts?.state), word(parts?.zip)].filter(Boolean);
  if (anchors.length) return anchors.every(says);
  const city = word(parts?.city);
  return city ? says(city) : true;
}

/** Drives the amber "no city on file" chip. A visible gap beats a silent partial on signed paper. */
export const siteIsIncomplete = (site: ResolvedSite | null): boolean => !!site?.address && !site.complete;
