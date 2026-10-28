/**
 * THE ORDER OF THE LEADS BOARD — one rule, read by the page's query and by anything that sorts
 * leads in memory (cn-v1137; Bug Watch: "a hand-added lead lands in the MIDDLE of the list").
 *
 * WHAT WENT WRONG. The board sorted priority DESC first. The website's triage (lib/lead-triage)
 * scores every web lead above zero (size + readiness + reachability), and a lead typed by hand
 * never gets a score (0097's default 0, and createInquiry sets none) — so the lead he had just
 * added sorted UNDER every web lead the triage had scored, and he concluded the save had failed.
 * The same confusion as the follow-up-date order before it ("the new lead i just added isnt
 * showing up"): a lead he just made belongs at the top, whatever a score says.
 *
 * THE RULE: newest first. The triage score no longer orders the board silently — it is SHOWN on the
 * row as a chip ("Priority 42", inquiry-row.tsx) so the office can see which web leads are hot
 * without any of them ever hiding a lead someone typed a minute ago. The follow-up order stays as a
 * secondary key (undated before dated, soonest first) and the score as the last tie-break; on a
 * timestamp column ties are rare, so in practice the board reads top to bottom by when each lead
 * arrived.
 */
export type LeadBoardOrder = {
  column: "created_at" | "next_follow_up_at" | "priority";
  ascending: boolean;
  nullsFirst?: boolean;
};

export const LEAD_BOARD_ORDER: readonly LeadBoardOrder[] = [
  { column: "created_at", ascending: false },
  // A lead with NO follow-up date is an untouched lead and sorts before the dated ones (soonest
  // first); the Follow-Ups Due tile carries the due story.
  { column: "next_follow_up_at", ascending: true, nullsFirst: true },
  { column: "priority", ascending: false },
];

/** Chain the board's order onto a PostgREST query, in the rule's order. */
export function orderLeadBoard<Q extends { order: (column: string, opts: { ascending: boolean; nullsFirst?: boolean }) => Q }>(q: Q): Q {
  let out = q;
  for (const o of LEAD_BOARD_ORDER) out = out.order(o.column, { ascending: o.ascending, nullsFirst: o.nullsFirst });
  return out;
}

export type LeadBoardRow = {
  created_at: string | null;
  next_follow_up_at: string | null;
  priority?: number | null;
};

const ms = (iso: string | null): number => {
  const n = Date.parse(String(iso ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/** The same order as `LEAD_BOARD_ORDER`, in memory — what the database does, so a test can prove it. */
export function compareLeadsForBoard(a: LeadBoardRow, b: LeadBoardRow): number {
  const created = ms(b.created_at) - ms(a.created_at); // newest first
  if (created !== 0) return created;
  const fa = a.next_follow_up_at ? String(a.next_follow_up_at).slice(0, 10) : null;
  const fb = b.next_follow_up_at ? String(b.next_follow_up_at).slice(0, 10) : null;
  if (fa !== fb) {
    if (fa === null) return -1; // no date sorts first
    if (fb === null) return 1;
    return fa < fb ? -1 : 1; // soonest first
  }
  return (Number(b.priority) || 0) - (Number(a.priority) || 0); // hotter first
}

export function sortLeadsForBoard<T extends LeadBoardRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareLeadsForBoard);
}
