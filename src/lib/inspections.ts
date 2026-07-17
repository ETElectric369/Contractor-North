/**
 * Bucket logic for the Sales → Inspections tab — pure and unit-tested, because the tab's
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
 */

export interface InspectionBucketRow {
  id: string;
  status: string; // APPOINTMENT_STATUSES value
  starts_at: string | null;
  inquiry_id: string | null;
  job_id: string | null;
  capture?: unknown;
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
): InspectionBuckets<T> {
  const out: InspectionBuckets<T> = { toWriteUp: [], upcoming: [], filed: [] };
  const time = (r: T) => (r.starts_at ? new Date(r.starts_at).getTime() : 0);

  for (const r of rows) {
    const capQuote = captureQuoteId(r.capture);
    const writtenUp =
      (!!r.inquiry_id && estimateInquiryIds.has(r.inquiry_id)) ||
      (!!r.job_id && estimateJobIds.has(r.job_id)) ||
      (!!capQuote && estimateQuoteIds.has(capQuote));
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
