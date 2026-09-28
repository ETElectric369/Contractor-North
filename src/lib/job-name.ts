/**
 * A JOB'S NAME IS THE STREET, AND NEVER WHERE IT CAME FROM (Erik 2026-09-27 / 09-28).
 *
 * "site inspections are labeled with the tag they shouldnt carry site inspection in the job title
 * same goes for any conversion", then, final: "street number and name as always". His company's
 * jobs have always been named "3245 West Lake Boulevard", "498 Mil Drae Lane"; with no address, the
 * person ("Jackie Burks"); a unit complex "TTP #56".
 *
 * ONE namer for every door that makes a job (a visit, a lead, an accepted estimate, New Job, Nort,
 * an import, a recurring template). The SQL twin is public.job_name_from (0369), used by the public
 * estimate accept; the two are pinned against each other by the same cases (job-name.cases.ts).
 *
 *   1. A name a PERSON typed (`typed`: New Job's or Nort's name, an import's job_name column, a
 *      recurring template's title) stays exactly as typed, unless it is ONLY a source tag, or a tag
 *      and the customer or the street (the stock "Site inspection: Rita Moss"): that is no name.
 *   2. With a street: the street number and name, and " #<unit>" when the job has a unit ("300
 *      West Lake Boulevard #56"). No person, no city/state/zip. Words a SOURCE carried
 *      (`sourceWords`: a visit's title, an estimate's title, a lead's short scope) never replace it.
 *   3. No street: the customer as written (the company, else the whole name: "Jackie Burks"), then
 *      " · " and the source's own work words when any are left once the tag comes off ("Jackie
 *      Burks · Panel Upgrade"), cut to about 40 characters, never a paragraph. A part of the words
 *      that is only who or where comes off too (the lead door's "New deck — Rita Moss" is "New deck").
 *   4. Neither: "New Job · Sep 28" on the company's today. (Work words with no one and nowhere are
 *      still the work: "Kitchen rewire", never a date.)
 * 2-4 are lib/schedule-options defaultJobName, the line New Job shows live ("It'll Be Called").
 *
 * A tag counts only at the very front, followed by a separator or nothing: a real name that merely
 * contains the word stays ("RV Inspection", "Lead Paint Abatement"). The phone-call booking's stock
 * title has no separator (bookingTitle's "Call Rita Moss", "Call Visit"): a leading "Call" is a tag
 * there only when the person, the street or nothing follows it, so "Call box install" stays.
 *
 * Pure (no clock of its own): every caller hands in the company's today, like defaultJobName.
 */
import { defaultJobName, unitForName } from "@/lib/schedule-options";

type Customer = { name?: string | null; company_name?: string | null; type?: string | null } | null | undefined;

/** The source tags, longest first so "Site inspection" is taken whole before "Inspection". */
export const SOURCE_TAGS = [
  "site inspection",
  "site visit",
  "service call",
  "phone call",
  "walk-through",
  "walk through",
  "walkthrough",
  "inspection",
  "appointment",
  "estimate",
  "inquiry",
  "meeting",
  "quote",
  "call",
  "lead",
  "visit",
] as const;

const TAG_ALT = SOURCE_TAGS.map((t) => t.replace(/[-\s]/g, (c) => (c === "-" ? "\\-" : "\\s+"))).join("|");
// A tag counts only at the very front, and only when a separator (":" "—" "–" "·" "|", or a hyphen
// with a space on either side, so "Lead-free piping" is left alone) or the end follows it.
const LEADING_TAG = new RegExp(`^(?:${TAG_ALT})\\s*(?:[:—–·|]|\\s-|-\\s|$)\\s*`, "i");
// The phone-call booking's stock title, "Call Rita Moss" (lib/schedule/work-shape bookingTitle): no
// separator after the word, so it is a tag only when who, where or nothing follows (untag).
const BARE_CALL = /^(?:phone\s+)?call\s+/i;
// The old stock fallbacks: "Job from appointment", "Job from Q-0012" (a quote number), "Job from lead".
const STOCK_FALLBACK = /^job\s+from\s+(?:appointment|lead|inquiry|estimate|quote|visit|[a-z]{1,3}-?\d[\w-]*)\s*$/i;

/** The title with any leading source tag taken off ("Site inspection: Rita Moss" → "Rita Moss";
 *  "Inspection" → ""). A title with no leading tag comes back as typed, trimmed. */
