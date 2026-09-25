"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import { cleanVendorCard, vendorCardRefusal, vendorKey, type VendorCardField } from "./item-options-math";
import { CARDS_NOT_READY, cardOfVendor, cardsMissing, optionsOfVendor } from "./vendor-db";

/**
 * VENDORS: THE BRAND, ITS PHONE NUMBER, AND EVERY ITEM IT IS ON.
 *
 * Erik for Justin (Vivian Builders), 2026-09-24: "vendor means what brand with its own cost and
 * sell price". The cost and sell live on price_list_item_options (0282), one row per item per
 * vendor. How to reach the vendor lives once per name on price_list_vendors (0296).
 *
 * Every write here is staff-only (requireStaff, then 0296's policies), org-scoped by an explicit
 * org_id filter as well as RLS, reads its rows back (THE SILENT-WRITE LAW), and returns what it
 * replaced so the toast can Undo it. Nothing is ever deleted: archive, with a way back.
 */

export type VendorResult = { ok: boolean; error?: string; note?: string };

const NO_ORG = "Your account isn't attached to a company yet, so there's no price list to change.";

/** Add a vendor with its contact details. Items come after: from the vendor's own sheet, or from
 *  any item's Add Vendor. */
export async function addVendor(
  input: Partial<Record<VendorCardField, string | null>>,
): Promise<VendorResult & { name?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };

  const cleaned = cleanVendorCard(input, "create");
  if ("error" in cleaned) return { ok: false, error: cleaned.error };
  const name = String(cleaned.clean.name);

  const existing = await cardOfVendor(supabase, orgId, name);
  if ("error" in existing) return { ok: false, error: cardsMissing(existing.error) ? CARDS_NOT_READY : dbError(existing.error) };
  const opts = await optionsOfVendor(supabase, orgId, name);
  const onItems = "rows" in opts ? opts.rows.filter((o) => !o.archived).length : 0;

  if (existing.card && !existing.card.archived) {
    return { ok: false, error: `${String(existing.card.name)} is already on your Vendors list. Open it there to change its details.` };
  }

  if (existing.card) {
    // It was archived. Bring the one card back rather than refusing: a second card for the same
    // name is the one thing the index forbids, and "it's archived somewhere" is a dead end.
    const patch: Record<string, unknown> = { archived: false };
    for (const [k, v] of Object.entries(cleaned.clean)) if (v !== null && k !== "name") patch[k] = v;
    const { data, error } = await supabase
      .from("price_list_vendors")
      .update(patch)
      .eq("id", String(existing.card.id))
      .eq("org_id", orgId)
      .select("id");
    if (error) return { ok: false, error: vendorCardRefusal(error, name) };
    if (!data?.length) return { ok: false, error: "Nothing was saved. Reload the page and try again." };
    revalidatePath("/price-list");
    return { ok: true, name: String(existing.card.name), note: `${String(existing.card.name)} was archived, so it came back with what you typed.` };
  }

  const { data, error } = await supabase
    .from("price_list_vendors")
    .insert({ ...cleaned.clean, name, created_by: userId })
    .select("id");
  if (error) return { ok: false, error: cardsMissing(error) ? CARDS_NOT_READY : vendorCardRefusal(error, name) };
  if (!data?.length) return { ok: false, error: "Nothing was saved. Reload the page and try again." };
  revalidatePath("/price-list");
  return {
    ok: true,
    name,
    note: onItems ? `It's already on ${onItems} item${onItems === 1 ? "" : "s"}, listed below it.` : undefined,
  };
}

/**
 * Change one detail of a vendor, by its name. A vendor that is only on items so far (no card
 * yet) gets its card on the first detail typed. Returns the value it replaced, for Undo.
 *
 * `field: "name"` RENAMES the vendor everywhere it is written: the card and every item it is on,
 * so the brand never splits into an old spelling and a new one. Renaming onto a name another
 * vendor already has is refused: that would merge two vendors' prices, and a merge is a person's
 * decision item by item, not a side effect of a typo fix.
 */
