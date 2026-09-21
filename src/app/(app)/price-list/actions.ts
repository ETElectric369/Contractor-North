"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { searchPaidPrices, type LearnedPrice } from "@/lib/pricing/learned-prices";
import { normalizeUnit } from "@/lib/pricing/units";
import { effectiveMarkupPct, sellPrice } from "@/lib/pricing/markup";
import { lineDisplayName } from "@/lib/kit-line";
import { cleanOptionFields, optionName, optionWriteRefusal, type OptionFieldsInput } from "./item-options-math";

export type Result = { ok: boolean; error?: string; imported?: number };

/** "What I've paid" — real material costs learned from this org's own bills. Staff-only (cost data),
 *  RLS-scoped to the org via the authed client. Returns [] when there's no purchase history. */
export async function searchMyPrices(query: string): Promise<{ ok: boolean; items: LearnedPrice[]; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, items: [], error: ctx.error };
  const items = await searchPaidPrices(ctx.supabase, String(query ?? ""), 40);
  return { ok: true, items };
}

export interface PriceItemInput {
  code?: string | null;
  description?: string;
  category?: string | null;
  supplier?: string | null;
  unit?: string;
  buy_price?: number;
  markup_pct?: number;
  /** 0240 SIZING — the kit magic living on the item. Null clears (a line that used to size itself
   *  must be able to go back to a flat quantity). undefined = untouched. */
  qty_per_sqft?: number | null;
  qty_per_lf?: number | null;
  qty_min?: number | null;
  qty_round?: string | null;
  /** 0241: counted per this walk-through measurement (need key, or area_sqft / length_lf), so many per. */
  sized_by?: string | null;
  qty_per?: number | null;
}

const QTY_ROUND = new Set(["up", "nearest", "none"]);

/** A sizing coefficient: finite and ≥ 0, or null. A negative would silently subtract material. */
function coeff(v: number | null | undefined): number | null | "bad" {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return "bad";
  return n === 0 ? null : n;
}

export async function createPriceItem(input: PriceItemInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.description?.trim()) return { ok: false, error: "Description is required." };
  const { data, error } = await supabase
    .from("price_list_items")
    .insert({
      code: input.code?.trim() || null,
      description: input.description.trim(),
      category: input.category?.trim() || null,
      supplier: input.supplier?.trim() || null,
      unit: normalizeUnit(input.unit),
      buy_price: Number.isFinite(input.buy_price) ? input.buy_price : 0,
      markup_pct: Number.isFinite(input.markup_pct) ? input.markup_pct : 0,
    })
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Nothing was saved." };
  revalidatePath("/price-list");
  return { ok: true };
}

/** Patch one item. Writes ONLY what the caller passed — a computed sell is never stored; the book
 *  holds cost + markup and every surface derives sell through effectiveMarkupPct. */
export async function updatePriceItem(id: string, patch: PriceItemInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const clean: Record<string, unknown> = {};
  if (patch.code !== undefined) clean.code = patch.code?.trim() || null;
  if (patch.description !== undefined) {
    if (!patch.description.trim()) return { ok: false, error: "Description is required." };
    clean.description = patch.description.trim();
  }
  if (patch.category !== undefined) clean.category = patch.category?.trim() || null;
  if (patch.supplier !== undefined) clean.supplier = patch.supplier?.trim() || null;
  if (patch.unit !== undefined) clean.unit = normalizeUnit(patch.unit);
  if (patch.buy_price !== undefined) {
    const n = Number(patch.buy_price);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Cost must be a number, zero or more." };
    clean.buy_price = Math.round(n * 100) / 100;
  }
  if (patch.markup_pct !== undefined) {
    const n = Number(patch.markup_pct);
    if (!Number.isFinite(n)) return { ok: false, error: "Markup must be a number." };
    if (n <= -100) return { ok: false, error: "A markup below -100% would sell for less than nothing." };
    clean.markup_pct = Math.round(n * 100) / 100;
  }
  for (const k of ["qty_per_sqft", "qty_per_lf", "qty_min", "qty_per"] as const) {
    if (patch[k] === undefined) continue;
    const c = coeff(patch[k]);
    if (c === "bad") return { ok: false, error: "Sizing numbers must be zero or more." };
    clean[k] = c;
  }
  if (patch.sized_by !== undefined) {
    const key = (patch.sized_by ?? "").trim();
    if (key.length > 64) return { ok: false, error: "That measurement name is too long." };
    clean.sized_by = key || null;
  }
  if (patch.qty_round !== undefined) {
    const r = patch.qty_round?.trim().toLowerCase() || null;
    if (r !== null && !QTY_ROUND.has(r)) return { ok: false, error: "Rounding must be up, nearest, or none." };
    clean.qty_round = r;
  }
  if (Object.keys(clean).length === 0) return { ok: true };
  // THE SILENT-WRITE LAW: a zero-row UPDATE is a 204. RLS hides a foreign/removed id, so the
  // only way to know the write landed is to ask for the id back.
  const { data, error } = await supabase.from("price_list_items").update(clean).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Nothing was saved — that item may have been removed. Reload the page." };
  revalidatePath("/price-list");
  return { ok: true };
}

