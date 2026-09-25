"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import {
  cleanVendorCard,
  kindCarriesPrices,
  vendorCardRefusal,
  vendorKey,
  type VendorCardClean,
  type VendorCardField,
  type VendorCardInput,
  type VendorKind,
} from "./item-options-math";
import { CARDS_NOT_READY, KINDS_NOT_READY, cardOfVendor, cardsMissing, cardsOf, kindsMissing, optionsOfVendor } from "./vendor-db";

/**
 * VENDORS: YOUR SUPPLIERS, SUBCONTRACTORS AND BRANDS, HOW TO REACH THEM, AND EVERY ITEM THEY ARE ON.
 *
 * Erik for Justin (Vivian Builders), 2026-09-24: "vendor means what brand with its own cost and
 * sell price". The cost and sell live on price_list_item_options (0282), one row per item per
 * vendor. How to reach the vendor lives once per name on price_list_vendors (0296), with its kind
 * (0341): a brand or a supplier can carry prices on items; a subcontractor never does. Andrew's
 * list (2026-09-25) was mostly subcontractors, and 0296's "a vendor is the brand" would have
 * offered Coldwater Drywall as a maker of windows.
 *
 * Every write here is staff-only (requireStaff, then 0296's policies), org-scoped by an explicit
 * org_id filter as well as RLS, reads its rows back (THE SILENT-WRITE LAW), and returns what it
 * replaced so the toast can Undo it. Nothing is ever deleted: archive, with a way back.
 */

export type VendorResult = { ok: boolean; error?: string; note?: string };

const NO_ORG = "Your account isn't attached to a company yet, so there's no price list to change.";

/** Add a vendor with its contact details. Items come after: from the vendor's own sheet, or from
 *  any item's Add Vendor. */
export async function addVendor(input: VendorCardInput): Promise<VendorResult & { name?: string }> {
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
  const subRefusal = subOnItemsRefusal(name, cleaned.clean.kind, onItems);
  if (subRefusal) return { ok: false, error: subRefusal };

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
    if (error) return { ok: false, error: kindsMissing(error) ? KINDS_NOT_READY : vendorCardRefusal(error, name) };
    if (!data?.length) return { ok: false, error: "Nothing was saved. Reload the page and try again." };
    revalidatePath("/price-list");
    return { ok: true, name: String(existing.card.name), note: `${String(existing.card.name)} was archived, so it came back with what you typed.` };
  }

  const { data, error } = await supabase
    .from("price_list_vendors")
    .insert({ ...cleaned.clean, name, created_by: userId })
    .select("id");
  if (error) {
    return { ok: false, error: cardsMissing(error) ? CARDS_NOT_READY : kindsMissing(error) ? KINDS_NOT_READY : vendorCardRefusal(error, name) };
  }
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
  if (input.field === "kind" && value === "subcontractor") {
    const opts = await optionsOfVendor(supabase, orgId, input.name);
    if ("error" in opts) return { ok: false, error: dbError(opts.error) };
    const refusal = subOnItemsRefusal(card ? String(card.name) : input.name, "subcontractor", opts.rows.filter((o) => !o.archived).length);
    if (refusal) return { ok: false, error: refusal };
  }
  const previous = card ? ((card[input.field] as string | null) ?? null) : null;
  if (card) {
    const { data, error } = await supabase
      .from("price_list_vendors")
      .update({ [input.field]: value })
      .eq("id", String(card.id))
      .eq("org_id", orgId)
      .select("id");
    if (error) return { ok: false, error: kindsMissing(error) ? KINDS_NOT_READY : vendorCardRefusal(error, input.name) };
    if (!data?.length) return { ok: false, error: "Nothing was saved. That vendor may have been removed, so reload the page." };
  } else {
    const { data, error } = await supabase
      .from("price_list_vendors")
      .insert({ name: input.name.trim(), [input.field]: value, created_by: userId })
      .select("id");
    if (error) return { ok: false, error: kindsMissing(error) ? KINDS_NOT_READY : vendorCardRefusal(error, input.name) };
    if (!data?.length) return { ok: false, error: "Nothing was saved. Reload the page and try again." };
  }
  revalidatePath("/price-list");
  return { ok: true, previous, name: input.name.trim() };
}

type Db = Extract<Awaited<ReturnType<typeof requireStaff>>, { supabase: unknown }>["supabase"];

/** A subcontractor never carries prices on items. A vendor that already does can't become one
 *  until it's off those items: said by name, with the way out. */
function subOnItemsRefusal(name: string, kind: VendorKind | null | undefined, liveOnItems: number): string | null {
  if (kindCarriesPrices(kind) || liveOnItems === 0) return null;
  return `${name.trim()} has prices on ${liveOnItems} item${liveOnItems === 1 ? "" : "s"}, so it can't be a subcontractor. Keep it a Supplier or Brand, or take it off those items first.`;
}

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

