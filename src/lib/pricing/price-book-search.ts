import { escapeLike } from "@/lib/utils";

/**
 * THE FUZZY LADDER — find a part in the company's price book however it was phrased.
 *
 * Extracted from the `search_price_list` tool so `price_material` runs the SAME search rather than
 * a second, subtly different one. A price lookup that finds the book in one tool and misses it in
 * another is how the same part gets two prices on two quotes.
 *
 * The ladder exists because a single whole-phrase ilike is not enough: the $331.86 panel
 * (PN4060L1200C) WAS in the book, the phrase search missed it, and the assistant fell through to a
 * web guess of $200. Each rung is a progressively looser strategy; the first one that hits wins,
 * and the caller is told WHICH rung matched so a loose match can be treated with suspicion.
 */

export type PriceBookRow = {
  code: string | null;
  description: string | null;
  category: string | null;
  unit: string | null;
  buy_price: number | string | null;
  markup_pct: number | string | null;
  supplier: string | null;
};

/** Strip characters that would break a PostgREST `.or()` filter expression. */
function sanitize(s: unknown): string {
  return String(s ?? "")
    .replace(/[,()%*]/g, " ")
    .trim()
    .slice(0, 80);
}

type Client = {
  from: (t: string) => any;
};

export type PriceBookHit = {
  /** Which rung matched, or null when nothing did. Looser rungs deserve more scrutiny. */
  matched_by: string | null;
  rows: PriceBookRow[];
};

/**
 * Search the org's price book. The supabase client must be ORG-SCOPED (RLS confines the rows);
 * this adds no org filter, exactly like the tool it came from.
 */
export async function searchPriceBook(supabase: Client, search: string, limit = 15): Promise<PriceBookHit> {
  const raw = String(search ?? "").trim().slice(0, 80);
  const baseQuery = () =>
    supabase
      .from("price_list_items")
      .select("code, description, category, unit, buy_price, markup_pct, supplier")
      .eq("archived", false)
      .order("description")
      .limit(limit);

  if (!raw) {
    const { data, error } = await baseQuery();
    if (error) throw error;
    return { matched_by: null, rows: (data ?? []) as PriceBookRow[] };
  }

  const s = sanitize(raw);
  const words = raw.split(/\s+/).map((w) => sanitize(w)).filter((w) => w.length >= 2);
  const lastToken = words.length > 1 ? words[words.length - 1] : null;

  const strategies: { how: string; run: () => any }[] = [
    // 1. the exact catalog code ("PN4060L1200C"), case-insensitive
    { how: "exact code", run: () => baseQuery().ilike("code", escapeLike(raw)) },
    // 2. the query somewhere inside a code (partial/prefixed part numbers)
    { how: "code contains", run: () => baseQuery().ilike("code", `%${escapeLike(raw)}%`) },
    // 3. the whole phrase anywhere in description / code / category
    {
      how: "phrase",
      run: () => (s ? baseQuery().or(`description.ilike.%${s}%,code.ilike.%${s}%,category.ilike.%${s}%`) : null),
    },
    // 4. EVERY significant word in the description, any order ("outdoor 200a panel" hits
    //    "Panel, 200A main breaker, outdoor")
    {
      how: "all words in description",
      run: () => (words.length > 1 ? words.reduce((q: any, w: string) => q.ilike("description", `%${w}%`), baseQuery()) : null),
    },
    // 5. the LAST token against code — the findPl idiom ("RACO 936" → code 936)
    { how: "last token as code", run: () => (lastToken ? baseQuery().ilike("code", `%${lastToken}%`) : null) },
    // 6. ANY significant word in description or code — the widest net before giving up
    {
      how: "any word",
      run: () => {
        const parts = words.flatMap((w) => [`description.ilike.%${w}%`, `code.ilike.%${w}%`]);
        return parts.length ? baseQuery().or(parts.join(",")) : null;
      },
    },
  ];

  for (const st of strategies) {
    const q = st.run();
    if (!q) continue;
    const { data, error } = await q;
    if (error) throw error;
    if (data?.length) return { matched_by: st.how, rows: data as PriceBookRow[] };
  }
  return { matched_by: null, rows: [] };
}

/** Rungs 4-6 are word-soup matches — the right description may not be the first row. */
export const LOOSE_RUNGS = new Set(["all words in description", "last token as code", "any word"]);
