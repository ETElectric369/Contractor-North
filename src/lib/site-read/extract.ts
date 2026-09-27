import { formatPhone } from "@/lib/utils";

/**
 * A CONTACT CARD READ OUT OF A WEB PAGE, WITH NO MODEL (Fill From Their Site, 2026-09-27).
 *
 * In order of trust, and each later source only fills what an earlier one left empty:
 *   1. schema.org JSON-LD: the site's own card (Organization, LocalBusiness, GovernmentOrganization
 *      and their kin), including its address, hours and contact points.
 *   2. Meta tags: og:site_name, the old OpenGraph/Facebook contact tags, schema.org microdata.
 *   3. tel: and mailto: links, then phone numbers, emails, a street address and hours written in
 *      the page's visible text.
 * A name taken from the <title> is WEAK (titles say "Home | Acme"), so the model may improve it.
 *
 * Pure and total: any HTML, however broken, gives back an object. Every pattern here is bounded,
 * because the page is a stranger's and can be 1.5 MB of anything.
 */

export interface SiteFields {
  name?: string;
  /** Formatted with the one formatPhone, main line first, at most 3. */
  phones?: string[];
  email?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  hours?: string;
  /** One line saying what they are ("Utility — electric service"). Only the model writes it. */
  about?: string;
  /** One of the Resources categories. Only the model picks it. */
  category?: string;
}
export type SiteField = keyof SiteFields;
export interface Extraction {
  fields: SiteFields;
  /** Fields found, but from a weak source (the page title), which a better answer may replace. */
  weak: SiteField[];
}

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE",
  nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR", guam: "GU",
};
const STATE_CODES = new Set(Object.values(US_STATES));

/** "California" or "ca" → "CA"; anything else stays as written (a foreign region is still true). */
export function stateCode(v: string | undefined): string | undefined {
  const s = clean(v, 40);
  if (!s) return undefined;
  if (STATE_CODES.has(s.toUpperCase())) return s.toUpperCase();
  return US_STATES[s.toLowerCase()] ?? s;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", hellip: "…", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Collapse whitespace, trim, cap. Undefined when nothing is left. */
function clean(v: unknown, max = 160): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
}

/** A tag's attributes, names lowercased, values entity-decoded. Quoted ">" is handled. */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = tag.replace(/^<\s*[\w:-]+/, "").replace(/\/?>$/, "");
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/**
 * LINEAR TIME ON A HOSTILE PAGE. A tag pattern never runs past the next "<" (not even inside an
 * unclosed quote), and elements are cut out with indexOf, not a lazy regex: "<select <select …" or a
 * thousand unclosed "<!--" would otherwise make each match scan to the end of 1.5 MB, once per
 * occurrence.
 */
const TAG = (name: string) => new RegExp(`<${name}\\b(?:[^<>"']|"[^"<]*"|'[^'<]*')*>`, "gi");

