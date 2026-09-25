/**
 * THE SHIFT, NOT THE PIECE (audit v994 SW1, Erik 2026-09-24).
 *
 * Since 0288 a Switch Job CUTS the running shift: the entry is closed at the switch and a new one
 * opens at the same instant, pointing at the shift's first entry through `split_from` with
 * split_how 'live'. So the running entry is only the part since the last switch, and every rule that
 * is about the SHIFT (the office's bell at 10 hours, the question and the buzz at 12, the forgotten
 * shift sheet, "you've been on the clock since…", Nort's clocks_running, the geofence's re-arm window
 * after a switch) measured from the switch instead of from the start of the day. Brian clocks in at
 * 7:00 AM, switches at 3:00 PM and forgets: the bell came at 1:00 AM and said "10 hours ago".
 *
 * Erik's call: after a Switch Job the 12 hours count from the START OF THE DAY (the first piece).
 *
 * THE SHIFT is the running piece plus the pieces before it that
 *   - belong to the same split family (coalesce(split_from, id) is the same first entry),
 *   - belong to the same person, and
 *   - touch: each ended within a second of when the next began.
 * A gap (the office edited a piece's times, or deleted one) ends the walk: what is before it is not
 * the same stretch of work. A running entry with no split_from is its own shift.
 *
 * Kept per PIECE on purpose: the 18-hour ceiling and the stop picker's window (stopWindow), because
 * the database enforces those per entry and a stop time closes only the running piece.
 *
 * The pure part takes rows the caller already has. loadShiftChains does the one extra read for the
 * server doors (the hourly job runs on the service client, so it is org-scoped by hand).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** A second of slack: the pieces of a switch share one instant, stored to the microsecond. */
const TOUCH_MS = 1000;

export type ChainPiece = {
  id: string;
  profile_id?: string | null;
  clock_in: string;
  clock_out?: string | null;
  status?: string | null;
  split_from?: string | null;
  lunch_minutes?: number | null;
  paid_at?: string | null;
  long_shift_warned_at?: string | null;
  long_shift_nudged_at?: string | null;
};

/** The family a row belongs to: the shift's first entry. */
export function familyOf(r: { id: string; split_from?: string | null }): string {
  return String(r.split_from || r.id);
}

/**
 * The pieces of `open`'s shift, earliest first, ending with `open` itself.
 *
 * `rows` may hold anything (a week, a family, other people's rows): only pieces of the same family
 * and the same person that touch are taken. A running entry with no family is a shift of one.
 */
export function shiftChain<T extends ChainPiece>(open: T, rows: readonly T[]): T[] {
  const chain: T[] = [open];
  if (!open?.split_from) return chain;
  const fam = familyOf(open);
  const kin = (rows ?? []).filter(
    (r) =>
      r &&
      r.id !== open.id &&
      familyOf(r) === fam &&
      (r.profile_id ?? null) === (open.profile_id ?? null) &&
      !!r.clock_out,
  );
  const seen = new Set<string>([open.id]);
  let cursor = Date.parse(open.clock_in);
  // A day has a handful of switches; the bound only stops a malformed loop.
  for (let hop = 0; hop < 50 && Number.isFinite(cursor); hop++) {
    const prev = kin.find((r) => !seen.has(r.id) && Math.abs(Date.parse(String(r.clock_out)) - cursor) < TOUCH_MS);
    if (!prev) break;
    seen.add(prev.id);
    chain.unshift(prev);
    cursor = Date.parse(prev.clock_in);
  }
  return chain;
}

export type ShiftInfo<T extends ChainPiece = ChainPiece> = {
  /** When the shift began: the first piece's clock_in. The running piece's own when it has none. */
  startIso: string;
  startMs: number;
  /** Every piece, earliest first, ending with the running one. */
  pieces: T[];
  /** The pieces before the running one (empty for a shift that never switched). */
  earlier: T[];
  /** The office's 10-hour bell line already went out on some piece of this shift. */
  warned: boolean;
  /** The 12-hour question and buzz already went out on some piece of this shift. */
  nudged: boolean;
};

/** What the shift-level rules need to know about `open`'s shift. */
export function shiftInfo<T extends ChainPiece>(open: T, rows: readonly T[]): ShiftInfo<T> {
  const pieces = shiftChain(open, rows);
  const first = pieces[0] ?? open;
  return {
    startIso: String(first.clock_in),
    startMs: Date.parse(String(first.clock_in)),
    pieces,
    earlier: pieces.slice(0, -1),
    warned: pieces.some((p) => !!p.long_shift_warned_at),
    nudged: pieces.some((p) => !!p.long_shift_nudged_at),
  };
}

/** The start of `open`'s shift in epoch ms (NaN when its clock_in is unreadable). */
export function shiftStartMs<T extends ChainPiece>(open: T, rows: readonly T[]): number {
  return shiftInfo(open, rows).startMs;
}

const CHAIN_COLUMNS =
  "id, profile_id, clock_in, clock_out, status, split_from, lunch_minutes, paid_at, long_shift_warned_at, long_shift_nudged_at";

/**
 * One read for the families of these running entries, then the walk above, keyed by running entry
 * id. Entries with no split_from need no read (a shift of one).
 *
 * `orgId`: required for the service client (the hourly job), which bypasses RLS; on a caller's own
 * client it is belt and braces. A failed read THROWS: a shift rule that silently fell back to the
 * piece would be the bug this file exists to fix, told as if it were the answer.
 */
export async function loadShiftChains<T extends ChainPiece>(
  client: SupabaseClient,
  open: readonly T[],
  orgId: string | null,
): Promise<Map<string, ShiftInfo<ChainPiece>>> {
  const out = new Map<string, ShiftInfo<ChainPiece>>();
  const roots = [...new Set(open.filter((r) => r?.split_from).map((r) => String(r.split_from)))];
  let kin: ChainPiece[] = [];
  if (roots.length) {
    const list = roots.join(",");
    let q = client.from("time_entries").select(CHAIN_COLUMNS).or(`id.in.(${list}),split_from.in.(${list})`);
    if (orgId) q = q.eq("org_id", orgId);
    const { data, error } = await q;
    if (error) throw error;
    kin = (data ?? []) as unknown as ChainPiece[];
  }
  for (const r of open) {
    const base = r as unknown as ChainPiece;
    out.set(String(r.id), shiftInfo(base, [...kin, base]));
  }
  return out;
}
