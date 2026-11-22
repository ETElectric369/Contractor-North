import { visitStands } from "@/lib/leads/new-intake";

/**
 * ONE WAY TO SAY A VISIT ON A PERSON'S FILE (cn-v1171): the lead's file and the customer's page draw
 * the same list (components/file/visit-list) through this one rule.
 *
 * Erik, 2026-11-19: "won converts everything into the customer file keeping the inspection,
 * estimates, work, invoices and everything". The Inspections page lost its Filed side in the same
 * release, so a person's file is now the one place a finished or cancelled inspection is found, which
 * is why Cancelled is a state here.
 *
 * Pure. It returns catalog key ids and never imports a catalog (a lib never does).
 */

/** The columns a file reads for a visit. No money column. */
export type FileVisitRow = {
  id: string;
  type: string | null;
  status: string | null;
  outcome: string | null;
  starts_at: string | null;
  title: string | null;
  /** Its job (cn-v1175): the one visit rule reads it (a win with no job picked is still open). */
  job_id?: string | null;
};

/**
 * A visit's state on a file. The outcome first (won, then Not Sold), then cancelled, then completed,
 * then booked: a visit that ended Not Sold and was later tidied away is still Not Sold, which is the
 * answer a salesperson reads. null: a state the rule was never taught, which reads as its stored word.
 */
export function visitStateKey(v: Pick<FileVisitRow, "status" | "outcome">): string | null {
  if (v.outcome === "won") return "ld_btn_fileVisitWon";
  if (v.outcome === "lost" || v.outcome === "no_bid") return "ld_btn_fileVisitNotSold";
  if (v.status === "cancelled") return "ld_btn_fileVisitCancelled";
  if (v.status === "completed") return "ld_btn_fileVisitDone";
  if (v.status === "scheduled" || v.status === "proposed") return "ld_btn_fileVisitBooked";
  return null;
}

/** OPEN, for a file's Inspections count: on the books and not done yet (still ahead). A completed
 *  visit may still be waiting on its write-up, but nobody has to go out for it. A badge counts only
 *  what is open (tests/badges-show-open). */
export function isOpenFileVisit(v: Pick<FileVisitRow, "status" | "outcome" | "starts_at">, nowMs: number): boolean {
  return v.status !== "completed" && visitStands(v, nowMs);
}

/**
 * THE ORDER on a file: the ones waiting for a day on top (nothing else in the list says they need
 * one), then newest first, so a long history does not push this week's visit out of sight.
 */
export function fileVisitOrder<T extends Pick<FileVisitRow, "id" | "status" | "starts_at">>(visits: readonly T[]): T[] {
  const waiting = (v: T) => v.status !== "proposed" && !v.starts_at && v.status !== "cancelled";
  const at = (v: T) => (v.starts_at ? Date.parse(v.starts_at) : NaN);
  return [...visits].sort((a, b) => {
    const wa = waiting(a) ? 0 : 1;
    const wb = waiting(b) ? 0 : 1;
    if (wa !== wb) return wa - wb;
    const ta = at(a);
    const tb = at(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.isNaN(ta) ? (Number.isNaN(tb) ? 0 : 1) : -1;
    return tb - ta;
  });
}

/** One list from two reads (a customer's own visits, and the ones made from their leads, which often
 *  carry no customer): each visit once, the first read's row kept. */
export function mergeVisits<T extends { id: string }>(...lists: readonly (readonly T[])[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const v of list) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(v);
    }
  }
  return out;
}