/** Lowercased with every index still lined up with the original ("İ".toLowerCase() is 2 long). */
function lowerSameLength(s: string): string {
  const l = s.toLowerCase();
  return l.length === s.length ? l : s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

const CODE = ["script", "style", "template", "svg"];
const HIDDEN = ["noscript", "select", "iframe", "object", "canvas", "head", "title"];

/** Where `close` ("</head", "-->") next appears from `from`, as a whole name: "</head" is not the
 *  start of "</header", which a page that leaves out its </head> would otherwise cut to. Each skip
 *  moves on past the false match, so the search still reads the page once. */
function closeAt(lower: string, close: string, from: number): number {
  let j = lower.indexOf(close, from);
  if (close === "-->") return j;
  while (j !== -1 && /[\w:-]/.test(lower[j + close.length] ?? "")) j = lower.indexOf(close, j + 1);
  return j;
}

/**
 * Cut out comments and the named elements, in ONE left-to-right pass (as a browser reads: a comment
 * that opens first hides a script, and a script that opens first holds a comment). An unclosed one
 * loses only its opening marker, and once a closing marker is known to be missing it is never
 * searched for again: that is what keeps a page of unclosed tags linear.
 */
function cutElements(html: string, names: readonly string[]): string {
  const lower = lowerSameLength(html);
  const noClose = new Set<string>();
  let out = "";
  let pos = 0;
  let i = lower.indexOf("<");
  while (i !== -1) {
    let open = "";
    let close = "";
    if (lower.startsWith("!--", i + 1)) {
      open = "<!--";
      close = "-->";
    } else {
      const n = names.find((x) => lower.startsWith(x, i + 1) && !/[\w:-]/.test(lower[i + 1 + x.length] ?? ""));
      if (n) {
        open = `<${n}`;
        close = `</${n}`;
      }
    }
    if (!open) {
      i = lower.indexOf("<", i + 1);
      continue;
    }
    const j = noClose.has(close) ? -1 : closeAt(lower, close, i + open.length);
    out += `${html.slice(pos, i)} `;
    if (j === -1) {
      noClose.add(close);
      pos = i + open.length;
    } else {
      pos = close === "-->" ? j + 3 : lower.indexOf(">", j) + 1 || html.length;
    }
    i = lower.indexOf("<", pos);
  }
  return out + html.slice(pos);
}

/** The HTML without comments, scripts, styles and inline pictures: what links and meta are read from. */
function withoutCode(html: string): string {
  return cutElements(html, CODE);
}

/** The words a person would see, one block per line. */
export function visibleText(html: string): string {
  const s = cutElements(html, [...CODE, ...HIDDEN])
    .replace(/<br\b[^<>]*>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|nav|aside|main|address|dd|dt|dl|form|fieldset|figure|figcaption|blockquote|pre|hr)\b[^<>]*>/gi, "\n")
    .replace(/<[^<>]*>/g, " ");
  return decodeEntities(s)
    .split("\n")
    .map((l) => l.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

// ── PHONES AND EMAILS ───────────────────────────────────────────────────────────────────────────

/** Ten digits of a North American number, or null. Longer or foreign numbers are left alone
 *  (formatPhone would mangle them), and so is anything that can't be an area code + exchange. */
export function phoneDigits(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  if (!/^[2-9]\d{2}[2-9]/.test(d)) return null;
  return d;
}

export function cleanEmail(raw: string): string | null {
  const e = raw.trim().replace(/^mailto:/i, "").replace(/[.,;:)]+$/, "").toLowerCase();
  if (e.length > 120) return null;
  if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(e)) return null;
  const [local, domain] = e.split("@");
  if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e)) return null;
  if (/(^|\.)(example\.(com|org|net)|domain\.com|yourdomain\.com|sentry\.io|wixpress\.com)$/.test(domain)) return null;
  if (/^(your-?(name|email)?|name|user|email|someone|john\.?doe|test)$/.test(local)) return null;
  return e;
}

/** A tally that keeps first-seen order for ties. */
class Tally {
  private m = new Map<string, { n: number; at: number; score: number }>();
  add(key: string, score = 0) {
    const cur = this.m.get(key);
    if (cur) {
      cur.n++;
      cur.score = Math.max(cur.score, score);
    } else this.m.set(key, { n: 1, at: this.m.size, score });
  }
  ranked(): string[] {
    return [...this.m.entries()].sort((a, b) => b[1].score - a[1].score || b[1].n - a[1].n || a[1].at - b[1].at).map(([k]) => k);
  }
}

/** Phone numbers written out in text: "(530) 555-1234", "530-555-1234", "+1 530.555.1234". A bare
 *  run of ten digits is NOT taken (it is as often an order or permit number). Fax lines are skipped. */
function textPhones(text: string): string[] {
  const out: string[] = [];
  const re = /(?<![\d-])(?:\+?1[ .-]?)?(?:\(\s?([2-9]\d{2})\s?\)[ .-]?|([2-9]\d{2})[ .-])([2-9]\d{2})[ .-](\d{4})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 16), m.index);
    if (/\b(fax|f)\s*[:.#]?\s*$/i.test(before)) continue;
    out.push(`${m[1] ?? m[2]}${m[3]}${m[4]}`);
  }
  return out;
}

/** Emails in text, found from each "@" outward (no regex scan of the whole page, so a long run of
 *  letters can't make it slow). */
function textEmails(text: string): string[] {
  const out: string[] = [];
  let i = text.indexOf("@");
  while (i !== -1 && out.length < 50) {
    const left = /[A-Za-z0-9._%+-]{1,64}$/.exec(text.slice(Math.max(0, i - 64), i))?.[0];
    const right = /^[A-Za-z0-9.-]{1,120}/.exec(text.slice(i + 1, i + 121))?.[0];
    if (left && right) {
      const e = cleanEmail(`${left}@${right}`);
      if (e) out.push(e);
    }
    i = text.indexOf("@", i + 1);
  }
  return out;
}