/** Archive is the primary verb — the row leaves the book and every picker, but a quote that
 *  priced from it can still find it. Pass archived=false to restore (the toast's Undo). */
export async function archivePriceItem(id: string, archived = true): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data, error } = await supabase.from("price_list_items").update({ archived }).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Nothing changed — that item may have been removed. Reload the page." };
  revalidatePath("/price-list");
  return { ok: true };
}

export async function deletePriceItem(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data, error } = await supabase.from("price_list_items").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Nothing was deleted — that item may already be gone. Reload the page." };
  revalidatePath("/price-list");
  return { ok: true };
}

/* ── THE IMPORTER ──────────────────────────────────────────────────────────────────────────────
   Until cn-v909 this was a plain INSERT: re-importing the CED list every quarter doubled the book,
   and the "Cost Code" sheet (Vivian Builders) landed twice. 0240 made (org, lower(code)) unique,
   so the code is the join key: a row WITH a code refreshes the row that already carries it. A row
   WITHOUT a code matches an existing item by exact normalized description when that is
   unambiguous in the book (the same rule migration 0240's backfill used) — so a sheet with no
   code column re-imports onto itself too. Anything unmatched is new.

   ONLY MAPPED, NON-BLANK COLUMNS TOUCH AN EXISTING ROW — a sheet with no supplier column cannot
   erase the supplier the book already knows, a blank cell in a mapped column is "no news", and
   markup is refreshed only when the CSV actually carried one (a net-cost feed must not flatten
   hand-set markups to 0). New rows fill defaults for whatever the sheet didn't say. ─────────── */

export interface ImportRow {
  code?: string | null;
  description: string;
  category?: string | null;
  supplier?: string | null;
  /** Blank = the sheet said nothing (an existing row keeps its unit; a new one gets "ea"). */
  unit?: string | null;
  /** null/undefined = a blank cell. On an existing row that means "leave it alone" — never 0. */
  buy_price?: number | null;
  markup_pct?: number | null;
  /** A "kit" column groups rows into kits (Erik: "the kit magic lives on the item"). */
  kit?: string | null;
  /** Quantity of this item in that kit; blank = 1. */
  quantity?: number | null;
}

export type ImportField = "code" | "description" | "category" | "supplier" | "unit" | "buy_price" | "markup_pct";

export type ImportResult = {
  ok: boolean;
  error?: string;
  inserted?: number;
  updated?: number;
  /** inserted + updated — the old `Result.imported` shape, kept for any caller still reading it. */
  imported?: number;
  /** Rows skipped for having no description, plus in-file duplicates (last one wins). */
  skipped?: number;
  kits?: number;
  kitLines?: number;
  /** Something non-fatal worth saying in the toast (e.g. kits skipped mid-migration). */
  note?: string;
};

type BookRow = { id: string; code: string | null; description: string; archived?: boolean | null };
type Book = {
  /** lower(code) → item. 0240 makes this unique per org — ARCHIVED rows included, since the index
   *  has no archived predicate, so a coded sheet row can land nowhere else (audit v921). */
  byCode: Map<string, BookRow>;
  /** normalized description → item id, or null when two items share the description (ambiguous). */
  byDesc: Map<string, string | null>;
  /** The matched ids that are archived — the import brings them back rather than refreshing a
   *  row nobody can see (audit v921). */
  archivedIds: Set<string>;
};
type StaffDb = Extract<Awaited<ReturnType<typeof requireStaff>>, { supabase: unknown }>["supabase"];

const normCode = (v: unknown) => String(v ?? "").trim().toLowerCase();
const normDesc = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Every item in the org, keyed both ways. Paged: PostgREST caps a single response, and a
 *  supplier book can run past it. */
async function loadBook(supabase: StaffDb): Promise<Book> {
  const byCode = new Map<string, BookRow>();
  const byDesc = new Map<string, string | null>();
  const archivedIds = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("price_list_items")
      .select("id, code, description, archived")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of (data ?? []) as BookRow[]) {
      const code = normCode(r.code);
      if (code && !byCode.has(code)) byCode.set(code, r);
      if (r.archived) { archivedIds.add(r.id); continue; }
      // Description matching is between ACTIVE rows only (audit v921): an archived twin used to
      // poison the description — byDesc marked it ambiguous — so every re-import of an uncoded
      // sheet inserted the row again as a fresh duplicate.
      const d = normDesc(r.description);
      if (d) byDesc.set(d, byDesc.has(d) ? null : r.id);
    }
    if ((data?.length ?? 0) < PAGE) break;
  }
  return { byCode, byDesc, archivedIds };
}

