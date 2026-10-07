// Server-safe on purpose: the job page (a server component) calls contractEstimates at render. It
// used to live in left-to-bill-card.tsx, a "use client" module, and every export of a "use client"
// module becomes a client reference that the server cannot call, so the page crashed. No "use client".

/** The estimates that make the contract, for the fold: the ACCEPTED ones (a job can win two), else
 *  the newest proposal on its own (contractTotalFromQuotes' own rule, so the fold names exactly the
 *  estimate the figure was taken from). */
export function contractEstimates<T extends { quote_number?: string | null; total?: number | null; status?: string | null; created_at?: string | null }>(
  quotes: readonly T[],
): { number: string | null; total: number; accepted: boolean }[] {
  const accepted = quotes.filter((q) => q.status === "accepted");
  const picked = accepted.length
    ? accepted
    : [...quotes].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))).slice(0, 1);
  return picked.map((q) => ({ number: q.quote_number ?? null, total: Number(q.total) || 0, accepted: q.status === "accepted" }));
}