export async function saveVendorField(input: {
  name: string;
  field: VendorCardField;
  value: string | null;
}): Promise<VendorResult & { previous?: string | null; name?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  if (!vendorKey(input.name)) return { ok: false, error: "No vendor was named. Reload the page." };

  const cleaned = cleanVendorCard({ [input.field]: input.value ?? "" }, "update");
  if ("error" in cleaned) return { ok: false, error: cleaned.error };
  const value = cleaned.clean[input.field] ?? null;

  const found = await cardOfVendor(supabase, orgId, input.name);
  if ("error" in found && !cardsMissing(found.error)) return { ok: false, error: dbError(found.error) };
  const cardsReady = !("error" in found);
  const card = "card" in found ? found.card : null;

  if (input.field === "name") return renameVendor(supabase, orgId, input.name, String(value), card, cardsReady);

  if (!cardsReady) return { ok: false, error: CARDS_NOT_READY };
  const previous = card ? ((card[input.field] as string | null) ?? null) : null;
  if (card) {
    const { data, error } = await supabase
      .from("price_list_vendors")
      .update({ [input.field]: value })
      .eq("id", String(card.id))
      .eq("org_id", orgId)
      .select("id");
    if (error) return { ok: false, error: vendorCardRefusal(error, input.name) };
    if (!data?.length) return { ok: false, error: "Nothing was saved. That vendor may have been removed, so reload the page." };
  } else {
    const { data, error } = await supabase
      .from("price_list_vendors")
      .insert({ name: input.name.trim(), [input.field]: value, created_by: userId })
      .select("id");
    if (error) return { ok: false, error: vendorCardRefusal(error, input.name) };
    if (!data?.length) return { ok: false, error: "Nothing was saved. Reload the page and try again." };
  }
  revalidatePath("/price-list");
  return { ok: true, previous, name: input.name.trim() };
}

type Db = Extract<Awaited<ReturnType<typeof requireStaff>>, { supabase: unknown }>["supabase"];

async function renameVendor(
  supabase: Db,
  orgId: string,
  from: string,
  to: string,
  card: Record<string, unknown> | null,
  cardsReady: boolean,
): Promise<VendorResult & { previous?: string | null; name?: string }> {
  const oldName = card ? String(card.name) : from.trim();
  if (to === oldName) return { ok: true, previous: oldName, name: to };
  const sameVendor = vendorKey(to) === vendorKey(from);

  const mine = await optionsOfVendor(supabase, orgId, from);
  if ("error" in mine) return { ok: false, error: dbError(mine.error) };

  if (!sameVendor) {
    const theirs = await optionsOfVendor(supabase, orgId, to);
    if ("error" in theirs) return { ok: false, error: dbError(theirs.error) };
    const otherCard = cardsReady ? await cardOfVendor(supabase, orgId, to) : { card: null };
    if (theirs.rows.length > 0 || ("card" in otherCard && otherCard.card)) {
      return {
        ok: false,
        error: `${to} is already a vendor. Renaming ${oldName} to it would mix two vendors' prices, so it wasn't changed. Pick another name.`,
      };
    }
  }

  if (card) {
    const { data, error } = await supabase
      .from("price_list_vendors")
      .update({ name: to })
      .eq("id", String(card.id))
      .eq("org_id", orgId)
      .select("id");
    if (error) return { ok: false, error: vendorCardRefusal(error, to) };
    if (!data?.length) return { ok: false, error: "Nothing was saved. That vendor may have been removed, so reload the page." };
  }
  const ids = mine.rows.map((o) => o.id);
  if (ids.length) {
    const { data, error } = await supabase
      .from("price_list_item_options")
      .update({ vendor: to })
      .in("id", ids)
      .eq("org_id", orgId)
      .select("id");
    if (error || (data?.length ?? 0) !== ids.length) {
      /* ONE NAME OR THE OTHER, NEVER BOTH (audit v994 VP4). The card already carries the new
         name, so a failure here used to leave a card with no items and items with no card, and
         the suggested retry was refused both ways (the new name "is already a vendor", the old
         one has items). Put back whatever moved, checked, and say nothing was renamed. Only when
         the put-back itself fails is there a split to name, and then it says exactly which. */
      const took = ((data ?? []) as { id: string }[]).map((r) => r.id);
      const optsBack = took.length
        ? await supabase.from("price_list_item_options").update({ vendor: oldName }).in("id", took).eq("org_id", orgId).select("id")
        : { data: [] as { id: string }[], error: null };
      const cardBack = card
        ? await supabase.from("price_list_vendors").update({ name: oldName }).eq("id", String(card.id)).eq("org_id", orgId).select("id")
        : { data: [{ id: "none" }], error: null };
      const restored = !optsBack.error && (optsBack.data?.length ?? 0) === took.length && !cardBack.error && (cardBack.data?.length ?? 0) > 0;
      const why = error ? dbError(error) : `Only ${data?.length ?? 0} of ${ids.length} items could take the new name.`;
      if (restored) return { ok: false, error: `${why} Nothing was renamed: ${oldName} is still ${oldName} everywhere. Try again.` };
      return {
        ok: false,
        error: `${why} ${oldName} is now half renamed and could not be put back. Reload the page: rename the ${to} card back to ${oldName}, then rename it again.`,
      };
    }
  }
  revalidatePath("/price-list");
  return {
    ok: true,
    previous: oldName,
    name: to,
    note: ids.length ? `Renamed on ${ids.length} item${ids.length === 1 ? "" : "s"} too.` : undefined,
  };
}

/**
 * ARCHIVE A VENDOR: its card, and its row on every item. The prices stay (archived, findable,
 * restorable); they just stop being offered on estimates. An item that priced at this vendor by
 * default goes back to its own price, and the note says how many.
 *
 * Returns exactly what it touched, so Undo puts back THOSE rows and no others.
 */
