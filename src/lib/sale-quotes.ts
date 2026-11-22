/**
 * ONE SALE IS AN ESTIMATE AND ITS REVISION FAMILY (cn-v1178, migration 0416 public.quote_family_ids).
 *
 * Revise births a copy that remembers what it revises (quotes.revises_quote_id, the intent a person
 * stated with that tap). A corrected price for the same work is the same SALE: the same customer, the
 * same job, and ONE deposit. Until this rule a deposit belonged to one estimate's id, so a revision of
 * an estimate whose deposit was already requested or paid stated the deposit again, and the customer's
 * tap made and charged a second one (the sales-path audit of 2026-11-22, finding B1).
 *
 * THE FAMILY, as the database answers it (the one rule; this file only asks): the estimate itself, every
 * estimate it revises up to the first of the line, and everything that revises any of them. Keep Both
 * (cn-v1168) clears the pointer, so two estimates a person kept as separate work are two sales, each
 * with its own deposit. The function runs with the caller's own rights, so a signed-in person is
 * answered only from their own company's estimates.
 *
 * A failed read THROWS: a door that cannot tell which estimates are one sale must not make a second
 * request for it. The id asked about is always in the answer.
 */
export const QUOTE_FAMILY_RPC = "quote_family_ids";

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

export async function saleQuoteIds(db: RpcClient, quoteId: string): Promise<string[]> {
  const id = String(quoteId ?? "");
  if (!id) return [];
  const { data, error } = await db.rpc(QUOTE_FAMILY_RPC, { p_quote: id });
  if (error) throw error;
  const ids = new Set<string>([id]);
  for (const row of Array.isArray(data) ? data : []) {
    // A set of uuids comes back as bare strings; some clients wrap each in an object keyed by the function.
    const v = typeof row === "string" ? row : row && typeof row === "object" ? (Object.values(row as Record<string, unknown>)[0] as unknown) : null;
    if (typeof v === "string" && v) ids.add(v);
  }
  return [...ids];
}
