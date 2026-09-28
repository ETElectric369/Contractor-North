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
 *      Burks · Panel Upgrade"), cut to about 40 characters, never a paragraph.
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
import { defaultJobName } from "@/lib/schedule-options";

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

const key = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
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
  const whoKeys = [p.customer?.name, p.customer?.company_name, p.street, ...(p.aliases ?? [])].map(key).filter(Boolean);
  const streetLineKey = key(streetOf(p.street));
  // Only who or where: the customer's name, the company, an alias, the street (or an address line on it).
  const isOnlyWhoOrWhere = (w: string) => whoKeys.includes(key(w)) || (streetLineKey !== "" && streetLineKey === key(streetOf(w)));

  // 1. A typed name stays exactly as typed, unless it is only a tag, or a tag and who or where.
  const typed = tidy(p.typed);
  if (typed) {
    const { words, tagged } = untag(typed, isOnlyWhoOrWhere);
    if (!tagged || (words && !isOnlyWhoOrWhere(words))) return typed;
  }

  // 2-4. The street (and unit), else who · the source's work words, else "New Job · Sep 28".
  const { words } = untag(tidy(p.sourceWords), isOnlyWhoOrWhere);
  const work = words && !isOnlyWhoOrWhere(words) ? words : "";
  return defaultJobName({ customer: p.customer ?? null, street: p.street ?? null, unit: p.unit ?? null, work, todayStr: p.todayStr });
}

/** Could this typed name be no name (blank, a tag, the call booking's "Call …")? Only then does a
 *  door need to read who and where for jobNameFrom; any other typed name is kept exactly as typed. */
export function typedNameMayBeATag(typed: string | null | undefined): boolean {
  const t = tidy(typed);
  return !t || stripSourceTag(t) !== t || BARE_CALL.test(t);
}

/** The words with any leading source tag off, and whether a tag came off. The phone-call booking's
 *  "Call Rita Moss" / "Call Visit" (no separator) is a tag only with who, where or nothing after it. */
function untag(raw: string, isOnlyWhoOrWhere: (w: string) => boolean): { words: string; tagged: boolean } {
  const words = stripSourceTag(raw);
  if (words !== raw) return { words, tagged: true };
  if (BARE_CALL.test(raw)) {
    const rest = stripSourceTag(raw.replace(BARE_CALL, ""));
    if (!rest || isOnlyWhoOrWhere(rest)) return { words: rest, tagged: true };
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