/* ── A WHOLE LIST AT ONCE (vendor import, Phase 1) ─────────────────────────────────────────── */

export type ImportVendorRow = VendorCardInput & { name: string };

export type ImportResult = VendorResult & {
  /** Cards this press created. */
  added?: number;
  /** Archived cards this press brought back, with the stamp each carried when it did, so Undo can
   *  tell a card nobody has touched since from one somebody has. */
  restored?: { id: string; name: string; stamp: string }[];
  /** Rows not added, each with the reason, by name. */
  refused?: { name: string; why: string }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH_MAX = 200;

/**
 * ADD N VENDORS: the ticked rows of an import preview, in one press.
 *
 * Staff only, this org only. Each row goes through cleanVendorCard (the same whitelist and limits
 * as one vendor added by hand). Then, checked HERE against every card the org has, live and
 * archived, whatever the preview said:
 *   · a name that is already a live card is refused by name (the exact one-per-name rule);
 *   · a name on an archived card brings that card back with what the row says (as addVendor does);
 *   · a name twice in this press is added once;
 *   · a subcontractor whose name already has prices on items is refused by name.
 * Every new card goes in ONE insert, stamped with this press's batch id, so it lands whole or not
 * at all, and is read back (THE SILENT-WRITE LAW): the count that landed is the count we say.
 */
export async function addVendorsBatch(rows: ImportVendorRow[], batchId: string): Promise<ImportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  if (!UUID.test(String(batchId ?? ""))) return { ok: false, error: "That import lost its place. Close it and drop the file again." };
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { ok: false, error: "Nothing is ticked, so nothing was added." };
  if (list.length > BATCH_MAX) return { ok: false, error: `That's more than ${BATCH_MAX} vendors at once. Split the list and add it in parts.` };

  const cards = await cardsOf(supabase, orgId);
  if ("error" in cards) return { ok: false, error: cardsMissing(cards.error) ? CARDS_NOT_READY : dbError(cards.error) };
  if (!cards.kinds) return { ok: false, error: KINDS_NOT_READY };
  const byKey = new Map(cards.rows.map((c) => [vendorKey(String(c.name ?? "")), c]));

  const { data: optRows, error: optErr } = await supabase
    .from("price_list_item_options")
    .select("vendor, archived")
    .eq("org_id", orgId)
    .limit(5000);
  if (optErr) return { ok: false, error: dbError(optErr) };
  const liveOnItems = new Map<string, number>();
  for (const o of (optRows ?? []) as { vendor: string; archived: boolean }[]) {
    if (o.archived) continue;
    const k = vendorKey(o.vendor);
    liveOnItems.set(k, (liveOnItems.get(k) ?? 0) + 1);
  }

  const refused: { name: string; why: string }[] = [];
  const inserts: (VendorCardClean & { name: string })[] = [];
  const restores: { id: string; name: string; patch: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const typed = String(raw?.name ?? "").trim() || "A row with no name";
    const cleaned = cleanVendorCard({ ...raw, is_person: raw?.is_person === true }, "create");
    if ("error" in cleaned) {
      refused.push({ name: typed, why: cleaned.error });
      continue;
    }
    const name = String(cleaned.clean.name);
    const key = vendorKey(name);
    if (seen.has(key)) {
      refused.push({ name, why: "It's in this list twice, so it was added once." });
      continue;
    }
    seen.add(key);
    const sub = subOnItemsRefusal(name, cleaned.clean.kind, liveOnItems.get(key) ?? 0);
    if (sub) {
      refused.push({ name, why: sub });
      continue;
    }
    const card = byKey.get(key);
    if (card && !card.archived) {
      refused.push({ name, why: `${String(card.name)} is already on your Vendors list.` });
      continue;
    }
    if (card) {
      const patch: Record<string, unknown> = { archived: false, import_batch: batchId };
      for (const [k, v] of Object.entries(cleaned.clean)) if (v !== null && v !== undefined && k !== "name") patch[k] = v;
      restores.push({ id: String(card.id), name: String(card.name), patch });
      continue;
    }
    inserts.push({ ...cleaned.clean, name });
  }

  let added = 0;
  if (inserts.length) {
    const { data, error } = await supabase
      .from("price_list_vendors")
      .insert(inserts.map((r) => ({ ...r, import_batch: batchId, created_by: userId })))
      .select("id, name");
    if (error) {
      // One insert: a refusal here means none of the new ones landed. Say which name, when it's
      // the one-per-name rule (another tab added it a moment ago).
      const dup = /price_list_vendors_one_per_name/.test(String(error.message ?? ""));
      return {
        ok: false,
        error: dup
          ? "One of these names was added to your Vendors list a moment ago, somewhere else. Nothing was added. Close this and drop the file again."
          : kindsMissing(error)
            ? KINDS_NOT_READY
            : `${dbError(error)} Nothing was added.`,
      };
    }
    added = data?.length ?? 0;
    if (added !== inserts.length) {
      return { ok: false, error: `Only ${added} of ${inserts.length} vendors were saved. Reload the page to see which, before adding again.` };
    }
  }

  const restored: { id: string; name: string; stamp: string }[] = [];
  for (const r of restores) {
    const { data, error } = await supabase
      .from("price_list_vendors")
      .update(r.patch)
      .eq("id", r.id)
      .eq("org_id", orgId)
      .select("id, updated_at");
    if (error || !data?.length) {
      refused.push({ name: r.name, why: `It's archived and couldn't be brought back${error ? ` (${dbError(error)})` : ""}. Open Show Archived and try again.` });
      continue;
    }
    restored.push({ id: r.id, name: r.name, stamp: String((data[0] as { updated_at: string }).updated_at) });
  }

  if (added || restored.length) revalidatePath("/price-list");
  const done = added + restored.length;
  return {
    ok: done > 0,
    error: done > 0 ? undefined : refused.length ? "None of these could be added. The reasons are listed by name." : "Nothing was added.",
    added,
    restored,
    refused,
    note: restored.length
      ? `${restored.length} ${restored.length === 1 ? "was" : "were"} archived and came back: ${restored.map((r) => r.name).join(", ")}.`
      : undefined,
  };
}