function sameSite(email: string, host: string): boolean {
  const d = email.split("@")[1] ?? "";
  const h = host.toLowerCase().replace(/^www\./, "");
  return !!d && (d === h || h.endsWith(`.${d}`) || d.endsWith(`.${h}`));
}

// ── ADDRESSES ───────────────────────────────────────────────────────────────────────────────────

const STREET_WORD =
  "(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Cir|Circle|Ter|Terrace|Trl|Trail|Loop|Sq|Square|Plaza|Row|Pike|Hwy|Highway)\\.?";
const NUMBERED_ROAD = "(?:Highway|Hwy\\.?|Route|Rte\\.?|State Route|SR|US|County Road|CR)[ ]\\d{1,4}[A-Z]?";
const STREET =
  `\\d{1,6}(?:-\\d{1,4})?[ ](?:[NSEW]\\.?[ ])?(?:[A-Za-z0-9.'-]+[ ]){0,5}?(?:${STREET_WORD}|${NUMBERED_ROAD})(?:[ ][NSEW]{1,2}\\.?)?` +
  `(?:,?[ ](?:Suite|Ste\\.?|Unit|Bldg\\.?|Building|#)[ ]?[\\w-]{1,8})?`;
const CITY_STATE_ZIP = "[,\\s]{1,4}([A-Za-z][A-Za-z .'-]{1,40}?),?[ ]{1,3}([A-Z]{2})\\.?,?[ ]{1,3}(\\d{5}(?:-\\d{4})?)\\b";
const ADDRESS_RE = new RegExp(`\\b(${STREET})${CITY_STATE_ZIP}`, "g");
const PO_BOX_RE = new RegExp(`\\b(P\\.?[ ]?O\\.?[ ]?Box[ ]\\d{1,6})${CITY_STATE_ZIP}`, "gi");

type Address = { street?: string; city?: string; state?: string; zip?: string };

function textAddress(text: string): Address | null {
  for (const re of [ADDRESS_RE, PO_BOX_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!STATE_CODES.has(m[3].toUpperCase())) continue;
      return { street: clean(m[1], 120), city: clean(m[2], 60), state: m[3].toUpperCase(), zip: m[4] };
    }
  }
  return null;
}

// ── HOURS ───────────────────────────────────────────────────────────────────────────────────────

const DAY = "(?:Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\\.?";
const DAYS = `${DAY}(?:[ ]?(?:-|–|—|to|through|thru|&|and)[ ]?${DAY})?`;
const CLOCK = "\\d{1,2}(?::\\d{2})?[ ]?(?:[ap]\\.?[ ]?m\\.?)?";
const SPAN = `${CLOCK}[ ]?(?:-|–|—|to)[ ]?${CLOCK}`;
const HOURS_RE = new RegExp(`\\b(?:${DAYS}[ ]?[,:]?[ ]?${SPAN}|${SPAN},?[ ]${DAYS})`, "gi");

function textHours(text: string): string | undefined {
  const seen: string[] = [];
  let m: RegExpExecArray | null;
  HOURS_RE.lastIndex = 0;
  while ((m = HOURS_RE.exec(text)) && seen.length < 3) {
    // "4 PM." at the end of a sentence: the period is the sentence's, not the clock's ("p.m." keeps it).
    const s = clean(m[0], 80)?.replace(/(\b[ap]m)\.$/i, "$1");
    if (s && !seen.some((x) => x.toLowerCase() === s.toLowerCase())) seen.push(s);
  }
  return seen.length ? seen.join("; ") : undefined;
}

/** A day ("Mon", "Tuesdays"), a clock ("8 AM", "5:30 p.m.", "17:00") or "24/7": what any line of
 *  opening hours has, and a line that isn't hours ("Pay invoices by Zelle") doesn't. */
const HOURS_WORD_RE =
  /\b(?:Mon|Tues?|Wed(?:nes)?|Thu(?:rs?)?|Fri|Sat(?:ur)?|Sun)(?:day)?s?\.?(?![a-z])|\b\d{1,2}(?::\d{2})?[ ]?[ap]\.?[ ]?m\b|\b\d{1,2}:\d{2}\b|\b24\/7\b|\b24 hours\b/i;
