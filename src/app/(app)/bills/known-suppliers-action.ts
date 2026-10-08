"use server";

import { requireStaff } from "@/lib/staff-guard";
import { readAllPages } from "@/lib/read-all-pages";
import { knownSuppliersFrom, type KnownSupplier } from "@/lib/supplier-suggest";

/**
 * THE SUPPLIERS THE BOX KNOWS (item D, 2026-10-07): every account with its aliases, and every bill
 * spelling, folded by the one rule (knownSuppliersFrom). Read once per page by the box on its first
 * focus, RLS-scoped to the signed-in company. A failed read is an empty list: the box then asks
 * nothing, and the server's exact snap still runs at the save.
 */
export async function listKnownSuppliers(): Promise<KnownSupplier[]> {
  const ctx = await requireStaff();
  if ("error" in ctx) return [];
  const { supabase, orgId } = ctx;
  const [accounts, aliases, bills] = await Promise.all([
    supabase.from("supplier_accounts").select("id, name").eq("org_id", orgId).limit(500),
    supabase.from("supplier_aliases").select("alias, supplier_account_id").eq("org_id", orgId).limit(5000),
    readAllPages<{ supplier: string | null }>((from, to) => supabase.from("bills").select("supplier").eq("org_id", orgId).order("id").range(from, to)),
  ]);
  if (accounts.error || aliases.error || bills.error) return [];
  return knownSuppliersFrom(
    (accounts.data ?? []) as { id: string; name: string }[],
    (aliases.data ?? []) as { alias: string; supplier_account_id: string }[],
    bills.rows.map((b) => b.supplier),
  );
}
