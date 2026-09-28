/**
 * A JOB'S NAME IS NEVER WHERE IT CAME FROM.
 *
 * Erik (2026-09-27): "site inspections are labeled with the tag they shouldnt carry site inspection
 * in the job title same goes for any conversion." A visit turned into a job copied the visit's title,
 * so a job was born "Site inspection: Rita Moss", and bookings left "Service call — <the customer>" behind.
 * He reads jobs by who/where and what ("i cant tell by job numbers alone"); a source tag is neither.
 *
 * ONE namer for every door that CONVERTS something into a job (a visit, a lead, an accepted estimate,
 * New Job, Nort, an import). The SQL twin is public.job_name_from (0369), used by the public
 * estimate accept; the two are pinned against each other by the same cases in job-name.test.ts.
 * (A recurring template is not a conversion: its title is the work a person typed, and every job it
 * makes keeps it as typed, lib/recurring-engine.)
 *
 *   - the work's own words win when there are any, with a leading source tag taken off the front;
 *   - a tag with nothing after it, or with only the customer's name or the street after it (the
 *     stock "Site inspection: Rita Moss"), is no name at all, so the job gets the one default:
 *     lib/schedule-options defaultJobName ("Moss · 1871 Apache Ct", else "New Job · Sep 27");
 *   - a real name that merely contains the word stays as typed ("RV Inspection", "Lead Paint
 *     Abatement"): only a LEADING tag followed by a separator, or the bare tag, is a tag;
 *   - the phone-call booking's stock title has no separator (bookingTitle's "Call Rita Moss", "Call
 *     Visit"): a leading "Call" is a tag there only when the booked person, the street or nothing
 *     follows it, so "Call box install" stays as typed.
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
// separator after the word, so it is a tag only when who, where or nothing follows (jobNameFrom).
const BARE_CALL = /^(?:phone\s+)?call\s+/i;
// The old stock fallbacks: "Job from appointment", "Job from Q-0012" (a quote number), "Job from lead".
const STOCK_FALLBACK = /^job\s+from\s+(?:appointment|lead|inquiry|estimate|quote|visit|[a-z]{1,3}-?\d[\w-]*)\s*$/i;

/** The title with any leading source tag taken off ("Site inspection: Rita Moss" → "Rita Moss";
 *  "Inspection" → ""). A title with no leading tag comes back as typed, trimmed. */
export function stripSourceTag(title: string | null | undefined): string {
  let s = String(title ?? "").trim().replace(/\s+/g, " ");
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

/**
 * THE NAME A NEW JOB GETS, from every door. `title` is whatever words the source carried (a visit's
 * title, an estimate's title, a typed name); `customer` and `street` are who and where, for the
 * default. With no words left after the tag comes off, or only the customer's own name or the street
 * (the stock title), the default: "Moss · 1871 Apache Ct", else "New Job · Sep 27".
 *
 * `aliases` are other spellings of who the stock title may carry: a visit's title is built from the
 * LEAD's typed name ("Site inspection: Rich Test") while the job is named for the card it links to
 * ("Richard Test"), so the lead's own name counts as only-who too (jobWho gives them).
 */
export function jobNameFrom(p: {
  title?: string | null;
  customer?: Customer;
  street?: string | null;
  todayStr: string;
  aliases?: (string | null | undefined)[];
}): string {
  const raw = String(p.title ?? "").trim().replace(/\s+/g, " ");
  const whoKeys = [p.customer?.name, p.customer?.company_name, p.street, ...(p.aliases ?? [])].map(key).filter(Boolean);
  const isOnlyWhoOrWhere = (w: string) =>
    whoKeys.includes(key(w)) || (key(p.street) !== "" && key(p.street) === key(streetOf(w)));
  let words = stripSourceTag(raw);
  let tagged = words !== raw;
  // "Call Rita Moss" / "Call Visit", the call booking's stock title: a tag only with who, where or nothing after it.
  if (!tagged && BARE_CALL.test(raw)) {
    const rest = stripSourceTag(raw.replace(BARE_CALL, ""));
    if (!rest || isOnlyWhoOrWhere(rest)) {
      words = rest;
      tagged = true;
    }
  }
  const onlyWhoOrWhere = tagged && !!words && isOnlyWhoOrWhere(words);
  if (words && !onlyWhoOrWhere) return words;
  return defaultJobName({ customer: p.customer ?? null, street: p.street ?? null, todayStr: p.todayStr });
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