export function looksLikeHours(s: string): boolean {
  return HOURS_WORD_RE.test(s);
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_INDEX: Record<string, number> = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };

/** A JSON-LD value is anything the page wrote, so only a string is read: String() on an object whose
 *  "toString" is 1 throws, and one bad day must not take the whole card down with it. */
function dayIndex(v: unknown): number | null {
  const s = (typeof v === "string" ? v : "").replace(/^https?:\/\/schema\.org\//i, "").trim().toLowerCase();
  return s.length >= 2 && s.slice(0, 2) in DAY_INDEX ? DAY_INDEX[s.slice(0, 2)] : null;
}

/** "08:00" → "8 AM", "17:30" → "5:30 PM". */
function time12(t: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  if (!m) return t.trim();
  const h24 = Number(m[1]);
  const ap = h24 >= 12 && h24 < 24 ? "PM" : "AM";
  const h = h24 % 12 || 12;
  return m[2] === "00" ? `${h} ${ap}` : `${h}:${m[2]} ${ap}`;
}

/** Days as runs: [0,1,2,3,4] → "Mon–Fri", [0,2] → "Mon, Wed". */
function dayRuns(days: readonly number[]): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < d.length; ) {
    let j = i;
    while (j + 1 < d.length && d[j + 1] === d[j] + 1) j++;
    runs.push(j - i >= 2 ? `${DAY_NAMES[d[i]]}–${DAY_NAMES[d[j]]}` : d.slice(i, j + 1).map((x) => DAY_NAMES[x]).join(", "));
    i = j + 1;
  }
  return runs.join(", ");
}

/** schema.org openingHours ("Mo-Fr 08:00-17:00") or openingHoursSpecification, in plain words.
 *  A real week is 7 days in a handful of specs, so both lists are capped: a page's own arrays are
 *  otherwise as long as it likes (300k copies of "Mo" in 1.5 MB). Each day is SET once, so every
 *  list stays at most 7 long whatever the page repeats. */
function ldHours(node: Record<string, unknown>): string | undefined {
  const spec = ([] as unknown[]).concat(node.openingHoursSpecification ?? []).slice(0, 50);
  if (spec.length) {
    const byTime = new Map<string, Set<number>>();
    for (const s of spec) {
      if (!s || typeof s !== "object") continue;
      const o = s as Record<string, unknown>;
      const opens = clean(o.opens, 8);
      const closes = clean(o.closes, 8);
      if (!opens || !closes || (opens.startsWith("00:00") && closes.startsWith("00:00"))) continue;
      const key = `${time12(opens)}–${time12(closes)}`;
      for (const d of ([] as unknown[]).concat(o.dayOfWeek ?? []).slice(0, 14)) {
        const i = dayIndex(d);
        if (i === null) continue;
        const days = byTime.get(key) ?? new Set<number>();
        days.add(i);
        byTime.set(key, days);
      }
    }
    const parts = [...byTime.entries()]
      .map(([t, days]) => [t, [...days]] as const)
      .sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]))
      .map(([t, days]) => `${dayRuns(days)} ${t}`);
    if (parts.length) return parts.join("; ");
  }
  const oh = ([] as unknown[])
    .concat(node.openingHours ?? [])
    .slice(0, 50)
    .map((x) => clean(x, 60))
    .filter(Boolean) as string[];
  if (!oh.length) return undefined;
  return oh
    .slice(0, 4)
    .map((s) => {
      const m = /^([A-Za-z,\s-]+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(s);
      if (!m) return s;
      const days = m[1].replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/g, (d) => DAY_NAMES[DAY_INDEX[d.toLowerCase()]]).replace(/\s*-\s*/g, "–").replace(/\s*,\s*/g, ", ");
      return `${days} ${time12(m[2])}–${time12(m[3])}`;
    })
    .join("; ");
}

// ── JSON-LD ─────────────────────────────────────────────────────────────────────────────────────

type Node = Record<string, unknown>;

