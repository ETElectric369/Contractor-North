/**
 * The "learn from bills" price book. Instead of maintaining a catalog of a million tiny parts, we
 * derive what the company ACTUALLY PAID from the line items on the bills they enter — ground truth
 * for their real net cost (their own supplier pricing, no subscription, self-updating the moment a
 * bill is saved). Queried live off bill_line_items — nothing is stored or synced.
 *
 * The caller passes an ORG-SCOPED supabase client (RLS confines rows to the org); this helper adds
 * no org filter, exactly like search_price_list.
 */
export type LearnedPrice = {
  item: string;
  lastPrice: number;
  avgPrice: number;
  lowPrice: number;
  highPrice: number;
  timesBought: number;
  lastDate: string | null;
  lastSupplier: string | null;
};

const num = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

export async function searchPaidPrices(
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => any },
  search: string,
  limit = 15,
): Promise<LearnedPrice[]> {
  // Keep only characters a real part description uses — strips ilike wildcards (% _) and anything
  // that could perturb the match. The value is passed as an RPC ARG, never concatenated into SQL.
  const s = String(search ?? "").replace(/[^a-zA-Z0-9 &'/.#-]/g, "").trim().slice(0, 60);
  if (!s) return [];

  // Aggregation happens in the DB (public.learned_prices) over ALL matching rows — correct at any
  // scale, RLS-scoped to the caller's org. Returns most-recently-purchased items first.
  const { data, error } = await supabase.rpc("learned_prices", {
    p_search: s,
    p_limit: Math.min(40, Math.max(1, limit)),
  });
  if (error || !Array.isArray(data)) return [];

  return (data as any[]).map((r) => ({
    item: String(r?.item ?? ""),
    lastPrice: num(r?.last_price),
    avgPrice: num(r?.avg_price),
    lowPrice: num(r?.low_price),
    highPrice: num(r?.high_price),
    timesBought: num(r?.times_bought),
    lastDate: r?.last_date ?? null,
    lastSupplier: r?.last_supplier ?? null,
  }));
}
