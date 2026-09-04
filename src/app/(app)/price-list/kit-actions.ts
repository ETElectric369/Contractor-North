"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { effectiveMarkupPct, sellPrice } from "@/lib/pricing/markup";
import { normalizeUnit } from "@/lib/pricing/units";
import { firstThatWorks, lineDisplayName, type KitSizing } from "@/lib/kit-line";

export type Result = { ok: boolean; error?: string; id?: string };

export type KitImportRow = {
  kit: string;
  category?: string;
  /** 0240: a code that matches the org's book links the line to the item. */
  code?: string;
  description: string;
  quantity?: string;
  unit?: string;
  unit_price?: string;
};

/* ── 0240 PLUMBING ────────────────────────────────────────────────────────────────────────────
   A kit line may POINT at a price-list item. The line still carries description/unit/unit_price,
   but on a linked line they are a SNAPSHOT — refreshed whenever the link is made or broken, so an
   older client or a line whose item vanishes still renders — never the source of truth. Readers
   go through kitLineView, which ignores the snapshot while the link holds.

   Every read of a 0240 column is tolerant (retry without it): the deploy lands before the
   migration. Every WRITE that needs the column falls back to a frozen line and SAYS so in the
   Result — never a silent downgrade. */

type Db = Awaited<ReturnType<typeof requireStaff>> extends infer R ? (R extends { supabase: infer S } ? S : never) : never;

type BookItem = {
  id: string;
  code: string | null;
  description: string;
  unit: string | null;
  buy_price: number | string | null;
  markup_pct: number | string | null;
  qty_per_sqft?: number | string | null;
  qty_per_lf?: number | string | null;
  qty_min?: number | string | null;
  qty_round?: string | null;
};

type LineRow = {
  id: string;
  kit_id: string;
  description: string;
  unit: string | null;
  unit_price: number | string | null;
  quantity: number | string | null;
  price_list_item_id?: string | null;
  qty_per_sqft?: number | string | null;
  qty_per_lf?: number | string | null;
  qty_min?: number | string | null;
  qty_round?: string | null;
};

/** "That column isn't there yet" — PostgREST phrases it three ways depending on the verb. */
const missingColumn = (e: { message?: string } | null | undefined) =>
  /does not exist|schema cache|could not find/i.test(e?.message ?? "");

const finite = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** An item from the org's book (RLS-scoped). Sizing columns requested first, retried without. */
async function loadBookItem(supabase: Db, id: string): Promise<BookItem | null> {
  const base = "id, code, description, unit, buy_price, markup_pct";
  const r = await firstThatWorks(
    [`${base}, qty_per_sqft, qty_per_lf, qty_min, qty_round`, base].map(
      (cols) => () => supabase.from("price_list_items").select(cols).eq("id", id).eq("archived", false).maybeSingle(),
    ),
  );
  return (r.data as BookItem | null) ?? null;
}

/** One kit line with its link + sizing, tolerant of both migrations being absent. */
async function loadLine(supabase: Db, id: string): Promise<LineRow | null> {
  const base = "id, kit_id, description, unit, unit_price, quantity";
  const sizing = "qty_per_sqft, qty_per_lf, qty_min, qty_round";
  const r = await firstThatWorks(
    [`${base}, ${sizing}, price_list_item_id`, `${base}, ${sizing}`, base].map(
      (cols) => () => supabase.from("kit_items").select(cols).eq("id", id).maybeSingle(),
    ),
  );
  return (r.data as LineRow | null) ?? null;
}

async function orgDefaultMarkup(supabase: Db): Promise<number> {
  const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  return getOrgSettings((data as { settings?: unknown } | null)?.settings).default_markup_pct;
}

/** The snapshot a linked line carries: the item's name (with code), normalized unit, and sell
 *  through THE rule with the org default — no customer level, a kit is authored for nobody in
 *  particular. Equal to what kitLineView shows at the moment it is written. */
function snapshotOf(item: BookItem, orgDefaultPct: number) {
  return {
    description: lineDisplayName(item),
    unit: normalizeUnit(item.unit),
    unit_price: sellPrice(finite(item.buy_price) ?? 0, effectiveMarkupPct({ itemPct: finite(item.markup_pct), orgDefaultPct })),
  };
}

