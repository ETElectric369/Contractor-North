/**
 * THE PLACE A DOCUMENT IS ABOUT, in a link and a filename (Erik 2026-09-25, after sharing Tao
 * Zhu's INV-080: "the invoice link and filename should also have the street number and name like
 * the job name", then "estimates too but we dont need the street label", then "KISS").
 *
 *   "235 Timbercreek Court"                    -> "235 Timbercreek"
 *   "3245 West Lake Boulevard"                 -> "3245 West Lake"
 *   "13897 Herringbone Way Truckee  CA 96161"  -> "13897 Herringbone"
 *
 * The place is the job site's first address line (a quote's own site first, when it has one),
 * else the customer's; else nothing. Never the customer's name, phone, city or anything else:
 * a link gets forwarded and a filename sits in a Downloads folder, and the street is all Erik
 * asked for.
 *
 * ONE HELPER, EVERY DOOR: every customer link to /i/<token> or /q/<token> goes through
 * orgDocUrl(settings, prefix, token, place) and every PDF filename through docFileName. The slug
 * is decoration — /i/<token>/<anything> renders the same page as /i/<token>, so every link
 * already sent keeps working and a street that changes later breaks nothing.
 */

/** A trailing street-type word ("the street label"), full or abbreviated, with or without a dot. */
const STREET_TYPE =
  /^(?:street|st|road|rd|drive|dr|lane|ln|avenue|ave|av|boulevard|blvd|court|ct|way|wy|circle|cir|place|pl|highway|hwy|trail|trl|loop|parkway|pkwy|terrace|ter)\.?$/i;

/** A unit suffix and everything after it: "#4", "Apt 2", "Unit B", "Suite 100", "Ste 5", "Spc 12". */
const UNIT = /\s*(?:#|\b(?:apt|apartment|unit|suite|ste|spc|space|bldg)\b\.?\s*#?)\s*[\w-]+.*$/i;

/**
 * The place: the first non-empty address, its first line, minus a unit suffix and minus the
 * street-type word. "" when there is no address at all.
 *
 * The cut is at the LAST street-type word, not only a literal last word, because a third of the
 * addresses on file are one comma-less blob ("1871 Apache Ct Olympic Valley CA 96146 United
 * States") where the street label is followed by the town. It never cuts down to the bare house
 * number ("94248 Highway 70" stays whole).
 */
export function docPlace(...addresses: (string | null | undefined)[]): string {
  const first = addresses.map((a) => String(a ?? "").trim()).find(Boolean);
  if (!first) return "";
  const line1 = first.split(/[,\n]/)[0].replace(UNIT, "").replace(/\s+/g, " ").trim();
  const words = line1.split(" ");
  for (let i = words.length - 1; i >= 1; i--) {
    if (!STREET_TYPE.test(words[i])) continue;
    const kept = words.slice(0, i);
    // Keep at least one word that isn't the house number.
    if (kept.some((w) => !/^\d+[a-z]?$/i.test(w))) return kept.join(" ").replace(/[.\s]+$/, "");
    break;
  }
  return line1;
}

type Addr = { address?: string | null } | { address?: string | null }[] | null | undefined;
const addressOf = (a: Addr) => (Array.isArray(a) ? a[0] : a)?.address;

/**
 * The place of an invoice or quote row read with its `address` embeds — `jobs(address)`,
 * `customers(address)`, and for a quote its own `address` and `inquiries(address)`. Most specific
 * first: the quote's own site, the job's, the lead's, then the customer's.
 */
export function rowPlace(
  row: { address?: string | null; jobs?: Addr; inquiries?: Addr; inquiry?: Addr; customers?: Addr } | null | undefined,
): string {
  return docPlace(
    row?.address,
    addressOf(row?.jobs),
    addressOf(row?.inquiries ?? row?.inquiry),
    addressOf(row?.customers),
  );
}

/** The place of what public_invoice / public_quote return: its site candidates in order (a null
 *  candidate is normal there, see pickSite), then the customer. */
export function projectionPlace(
  data: { site_candidates?: unknown; customer?: { address?: string | null } | null } | null | undefined,
): string {
  const sites = Array.isArray(data?.site_candidates) ? data.site_candidates : [];
  return docPlace(
    ...sites.map((c) => (c as { parts?: { address?: string | null } } | null)?.parts?.address),
    data?.customer?.address,
  );
}

/** "235 Timbercreek" -> "235-timbercreek": lowercase ASCII letters, digits and dashes only. */
export function placeSlug(place: string | null | undefined): string {
  return String(place ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

/** A link with the place on the end: ".../i/<token>/235-timbercreek". No place, no slug. */
export function withPlace(url: string, place: string | null | undefined): string {
  const slug = placeSlug(place);
  return slug ? `${url}/${slug}` : url;
}

/** "INV-080 235 Timbercreek.pdf" / "E-017 13897 Herringbone.pdf". Characters a filesystem
 *  refuses (/ \ : * ? " < > |) are dropped. */
export function docFileName(number: string | null | undefined, place: string | null | undefined): string {
  const name = [number, place]
    .map((p) => String(p ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 100)
    .trim();
  return `${name || "document"}.pdf`;
}

/** The page <title>: what the browser offers as the Save As PDF filename. */
export function docPageTitle(number: string | null | undefined, place: string | null | undefined): string {
  return docFileName(number, place).replace(/\.pdf$/, "");
}
