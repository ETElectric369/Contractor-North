import type { SupabaseClient } from "@supabase/supabase-js";
import type { FeatureKey } from "@/lib/features";

/**
 * WHAT A COMPANY HAS SAVED IN EACH FEATURE: the Features page's "Off · 3 saved" and the Recurring
 * Billing confirm's "Stops 2 repeat invoices". Counts, never rows (head:true sends no body).
 *
 * The caller's own client, so RLS scopes every count, and each one names the company besides
 * (a person's client can only ever see their own company; the filter is the house rule anyway).
 * A count that fails is LEFT OUT, never read as 0: "nothing saved" is a claim, and an RLS refusal
 * or a missing table is not evidence for it.
 *
 * Nort and Calculators have no rows a company saves, so they have no count.
 */
type Count = { table: string; filter?: (q: any) => any };
const SOURCES: Partial<Record<FeatureKey, Count>> = {
  leads: { table: "inquiries" },
  referrals: { table: "inquiries", filter: (q) => q.not("referred_by", "is", null) },
  estimates: { table: "quotes" },
  kits: { table: "kits" },
  contracts: { table: "contracts" },
  purchase_orders: { table: "purchase_orders" },
  shop_stock: { table: "inventory_items" },
  crew_payroll: { table: "pay_payments", filter: (q) => q.is("voided_at", null) },
  daily_reports: { table: "daily_reports" },
  crew_board: { table: "crew_day_assignments" },
  job_codes: { table: "time_entries", filter: (q) => q.not("job_code", "is", null).neq("job_code", "") },
  permits: { table: "permits" },
  panel_map: { table: "job_circuits", filter: (q) => q.is("removed_at", null) },
  customer_portal: { table: "job_shared_documents", filter: (q) => q.is("removed_at", null) },
  // The repeat invoices the engine would make: what turning Recurring Billing off stops.
  recurring_billing: { table: "recurring_templates", filter: (q) => q.eq("kind", "invoice").eq("active", true) },
  sales_tax: { table: "tax_rates" },
  licenses: { table: "compliance_items" },
  safety_log: { table: "safety_records" },
  website: { table: "site_pages" },
  site_chat: { table: "inquiries", filter: (q) => q.eq("source", "site_chat") },
  todo_extras: { table: "tasks", filter: (q) => q.or("parent_id.not.is.null,priority.neq.0") },
};

export async function featureCounts(
  supabase: SupabaseClient,
  orgId: string,
  keys: readonly FeatureKey[],
): Promise<Partial<Record<FeatureKey, number>>> {
  const wanted = [...new Set(keys)].filter((k) => SOURCES[k]);
  const counted = await Promise.all(
    wanted.map(async (k) => {
      const src = SOURCES[k]!;
      try {
        let q = supabase.from(src.table).select("org_id", { count: "exact", head: true }).eq("org_id", orgId);
        if (src.filter) q = src.filter(q);
        const { count, error } = await q;
        return error || typeof count !== "number" ? null : ([k, count] as const);
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(counted.filter((c): c is readonly [FeatureKey, number] => c !== null));
}

/** Which features have a count at all (the rest never say "N saved"). */
export const COUNTED_FEATURES = Object.keys(SOURCES) as FeatureKey[];
