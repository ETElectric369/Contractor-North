import { VISITS_UNREAD, type LeadVisits, type LeadVisitsAnswer } from "./next-step";

/**
 * WHAT THE LEADS BOARD KNOWS ABOUT EACH LEAD'S VISITS — AND WHEN IT KNOWS NOTHING.
 *
 * The board asked for every open lead's appointments in ONE request and threw the error away
 * (`const { data: visitRows } = await …`). A read that FAILED then looked exactly like a book with no
 * visits in it, and the one next-step chip fell through to its last rule: "New · Call Them" on a lead
 * with an inspection booked for Tuesday. Both ways it fails are ordinary — past roughly two hundred
 * open leads the uuid list makes the request too long for the gateway, and a busy book overflows the
 * five hundred rows it asked for.
 *
 * So the read is bounded where the request actually is: by HOW MANY IDS go in one of them. The lead
 * list itself keeps no cap (build for millions, and the same call the clock's job list makes) —
 * capping it would drop open leads off the board and make the Open Leads badge lie, which is trading
 * one silent wrong for another.
 *
 * THREE ANSWERS, NOT TWO (nothing silent): what was read, nothing for this lead, or NOT READ. A
 * batch that came back at its row cap counts as not read too, because a short answer and a whole one
 * are the same bytes. `forLead` is the only way out of here, so a caller cannot turn "I don't know"
 * back into "nothing" with a `?? null`.
 */

/** One appointment row, as the board selects it. */
export type VisitRow = { inquiry_id: string | null; status: string | null; starts_at: string | null; type: string | null };

/** The read the page performs: a batch of lead ids and the rows one request may carry. PromiseLike,
 *  because a Supabase query builder is awaited without being a Promise. */
export type VisitQuery = (ids: string[], cap: number) => PromiseLike<{ data: VisitRow[] | null; error: unknown }>;

/**
 * HOW MANY LEAD IDS GO IN ONE REQUEST. A uuid is 36 characters, and `in.(…)` puts them in the URL:
 * fifty is under two kilobytes, which no gateway in front of this app has trouble with, where the
 * whole open board at two hundred-plus leads did.
 */
export const VISIT_IDS_PER_REQUEST = 50;

/** The rows one request may bring back. Fifty leads could not honestly use more than this many
 *  visits between them, and a batch that hits the number is reported as NOT READ rather than
 *  truncated into a wrong chip. */
export const VISIT_ROW_CAP = 500;

/** How many of those requests are in flight at once. */
export const VISIT_REQUESTS_AT_ONCE = 4;

export type LeadVisitsRead = {
  /** This lead's visits, null when it has none, or VISITS_UNREAD when nobody could tell. */
  forLead: (id: string) => LeadVisitsAnswer;
  /** How many leads' visits could not be read — zero on a healthy board. */
  unreadCount: number;
};

/** Fold one row into the lead's tally (the board's own rule: the EARLIEST booked start wins, and a
 *  visit still waiting for a day never displaces one that has one). */
function tally(byLead: Map<string, LeadVisits>, r: VisitRow): void {
  const id = r.inquiry_id;
  if (!id) return;
  const cur = byLead.get(id) ?? { done: 0, upcoming: 0, nextAt: null, nextType: null };
  if (r.status === "completed") cur.done += 1;
  else {
    cur.upcoming += 1;
    if (r.starts_at && (!cur.nextAt || r.starts_at < cur.nextAt)) {
      cur.nextAt = r.starts_at;
      cur.nextType = r.type;
    } else if (!cur.nextAt && !cur.nextType) cur.nextType = r.type;
  }
  byLead.set(id, cur);
}

/**
 * Every lead's visits, read in batches. A batch that errors — or comes back at its cap — marks THAT
 * batch's leads unknown and the rest are still answered: one bad request never blanks the board.
 */
export async function readLeadVisits(ids: string[], query: VisitQuery): Promise<LeadVisitsRead> {
  const byLead = new Map<string, LeadVisits>();
  const unread = new Set<string>();
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += VISIT_IDS_PER_REQUEST) batches.push(ids.slice(i, i + VISIT_IDS_PER_REQUEST));
  // A few at a time, not one at a time and not all at once: the board used to make ONE request, so
  // four hundred leads must not become eight round trips the page waits through one after another —
  // nor ten thousand requests fired at the database at once.
  for (let w = 0; w < batches.length; w += VISIT_REQUESTS_AT_ONCE) {
    const wave = batches.slice(w, w + VISIT_REQUESTS_AT_ONCE);
    const answers = await Promise.all(wave.map((batch) => query(batch, VISIT_ROW_CAP)));
    wave.forEach((batch, n) => {
      const { data, error } = answers[n];
      const rows = data ?? [];
      if (error || !data || rows.length >= VISIT_ROW_CAP) {
        for (const id of batch) unread.add(id);
        return;
      }
      for (const r of rows) tally(byLead, r);
    });
  }
  return {
    forLead: (id: string) => (unread.has(id) ? VISITS_UNREAD : (byLead.get(id) ?? null)),
    unreadCount: unread.size,
  };
}