/** Where a sheet row lands: its de-dup key (code first, else description) and the existing item
 *  it refreshes, if any. null = the row has neither a code nor a description. */
function resolveMatch(book: Book, code: unknown, description: unknown): { key: string; id: string | null } | null {
  const c = normCode(code);
  if (c) return { key: `code:${c}`, id: book.byCode.get(c)?.id ?? null };
  const d = normDesc(description);
  if (!d) return null;
  const hit = book.byDesc.get(d);
  return { key: `desc:${d}`, id: typeof hit === "string" ? hit : null };
}

/** Before the write: how many of these rows already exist in the book, so the button can say
 *  "Update N, Add M" instead of "Import". Never fails loudly — the button falls back to a count. */
export async function previewImportMatches(
  keys: { code?: string | null; description?: string | null }[],
): Promise<{ ok: boolean; existing: number; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, existing: 0, error: ctx.error };
  try {
    const book = await loadBook(ctx.supabase);
    const seen = new Set<string>();
    let existing = 0;
    for (const k of keys ?? []) {
      const m = resolveMatch(book, k?.code, k?.description);
      if (!m || seen.has(m.key)) continue;
      seen.add(m.key);
      if (m.id) existing++;
    }
    return { ok: true, existing };
  } catch (e) {
    return { ok: false, existing: 0, error: dbError(e) };
  }
}

