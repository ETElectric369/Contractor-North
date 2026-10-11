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

/** THE ACCEPTED REVISION THAT REPLACED AN ESTIMATE — or the one that replaced that (a chain), newest
 *  first. Null when none: a superseded estimate with no live revision (the revision was deleted or
 *  walked back) may be set back by hand. */
export async function revisionOf(
  sb: SupabaseClient,
  who: { quoteId: string; orgId: string | null },
): Promise<{ id: string; quote_number: string | null } | null> {
  let q = sb.from("quotes").select("id, quote_number, accepted_at").eq("revises_quote_id", who.quoteId).in("status", ["accepted", "superseded"]);
  if (who.orgId) q = q.eq("org_id", who.orgId);
  // NULLS LAST (audit v1085): Postgres puts nulls first on DESC, which named a never-accepted sibling.
  const { data, error } = await q.order("accepted_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  if (error) throw new Error(`revisionOf: ${dbError(error)}`); // a failed read must not lift a lock
  return (data as { id: string; quote_number: string | null } | null) ?? null;
}
