import "server-only";
import type { requireStaff } from "@/lib/staff-guard";
import { vendorKey } from "./item-options-math";

/**
 * THE VENDOR READS THE PRICE-LIST ACTIONS SHARE. A vendor is a name (the brand) on
 * price_list_item_options.vendor (0282), with an optional card on price_list_vendors (0296).
 * Server-only and not a "use server" file, so these helpers are never callable from a browser.
 */

export type StaffDb = Extract<Awaited<ReturnType<typeof requireStaff>>, { supabase: unknown }>["supabase"];

/** Is 0296 on this database? A deploy can land before its migration; every vendor-card write
 *  checks first and says so in words instead of surfacing "relation does not exist". */
export function cardsMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "PGRST205") return true;
  const msg = String(err.message ?? "");
  return /price_list_vendors/.test(msg) && /does not exist|schema cache/.test(msg);
}

export const CARDS_NOT_READY =
  "Vendor contact details aren't switched on for your account yet. The vendor's items and prices still work; the phone and email arrive with the next update.";

/** Every spelling of every vendor this org already uses: cards first (a person chose that
 *  spelling), then the names on items. Explicitly org-scoped as well as RLS-scoped. */
export async function knownVendorNamesFor(supabase: StaffDb, orgId: string): Promise<string[]> {
  const [cards, opts] = await Promise.all([
    supabase.from("price_list_vendors").select("name, archived").eq("org_id", orgId).limit(2000),
    supabase.from("price_list_item_options").select("vendor").eq("org_id", orgId).limit(5000),
  ]);
  const seen = new Map<string, string>();
  for (const c of ((cards.error ? [] : cards.data) ?? []) as { name: string; archived: boolean }[]) {
    const k = vendorKey(c.name);
    if (k && !c.archived && !seen.has(k)) seen.set(k, c.name.trim());
  }
  for (const o of ((opts.error ? [] : opts.data) ?? []) as { vendor: string }[]) {
    const k = vendorKey(o.vendor);
    if (k && !seen.has(k)) seen.set(k, o.vendor.trim());
  }
  return [...seen.values()];
}

/** The vendor's options on this org's items (live and archived), matched by name the way 0282's
 *  index matches: lower(btrim(vendor)). Read in full and matched here rather than with ilike, so a
 *  "%" or "_" in a brand name can never widen the match. */
export async function optionsOfVendor(
  supabase: StaffDb,
  orgId: string,
  name: string,
): Promise<{ rows: { id: string; item_id: string; vendor: string; label: string | null; is_default: boolean; archived: boolean }[] } | { error: unknown }> {
  const { data, error } = await supabase
    .from("price_list_item_options")
    .select("id, item_id, vendor, label, is_default, archived")
    .eq("org_id", orgId)
    .limit(5000);
  if (error) return { error };
  const key = vendorKey(name);
  const rows = ((data ?? []) as { id: string; item_id: string; vendor: string; label: string | null; is_default: boolean; archived: boolean }[]).filter(
    (o) => vendorKey(o.vendor) === key,
  );
  return { rows };
}

/** The org's card for this vendor name, if it has one. */
export async function cardOfVendor(
  supabase: StaffDb,
  orgId: string,
  name: string,
): Promise<{ card: Record<string, unknown> | null } | { error: { code?: string; message?: string } }> {
  const { data, error } = await supabase
    .from("price_list_vendors")
    .select("id, name, contact_name, phone, email, website, address, notes, archived")
    .eq("org_id", orgId)
    .limit(2000);
  if (error) return { error };
  const key = vendorKey(name);
  const card = ((data ?? []) as Record<string, unknown>[]).find((c) => vendorKey(String(c.name ?? "")) === key) ?? null;
  return { card };
}
