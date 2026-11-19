import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";

/**
 * A REVISION SUPERSEDES THE ESTIMATE IT REVISES (0391, cn-v1085).
 *
 * Two accepted estimates on one job add up everywhere a job's accepted estimates are summed — right
 * for a change order, wrong for a corrected price for the same work. Revise (on the original's page)
 * births a copy that remembers what it revises (quotes.revises_quote_id, the INTENT); when the
 * revision is ACCEPTED, this moves what it replaces from sent or accepted to `superseded` (the FACT),
 * so every reader of "accepted" — the job's tasks and length, its buy list, the contract total, the
 * preliminary notice, the won tally — sees one estimate for the work without learning a new rule.
 * A superseded estimate keeps its lines and its history; it simply stops counting.
 *
 * WHAT IS REPLACED: the estimate this one revises, every estimate THAT one revised before it (the
 * chain — a revision of a revision replaces the whole line of them), and any other revision of the
 * same original (a sibling: two corrected offers for one job, the accepted one wins). Only an OFFER or
 * a WON estimate moves: a draft never counted, a declined one never will.
 *
 * Only an ACCEPTED revision supersedes anything — Create Job on a draft revision, or Nort's
 * convertToJob, moves nothing. Idempotent: nothing left to move answers `superseded: []`. The write
 * selects what it moved (the silent-write law). Org-scoped when the caller says who (the service
 * client on the customer's own Accept link).
 */
export async function supersedeRevised(
  sb: SupabaseClient,
  who: { revisionId: string; orgId: string | null },
): Promise<{ /** The numbers of the estimates that moved to superseded, the one revised first. */ superseded: string[]; error?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const org = (q: any): any => (who.orgId ? q.eq("org_id", who.orgId) : q); // any-typed: the generic form trips TS2589
  const { data: rev, error: rErr } = await org(sb.from("quotes").select("revises_quote_id, status").eq("id", who.revisionId)).maybeSingle();
  if (rErr) return { superseded: [], error: dbError(rErr) };
  const revision = rev as { revises_quote_id?: string | null; status?: string | null } | null;
  const original = revision?.revises_quote_id ?? null;
  if (!original || revision?.status !== "accepted") return { superseded: [] };

  // The chain upward from the original (bounded; a cycle stops at the first repeat).
  type Row = { id: string; quote_number: string | null; revises_quote_id: string | null };
  const targets: Row[] = [];
  const seen = new Set<string>([who.revisionId]);
  let cur: string | null = original;
  for (let hop = 0; cur && !seen.has(cur) && hop < 12; hop++) {
    seen.add(cur);
    const { data, error } = await org(sb.from("quotes").select("id, quote_number, revises_quote_id").eq("id", cur)).maybeSingle();
    if (error) return { superseded: [], error: dbError(error) };
    const row = data as Row | null;
    if (!row) break; // gone, or another company's: the chain ends here
    targets.push(row);
    cur = row.revises_quote_id ?? null;
  }
  // The siblings: other revisions of the same original.
  const { data: sibs, error: sErr } = await org(sb.from("quotes").select("id, quote_number, revises_quote_id").eq("revises_quote_id", original));
  if (sErr) return { superseded: [], error: dbError(sErr) };
  for (const s of (sibs ?? []) as Row[]) if (!seen.has(s.id)) { seen.add(s.id); targets.push(s); }
  if (!targets.length) return { superseded: [] };

  const { data: moved, error } = await org(
    sb.from("quotes").update({ status: "superseded" }).in("id", targets.map((t) => t.id)).in("status", ["sent", "accepted"]),
  ).select("id");
  if (error) return { superseded: [], error: dbError(error) };
  const movedIds = new Set(((moved ?? []) as Array<{ id: string }>).map((m) => m.id));
  return { superseded: targets.filter((t) => movedIds.has(t.id)).map((t) => t.quote_number ?? "an earlier estimate") };
}