const hasSizing = (s: { qty_per_sqft?: unknown; qty_per_lf?: unknown; qty_min?: unknown; qty_round?: unknown }) =>
  finite(s.qty_per_sqft) !== null || finite(s.qty_per_lf) !== null || finite(s.qty_min) !== null || !!s.qty_round;

const sizingOfRow = (s: { qty_per_sqft?: unknown; qty_per_lf?: unknown; qty_min?: unknown; qty_round?: unknown }): KitSizing => ({
  qty_per_sqft: finite(s.qty_per_sqft),
  qty_per_lf: finite(s.qty_per_lf),
  qty_min: finite(s.qty_min),
  qty_round: typeof s.qty_round === "string" && s.qty_round ? s.qty_round : null,
});

/** Validate + shape a sizing patch for either table. `undefined` = leave alone; null/"" = clear. */
function sizingPatch(sizing: Partial<KitSizing>): { patch: Record<string, unknown>; error?: string } {
  const patch: Record<string, unknown> = {};
  for (const k of ["qty_per_sqft", "qty_per_lf", "qty_min"] as const) {
    if (sizing[k] === undefined) continue;
    const n = finite(sizing[k]);
    if (n !== null && n < 0) return { patch, error: "A sizing number can't be negative." };
    patch[k] = n && n > 0 ? n : null;
  }
  if (sizing.qty_round !== undefined) {
    const r = sizing.qty_round || null;
    if (r !== null && !["up", "nearest", "none"].includes(r)) return { patch, error: "Rounding must be up, nearest or none." };
    patch.qty_round = r;
  }
  return { patch };
}

/** Bulk-import kits (preset line-item bundles) from a CSV. Each row is ONE line item with a `kit`
 *  column that groups rows into kits — so an office can build "Deck Package A" etc. in a spreadsheet
 *  and import them instead of hand-entering each. Staff-gated; org_id is stamped by the set_org_id
 *  trigger (same as createKit). One bad kit's items are skipped, not the whole import.
 *
 *  0240: a row whose `code` (or the CODE in a "CODE — description" name) matches the org's book,
 *  case-insensitively, is LINKED to that item — it prices live from then on. Rows with no match
 *  land frozen, exactly as before. */
export async function bulkImportKits(
  rows: KitImportRow[],
): Promise<Result & { kits?: number; items?: number; skipped?: number; linked?: number; linkPending?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // Group by kit name (in order), skipping rows missing a kit name or a description.
  const groups = new Map<string, KitImportRow[]>();
  let skipped = 0;
  for (const r of rows ?? []) {
    const kit = (r.kit ?? "").trim();
    const desc = (r.description ?? "").trim();
    if (!kit || !desc) { skipped++; continue; }
    const arr = groups.get(kit) ?? [];
    arr.push(r);
    groups.set(kit, arr);
  }
  if (groups.size === 0) return { ok: false, error: "No valid rows — need a 'kit' name and a 'description' per row." };

  // The org's book, keyed by lower-cased code (0240 made code unique per org, so this is a join).
  const { data: book } = await supabase
    .from("price_list_items")
    .select("id, code, description, unit, buy_price, markup_pct")
    .eq("archived", false)
    .not("code", "is", null)
    .limit(5000);
  const byCode = new Map<string, BookItem>();
  for (const b of (book ?? []) as BookItem[]) {
    const k = String(b.code ?? "").trim().toLowerCase();
    if (k && !byCode.has(k)) byCode.set(k, b);
  }
  const orgDefaultPct = byCode.size ? await orgDefaultMarkup(supabase) : 0;
  const codeOf = (r: KitImportRow) => {
    const explicit = (r.code ?? "").trim();
    if (explicit) return explicit;
    // The pre-0240 naming convention: "CODE — description" (same rule migration 0240 backfilled by).
    const m = r.description.match(/^(.+?)\s+—\s+/);
    return m ? m[1].trim() : "";
  };

  const num = (v: string | undefined, dflt: number) => {
    const s = (v ?? "").replace(/[$,]/g, "").trim();
    if (!s) return dflt; // blank → default (Number("") is 0, which would wrongly skip the default)
    const n = Number(s);
    return Number.isFinite(n) ? n : dflt;
  };
  let kitsCreated = 0;
  let itemsCreated = 0;
  let linked = 0;
  let linkPending = false;
  for (const [name, items] of groups) {
    const category = items.map((i) => (i.category ?? "").trim()).find(Boolean) || null;
    const { data: kit, error: kErr } = await supabase.from("kits").insert({ name, category }).select("id").single();
    if (kErr || !kit) { skipped += items.length; continue; }
    kitsCreated++;
    const itemRows = items.map((it, idx) => {
      const code = codeOf(it).toLowerCase();
      const match = code ? byCode.get(code) : undefined;
      const quantity = Math.max(0, num(it.quantity, 1));
      if (match) {
        return { kit_id: kit.id, ...snapshotOf(match, orgDefaultPct), quantity, sort_order: idx, price_list_item_id: match.id as string | undefined };
      }
      return {
        kit_id: kit.id,
        description: it.description.trim(),
        quantity,
        unit: normalizeUnit(it.unit),
        unit_price: Math.max(0, num(it.unit_price, 0)),
        sort_order: idx,
        price_list_item_id: undefined as string | undefined,
      };
    });
    const wantsLink = itemRows.some((r) => r.price_list_item_id);
    let ins = await supabase.from("kit_items").insert(itemRows).select("id");
    if (ins.error && wantsLink && missingColumn(ins.error)) {
      // 0240 hasn't landed: import the lines frozen and say so, rather than losing the kit.
      linkPending = true;
      ins = await supabase.from("kit_items").insert(itemRows.map(({ price_list_item_id: _l, ...r }) => r)).select("id");
    }
    if (ins.error) { skipped += itemRows.length; continue; }
    itemsCreated += ins.data?.length ?? itemRows.length;
    if (!linkPending) linked += itemRows.filter((r) => r.price_list_item_id).length;
  }
  revalidatePath("/price-list");
  return { ok: true, kits: kitsCreated, items: itemsCreated, skipped, linked, linkPending };
}