/** A sheet number: null for a blank/garbage cell (Number("") is 0 and Number(null) is 0 — both
 *  would silently write a zero over a real price). */
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Upsert from a parsed CSV. `mapped` = the fields the CSV actually had a column for; those are
 * the only fields an existing row is refreshed on (and only where the cell wasn't blank). Inserts
 * fill defaults for the rest. Rows with a `kit` value are also linked into that kit (found or
 * created by name, org-scoped) as kit_items pointing at the item by price_list_item_id — skipping
 * lines already linked.
 */
export async function bulkImportPriceItems(rows: ImportRow[], mapped: ImportField[] = []): Promise<ImportResult> {
  // requireStaff, like every other write in this file. The DB boundary already holds — 0020's
  // price_list_write policy carries `is_org_staff()` and the stamp_org_price_list trigger sets
  // org_id — so this was never a hole. It was the ONE action here that let a tech through to a
  // raw Postgres RLS message instead of a sentence, and an app guard that disagrees with its own
  // siblings is how the two eventually drift apart.
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const has = (f: ImportField) => mapped.includes(f);

  type Clean = {
    code: string | null;
    description: string;
    category: string | null;
    supplier: string | null;
    /** Normalized; null = blank cell. */
    unit: string | null;
    buy_price: number | null;
    markup_pct: number | null;
    kit: string | null;
    quantity: number;
    /** True when the sheet actually carried a quantity for this row — a blank cell is "no news",
     *  and only a typed number may change a kit line that already exists (audit v921). */
    quantityGiven: boolean;
  };
  let skipped = 0;
  const cleaned: Clean[] = [];
  for (const r of rows ?? []) {
    const description = String(r.description ?? "").trim();
    if (!description) { skipped++; continue; }
    const unitRaw = String(r.unit ?? "").trim();
    const buy = numOrNull(r.buy_price);
    const pct = numOrNull(r.markup_pct);
    const qty = numOrNull(r.quantity);
    cleaned.push({
      code: String(r.code ?? "").trim() || null,
      description,
      category: String(r.category ?? "").trim() || null,
      supplier: String(r.supplier ?? "").trim() || null,
      unit: unitRaw ? normalizeUnit(unitRaw) : null,
      buy_price: buy === null ? null : cents(Math.max(0, buy)),
      markup_pct: pct === null ? null : cents(Math.max(-99.99, pct)),
      kit: String(r.kit ?? "").trim() || null,
      // An EXPLICIT 0 is a template value the kit author meant (kit-picker opens that line
      // unchecked); only a BLANK cell means 1. The old `|| 1` turned the zero into a billed line
      // (audit v921).
      quantity: qty === null ? 1 : Math.max(0, qty),
      quantityGiven: qty !== null,
    });
  }
  if (cleaned.length === 0) return { ok: false, error: "No valid rows found in the file." };

  let book: Book;
  try {
    book = await loadBook(supabase);
  } catch (e) {
    return { ok: false, error: dbError(e) };
  }

  // In-file duplicates: the same code (or, uncoded, the same description) twice would make one
  // INSERT collide with itself, or one upsert touch a row twice. Last wins (a later line is a
  // later price), and the count is reported rather than swallowed.
  const byKey = new Map<string, { row: Clean; id: string | null }>();
  for (const c of cleaned) {
    const m = resolveMatch(book, c.code, c.description)!; // description is guaranteed non-blank
    if (byKey.has(m.key)) skipped++;
    byKey.set(m.key, { row: c, id: m.id });
  }
  const toUpdate: { id: string; row: Clean }[] = [];
  const toInsert: Clean[] = [];
  const claimed = new Set<string>();
  for (const { row, id } of byKey.values()) {
    if (!id) { toInsert.push(row); continue; }
    // A coded row and an uncoded row can resolve to the same item — one refresh per item.
    if (claimed.has(id)) { skipped++; continue; }
    claimed.add(id);
    toUpdate.push({ id, row });
  }

  // itemId per cleaned row, for the kit stage.
  const itemIdOf = new Map<Clean, string>();

  // UPDATES — an upsert keyed on id, so a chunk is one statement instead of 500 round trips. Only
  // mapped, non-blank columns ride in the payload, so everything else is untouched (PostgREST
  // sets exactly the keys it was given). Rows are grouped by the exact key set they carry: a bulk
  // payload must be uniform, or a key missing from one row is sent as NULL for it — which would
  // wipe the very column this is careful not to touch. description is always mapped (the
  // importer refuses to run without it).
  let updated = 0;
  let restored = 0;
  const bySignature = new Map<string, { id: string; row: Clean; payload: Record<string, unknown> }[]>();
  for (const { id, row } of toUpdate) {
    const payload: Record<string, unknown> = { id, description: row.description };
    // The row the sheet matched is ARCHIVED: 0240's unique (org, lower(code)) index has no
    // archived predicate, so a coded row can land nowhere else — refreshing it silently leaves the
    // new price on an item nobody can see (audit v921). We refresh the price but DO NOT un-archive
    // (review blocker): a vendor re-import would resurrect every deliberately-hidden item into
    // every picker and kit, in bulk, with no confirm and no undo — against the no-save-game law.
    // The count is surfaced to the person instead, who can restore the ones they actually want.
    if (has("code") && row.code) payload.code = row.code;
    if (has("category") && row.category) payload.category = row.category;
    if (has("supplier") && row.supplier) payload.supplier = row.supplier;
    if (has("unit") && row.unit) payload.unit = row.unit;
    if (has("buy_price") && row.buy_price !== null) payload.buy_price = row.buy_price;
    if (has("markup_pct") && row.markup_pct !== null) payload.markup_pct = row.markup_pct;
    const sig = Object.keys(payload).sort().join(",");
    if (!bySignature.has(sig)) bySignature.set(sig, []);
    bySignature.get(sig)!.push({ id, row, payload });
  }
  for (const group of bySignature.values()) {
    for (let i = 0; i < group.length; i += 500) {
      const chunk = group.slice(i, i + 500);
      const { data, error } = await supabase
        .from("price_list_items")
        .upsert(chunk.map((c) => c.payload), { onConflict: "id" })
        .select("id");
      if (error) return { ok: false, error: `${dbError(error)} (after ${updated} updated, 0 added)` };
      const wrote = new Set((data ?? []).map((r: { id: string }) => r.id));
      for (const { id, row } of chunk) if (wrote.has(id)) { updated++; itemIdOf.set(row, id); if (book.archivedIds.has(id)) restored++; }
    }
  }

  // INSERTS — returned in payload order, matched back by index (verified by description so a
  // reordered response can't wire a kit line to the wrong item).
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += 500) {
    const chunk = toInsert.slice(i, i + 500);
    const { data, error } = await supabase
      .from("price_list_items")
      .insert(chunk.map((r) => ({
        code: r.code,
        description: r.description,
        category: r.category,
        supplier: r.supplier,
        unit: r.unit ?? "ea",
        buy_price: r.buy_price ?? 0,
        markup_pct: r.markup_pct ?? 0,
      })))
      .select("id, description");
    if (error) return { ok: false, error: `${dbError(error)} (after ${updated} updated, ${inserted} added)` };
    const got = (data ?? []) as { id: string; description: string }[];
    inserted += got.length;
    chunk.forEach((row, idx) => {
      const byIdx = got[idx];
      const hit = byIdx && byIdx.description === row.description ? byIdx : got.find((g) => g.description === row.description);
      if (hit) itemIdOf.set(row, hit.id);
    });
  }

  // KITS — only when the sheet carried a kit column. Tolerant of 0240 not having landed yet:
  // the FK column is the one thing here that can be missing, and a price import must not fail
  // because its kit stage can't run.
  let kits = 0;
  let kitLines = 0;
  let kitQtyUpdated = 0;
  let note: string | undefined;
  const kitRows = cleaned.filter((c) => c.kit && itemIdOf.has(c));
  if (kitRows.length) {
    try {
      const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
      const orgDefaultPct = getOrgSettings((org as { settings?: unknown } | null)?.settings).default_markup_pct;

      // The SNAPSHOT a linked line carries (kit-actions' snapshotOf, same shape): the item's name
      // with its code, normalized unit, and sell through THE rule with the org default. Read back
      // from the book AFTER the writes, so a row that refreshed only some columns still snapshots
      // the whole item, not the half the sheet knew.
      type Snap = { id: string; code: string | null; description: string; unit: string | null; buy_price: number | string | null; markup_pct: number | string | null };
      const snapOf = new Map<string, { description: string; unit: string; unit_price: number }>();
      const ids = [...new Set(kitRows.map((c) => itemIdOf.get(c)!))];
      for (let i = 0; i < ids.length; i += 500) {
        const { data: items, error: sErr } = await supabase
          .from("price_list_items")
          .select("id, code, description, unit, buy_price, markup_pct")
          .in("id", ids.slice(i, i + 500));
        if (sErr) throw sErr;
        for (const it of (items ?? []) as Snap[]) {
          snapOf.set(it.id, {
            description: lineDisplayName(it),
            unit: normalizeUnit(it.unit),
            unit_price: sellPrice(Number(it.buy_price) || 0, effectiveMarkupPct({ itemPct: Number(it.markup_pct) || 0, orgDefaultPct })),
          });
        }
      }

      const { data: existingKits, error: kErr } = await supabase.from("kits").select("id, name");
      if (kErr) throw kErr;
      const kitIdByName = new Map<string, string>();
      for (const k of (existingKits ?? []) as { id: string; name: string }[]) kitIdByName.set(k.name.trim().toLowerCase(), k.id);

      const groups = new Map<string, Clean[]>();
      for (const c of kitRows) {
        const key = c.kit!.toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(c);
      }
      for (const [key, lines] of groups) {
        let kitId = kitIdByName.get(key);
        if (!kitId) {
          const category = lines.map((l) => l.category).find(Boolean) ?? null;
          const { data: made, error } = await supabase.from("kits").insert({ name: lines[0].kit, category }).select("id").single();
          if (error || !made) throw error ?? new Error("Could not create the kit.");
          kitId = made.id as string;
          kitIdByName.set(key, kitId);
          kits++;
        }
        const { data: existingLines, error: lErr } = await supabase
          .from("kit_items")
          .select("price_list_item_id, sort_order")
          .eq("kit_id", kitId);
        if (lErr) throw lErr;
        const linked = new Set((existingLines ?? []).map((l: { price_list_item_id: string | null }) => l.price_list_item_id).filter(Boolean));
        let sort = (existingLines ?? []).reduce((m: number, l: { sort_order: number | null }) => Math.max(m, Number(l.sort_order) || 0), 0);
        // A line already in the kit used to be dropped on the floor: re-importing the same sheet
        // with corrected "Qty in Kit" numbers changed nothing and the toast said nothing about it
        // (audit v921). An EXPLICIT quantity on the sheet now updates the line it belongs to; a
        // blank cell is still "no news" and leaves the kit alone.
        for (const l of lines) {
          const itemId = itemIdOf.get(l)!;
          if (!linked.has(itemId) || !l.quantityGiven) continue;
          const { data: upd, error: uErr } = await supabase
            .from("kit_items")
            .update({ quantity: l.quantity })
            .eq("kit_id", kitId)
            .eq("price_list_item_id", itemId)
            .select("id");
          if (uErr) throw uErr;
          kitQtyUpdated += upd?.length ?? 0;
        }
        const fresh = lines.filter((l) => !linked.has(itemIdOf.get(l)!));
        if (!fresh.length) continue;
        const payload = fresh.map((l) => {
          const itemId = itemIdOf.get(l)!;
          const snap = snapOf.get(itemId) ?? {
            description: l.description,
            unit: l.unit ?? "ea",
            unit_price: sellPrice(l.buy_price ?? 0, effectiveMarkupPct({ itemPct: l.markup_pct, orgDefaultPct })),
          };
          return {
            kit_id: kitId,
            price_list_item_id: itemId,
            // Frozen copies for a line that is later unlinked; while linked, kitLineView derives live.
            ...snap,
            quantity: l.quantity,
            sort_order: ++sort,
          };
        });
        const { data: ins, error: iErr } = await supabase.from("kit_items").insert(payload).select("id");
        if (iErr) throw iErr;
        kitLines += ins?.length ?? 0;
      }
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      note = /column .*price_list_item_id.* does not exist/i.test(msg)
        ? "Kits were skipped — that part of the app is mid-update. Import the sheet again once it lands."
        : `Prices imported, but the kit step stopped: ${dbError(e)}`;
    }
  }

  // What the counts alone can't say (audit v921): items that came back out of the archive, and
  // kit quantities changed on lines that already existed — both invisible in "added N, updated M".
  const extra = [
    // We refreshed the price but left them archived (review blocker) — name them so the person
    // can restore the ones they actually want, instead of a re-import resurrecting the lot.
    restored
      ? `${restored} archived item${restored === 1 ? " was" : "s were"} repriced but stayed archived — restore from Archived if you want ${restored === 1 ? "it" : "them"} back in the book.`
      : null,
    kitQtyUpdated ? `${kitQtyUpdated} kit quantit${kitQtyUpdated === 1 ? "y was" : "ies were"} updated.` : null,
    note,
  ].filter(Boolean);
  revalidatePath("/price-list");
  return { ok: true, inserted, updated, skipped, kits, kitLines, note: extra.length ? extra.join(" ") : undefined, imported: inserted + updated };
}

