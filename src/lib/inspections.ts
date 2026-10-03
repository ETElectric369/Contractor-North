/**
 * Bucket logic for the Sales → Walk-Throughs tab (/inspections) — pure and unit-tested, because the tab's
 * whole promise is TRUTHFUL buckets (Erik's design 2026-07-14: open work first, settled
 * paperwork files away like estimates do).
 *
 *   • "To write up" — the money bucket: the visit happened (status completed, or its time
 *     is past AND field capture exists — capture is what makes an unmarked visit "done")
 *     but no estimate exists yet on its inquiry or job. Each row's next step is one
 *     button: Create estimate.
 *   • "Upcoming & proposed" — scheduled/proposed visits, including a past-dated one with
 *     NO capture (it may not have happened; hiding it would lie).
 *   • Filed — completed-and-written-up + cancelled, behind the ?view=completed toggle.
 *
 * The tags a row wears live here too (inspectionRowTags), for the same reason: one rule, one place.
 */
import { appointmentTypeLabel } from "@/lib/statuses";

export interface InspectionBucketRow {
  id: string;
  status: string; // APPOINTMENT_STATUSES value
  starts_at: string | null;
  inquiry_id: string | null;
  job_id: string | null;
  capture?: unknown;
  /** How it ended, when somebody said so: won / lost / no_bid (0205). */
  outcome?: string | null;
}

/** The estimate this inspection was written up into, stamped on the capture jsonb by
 *  saveQuote when the builder was opened via /quotes/new?capture=<appt>. This is the
 *  write-up signal for the LEAD-LESS "Inspect now" path (no inquiry_id/job_id to match),
 *  which used to leave the row in "To write up" forever. */
export function captureQuoteId(capture: unknown): string | null {
  if (!capture || typeof capture !== "object") return null;
  const q = (capture as { quote_id?: unknown }).quote_id;
  return typeof q === "string" && q.length > 0 ? q : null;
}

/** True when the capture jsonb carries any real field data (text or photos). */
export function hasCaptureData(capture: unknown): boolean {
  if (!capture || typeof capture !== "object") return false;
  const c = capture as { notes?: unknown; measurements?: unknown; materials?: unknown; photos?: unknown };
  const filled = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  return (
    filled(c.notes) ||
    filled(c.measurements) ||
    filled(c.materials) ||
    (Array.isArray(c.photos) && c.photos.length > 0)
  );
}

/** One tag on a Walk-Throughs row: what it says, and the Badge tone it says it in. The tone names
 *  are components/ui/badge's `Tone`, spelled out here so this module stays pure (no component
 *  import); the page's `<Badge tone={t.tone}>` is what checks the two against each other. */
export interface InspectionRowTag {
  tone: "indigo" | "amber" | "slate";
  label: string;
}

/**
 * EVERY TAG A WALK-THROUGHS ROW WEARS, in ONE place. /inspections draws one row component for the
 * open piles AND the filed pile, so a tag written inline on that row rides into the pile it was
 * never meant for.
 *
 * THERE IS NO "done" TAG, and that is the rule. Report 8592392b (2026-10-02): "glaring on the front
 * is [a customer] tagged Done while it sits in the open box." The green pill was drawn from
 * `status === "completed"` alone, so every row of "To write up" — the OPEN pile, each row carrying a
 * Create Estimate button — advertised itself as finished work. BADGES AND TAGS SHOW ONLY WHAT IS
 * OPEN. Nothing is lost by dropping it: every heading on this page already says the bucket ("To
 * write up", "Completed & written up", "Cancelled").
 */
export function inspectionRowTags(
  row: { type?: string | null; status: string; capture?: unknown },
  /** The row is in "To write up", the one pile where a visit with no field notes is worth saying. */
  writeUp = false,
): InspectionRowTag[] {
  const tags: InspectionRowTag[] = [];
  // The city's inspection on a permit is a different animal from the walk-through, and this list
  // holds both (ESTIMATE_VISIT_TYPES), so the row says which one it is.
  if (row.type === "final_inspection") tags.push({ tone: "indigo", label: appointmentTypeLabel(row.type) });
  if (row.status === "proposed") tags.push({ tone: "amber", label: "pending pick" });
  if (row.status === "cancelled") tags.push({ tone: "slate", label: "cancelled" });
  if (writeUp && !hasCaptureData(row.capture)) tags.push({ tone: "slate", label: "no field notes" });
  return tags;
}