export async function createKit(input: { name: string; category?: string | null }): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  const { data, error } = await supabase
    .from("kits")
    .insert({ name: input.name.trim(), category: input.category?.trim() || null })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/price-list");
  return { ok: true, id: data.id };
}

export async function updateKit(
  id: string,
  input: { name: string; category?: string | null },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  // Org-safe: RLS scopes the row to the caller's org; .select("id") after the write catches the
  // zero-row 204 a hidden/foreign id would otherwise turn into a silent "saved".
  const { data, error } = await supabase
    .from("kits")
    .update({ name: input.name.trim(), category: input.category?.trim() || null })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Kit not found." };
  revalidatePath("/price-list");
  return { ok: true };
}

export async function deleteKit(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data, error } = await ctx.supabase.from("kits").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Kit not found — it may already be gone." };
  revalidatePath("/price-list");
  return { ok: true };
}

/** Add a line to a kit. With `price_list_item_id` the line is LINKED: it stores the pointer plus
 *  quantity/sort, and the item's name/unit/sell are copied on as a snapshot (for an older client
 *  or a broken link) — never as the source of truth. Without it, a hand-typed frozen line, as
 *  before. `linked` in the Result says which one actually happened. */
export async function addKitItem(input: {
  kit_id: string;
  price_list_item_id?: string | null;
  description?: string;
  quantity?: number;
  unit?: string;
  unit_price?: number;
  sort_order?: number;
}): Promise<Result & { linked?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Org-safe: RLS scopes the kit to the caller's org; confirm it's visible before
  // inserting so a hidden/foreign kit_id can't be written into.
  const { data: kit } = await supabase.from("kits").select("id").eq("id", input.kit_id).maybeSingle();
  if (!kit) return { ok: false, error: "Kit not found." };

  let snapshot: { description: string; unit: string; unit_price: number };
  let linkId: string | null = null;
  if (input.price_list_item_id) {
    const item = await loadBookItem(supabase, input.price_list_item_id);
    if (!item) return { ok: false, error: "That price-list item isn't in your book (or is archived)." };
    snapshot = snapshotOf(item, await orgDefaultMarkup(supabase));
    linkId = item.id;
  } else {
    if (!input.description?.trim()) return { ok: false, error: "Description is required." };
    const price = typeof input.unit_price === "number" && Number.isFinite(input.unit_price) ? Math.max(0, input.unit_price) : 0;
    snapshot = { description: input.description.trim(), unit: normalizeUnit(input.unit), unit_price: price };
  }

  // Same clamp as updateKitItems — a NaN/negative from a direct caller must not land
  // in a kit template (every future estimate would inherit it).
  const qty = typeof input.quantity === "number" && Number.isFinite(input.quantity) ? Math.max(0, input.quantity) : 1;
  let sort_order = input.sort_order;
  if (typeof sort_order !== "number" || !Number.isFinite(sort_order)) {
    // New items land at the END of the kit — max existing sort_order + 1 (legacy rows
    // all default 0, so appends stay after them and keep a stable authored order).
    const { data: last } = await supabase
      .from("kit_items")
      .select("sort_order")
      .eq("kit_id", input.kit_id)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    sort_order = (Number(last?.sort_order) || 0) + 1;
  }
  const row = { kit_id: input.kit_id, ...snapshot, quantity: qty, sort_order };

  if (linkId) {
    const r = await supabase.from("kit_items").insert({ ...row, price_list_item_id: linkId }).select("id").single();
    if (!r.error && r.data) {
      revalidatePath("/price-list");
      return { ok: true, id: r.data.id, linked: true };
    }
    if (!missingColumn(r.error)) return { ok: false, error: dbError(r.error) };
    // 0240 hasn't landed — add the frozen snapshot and SAY so (linked: false), not a silent downgrade.
  }
  const { data, error } = await supabase.from("kit_items").insert(row).select("id").single();
  if (error || !data) return { ok: false, error: dbError(error ?? "Could not add the line.") };
  revalidatePath("/price-list");
  return { ok: true, id: data.id, linked: false };
}