/**
 * APPLY A SUPPLIER-QUOTE REVIEW — only ever the rows a person ticked.
 *
 * Erik: "some people arent going to want anything to override anything so maybe that should be
 * handled lightly per org or a flag for review." This is the flag-for-review shape: the supplier
 * upload PROPOSES (lib/pricing/book-review sorts lines into updates/additions, matching by exact
 * code or exact normalized description, no fuzzy rung), the review card shows old → new with
 * every tick DEFAULT OFF, and this action receives only what was ticked. Nothing overrides
 * silently, ever. A per-org auto-apply default can sit on top the day an org asks.
 *
 * PROVENANCE RIDES THE `supplier` COLUMN — "CED quote · Aug 15, 2026" — so a price always says
 * where it came from, which is the difference between a book and a pile of numbers.
 */
export async function applyPriceBookReview(
  updates: { itemId: string; newBuy: number }[],
  additions: { description: string; unit: string; newBuy: number }[],
  sourceLabel: string,
): Promise<{ ok: boolean; error?: string; updated?: number; added?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const source = sourceLabel.trim().slice(0, 80) || "supplier quote";

  // Bounded: a review is a human reading rows, not a bulk import — the CSV importer exists for
  // that. 200 covers any real quote and stops a crafted payload rewriting the whole book.
  const ups = updates.slice(0, 200).filter((u) => u.itemId && Number.isFinite(u.newBuy) && u.newBuy >= 0);
  const adds = additions.slice(0, 200).filter((a) => a.description?.trim() && Number.isFinite(a.newBuy) && a.newBuy >= 0);
  if (!ups.length && !adds.length) return { ok: false, error: "Nothing was ticked." };

  let updated = 0;
  for (const u of ups) {
    // Per-row, with the silent-write check — one refused row must not report the whole review
    // applied. RLS scopes the id to this org.
    const { data: wrote, error } = await supabase
      .from("price_list_items")
      .update({ buy_price: Math.round(u.newBuy * 100) / 100, supplier: source })
      .eq("id", u.itemId)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (wrote?.length) updated++;
  }

  let added = 0;
  if (adds.length) {
    const { data: ins, error } = await supabase
      .from("price_list_items")
      .insert(
        adds.map((a) => ({
          description: a.description.trim(),
          unit: normalizeUnit(a.unit),
          buy_price: Math.round(a.newBuy * 100) / 100,
          // markup_pct 0 = the item rung is vacuous, so pricing falls through to customer level →
          // org default — the same ladder every other line rides.
          markup_pct: 0,
          supplier: source,
        })),
      )
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    added = ins?.length ?? 0;
  }

  revalidatePath("/price-list");
  return { ok: true, updated, added };
}