export interface InspectionBuckets<T> {
  /** Visit happened, no estimate yet — oldest first (longest-waiting write-up on top). */
  toWriteUp: T[];
  /** Scheduled/proposed — soonest first. */
  upcoming: T[];
  /** Completed-and-written-up + cancelled — newest first (the ?view=completed pile). */
  filed: T[];
}

export function bucketInspections<T extends InspectionBucketRow>(
  rows: T[],
  estimateInquiryIds: ReadonlySet<string>,
  estimateJobIds: ReadonlySet<string>,
  now: Date = new Date(),
  /** Ids of quotes that still EXIST — matched against capture.quote_id so the lead-less
   *  "Inspect now" write-up files away too (and truthfully un-files if the quote is deleted). */
  estimateQuoteIds: ReadonlySet<string> = new Set(),
  /** Job ids that have real billing on them — a visit that became BILLED WORK is finished,
   *  estimate or no estimate (0205). Empty set keeps the old behaviour for callers that
   *  don't care (e.g. a pure calendar view). */
  billedJobIds: ReadonlySet<string> = new Set(),
): InspectionBuckets<T> {
  const out: InspectionBuckets<T> = { toWriteUp: [], upcoming: [], filed: [] };
  const time = (r: T) => (r.starts_at ? new Date(r.starts_at).getTime() : 0);

  for (const r of rows) {
    const capQuote = captureQuoteId(r.capture);
    /**
     * FOUR WAYS A VISIT ENDS, not one (0205).
     *
     * This asked only "does an estimate exist?", so a walk-through that turned into billed,
     * paid work still nagged (Mallow Springs: job complete, invoice paid, no estimate ever
     * written) and a lost bid could never leave at all (Donner Pass, which has no customer,
     * inquiry, job or estimate to hang anything on). Money is an outcome; so is a decision.
     */
    const settled =
      (!!r.inquiry_id && estimateInquiryIds.has(r.inquiry_id)) ||
      (!!r.job_id && estimateJobIds.has(r.job_id)) ||
      (!!capQuote && estimateQuoteIds.has(capQuote)) ||
      (!!r.job_id && billedJobIds.has(r.job_id)) ||
      /* A LINKED JOB IS ITSELF SETTLEMENT. The write-up nag asks "did the visit become an
         estimate?" — but a visit whose work went straight to a JOB was answered better than any
         estimate could: the work is sold (Erik's Karen: job on the calendar, and this bucket
         still demanding "Create estimate"). Billing-only was too narrow — it kept nagging
         through the whole gap between winning the work and invoicing it. */
      !!r.job_id ||
      !!r.outcome;
    const writtenUp = settled;
    const past = !!r.starts_at && new Date(r.starts_at).getTime() < now.getTime();

    if (r.status === "cancelled") out.filed.push(r);
    else if (r.status === "completed") (writtenUp ? out.filed : out.toWriteUp).push(r);
    // "Done by capture": a past visit with field data counts as happened even if nobody
    // tapped complete — unless its estimate already exists, in which case it's settled.
    // A written-up estimate is itself the strongest "the visit happened" signal, so a
    // past visit whose estimate exists files even when the capture text was left blank.
    else if (past && (hasCaptureData(r.capture) || writtenUp))
      (writtenUp ? out.filed : out.toWriteUp).push(r);
    else out.upcoming.push(r);
  }

  out.toWriteUp.sort((a, b) => time(a) - time(b));
  out.upcoming.sort((a, b) => time(a) - time(b));
  out.filed.sort((a, b) => time(b) - time(a));
  return out;
}