/**
 * UNDO AN IMPORT: archive exactly that press's cards, in this org, and ONLY the ones nobody has
 * touched since. A card someone has edited, renamed or put on an item since the import is left
 * alone and named, because Undo is for the import, not for the work done after it.
 *
 * Untouched means: a card this press CREATED still has updated_at = created_at (0296's touch
 * trigger fires on update only); a card this press BROUGHT BACK still carries the stamp the
 * restore gave it. Nothing is deleted: archive, with Show Archived as the way back.
 */
export async function undoVendorImport(input: {
  batchId: string;
  restored?: { id: string; stamp: string }[];
}): Promise<VendorResult & { archived?: number; leftAlone?: string[] }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  if (!UUID.test(String(input?.batchId ?? ""))) return { ok: false, error: "That import can't be found to undo." };
  const stamps = new Map((input.restored ?? []).slice(0, BATCH_MAX).map((r) => [String(r.id), String(r.stamp)]));

  const { data, error } = await supabase
    .from("price_list_vendors")
    .select("id, name, archived, created_at, updated_at")
    .eq("org_id", orgId)
    .eq("import_batch", input.batchId)
    .limit(BATCH_MAX + 1);
  if (error) return { ok: false, error: kindsMissing(error) ? KINDS_NOT_READY : dbError(error) };
  const batch = ((data ?? []) as { id: string; name: string; archived: boolean; created_at: string; updated_at: string }[]).filter((c) => !c.archived);
  if (!batch.length) return { ok: true, archived: 0, leftAlone: [], note: "Nothing from that import is on your list any more." };

  const { data: optRows, error: optErr } = await supabase
    .from("price_list_item_options")
    .select("vendor, archived")
    .eq("org_id", orgId)
    .limit(5000);
  if (optErr) return { ok: false, error: dbError(optErr) };
  const onItems = new Set(((optRows ?? []) as { vendor: string; archived: boolean }[]).filter((o) => !o.archived).map((o) => vendorKey(o.vendor)));

  const untouched = batch.filter((c) => {
    if (onItems.has(vendorKey(c.name))) return false;
    const stamp = stamps.get(c.id);
    return stamp !== undefined ? c.updated_at === stamp : c.updated_at === c.created_at;
  });
  const leftAlone = batch.filter((c) => !untouched.includes(c)).map((c) => c.name);

  let archived = 0;
  if (untouched.length) {
    const ids = untouched.map((c) => c.id);
    const { data: done, error: upErr } = await supabase
      .from("price_list_vendors")
      .update({ archived: true })
      .in("id", ids)
      .eq("org_id", orgId)
      .eq("import_batch", input.batchId)
      .select("id");
    if (upErr) return { ok: false, error: dbError(upErr) };
    archived = done?.length ?? 0;
    if (archived !== ids.length) {
      revalidatePath("/price-list");
      return {
        ok: false,
        archived,
        leftAlone,
        error: `Only ${archived} of ${ids.length} were archived. Reload the page to see which are still there.`,
      };
    }
    revalidatePath("/price-list");
  }
  const bits = [`Archived ${archived} vendor${archived === 1 ? "" : "s"} from that import.`];
  if (leftAlone.length) {
    bits.push(
      `Left alone because ${leftAlone.length === 1 ? "it has" : "they have"} been changed since: ${leftAlone.slice(0, 5).join(", ")}${leftAlone.length > 5 ? ` and ${leftAlone.length - 5} more` : ""}.`,
    );
  }
  return { ok: true, archived, leftAlone, note: bits.join(" ") };
}