/**
 * Keys whose value is ANOTHER party, never the site's own card: a product's brand or maker, an
 * article's author, a parent company, a sponsor, a review. Their names and numbers are not the
 * contact's (a supply house's product page names Square D, with Square D's phone). publisher,
 * provider and seller are kept: on the site's own pages they are the site's own organization.
 */
const OTHER_PARTY = new Set([
  "brand", "manufacturer", "author", "creator", "contributor", "editor", "parentorganization", "memberof", "member",
  "members", "sponsor", "funder", "organizer", "performer", "attendee", "review", "reviews", "itemreviewed",
  "affiliation", "worksfor", "alumniof", "competitor", "isbasedon", "citation", "mentions",
]);

/** Every typed node in the page's JSON-LD, with how many typed nodes it sits inside: 0 for a node at
 *  the top or straight in @graph (the site's own cards), 1+ for one nested in another's field. */
function jsonLdNodes(html: string): { n: Node; nest: number }[] {
  const out: { n: Node; nest: number }[] = [];
  const walk = (v: unknown, depth: number, nest: number) => {
    if (depth > 8 || out.length > 300 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 100)) walk(x, depth + 1, nest);
      return;
    }
    const o = v as Node;
    const typed = !!o["@type"];
    if (typed) out.push({ n: o, nest });
    for (const [k, x] of Object.entries(o)) {
      if (x && typeof x === "object" && !OTHER_PARTY.has(k.toLowerCase())) walk(x, depth + 1, typed ? nest + 1 : nest);
    }
  };
  const lower = lowerSameLength(html);
  const re = TAG("script");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const start = m.index + m[0].length;
    const end = lower.indexOf("</script", start);
    if (end === -1) break; // no closing tag anywhere after this: no more scripts to read
    re.lastIndex = end;
    if (!/ld\+json/i.test(attrsOf(m[0]).type ?? "")) continue;
    const body = html.slice(start, end).trim().replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/^<!--|-->$/g, "").trim();
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      try {
        data = JSON.parse(body.replace(/[\u0000-\u001f]+/g, " ").replace(/,(\s*[}\]])/g, "$1"));
      } catch {
        continue;
      }
    }
    walk(data, 0, 0);
  }
  return out;
}

function typesOf(n: Node): string[] {
  return ([] as unknown[])
    .concat(n["@type"] ?? [])
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.replace(/^https?:\/\/schema\.org\//i, ""))
    .filter(Boolean);
}

/** 3 = a business or public office, 2 = an organization, 1 = a website or place, 0 = not a card.
 *  "Service" (a thing offered) and "GovernmentService" are not the card: their name is a service. */
function rankOf(types: string[]): number {
  if (types.some((t) => /^(LocalBusiness|GovernmentOffice|GovernmentOrganization|GovernmentBuilding|CityHall|Courthouse|PostOffice|FireStation|PoliceStation|Library)$/.test(t)))
    return 3;
  if (types.some((t) => /(Business|Store|Contractor|Electrician|Plumber|Office|Dealer|Wholesaler|Utility|Agency|Department)$/.test(t))) return 3;
  if (types.some((t) => /^(?!Government)\w+Service$/.test(t))) return 3;
  if (types.some((t) => /(Organization|Corporation|NGO)$/.test(t))) return 2;
  if (types.some((t) => /^(Place|WebSite)$/.test(t))) return 1;
  return 0;
}

function ldAddress(v: unknown): Address | null {
  const a = Array.isArray(v) ? v[0] : v;
  if (typeof a === "string") {
    const s = clean(a, 200);
    if (!s) return null;
    const m = new RegExp(`^(.*?)${CITY_STATE_ZIP}$`).exec(s);
    return m ? { street: clean(m[1].replace(/,$/, ""), 120), city: clean(m[2], 60), state: m[3], zip: m[4] } : { street: s };
  }
  if (!a || typeof a !== "object") return null;
  const o = a as Node;
  const street = clean(([] as unknown[]).concat(o.streetAddress ?? []).filter((x) => typeof x === "string").join(", "), 120);
  const out = { street, city: clean(o.addressLocality, 60), state: stateCode(clean(o.addressRegion, 40)), zip: clean(o.postalCode, 10) };
  return out.street || out.city || out.zip ? out : null;
}

// ── MICRODATA ───────────────────────────────────────────────────────────────────────────────────

/**
 * The first element on the page for each itemprop asked for, and its words (up to 300 characters,
 * to the element's own closing tag). ONE pass over the tags, with the same linear TAG pattern: a
 * pattern that hunts for "itemprop" somewhere inside a tag re-scans the rest of a long tag once per
 * attribute in it, so a single 1.5 MB tag of itemprop="telephone" repeated ran for minutes.
 */
function microdata(bare: string, props: readonly string[]): Map<string, string> {
  const want = new Map(props.map((p) => [p.toLowerCase(), p]));
  const out = new Map<string, string>();
  const re = TAG("(\\w+)");
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) && out.size < want.size) {
    if (!/itemprop/i.test(m[0])) continue;
    const keys = (attrsOf(m[0]).itemprop ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((k) => want.has(k) && !out.has(want.get(k)!));
    if (!keys.length) continue;
    const start = m.index + m[0].length;
    const window = bare.slice(start, start + 400);
    const close = new RegExp(`</${m[1]}\\s*>`, "i").exec(window);
    if (!close || close.index > 300) continue;
    const words = clean(decodeEntities(window.slice(0, close.index).replace(/<[^<>]*>/g, " ")), 120);
    if (words) for (const k of keys) out.set(want.get(k)!, words);
  }
  return out;
}