/* ── VENDOR OPTIONS UNDER ONE CODE (0282) ──────────────────────────────────────────────────────
   Andrew, for Justin Vivian: "increase drop down options for each item code / multiple vendors /
   multiple items / ie. windows - mfg Andersen - mfg Milgard - mfg Marvin".

   Code 830 is "Windows (Materials) (Allowance)" at $830.00. The allowance is a placeholder for a
   decision nobody has made, and the decision is WHOSE window. The options live UNDER the code
   rather than the code appearing three times, so 830 still means ONE line on an estimate and the
   twelve places that read the book on "a code names one thing" keep working.

   THE ITEM'S OWN PRICE STAYS THE DEFAULT. An option is what gets used INSTEAD, once somebody picks
   a maker — which is also why nothing here ever writes to price_list_items.

   Archive, never delete: a price he put on a quote last month must not evaporate. There is
   deliberately no deleteItemOption.
   ─────────────────────────────────────────────────────────────────────────────────────────── */

/** Option writes answer in sentences, and sometimes have something extra worth saying out loud
 *  (a default that moved, an item back on its own price) — that is `note`, never a silent side
 *  effect. */
export type OptionResult = { ok: boolean; error?: string; note?: string };

// (StaffDb — the authed, org-scoped client requireStaff hands back — is already declared above.)

const NO_ORG = "Your account isn't attached to a company yet, so there's no price list to change.";

/** Is this item one of ours? RLS would refuse the write anyway, but "that item isn't in your price
 *  list" is an ANSWER and a bare policy refusal is not. Also org-scopes the id explicitly, so a
 *  guessed uuid can never reach a write (defense in depth — RLS stays the boundary). */