export async function archiveVendor(name: string): Promise<
  VendorResult & { undo?: { name: string; cardId: string | null; optionIds: string[]; defaultIds: string[] } }
> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };

  const found = await cardOfVendor(supabase, orgId, name);
  if ("error" in found && !cardsMissing(found.error)) return { ok: false, error: dbError(found.error) };
  const card = "card" in found ? found.card : null;
  const mine = await optionsOfVendor(supabase, orgId, name);
  if ("error" in mine) return { ok: false, error: dbError(mine.error) };
  const live = mine.rows.filter((o) => !o.archived);
  if (!card && live.length === 0) return { ok: false, error: "That vendor isn't on your list any more. Reload the page." };

  const optionIds = live.map((o) => o.id);
  const defaultIds = live.filter((o) => o.is_default).map((o) => o.id);
  if (optionIds.length) {
    const { data, error } = await supabase
      .from("price_list_item_options")
      .update({ archived: true })
      .in("id", optionIds)
      .eq("org_id", orgId)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if ((data?.length ?? 0) !== optionIds.length) {
      return { ok: false, error: "Some of its items didn't change. Reload the page and try again." };
    }
  }
  if (card && !card.archived) {
    const { data, error } = await supabase
      .from("price_list_vendors")
      .update({ archived: true })
      .eq("id", String(card.id))
      .eq("org_id", orgId)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!data?.length) return { ok: false, error: "Nothing changed. That vendor may have been removed, so reload the page." };
  }
  revalidatePath("/price-list");
  const d = defaultIds.length;
  return {
    ok: true,
    note: d ? `${d} item${d === 1 ? " that priced" : "s that priced"} at it by default ${d === 1 ? "is" : "are"} back to ${d === 1 ? "its" : "their"} own price.` : undefined,
    undo: { name: card ? String(card.name) : name, cardId: card ? String(card.id) : null, optionIds, defaultIds },
  };
}

/** Undo an archiveVendor: the card and exactly the rows it archived. A row that was the default
 *  comes back as the default only if nothing else took the seat since; otherwise it comes back
 *  as an alternative and the note says so (0282's one-default rule holds). */
export async function restoreVendor(input: {
  name: string;
  cardId: string | null;
  optionIds: string[];
  defaultIds: string[];
}): Promise<VendorResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const ids = (input.optionIds ?? []).filter(Boolean).slice(0, 2000);
  const defaults = new Set((input.defaultIds ?? []).filter((id) => ids.includes(id)));

  let steppedDown = 0;
  if (defaults.size) {
    const { data: rows, error } = await supabase
      .from("price_list_item_options")
      .select("id, item_id")
      .in("id", [...defaults])
      .eq("org_id", orgId);
    if (error) return { ok: false, error: dbError(error) };
    const items = ((rows ?? []) as { id: string; item_id: string }[]).map((r) => r.item_id);
    if (items.length) {
      const { data: sitting, error: sitErr } = await supabase
        .from("price_list_item_options")
        .select("item_id")
        .in("item_id", items)
        .eq("org_id", orgId)
        .eq("is_default", true)
        .eq("archived", false);
      if (sitErr) return { ok: false, error: dbError(sitErr) };
      const taken = new Set(((sitting ?? []) as { item_id: string }[]).map((r) => r.item_id));
      const stepDown = ((rows ?? []) as { id: string; item_id: string }[]).filter((r) => taken.has(r.item_id)).map((r) => r.id);
      if (stepDown.length) {
        const { error: sdErr } = await supabase
          .from("price_list_item_options")
          .update({ is_default: false })
          .in("id", stepDown)
          .eq("org_id", orgId)
          .select("id");
        if (sdErr) return { ok: false, error: dbError(sdErr) };
        steppedDown = stepDown.length;
      }
    }
  }

  if (ids.length) {
    const { data, error } = await supabase
      .from("price_list_item_options")
      .update({ archived: false })
      .in("id", ids)
      .eq("org_id", orgId)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if ((data?.length ?? 0) !== ids.length) {
      return { ok: false, error: `Only ${data?.length ?? 0} of ${ids.length} items came back. Reload the page to see which.` };
    }
  }
  if (input.cardId) {
    const { data, error } = await supabase
      .from("price_list_vendors")
      .update({ archived: false })
      .eq("id", input.cardId)
      .eq("org_id", orgId)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!data?.length) return { ok: false, error: "The vendor's card didn't come back. Reload the page." };
  }
  revalidatePath("/price-list");
  return {
    ok: true,
    note: steppedDown
      ? `${steppedDown} item${steppedDown === 1 ? " has" : "s have"} another vendor as the default now, so ${input.name} came back as an alternative there.`
      : undefined,
  };
}
