/**
 * THE OFFICE'S VIEW OF A JOB'S SHOWN PAPERS, AS VERSIONS (0326). Pure, so the rule the office reads
 * is the rule the portal applies (job_share_shows), tested once.
 *
 * A share row may name the older paper it replaces. The customer sees a live row only when no
 * other LIVE row replaces it. So, for the office:
 *   - current:  live rows no live row replaces, each with its earlier versions (following
 *               "replaces" back, whatever their own state), newest first;
 *   - takenOff: rows taken down that are nobody's earlier version (a plain "Taken Off" list, Put
 *               Back from there);
 * and a taken-down newest version lets the one it replaced show again, which the office is told.
 */
export type ShareLike = {
  document_id: string;
  title: string;
  kind: string;
  replaces_document_id: string | null;
  shared_at: string;
  shared_by: string | null;
  removed_at: string | null;
  removed_by: string | null;
  replaces_marked_at: string | null;
  replaces_marked_by: string | null;
};

export type PaperVersion<S extends ShareLike> = {
  share: S;
  /** The row that stands in for this one (a later version), with who marked it and when. */
  replacedBy: S | null;
};
export type PaperChain<S extends ShareLike> = { current: S; earlier: PaperVersion<S>[] };

export function paperHistory<S extends ShareLike>(shares: readonly S[]): { current: PaperChain<S>[]; takenOff: S[] } {
  const byId = new Map(shares.map((s) => [s.document_id, s]));
  const liveReplacerOf = new Map<string, S>();
  for (const s of shares) {
    if (!s.removed_at && s.replaces_document_id) liveReplacerOf.set(s.replaces_document_id, s);
  }
  // Any replacer, live or not, names the paper before it: that is history either way.
  const anyReplacerOf = new Map<string, S>();
  for (const s of shares) if (s.replaces_document_id && !anyReplacerOf.has(s.replaces_document_id)) anyReplacerOf.set(s.replaces_document_id, s);

  const inAChain = new Set<string>();
  const current: PaperChain<S>[] = [];
  const liveNewestFirst = shares.filter((s) => !s.removed_at && !liveReplacerOf.has(s.document_id)).sort((a, b) => b.shared_at.localeCompare(a.shared_at));
  for (const cur of liveNewestFirst) {
    const earlier: PaperVersion<S>[] = [];
    const seen = new Set([cur.document_id]);
    let newer: S = cur;
    let prevId = cur.replaces_document_id;
    while (prevId && !seen.has(prevId)) {
      seen.add(prevId);
      const prev = byId.get(prevId);
      if (!prev) break;
      earlier.push({ share: prev, replacedBy: newer });
      inAChain.add(prev.document_id);
      newer = prev;
      prevId = prev.replaces_document_id;
    }
    current.push({ current: cur, earlier });
  }
  const takenOff = shares
    .filter((s) => s.removed_at && !inAChain.has(s.document_id))
    .sort((a, b) => String(b.removed_at).localeCompare(String(a.removed_at)));
  return { current, takenOff };
}

/** When this row comes down, which older paper goes back up on the customer's page (if any). */
export function showsAgainIfTakenOff<S extends ShareLike>(shares: readonly S[], documentId: string): S | null {
  const me = shares.find((s) => s.document_id === documentId);
  if (!me || me.removed_at || !me.replaces_document_id) return null;
  const older = shares.find((s) => s.document_id === me.replaces_document_id);
  return older && !older.removed_at ? older : null;
}

/** The papers a newer one may be marked as replacing: what the customer sees now, except itself. */
export function replaceChoices<S extends ShareLike>(shares: readonly S[], documentId: string): S[] {
  return paperHistory(shares)
    .current.map((c) => c.current)
    .filter((s) => s.document_id !== documentId);
}