async function ownItem(supabase: StaffDb, orgId: string, itemId: string): Promise<{ id: string } | string> {
  if (!itemId) return "No item was named, so there is nothing to add an option to.";
  const { data, error } = await supabase.from("price_list_items").select("id").eq("id", itemId).eq("org_id", orgId).maybeSingle();
  if (error) return dbError(error);
  if (!data) return "That item isn't in your price list any more. Reload the page.";
  return data as { id: string };
}

/** Stand every OTHER option on this item down from default. Returns a sentence on failure, null
 *  on success — and ZERO ROWS IS SUCCESS here, because most items have never had a default. */
async function clearOtherDefaults(supabase: StaffDb, orgId: string, itemId: string, keepId: string | null): Promise<string | null> {
  let q = supabase
    .from("price_list_item_options")
    .update({ is_default: false })
    .eq("item_id", itemId)
    .eq("org_id", orgId)
    .eq("is_default", true)
    .eq("archived", false);
  if (keepId) q = q.neq("id", keepId);
  const { error } = await q.select("id");
  return error ? optionWriteRefusal(error) : null;
}

/** Where a new option sits in the list: after the ones already there. */
async function nextSortOrder(supabase: StaffDb, orgId: string, itemId: string): Promise<number> {
  const { data } = await supabase
    .from("price_list_item_options")
    .select("sort_order")
    .eq("item_id", itemId)
    .eq("org_id", orgId)
    .order("sort_order", { ascending: false })
    .limit(1);
  return (Number((data as { sort_order?: number }[] | null)?.[0]?.sort_order) || 0) + 1;
}

export async function addItemOption(
  input: { itemId: string; isDefault?: boolean } & OptionFieldsInput,
): Promise<OptionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };

  const cleaned = cleanOptionFields(input, "create");
  if ("error" in cleaned) return { ok: false, error: cleaned.error };
  const owned = await ownItem(supabase, orgId, input.itemId);
  if (typeof owned === "string") return { ok: false, error: owned };

  // 0282's one-default index is partial (is_default AND NOT archived), so the sitting default has
  // to step down BEFORE the new row lands — the other order is a guaranteed unique violation.
  if (input.isDefault) {
    const failed = await clearOtherDefaults(supabase, orgId, input.itemId, null);
    if (failed) return { ok: false, error: failed };
  }

  const { data, error } = await supabase
    .from("price_list_item_options")
    .insert({
      item_id: input.itemId,
      ...cleaned.clean,
      is_default: Boolean(input.isDefault),
      sort_order: await nextSortOrder(supabase, orgId, input.itemId),
      created_by: userId,
      // org_id is left to the set_org_id trigger, exactly like every other table in 0270+.
    })
    .select("id");
  if (error) return { ok: false, error: optionWriteRefusal(error, { vendor: input.vendor, label: input.label }) };
  // THE SILENT-WRITE LAW: an insert RLS refused comes back as zero rows, not an error.
  if (!data?.length) return { ok: false, error: "Nothing was saved. Reload the page and try again." };
  revalidatePath("/price-list");
  // The toast already names what was added, so this note says the CONSEQUENCE rather than the name
  // again: the item's own number just stopped being the one that prices it.
  return { ok: true, note: input.isDefault ? "This item prices at it now, instead of its own number." : undefined };
}

/** Patch one option. Writes ONLY what the caller passed, so a change to the part number can never
 *  blank the price. A blank markup stays NULL (fall through), never a 0. */
export async function updateItemOption(
  input: { optionId: string; isDefault?: boolean } & OptionFieldsInput,
): Promise<OptionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };

  const cleaned = cleanOptionFields(input, "update");
  if ("error" in cleaned) return { ok: false, error: cleaned.error };

  const { data: rowData, error: readErr } = await supabase
    .from("price_list_item_options")
    .select("id, item_id, vendor, label, is_default, archived")
    .eq("id", input.optionId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: dbError(readErr) };
  const row = rowData as { id: string; item_id: string; vendor: string; label: string | null; is_default: boolean; archived: boolean } | null;
  if (!row) return { ok: false, error: "That option isn't there any more. Reload the page." };
  if (input.isDefault && row.archived) {
    return { ok: false, error: "Restore this option first. An archived one can't be what the item prices at." };
  }

  const patch: Record<string, unknown> = { ...cleaned.clean };
  if (input.isDefault !== undefined) patch.is_default = Boolean(input.isDefault);
  if (Object.keys(patch).length === 0) return { ok: true };

  if (input.isDefault) {
    const failed = await clearOtherDefaults(supabase, orgId, row.item_id, row.id);
    if (failed) return { ok: false, error: failed };
  }

  // The refusal sentence has to name what he JUST typed, not what the row used to say — including
  // a label he deliberately cleared, which `??` would have quietly put back.
  const named = {
    vendor: "vendor" in patch ? (patch.vendor as string) : row.vendor,
    label: "label" in patch ? (patch.label as string | null) : row.label,
  };
  const { data, error } = await supabase
    .from("price_list_item_options")
    .update(patch)
    .eq("id", input.optionId)
    .eq("org_id", orgId)
    .select("id");
  if (error) return { ok: false, error: optionWriteRefusal(error, named) };
  if (!data?.length) return { ok: false, error: "Nothing was saved. That option may have been removed, so reload the page." };
  revalidatePath("/price-list");
  // What PRICES this item is the one thing on this form that moves money, so it is said out loud
  // when it MOVES — both directions, and never when the box was simply left where it was.
  const promoted = input.isDefault === true && !row.is_default;
  const demoted = input.isDefault === false && row.is_default;
  return {
    ok: true,
    note: promoted
      ? `${optionName(named)} is now what this item prices at.`
      : demoted
        ? "This item is priced at its own number again."
        : undefined,
  };
}

