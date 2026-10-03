import "server-only";

import { dbError } from "@/lib/db-error";
import { signDocumentUrls } from "@/lib/signed-docs";
import { answeredOnReconcile } from "@/lib/paperwork";
import type { PaperRowItem } from "@/components/paperwork-row";
import { bankLinesStayHere, bankViews } from "@/app/(app)/bills/bank-core";
import { openListViews } from "@/app/(app)/bills/open-list-core";

/**
 * ── THE STATEMENTS WAITING ON RECONCILE (2026-10-03) ──────────────────────────────────────────
 *
 * Erik: "so it still doesnt make sense to me that all this reconcile stuff is on the bills page." He
 * dropped a statement into Bring In A Statement and then walked to /bills to answer it. The rule that
 * decides which screen answers a paper is `answeredOnReconcile` (lib/paperwork.ts) and it is the only
 * filter here: a bank download and a supplier's open list compare two records, so they are answered
 * on this page; everything that becomes a cost stays on Bills with the jobs and the buckets.
 *
 * THE SAME READ BILLS MADE, MOVED, NOT COPIED. `openListViews` compares each list against that
 * supplier's papers as the page loads (so a card is never stale) and `bankViews` sorts a download
 * against the books — the same two functions, with the same org filter, and `bankLinesStayHere` still
 * strips a download's own lines before anything reaches the browser.
 *
 * A LOST READ IS NAMED, NEVER AN EMPTY LIST. "Nothing is waiting" over a read that failed is the false
 * all-clear this page's own lead is written to avoid, so the caller gets the words and says them.
 */
export type StatementCards = { items: PaperRowItem[]; error: string | null };

export async function readStatementCards(supabase: any, orgId: string): Promise<StatementCards> {
  const { data, error } = await supabase
    .from("organized_items")
    .select("*, jobs(job_number, name)")
    .eq("org_id", orgId)
    .eq("status", "needs_review")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return { items: [], error: `Couldn't read the statements waiting on you just now. ${dbError(error)}` };
  const rows = ((data ?? []) as any[]).filter((i) => answeredOnReconcile(i));
  if (!rows.length) return { items: [], error: null };
  const [urls, listViews, bankCards] = await Promise.all([
    signDocumentUrls(supabase, rows.map((i) => i.file_url)),
    openListViews(supabase, orgId, rows),
    bankViews(supabase, orgId, rows),
  ]);
  return {
    items: rows.map((i) => ({
      ...bankLinesStayHere(i, bankCards[i.id]),
      signedUrl: (i.file_url && urls.get(i.file_url)) || null,
      open_list: listViews[i.id] ?? null,
      bank: bankCards[i.id] ?? null,
    })),
    error: null,
  };
}
