/**
 * WHAT A CONVERTED LEAD BECAME, AS DOORS (cn-v1157).
 *
 * Erik, 2026-11-10, on a lead whose inspection he had just written up: "i had no way to get back to
 * his estimate even though it says right on the screen Became An Estimate". The estimate pointed at its
 * lead ("From Lead", the card's link) and the lead pointed at nothing: its chip named what it became
 * and the line under it said the estimate or job "carries the work now", with no way to open either.
 * Related things stay attached BOTH ways — so the row reads what was made from the lead
 * (quotes.inquiry_id, jobs.inquiry_id: 0109) and offers each as a door.
 *
 * THREE ANSWERS, like the visits read beside it (lib/leads/visit-read): the doors, NONE (null: nothing
 * this reader may see was made from it), or UNREAD — a failed read is never "nothing", so the row says
 * it could not load them instead of going quiet.
 *
 * Pure: the page hands in its two reads. No catalog, no database client of its own.
 */

export type LeadBecameDoor = {
  kind: "estimate" | "job";
  id: string;
  /** E-036 / J-061: the record's own number, or null on a record that has none yet. */
  number: string | null;
  /** The estimate's title or the job's name: what tells two doors apart. */
  title: string | null;
};

export const BECAME_UNREAD = "unread" as const;

/** The doors, none, or that nobody could read them. */
export type LeadBecameAnswer = LeadBecameDoor[] | typeof BECAME_UNREAD | null;

/** How many of each a row offers. A lead with more than this many estimates is a revision chain, and
 *  the newest ones are the ones a person is looking for. */
export const BECAME_CAP = 4;

type Read<T> = { data: T[] | null; error: unknown };
export type BecameQuoteRow = { id: string; quote_number: string | null; title: string | null };
export type BecameJobRow = { id: string; job_number: string | null; name: string | null };

const clean = (v: string | null | undefined): string | null => String(v ?? "").trim() || null;

/**
 * The two reads, as one answer. The job comes first — it is where the work lives once there is one —
 * then the estimates in the order they were read (the page asks newest first).
 */
export function leadBecame(quotes: Read<BecameQuoteRow>, jobs: Read<BecameJobRow>): LeadBecameAnswer {
  if (quotes.error || jobs.error || !quotes.data || !jobs.data) return BECAME_UNREAD;
  const doors: LeadBecameDoor[] = [
    ...jobs.data.map((j) => ({ kind: "job" as const, id: j.id, number: clean(j.job_number), title: clean(j.name) })),
    ...quotes.data.map((q) => ({ kind: "estimate" as const, id: q.id, number: clean(q.quote_number), title: clean(q.title) })),
  ];
  return doors.length ? doors : null;
}

/** Where a door goes. */
export const becameHref = (door: Pick<LeadBecameDoor, "kind" | "id">): string =>
  door.kind === "estimate" ? `/quotes/${door.id}` : `/jobs/${door.id}`;