/**
 * ARCHIVE, NOT DELETE — a price he used on a quote last month must still be findable. Pass
 * archived=false to bring it back (the toast's Undo, and the Restore button on the archived list).
 */
export async function archiveItemOption(optionId: string, archived = true): Promise<OptionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };

  const { data: rowData, error: readErr } = await supabase
    .from("price_list_item_options")
    .select("id, item_id, vendor, label, is_default")
    .eq("id", optionId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: dbError(readErr) };
  const row = rowData as { id: string; item_id: string; vendor: string; label: string | null; is_default: boolean } | null;
  if (!row) return { ok: false, error: "That option isn't there any more. Reload the page." };

  const patch: Record<string, unknown> = { archived };
  let note: string | undefined;
  if (archived && row.is_default) {
    // Archiving the default doesn't break the partial index, but it DOES change what the item
    // prices at — and a price that moves without a sentence is the silent write this app bans.
    note = "That was the default, so this item is back to its own price.";
  }
  if (!archived && row.is_default) {
    // It went into the archive as the default and something else has taken the seat since.
    // Bringing it back as default would break 0282's one-default index, so the RETURNING row steps
    // down (never the one currently in use) and the toast says which one still holds it.
    const { data: sitting } = await supabase
      .from("price_list_item_options")
      .select("vendor, label")
      .eq("item_id", row.item_id)
      .eq("org_id", orgId)
      .eq("is_default", true)
      .eq("archived", false)
      .neq("id", optionId)
      .limit(1);
    const held = (sitting as { vendor: string; label: string | null }[] | null)?.[0];
    if (held) {
      patch.is_default = false;
      note = `${optionName(held)} is still the default, so this one came back as an alternative.`;
    }
  }

  const { data, error } = await supabase
    .from("price_list_item_options")
    .update(patch)
    .eq("id", optionId)
    .eq("org_id", orgId)
    .select("id");
  if (error) return { ok: false, error: optionWriteRefusal(error, row) };
  if (!data?.length) return { ok: false, error: "Nothing changed. That option may have been removed, so reload the page." };
  revalidatePath("/price-list");
  return { ok: true, note };
}

/**
 * WHICH OPTION THIS ITEM PRICES AT. `optionId: null` hands the item back to its own allowance
 * price, which is where every item starts and where most of them stay.
 *
 * Two statements, and they have to be in this order: 0282's one-default index is a real database
 * rule, so the sitting default steps down first and the new one sits down second. There is a
 * blink where the item has no default; if the second statement fails, the refusal says reload,
 * and reloading shows the truth (the item on its own price) rather than a lie.
 */
export async function setDefaultItemOption(input: { itemId: string; optionId: string | null }): Promise<OptionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };

  const owned = await ownItem(supabase, orgId, input.itemId);
  if (typeof owned === "string") return { ok: false, error: owned };

  const failed = await clearOtherDefaults(supabase, orgId, input.itemId, input.optionId);
  if (failed) return { ok: false, error: failed };

  if (!input.optionId) {
    revalidatePath("/price-list");
    return { ok: true, note: "This item is priced at its own number again." };
  }

  const { data, error } = await supabase
    .from("price_list_item_options")
    .update({ is_default: true })
    .eq("id", input.optionId)
    .eq("item_id", input.itemId)
    .eq("org_id", orgId)
    .eq("archived", false)
    .select("id, vendor, label");
  if (error) return { ok: false, error: optionWriteRefusal(error) };
  if (!data?.length) {
    return { ok: false, error: "That option isn't there any more, or it's archived. Reload the page and pick again." };
  }
  revalidatePath("/price-list");
  const picked = (data as { vendor: string; label: string | null }[])[0];
  return { ok: true, note: `${optionName(picked)} is now what this item prices at.` };
}