// ── THE READER ──────────────────────────────────────────────────────────────────────────────────

/** Page <title>, split and cleaned: "Home | Acme Electric Supply" → "Acme Electric Supply". */
export function nameFromTitle(title: string | undefined): string | undefined {
  const t = clean(title, 200);
  if (!t) return undefined;
  const parts = t
    .split(/\s+[|•·–—-]\s+|\s*::\s*/)
    .map((p) => p.replace(/^welcome to\s+(the\s+)?/i, "").trim())
    .filter((p) => p && !/^(home( ?page)?|welcome|official (web ?)?site|index|main|contact( us)?|about( us)?)$/i.test(p));
  return clean(parts[0], 100);
}

export function extractContact(html: string, pageUrl: string): Extraction {
  const f: SiteFields = {};
  const weak = new Set<SiteField>();
  let host = "";
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    /* no host: emails just aren't ranked by it */
  }
  const phones = new Tally();
  const emails = new Tally();
  const addPhone = (raw: unknown, score: number) => {
    const d = typeof raw === "string" || typeof raw === "number" ? phoneDigits(String(raw)) : null;
    if (d) phones.add(d, score);
  };
  const addEmail = (raw: unknown, score: number) => {
    const e = typeof raw === "string" ? cleanEmail(raw) : null;
    if (e) emails.add(e, score + (sameSite(e, host) ? 1 : 0));
  };
  const setAddress = (a: Address | null) => {
    if (!a) return;
    if (!f.street && a.street) f.street = a.street;
    if (!f.city && a.city) f.city = a.city;
    if (!f.state && a.state) f.state = a.state;
    if (!f.zip && a.zip) f.zip = a.zip;
  };

  // 1. JSON-LD, best card first; of two as good, the one the site wrote at the top (not one nested
  //    in another node's field, like an offer's seller) first.
  const nodes = jsonLdNodes(html)
    .map(({ n, nest }) => ({ n, nest, rank: rankOf(typesOf(n)) }))
    .filter((x) => x.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.nest - b.nest);
  for (const { n } of nodes) {
    const nodeName = typeof n.name === "string" ? n.name : typeof n.legalName === "string" ? n.legalName : undefined;
    if (!f.name && nodeName) f.name = clean(decodeEntities(nodeName), 120);
    for (const t of ([] as unknown[]).concat(n.telephone ?? [])) addPhone(t, 4);
    for (const e of ([] as unknown[]).concat(n.email ?? [])) addEmail(e, 4);
    for (const cp of ([] as unknown[]).concat(n.contactPoint ?? [])) {
      if (!cp || typeof cp !== "object") continue;
      for (const t of ([] as unknown[]).concat((cp as Node).telephone ?? [])) addPhone(t, 3);
      for (const e of ([] as unknown[]).concat((cp as Node).email ?? [])) addEmail(e, 3);
    }
    if (!f.street && !f.city) setAddress(ldAddress(n.address));
    if (!f.hours) f.hours = ldHours(n);
  }

  // 2. Meta tags and microdata.
  const bare = withoutCode(html);
  const meta = new Map<string, string>();
  const tagRe = TAG("meta");
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(bare))) {
    const a = attrsOf(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? "").toLowerCase();
    const content = clean(a.content, 300);
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find(Boolean);
  if (!f.name) f.name = clean(pick("og:site_name"), 120);
  addPhone(pick("og:phone_number", "business:contact_data:phone_number", "telephone"), 3);
  addEmail(pick("og:email", "business:contact_data:email", "email"), 3);
  if (!f.street && !f.city) {
    setAddress({
      street: clean(pick("og:street-address", "business:contact_data:street_address", "streetaddress"), 120),
      city: clean(pick("og:locality", "business:contact_data:locality", "addresslocality"), 60),
      state: stateCode(pick("og:region", "business:contact_data:region", "addressregion")),
      zip: clean(pick("og:postal-code", "business:contact_data:postal_code", "postalcode"), 10),
    });
  }
  // Microdata written on the page itself: <span itemprop="telephone">(530) 555-0123</span>.
  const itemprop = microdata(bare, ["telephone", "email", "streetAddress", "addressLocality", "addressRegion", "postalCode"]);
  addPhone(itemprop.get("telephone"), 3);
  addEmail(itemprop.get("email"), 3);
  if (!f.street && !f.city) {
    setAddress({
      street: itemprop.get("streetAddress"),
      city: itemprop.get("addressLocality"),
      state: stateCode(itemprop.get("addressRegion")),
      zip: itemprop.get("postalCode"),
    });
  }

  // 3. Links, then the words on the page.
  const linkRe = TAG("a");
  while ((m = linkRe.exec(bare))) {
    const href = (attrsOf(m[0]).href ?? "").trim();
    const scheme = href.slice(0, 7).toLowerCase();
    if (scheme.startsWith("tel:") || scheme.startsWith("callto:")) {
      const rest = safeDecode(href.slice(href.indexOf(":") + 1)).split(/[;,]|\bext\b|\bx\b/i)[0];
      addPhone(rest, 2);
    } else if (scheme === "mailto:") {
      addEmail(safeDecode(href.slice(7)).split("?")[0].split(",")[0], 2);
    }
  }
  const text = visibleText(html).slice(0, 400_000);
  for (const d of textPhones(text)) phones.add(d, 1);
  for (const e of textEmails(text)) addEmail(e, 1);
  if (!f.street && !f.city) setAddress(textAddress(text));
  if (!f.hours) f.hours = textHours(text);

  if (!f.name) {
    const title = /<title\b[^<>]*>([\s\S]{0,400}?)<\/title\s*>/i.exec(bare)?.[1];
    f.name = nameFromTitle(decodeEntities(title ?? "")) ?? nameFromTitle(pick("og:title"));
    if (f.name) weak.add("name");
  }

  const phoneList = phones.ranked().slice(0, 3).map((d) => formatPhone(d));
  if (phoneList.length) f.phones = phoneList;
  const email = emails.ranked()[0];
  if (email) f.email = email;

  for (const k of Object.keys(f) as SiteField[]) if (f[k] === undefined) delete f[k];
  return { fields: f, weak: [...weak].filter((k) => f[k] !== undefined) };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The page as the model sees it: its address, title and description, then its words. A long page
 *  keeps its top and its bottom (where the footer's phone and address usually are). */
export function pageTextForModel(html: string, pageUrl: string, max = 12_000): string {
  const bare = withoutCode(html);
  const title = clean(decodeEntities(/<title\b[^<>]*>([\s\S]{0,400}?)<\/title\s*>/i.exec(bare)?.[1] ?? ""), 200);
  let desc: string | undefined;
  const tagRe = TAG("meta");
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(bare)) && !desc) {
    const a = attrsOf(m[0]);
    if (/^(description|og:description)$/i.test(a.name ?? a.property ?? "")) desc = clean(a.content, 300);
  }
  const text = visibleText(html);
  const body = text.length > max ? `${text.slice(0, Math.round(max * 0.6))}\n…\n${text.slice(-Math.round(max * 0.4))}` : text;
  return [`Page address: ${pageUrl}`, title ? `Title: ${title}` : "", desc ? `Description: ${desc}` : "", "", body]
    .filter((l, i) => l || i === 3)
    .join("\n");
}