export function stripSourceTag(title: string | null | undefined): string {
  let s = tidy(title);
  if (STOCK_FALLBACK.test(s)) return "";
  // Repeated, for a tag on a tag ("Site inspection: Visit").
  for (let i = 0; i < 4; i++) {
    const next = s.replace(LEADING_TAG, "").trim();
    if (next === s) break;
    s = next;
  }
  return STOCK_FALLBACK.test(s) ? "" : s;
}

// A name as a key: case, spacing, punctuation and accents don't make two spellings different. Letters
// and digits of ANY script count ("Иван Петров" and "李明" are keys too, never ""), the way the SQL
// twin's lower(normalize(.., NFKD)) and [[:alnum:]] read them.
const key = (s: string | null | undefined) =>
  String(s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
function tidy(s: string | null | undefined): string {
  return String(s ?? "").trim().replace(/\s+/g, " ");
}

/**
 * THE NAME A NEW JOB GETS, from every door (the rule is at the top of this file).
 *
 *   `typed`        a name a person typed: kept exactly as typed, unless it is only a tag, or a tag
 *                  and who or where;
 *   `sourceWords`  the words a source carried (a visit's or an estimate's title, a lead's short
 *                  scope): never the name when there is a street; with none, they follow who;
 *   `customer`, `street`, `unit`  who and where;
 *   `aliases`      other spellings of who a stock title may carry: a visit's title is built from the
 *                  LEAD's typed name ("Site inspection: Rich Test") while the job is named for the
 *                  card it links to ("Richard Test"), so the lead's own name counts as only-who too
 *                  (jobWho gives them).
 */
export function jobNameFrom(p: {
  typed?: string | null;
  sourceWords?: string | null;
  customer?: Customer;
  street?: string | null;
  unit?: string | null;
  todayStr: string;
  aliases?: (string | null | undefined)[];
}): string {
  const streetLine = streetOf(p.street);
  const unit = tidy(p.unit);
  // Who or where, as keys: the customer's name, the company, the street (and the street with its
  // unit, "12 Elm St #4" / "12 Elm St Apt 4"), an alias.
  const whoKeys = [
    p.customer?.name,
    p.customer?.company_name,
    p.street,
    ...(p.aliases ?? []),
    ...(streetLine && unit ? [`${streetLine} ${unitForName(unit)}`, `${streetLine} ${unit}`] : []),
  ]
    .map(key)
    .filter(Boolean);
  const streetLineKey = key(streetLine);
  // WHOLLY who or where: one of the keys, or an address line on the street.
  const isWho = (w: string) => {
    const k = key(w);
    return (k !== "" && whoKeys.includes(k)) || (streetLineKey !== "" && streetLineKey === key(streetOf(w)));
  };
  const rest = (w: string) => whoLess(w, isWho);

  // 1. A typed name stays exactly as typed, unless it is only a tag, or a tag and who or where.
  const typed = tidy(p.typed);
  if (typed) {
    const { words, tagged } = untag(typed, rest);
    if (!tagged || rest(words)) return typed;
  }

  // 2-4. The street (and unit), else who · the source's work words, else "New Job · Sep 28".
  const { words } = untag(tidy(p.sourceWords), rest);
  return defaultJobName({ customer: p.customer ?? null, street: p.street ?? null, unit: p.unit ?? null, work: rest(words), todayStr: p.todayStr });
}

/**
 * The words with who and where taken off: all of them when they are only who or where, else a part
 * at either end, after a separator (" — ", " – ", " · ", " | ", " - ", ", ", ": "), that is. The
 * lead door's seeded estimate is titled "New deck — Rita Moss": its work words are "New deck", never
 * the name again after "Rita Moss ·". "Rita Moss, 12 Elm St" is nothing. The SQL twin (0369,
 * job_name_who_less) splits and strips the same way.
 */
const PART_SEP = /(\s*[—–·|]\s*|\s+-\s+|\s*[,:]\s+)/;
function whoLess(words: string, isWho: (w: string) => boolean): string {
  let w = words.trim();
  for (let round = 0; round < 6; round++) {
    if (!w || isWho(w)) return "";
    // [part, separator, part, separator, …, part]
    const parts = w.split(PART_SEP);
    const n = parts.length;
    if (n < 3) break;
    let next: string | null = null;
    // The shortest run of parts at the front that is only who or where…
    for (let i = 0; i <= n - 3 && next === null; i += 2) {
      if (isWho(parts.slice(0, i + 1).join(""))) next = parts.slice(i + 2).join("");
    }
    // …else the shortest at the end.
    for (let i = n - 1; i >= 2 && next === null; i -= 2) {
      if (isWho(parts.slice(i).join(""))) next = parts.slice(0, i - 1).join("");
    }
    if (next === null) break;
    w = next.trim();
  }
  return w;
}

/** Is this typed name ONLY a source tag ("Service call", "Inspection", "Job from appointment")? It
 *  says what kind of visit, not which job: a door that has no one and nowhere to name the job for
 *  (the Timeclock's quick add) asks for the street or the customer instead. */
export function isOnlyASourceTag(typed: string | null | undefined): boolean {
  const t = tidy(typed);
  return !!t && stripSourceTag(t) === "";
}

/** Could this typed name be no name (blank, a tag, the call booking's "Call …")? Only then does a
 *  door need to read who and where for jobNameFrom; any other typed name is kept exactly as typed. */
export function typedNameMayBeATag(typed: string | null | undefined): boolean {
  const t = tidy(typed);
  return !t || stripSourceTag(t) !== t || BARE_CALL.test(t);
}

/** The words with any leading source tag off, and whether a tag came off. The phone-call booking's
 *  "Call Rita Moss" / "Call Visit" (no separator) is a tag only with who, where or nothing after it
 *  (nothing is left once who and where come off). */
function untag(raw: string, whoLessOf: (w: string) => string): { words: string; tagged: boolean } {
  const words = stripSourceTag(raw);
  if (words !== raw) return { words, tagged: true };
  if (BARE_CALL.test(raw)) {
    const rest = stripSourceTag(raw.replace(BARE_CALL, ""));
    if (!whoLessOf(rest)) return { words: rest, tagged: true };
  }
  return { words: raw, tagged: false };
}

/**
 * WHO A JOB IS FOR, the same way at the door and on the page that previews it: the first candidate
 * with a name or company (the visit's own card, then the lead's card, then the lead itself). Every
 * other candidate's spelling comes back as `aliases` for jobNameFrom, so a stock title built from the
 * lead's typed name is still recognized as only-who.
 */
export function jobWho(candidates: Customer[]): { customer: Customer; aliases: string[] } {
  const named = candidates.filter(
    (c): c is NonNullable<Customer> => !!c && !!(String(c.name ?? "").trim() || String(c.company_name ?? "").trim()),
  );
  const aliases = named
    .slice(1)
    .flatMap((c) => [c.name, c.company_name])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
  return { customer: named[0] ?? null, aliases };
}

/** The street line of a one-line address ("12 Elm St, Testville, CA 96161" → "12 Elm St"). A visit's
 *  `location` is the whole formatted line; the job's name wants only the street. */
export function streetOf(line: string | null | undefined): string {
  return String(line ?? "").split(",")[0].trim();
}

/**
 * The street of a VISIT's place, or "" when the place has none. A lead with a town and no street books
 * its visit at "Testville, CA 96161" (formatFullAddress with no street line), whose head is the town:
 * named for it, the job would be "Testville" (rule 2 is the street number and name, never the town).
 * The visit's own city/state/zip say which head is the town; a line shaped "Town, ST 12345" (a head
 * with no number, then only a state and zip) or a bare zip is no street either.
 */
export function visitStreetOf(
  location: string | null | undefined,
  place: { city?: string | null; state?: string | null; zip?: string | null } = {},
): string {
  const parts = String(location ?? "").split(",").map((x) => x.trim());
  const head = parts[0] ?? "";
  if (!head) return "";
  const k = key(head);
  if ([place.city, place.state, place.zip].some((v) => key(v) !== "" && key(v) === k)) return "";
  if (/^(?:[a-z]{2}\s*)?\d{5}(?:-\d{4})?$/i.test(head)) return ""; // "96161", "CA 96161"
  if (parts.length === 2 && !/\d/.test(head) && /^[a-z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/i.test(parts[1])) return "";
  return head;
}

/**
 * A lead's short scope words for its job's name (rule 3): the project type it picked, the head of
 * the label ("Resurface — new boards, keep the frame" → "Resurface", never "Not sure"), else its
 * message only when that is one short line ("3-way switches"), never a paragraph.
 */
export function leadScopeWords(lead: { projectTypeLabel?: string | null; projectType?: string | null; message?: string | null }): string {
  const label = tidy(lead.projectTypeLabel);
  if (label && lead.projectType !== "unsure") return label.split(/\s+[—–(]/)[0].trim();
  const raw = String(lead.message ?? "").trim();
  return raw && !/[\r\n]/.test(raw) && raw.length <= SHORT_SCOPE ? tidy(raw) : "";
}
const SHORT_SCOPE = 40;
