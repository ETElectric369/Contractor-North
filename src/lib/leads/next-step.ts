/**
 * ONE NEXT-STEP CHIP PER LEAD (W2-07).
 *
 * A lead's first line carried up to nine badges: its status word, "inspected ×2", "inspection
 * booked", the A/B/C bucket, 🚩 Site visit, web, deck site, "referred by X" and "follow up · date".
 * Nine facts, and not one of them said what to do next. Now one chip does, read off the same facts,
 * the first rule that matches winning:
 *
 *   1. it became something (converted_at): Became An Estimate / Became A Job     slate  (a ?focus= row)
 *   2. it said no (status lost): Lost                                           slate
 *   3. a follow-up day has passed: Call Back · Sep 20                            amber
 *   4. a visit is booked: Walk-Through · Tue Oct 1 (its earliest, on the
 *      company's clock); one waiting for a day: Walk-Through · No Day Yet        blue
 *   5. a visit was done: Walked · Estimate Next (Walked, with Estimates off)      green
 *   6. a follow-up day is coming: Call Back · Oct 3                              slate
 *   7. contacted: Contacted                                                      slate
 *   8. quoted by hand: Quoted                                                    indigo
 *   9. otherwise: New · Call Them                                                blue
 *
 * Only when a lead carries a bucket (a configurator's lead, any company's) does its letter lead the
 * chip ("A · New · Call Them", with the bucket's colored dot); "· Needs A Visit" follows when a site
 * visit is required and nothing is booked; a website lead gets the one Globe (lib/inquiries/sources).
 *
 * It takes its OWN small input (LeadStepInput), never lib/types' Inquiry, whose source union knows
 * four values. Dates compare as YYYY-MM-DD strings: no parsing mode to get wrong (the bug that once
 * flagged every lead due today as overdue). Pure: no database, no React.
 */
import { isWebSource } from "@/lib/inquiries/sources";
import { todayStrInTz } from "@/lib/tz";
import { workKind } from "@/lib/schedule/work-shape";

export type LeadStepInput = {
  status: string | null;
  converted_at: string | null;
  converted_to: string | null;
  next_follow_up_at: string | null;
  lead_bucket: string | null;
  site_inspection_required: boolean | null;
  source: string | null;
  referred_by: string | null;
};

/** What the leads page read about a lead's visits (cancelled ones left out): how many are done, how
 *  many are still booked, the earliest booked start (null when every booked one waits for a day),
 *  and that visit's type. */
export type LeadVisits = { done: number; upcoming: number; nextAt: string | null; nextType?: string | null };

/**
 * NOBODY COULD READ THIS LEAD'S VISITS (lib/leads/visit-read). The third answer, and the whole point
 * of having one: a failed read used to arrive here as `null` — the same value as "this lead has no
 * visits" — so the chip printed "New · Call Them" on a lead with a walk-through booked for Tuesday.
 */
export const VISITS_UNREAD = "unread" as const;

/** What the board can say about a lead's visits: what it read, NONE, or that it could not tell. */
export type LeadVisitsAnswer = LeadVisits | typeof VISITS_UNREAD | null;

/** The chip's words when the visits are not known. It says the one true thing instead of the next
 *  step, because every next step left depends on what is booked (Erik: nothing silent). */
export const VISITS_UNREAD_LABEL = "Visits Didn't Load";

export type LeadStepTone = "slate" | "amber" | "blue" | "green" | "indigo";
export type LeadBucketLetter = "A" | "B" | "C";

export type LeadStep = {
  /** The chip's words, bucket letter first when there is one. */
  label: string;
  tone: LeadStepTone;
  /** The bucket whose colored dot leads the chip, or null. */
  bucket: LeadBucketLetter | null;
  /** From one of the website's doors: the row draws the Globe. */
  web: boolean;
};