/** Point a kit line at a price-list item (or, with null, cut the link).
 *  LINK: the snapshot is refreshed from the item, and the line's sizing rule moves onto the item
 *  when the item has none (mirrors 0240's backfill (c)) — linking never loses a rule someone typed.
 *  UNLINK: the line freezes at what it showed a second ago — the snapshot is refreshed from the
 *  item FIRST, so the frozen values are today's, not the day it was linked — and the item's sizing
 *  copies back onto the line if the line has none. */
export async function linkKitItem(kitItemId: string, priceListItemId: string | null): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const line = await loadLine(supabase, kitItemId);
  if (!line) return { ok: false, error: "Line item not found." };

  if (priceListItemId) {
    const item = await loadBookItem(supabase, priceListItemId);
    if (!item) return { ok: false, error: "That price-list item isn't in your book (or is archived)." };
    const snap = snapshotOf(item, await orgDefaultMarkup(supabase));
    const { data, error } = await supabase
      .from("kit_items")
      .update({ price_list_item_id: item.id, ...snap })
      .eq("id", kitItemId)
      .select("id");
    if (error) {
      if (missingColumn(error)) return { ok: false, error: "Linking to the book arrives with the next update — try again in a minute." };
      return { ok: false, error: dbError(error) };
    }
    if (!data?.length) return { ok: false, error: "Line item not found." };
    if (hasSizing(line) && !hasSizing(item)) {
      const moved = await setItemSizing(item.id, sizingOfRow(line));
      if (!moved.ok) return { ok: false, error: `Linked, but the sizing rule didn't move onto the item: ${moved.error}` };
    }
  } else {
    const patch: Record<string, unknown> = { price_list_item_id: null };
    if (line.price_list_item_id) {
      const item = await loadBookItem(supabase, line.price_list_item_id);
      if (item) {
        Object.assign(patch, snapshotOf(item, await orgDefaultMarkup(supabase)));
        if (hasSizing(item) && !hasSizing(line)) Object.assign(patch, sizingOfRow(item));
      }
    }
    const { data, error } = await supabase.from("kit_items").update(patch).eq("id", kitItemId).select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!data?.length) return { ok: false, error: "Line item not found." };
  }
  revalidatePath("/price-list");
  return { ok: true };
}

/** The sizing rule ON THE ITEM (0240) — where a linked line's coefficients live. Every kit that
 *  links the item sizes the same way; an edit lands once. Blank/0 clears a coefficient. */
export async function setItemSizing(priceListItemId: string, sizing: Partial<KitSizing>): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { patch, error: vErr } = sizingPatch(sizing);
  if (vErr) return { ok: false, error: vErr };
  if (Object.keys(patch).length === 0) return { ok: true, id: priceListItemId };
  const { data, error } = await supabase.from("price_list_items").update(patch).eq("id", priceListItemId).select("id");
  if (error) {
    if (missingColumn(error)) return { ok: false, error: "Sizing on price-list items arrives with the next update — try again in a minute." };
    return { ok: false, error: dbError(error) };
  }
  if (!data?.length) return { ok: false, error: "Price-list item not found." };
  revalidatePath("/price-list");
  return { ok: true, id: priceListItemId };
}

