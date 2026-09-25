import "server-only";
import type { requireStaff } from "@/lib/staff-guard";
import { vendorKey } from "./item-options-math";

/**
 * THE VENDOR READS THE PRICE-LIST ACTIONS SHARE. A vendor is a name on
 * price_list_item_options.vendor (0282), with an optional card on price_list_vendors (0296)
 * that says what kind it is (0341: brand, supplier, subcontractor, or Not Sorted).
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

/** Is 0341 (a vendor has a kind) on this database? Naming a column that isn't there fails the
 *  whole select, so every read that asks for kind retries without it, and every write that sets it
 *  says so in words. */
export function kindsMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  const msg = String(err.message ?? "");
  return /\b(kind|trade|is_person|import_batch|source_url|maps_url|looked_up_at)\b/.test(msg) && /does not exist|schema cache|could not find/i.test(msg);
}

export const KINDS_NOT_READY =
  "Sorting vendors into suppliers, subcontractors and brands arrives with the next update. Add them one at a time for now.";

/** THE PROJECTION LAW: every column a card is read with, in one place. 0341's columns are asked
 *  for first and dropped on a database that doesn't have them yet. */
export const CARD_COLUMNS = "id, name, contact_name, phone, email, website, address, notes, archived";
export const CARD_COLUMNS_0341 = `${CARD_COLUMNS}, kind, trade, is_person, source_url, maps_url, looked_up_at`;

/** Every card of this org (live and archived), with 0341's columns when the database has them. */
export async function cardsOf(
  supabase: StaffDb,
  orgId: string,
): Promise<{ rows: Record<string, unknown>[]; kinds: boolean } | { error: { code?: string; message?: string } }> {
  const withKinds = await supabase.from("price_list_vendors").select(CARD_COLUMNS_0341).eq("org_id", orgId).limit(2000);
  if (!withKinds.error) return { rows: (withKinds.data ?? []) as unknown as Record<string, unknown>[], kinds: true };
  if (!kindsMissing(withKinds.error)) return { error: withKinds.error };
  const base = await supabase.from("price_list_vendors").select(CARD_COLUMNS).eq("org_id", orgId).limit(2000);
  if (base.error) return { error: base.error };
  return { rows: (base.data ?? []) as unknown as Record<string, unknown>[], kinds: false };
}

/** The names this org's live cards call SUBCONTRACTORS (0341), by vendorKey. A subcontractor never
 *  carries prices on an item, so the item writes refuse these by name. Empty before 0341. */
export async function subcontractorKeysFor(supabase: StaffDb, orgId: string): Promise<Set<string> | { error: unknown }> {
  const res = await supabase.from("price_list_vendors").select("name, kind, archived").eq("org_id", orgId).eq("kind", "subcontractor").limit(2000);
  // Before 0341 (or before 0296) there is no kind, so there are no subcontractors to keep out.
  if (res.error) return kindsMissing(res.error) || cardsMissing(res.error) ? new Set() : { error: res.error };
  return new Set(
    ((res.data ?? []) as { name: string; archived: boolean }[]).filter((c) => !c.archived).map((c) => vendorKey(c.name)),
  );
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
  const all = await cardsOf(supabase, orgId);
  if ("error" in all) return { error: all.error };
  const key = vendorKey(name);
  const card = all.rows.find((c) => vendorKey(String(c.name ?? "")) === key) ?? null;
  return { card };
}