const ymdOf = (v: string | null | undefined): string | null => {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const words = (ymd: string, weekday: boolean): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    ...(weekday ? { weekday: "short" as const } : {}),
    month: "short",
    day: "numeric",
  })
    .format(new Date(Date.UTC(y, m - 1, d, 12)))
    .replace(",", "");
};

/** "Sep 20": a follow-up day. */
export const monthDay = (ymd: string): string => words(ymd, false);
/** "Tue Oct 1": a visit's day. */
export const weekdayMonthDay = (ymd: string): string => words(ymd, true);

/** What a booked visit is called on the chip: the site visit is a Walk-Through; the rest say their
 *  own kind, never a walk-through they aren't. */
function visitWord(type: string | null | undefined): string {
  switch (workKind({ kind: "appointment", type: type || "inspection" })) {
    case "service":
      return "Service Call";
    case "job":
      return "Job";
    case "call":
      return "Phone Call";
    case "office":
      return "Meeting";
    case "other":
      return "Visit";
    default:
      return "Walk-Through";
  }
}

const BUCKETS: readonly string[] = ["A", "B", "C"];

export function leadNextStep(
  input: LeadStepInput,
  visits: LeadVisitsAnswer,
  todayYmd: string,
  opts: { estimatesOn: boolean; tz: string },
): LeadStep {
  const web = isWebSource(input.source);

  // 1-2: settled. Nothing to prefix, nothing still needed.
  if (input.converted_at) {
    const estimate = input.converted_to === "quote" || input.converted_to === "estimate";
    return { label: estimate ? "Became An Estimate" : "Became A Job", tone: "slate", bucket: null, web };
  }
  if (input.status === "lost") return { label: "Lost", tone: "slate", bucket: null, web };

  const follow = ymdOf(input.next_follow_up_at);
  // NOT READ IS NOT ZERO. The read's three-state answer stops here: a lead whose visits nobody could
  // read has no upcoming count and no done count, and must never be treated as having none of either.
  const read = visits === VISITS_UNREAD ? null : visits;
  const unread = visits === VISITS_UNREAD;
  const upcoming = read?.upcoming ?? 0;
  const done = read?.done ?? 0;

  let step: { label: string; tone: LeadStepTone };
  if (follow && follow < todayYmd) {
    step = { label: `Call Back · ${monthDay(follow)}`, tone: "amber" };
  } else if (unread) {
    // Every rule left — a visit booked, a visit walked, and the three that only hold while NOTHING is
    // booked — is an answer about visits. So the chip says the one thing that is true: it doesn't know.
    step = { label: VISITS_UNREAD_LABEL, tone: "amber" };
  } else if (upcoming > 0) {
    const day = read?.nextAt ? todayStrInTz(opts.tz, new Date(read.nextAt)) : null;
    step = { label: `${visitWord(read?.nextType)} · ${day ? weekdayMonthDay(day) : "No Day Yet"}`, tone: "blue" };
  } else if (done > 0) {
    step = { label: opts.estimatesOn ? "Walked · Estimate Next" : "Walked", tone: "green" };
  } else if (follow) {
    step = { label: `Call Back · ${monthDay(follow)}`, tone: "slate" };
  } else if (input.status === "contacted") {
    step = { label: "Contacted", tone: "slate" };
  } else if (input.status === "quoted") {
    step = { label: "Quoted", tone: "indigo" };
  } else {
    step = { label: "New · Call Them", tone: "blue" };
  }

  const bucket = BUCKETS.includes(String(input.lead_bucket ?? "")) ? (input.lead_bucket as LeadBucketLetter) : null;
  // "Needs A Visit" is the same claim the other way round: it says nothing is booked, which is exactly
  // what nobody could read. An unread board says neither.
  const needsVisit = !unread && !!input.site_inspection_required && upcoming === 0 && done === 0;
  const label = [bucket, step.label, needsVisit ? "Needs A Visit" : null].filter(Boolean).join(" · ");
  return { label, tone: step.tone, bucket, web };
}