/** Batch-write the Kit Picker's row edits back onto the kit itself — the explicit
 *  "Save changes to kit" path (never silent; import edits alone stay quote-only).
 *  Only ids that actually belong to this kit are touched, so a forged/foreign id in
 *  the payload is skipped rather than upserted into existence. Deleting kit items
 *  stays in Price list & kits. A LINKED line takes only its quantity from here — its
 *  name/unit/price are the item's. */
export async function updateKitItems(
  kitId: string,
  edits: { id: string; description: string; quantity: number; unit: string; unit_price: number }[],
): Promise<Result & { updated?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Org-safe: RLS scopes the kit to the caller's org; confirm it's visible before mutating.
  const { data: kit } = await supabase.from("kits").select("id").eq("id", kitId).maybeSingle();
  if (!kit) return { ok: false, error: "Kit not found." };
  const owned = await firstThatWorks(
    ["id, price_list_item_id", "id"].map((cols) => () => supabase.from("kit_items").select(cols).eq("kit_id", kitId)),
  );
  const linkedOf = new Map<string, boolean>();
  for (const r of ((owned.data ?? []) as unknown) as { id: string; price_list_item_id?: string | null }[]) linkedOf.set(r.id, !!r.price_list_item_id);
  let updated = 0;
  for (const e of edits ?? []) {
    if (!linkedOf.has(e.id)) continue;
    const quantity = Number.isFinite(e.quantity) ? Math.max(0, e.quantity) : 1;
    if (!linkedOf.get(e.id) && !e.description.trim()) continue;
    const patch = linkedOf.get(e.id)
      ? { quantity }
      : {
          description: e.description.trim(),
          quantity,
          unit: normalizeUnit(e.unit),
          unit_price: Number.isFinite(e.unit_price) ? Math.max(0, e.unit_price) : 0,
        };
    const { data, error } = await supabase.from("kit_items").update(patch).eq("id", e.id).select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (data?.length) updated++;
  }
  revalidatePath("/price-list");
  return { ok: true, updated };
}

/** Edit one kit line. On a LINKED line only the quantity is the line's to change — name, unit,
 *  price and sizing are the item's (use setItemSizing / the price list). On a frozen line
 *  everything is, as before. */
export async function updateKitItem(
  id: string,
  input: {
    description?: string;
    quantity?: number;
    unit?: string;
    unit_price?: number;
    /** 0166 SIZING. Null clears it — a line that used to size itself and now shouldn't must be
     *  able to go back to a flat quantity, so these are written even when blank. */
    qty_per_sqft?: number | null;
    qty_per_lf?: number | null;
    qty_min?: number | null;
    qty_round?: string | null;
  },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Org-safe: RLS scopes the row to the caller's org; confirm it's visible
  // before mutating so a hidden/foreign id can't be silently updated.
  const line = await loadLine(supabase, id);
  if (!line) return { ok: false, error: "Line item not found." };
  const quantity = typeof input.quantity === "number" && Number.isFinite(input.quantity) ? Math.max(0, input.quantity) : 1;

  let patch: Record<string, unknown>;
  if (line.price_list_item_id) {
    patch = { quantity };
  } else {
    if (!input.description?.trim()) return { ok: false, error: "Description is required." };
    const { patch: sizing, error: sErr } = sizingPatch(input);
    if (sErr) return { ok: false, error: sErr };
    patch = {
      description: input.description.trim(),
      quantity,
      unit: normalizeUnit(input.unit),
      unit_price: typeof input.unit_price === "number" && Number.isFinite(input.unit_price) ? Math.max(0, input.unit_price) : 0,
      ...sizing,
    };
  }
  const { data, error } = await supabase.from("kit_items").update(patch).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Line item not found." };
  revalidatePath("/price-list");
  return { ok: true };
}

export async function deleteKitItem(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data, error } = await ctx.supabase.from("kit_items").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Line item not found — it may already be gone." };
  revalidatePath("/price-list");
  return { ok: true };
}