/** The sentence under the status when a revision's acceptance superseded what it replaces. */
export const supersededWords = (numbers: string[]): string | null => {
  if (!numbers.length) return null;
  const list = numbers.length === 1 ? numbers[0] : `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
  return `${list} ${numbers.length === 1 ? "is" : "are"} now superseded by this estimate.`;
};

/** The one way back, said after supersededWords on the office's BELL (the customer's Accept link rings
 *  it; that bell is English, as its title and body are). On the estimate's own page the same hint is
 *  the catalog's, in the reader's language (qs_keepBothHint). "This estimate" is the one the bell is
 *  about and the sentence before it names: the revision just accepted, whose page always draws the
 *  door. The page of an estimate it replaced draws it only for the one it revises directly, so the
 *  hint never sends anyone to "either". */
export const KEEP_BOTH_BELL_HINT = "If they are separate work, open this estimate and tap Keep Both.";

/** THE REVISION THAT REPLACED AN ESTIMATE — the TIP of the chain (audit v1085, carried): a revision that
 *  was itself revised is superseded too, and the one that stands is the last one accepted; a two-deep
 *  chain used to name the middle one, which every reader took for "over". Bounded; a cycle stops at the
 *  first repeat. When the chain ends on a superseded estimate with nothing above it (its revision was
 *  deleted), that one is named — it is the next door. Null when none: a superseded estimate with no
 *  revision at all may be set back by hand. */
export async function revisionOf(
  sb: SupabaseClient,
  who: { quoteId: string; orgId: string | null },
): Promise<{ id: string; quote_number: string | null; /** It revises THIS estimate itself, not a revision of it (Keep Both's door is drawn only then). */ direct: boolean } | null> {
  type Rev = { id: string; quote_number: string | null; status?: string | null };
  const seen = new Set<string>([who.quoteId]);
  let cur = who.quoteId;
  let found: Rev | null = null;
  let hops = 0;
  for (let hop = 0; hop < 12; hop++) {
    let q = sb.from("quotes").select("id, quote_number, accepted_at, status").eq("revises_quote_id", cur).in("status", ["accepted", "superseded"]);
    if (who.orgId) q = q.eq("org_id", who.orgId);
    // NULLS LAST (audit v1085): Postgres puts nulls first on DESC, which named a never-accepted sibling.
    const { data, error } = await q.order("accepted_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    if (error) throw new Error(`revisionOf: ${dbError(error)}`); // a failed read must not lift a lock
    const row = data as Rev | null;
    if (!row || seen.has(row.id)) break;
    seen.add(row.id);
    found = row;
    hops++;
    if (row.status !== "superseded") break; // the one that stands
    cur = row.id;
  }
  return found ? { id: found.id, quote_number: found.quote_number, direct: hops === 1 } : null;
}

/**
 * KEEP BOTH (cn-v1168): A REVISION THAT IS NOT A REPLACEMENT STANDS ON ITS OWN, AND WHAT ITS ACCEPTANCE
 * RETIRED COMES BACK.
 *
 * Erik, 2026-11-19, with a duplex: one quote per unit, the second made with Revise on the first, both
 * accepted by the customer within a minute, and the first "got locked and disappeared to the bottom of
 * the list, if i wanted it gone i would have deleted it". The pointer (revises_quote_id) is an INTENT a
 * person never stated when he reached for Revise as a way to copy; supersedeRevised turned it into a
 * FACT on acceptance, and nothing could say otherwise afterwards. Keep Both is that door: the pointer is
 * cleared, and every estimate that stands superseded ONLY because of it is put back where it stood.
 *
 * THE PLAN, pure. `family` is every estimate of the revision's tree: the original it revises, that
 * one's own originals up to the first, and everything that revises any of them (the revision itself and
 * whatever revises IT are left out by the caller: once the pointer is cleared they are a tree of their
 * own). The candidates are exactly what supersedeRevised moves when this revision is accepted: its
 * original, the chain above it, and the original's other revisions. One comes back only when it is
 * superseded now and NO ACCEPTED estimate still replaces it by that same forward rule (an accepted
 * estimate below it in the tree, or an accepted revision of the same original beside it). Lowest in the
 * tree first, and among the same original's revisions the one accepted last first, so an estimate that
 * comes back as accepted goes on replacing what it replaced before: two prices for one piece of work
 * never both come back.
 *
 * WHERE IT COMES BACK TO: accepted when it carries the moment it was accepted (accepted_at, which
 * superseding never clears), otherwise sent. The row keeps no memory of the status it was superseded
 * FROM, so an estimate accepted, walked back to sent and only then superseded comes back accepted; the
 * door says what it did, and with nothing replacing it the status is the person's to set again.
 */
export interface FamilyRow {
  id: string;
  quote_number: string | null;
  status: string;
  revises_quote_id: string | null;
  accepted_at: string | null;
  job_id: string | null;
}
export interface KeepBothRestore {
  id: string;
  quote_number: string | null;
  job_id: string | null;
  to: "accepted" | "sent";
}
/** WHERE AN ESTIMATE COMES BACK TO when what replaced it is un-linked: accepted when it carries the
 *  moment it was accepted, otherwise an open offer. One rule: the plan below writes by it, and the
 *  estimate's page asks by it before anything is written (quotes/[id]/page), so the first tap's
 *  sentence and the deed never disagree about which of the two it will be. */
export const comebackOf = (acceptedAt: string | null | undefined): "accepted" | "sent" => (acceptedAt ? "accepted" : "sent");

export function planKeepBoth(
  family: ReadonlyArray<FamilyRow>,
  /** The estimate the revision revises (its pointer, as read before it is cleared). */
  originalId: string,
): { restore: KeepBothRestore[]; /** The candidates that stay superseded, each with the accepted estimate that still replaces it. */ still: Array<{ id: string; quote_number: string | null; by: string | null }> } {
  const byId = new Map(family.map((r) => [r.id, r]));
  const status = new Map(family.map((r) => [r.id, r.status]));
  const kids = new Map<string, FamilyRow[]>();
  for (const r of family) {
    if (!r.revises_quote_id || !byId.has(r.revises_quote_id)) continue;
    kids.set(r.revises_quote_id, [...(kids.get(r.revises_quote_id) ?? []), r]);
  }
  const original = byId.get(originalId);
  if (!original) return { restore: [], still: [] };

  // The accepted estimate that still replaces `x`, by the forward rule, on the statuses as they stand
  // in this plan: one below it in the tree, else another revision of the same original beside it.
  const acceptedBelow = (id: string, seen: Set<string>): FamilyRow | null => {
    for (const k of kids.get(id) ?? []) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      if (status.get(k.id) === "accepted") return k;
      const deeper = acceptedBelow(k.id, seen);
      if (deeper) return deeper;
    }
    return null;
  };
  const replacedBy = (x: FamilyRow): FamilyRow | null => {
    const below = acceptedBelow(x.id, new Set([x.id]));
    if (below) return below;
    if (!x.revises_quote_id) return null;
    return (kids.get(x.revises_quote_id) ?? []).find((s) => s.id !== x.id && status.get(s.id) === "accepted") ?? null;
  };

  // Lowest first: the original's other revisions (the one accepted last first), the original, then the
  // chain above it (bounded; a cycle stops at the first repeat).
  const lastAcceptedFirst = (a: FamilyRow, b: FamilyRow) => String(b.accepted_at ?? "").localeCompare(String(a.accepted_at ?? ""));
  const order: FamilyRow[] = [...(kids.get(original.id) ?? [])].sort(lastAcceptedFirst);
  const seen = new Set<string>(order.map((r) => r.id));
  for (let cur: FamilyRow | undefined = original, hop = 0; cur && !seen.has(cur.id) && hop < 12; hop++) {
    seen.add(cur.id);
    order.push(cur);
    cur = cur.revises_quote_id ? byId.get(cur.revises_quote_id) : undefined;
  }

  const restore: KeepBothRestore[] = [];
  const still: Array<{ id: string; quote_number: string | null; by: string | null }> = [];
  for (const x of order) {
    if (status.get(x.id) !== "superseded") continue;
    const by = replacedBy(x);
    if (by) {
      still.push({ id: x.id, quote_number: x.quote_number, by: by.quote_number });
      continue;
    }
    const to = comebackOf(x.accepted_at);
    status.set(x.id, to);
    restore.push({ id: x.id, quote_number: x.quote_number, job_id: x.job_id, to });
  }
  return { restore, still };
}

/**
 * THE FAMILY READ behind planKeepBoth: from the original up to the first estimate of the line, then
 * everything that revises any of them, level by level. The revision being un-linked and whatever
 * revises IT are left out (`leaveOut`): once its pointer is cleared they are a tree of their own.
 * Bounded both ways (twelve levels, as the chain readers above); org-scoped when the caller says who.
 * A failed read is an error: a plan made from half a family could bring back an estimate that is
 * still replaced.
 */
export async function revisionFamily(
  sb: SupabaseClient,
  who: { originalId: string; leaveOut: string; orgId: string | null },
): Promise<{ family: FamilyRow[]; error?: string }> {
  const COLS = "id, quote_number, status, revises_quote_id, accepted_at, job_id";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const org = (q: any): any => (who.orgId ? q.eq("org_id", who.orgId) : q); // any-typed: the generic form trips TS2589
  const family = new Map<string, FamilyRow>();
  // Up: the original and the chain above it; the last one found is the root.
  let root: string | null = null;
  for (let cur: string | null = who.originalId, hop = 0; cur && !family.has(cur) && cur !== who.leaveOut && hop < 12; hop++) {
    const { data, error } = await org(sb.from("quotes").select(COLS).eq("id", cur)).maybeSingle();
    if (error) return { family: [], error: dbError(error) };
    const row = data as FamilyRow | null;
    if (!row) break; // gone, or another company's: the line ends here
    family.set(row.id, row);
    root = row.id;
    cur = row.revises_quote_id ?? null;
  }
  if (!root) return { family: [] };
  // Down: everything that revises anything already in the family, one level at a time.
  let level = [...family.keys()];
  for (let depth = 0; level.length && depth < 12; depth++) {
    const { data, error } = await org(sb.from("quotes").select(COLS).in("revises_quote_id", level));
    if (error) return { family: [], error: dbError(error) };
    const next: string[] = [];
    for (const row of (data ?? []) as FamilyRow[]) {
      if (row.id === who.leaveOut || family.has(row.id)) continue;
      family.set(row.id, row);
      next.push(row.id);
    }
    level = next;
  }
  return { family: [...family.values()] };
}
