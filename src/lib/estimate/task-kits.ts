import { KIT_ITEM_SELECT_RUNGS, kitsSelectRungs, type KitLineRaw, type KitLinkedItem } from "@/lib/kit-line";
import type { TaskKit } from "./task-lines";
import type { PriceItemOptionRow } from "@/lib/pricing/item-options";

/**
 * TASK KITS, READ (W4, cn-v1076). A kit with `labor_minutes` (0386) is a TASK PER UNIT — "Footing":
 * his minutes for one, his parts for one — and it is what the Inspector's kit picker offers and
 * what the estimate's seed expands (expandTaskKit, task-lines.ts). An ordinary parts kit has no
 * minutes and is never offered to a task.
 *
 * ONE select shape for every page that needs task kits: the kit columns 0386 added, on top of
 * kit-line's shared item rungs, with a last rung without them — a deploy lands before its
 * migration, and naming an absent column fails the whole query rather than degrading.
 */

/** The kit columns a task kit needs (0386). */
export const TASK_KIT_COLS = "id, name, labor_minutes, unit";

/** Select strings, most capable first: with 0386's columns across every item rung, then without. */
export function taskKitSelectRungs(extraKitCols = ""): string[] {
  const full = extraKitCols ? `${TASK_KIT_COLS}, ${extraKitCols}` : TASK_KIT_COLS;
  const bare = extraKitCols ? `id, name, ${extraKitCols}` : "id, name";
  return [...kitsSelectRungs(full), ...kitsSelectRungs(bare)];
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * HOW THE KITS READ WENT (item 3 of the deferred four, 2026-10-10). firstThatWorks hands back the
 * first rung without an error and never says which — so a read that fell to a BARE rung (no 0386
 * columns: no task kit can exist) or failed on every rung emptied the Inspector's kit picker in
 * silence, and a task that had picked a kit then read "Kit No Longer In The Price List", which was
 * false. The read now carries its state, and every page says it in the same words.
 *   ok        the first rung: everything the kits know
 *   thin      a lower item rung won: no vendors and/or no part links — names may be short
 *   pre-0386  a bare rung won: the database has no labor_minutes yet, so there are no task kits
 *   failed    every rung refused (RLS, a timeout, a dropped connection): the LAST error is kept
 */
export type KitsReadState = "ok" | "thin" | "pre-0386" | "failed";

export interface TaskKitsRead {
  /** The task kits as read (empty on pre-0386 and failed). */
  kits: TaskKit[];
  /** The raw rows the winning rung returned (every kit, task or not), for the plain pickers. */
  rows: unknown;
  /** The index of the rung that won, null when none did. */
  rung: number | null;
  state: KitsReadState;
  error?: unknown;
}

/** Read the kits through the tolerant rungs and SAY how it went. `run` builds one query per select
 *  string (`(sel) => sb.from("kits").select(sel).order("name")`), so every page keeps one read and
 *  the rule is testable without a database. */
export async function readTaskKits(
  run: (select: string) => PromiseLike<{ data: unknown; error: unknown }>,
  extraKitCols = "",
): Promise<TaskKitsRead> {
  const rungs = taskKitSelectRungs(extraKitCols);
  let last: { data: unknown; error: unknown } | undefined;
  for (let i = 0; i < rungs.length; i++) {
    const r = await run(rungs[i]);
    if (!r.error) {
      const state: KitsReadState = i === 0 ? "ok" : i < KIT_ITEM_SELECT_RUNGS.length ? "thin" : "pre-0386";
      return { kits: state === "pre-0386" ? [] : taskKitsFrom(r.data), rows: r.data, rung: i, state };
    }
    last = r;
  }
  return { kits: [], rows: null, rung: null, state: "failed", error: last?.error ?? new Error("kits: no rung answered") };
}

/** The one sentence a page says for a read that was not whole — null when it was. */
export function kitsReadWords(state: KitsReadState): string | null {
  switch (state) {
    case "ok":
      return null;
    case "thin":
      return "The kits were read without their vendors or part links — part names may differ from the estimate's.";
    case "pre-0386":
      return "Kits need the database update before a task can pick one.";
    case "failed":
      return "The kits could not be read — a task's kit picker is off until you reload; its own hours stand.";
  }
}

/** Only the kits that are TASKS, coerced. Rows without minutes (ordinary kits, or a database
 *  before 0386) are not task kits, whatever else they carry. */
export function taskKitsFrom(rows: unknown): TaskKit[] {
  if (!Array.isArray(rows)) return [];
  const out: TaskKit[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const minutes = num(o.labor_minutes);
    if (minutes === null || minutes <= 0) continue;
    const id = typeof o.id === "string" ? o.id : "";
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!id || !name) continue;
    const unit = typeof o.unit === "string" && o.unit.trim() ? o.unit.trim() : null;
    out.push({ id, name, labor_minutes: Math.round(minutes), unit, items: Array.isArray(o.kit_items) ? (o.kit_items as KitLineRaw[]) : [] });
  }
  return out;
}

/** A vendor under a code (0282) with its NAMING fields only — vendor, label, part number, unit, the
 *  default flag and the order — and never its buy price or markup. The Inspector's preview names a
 *  kit part through THE SAME expandTaskKit the estimate seeds from, and that names a linked part after
 *  the org's default vendor ("Windows (Allowance) (Marvin, #M-1)"); dropping the vendors wholesale
 *  made the preview fall back to the item's own words and disagree with the estimate and the job's
 *  list (item 2 of the deferred four, 2026-10-10). A vendor's name is not a price: the crew orders by it. */
const optionsWithoutMoney = (raw: KitLinkedItem["price_list_item_options"]): PriceItemOptionRow[] =>
  (raw == null ? [] : Array.isArray(raw) ? raw : [raw])
    .filter((o): o is PriceItemOptionRow => !!o && typeof o === "object" && typeof o.id === "string")
    .map((o) => ({
      id: o.id,
      vendor: o.vendor,
      label: o.label ?? null,
      part_number: o.part_number ?? null,
      unit: o.unit ?? null,
      // The type names buy_price; the money is NOT carried — null is "no price here", which prices at 0 (a hole).
      buy_price: null,
      is_default: o.is_default ?? null,
      sort_order: o.sort_order ?? null,
      archived: o.archived ?? null,
    }));

/** The keys of a linked item that are NOT money: what a line needs to name and size itself. */
const linkedWithoutMoney = (it: KitLinkedItem): KitLinkedItem => ({
  id: it.id,
  code: it.code ?? null,
  archived: it.archived ?? null,
  description: it.description,
  unit: it.unit ?? null,
  qty_per_sqft: it.qty_per_sqft ?? null,
  qty_per_lf: it.qty_per_lf ?? null,
  qty_min: it.qty_min ?? null,
  qty_round: it.qty_round ?? null,
  sized_by: it.sized_by ?? null,
  qty_per: it.qty_per ?? null,
  price_list_item_options: optionsWithoutMoney(it.price_list_item_options),
});

/** The keys of a kit line that are NOT money: what it needs to name, count and size itself. An
 *  ALLOW-list, so a money column added to the select later never rides through unnoticed. */
const lineWithoutMoney = (it: KitLineRaw): KitLineRaw => {
  const linked = Array.isArray(it.price_list_items) ? it.price_list_items[0] : it.price_list_items;
  return {
    ...(it.id !== undefined ? { id: it.id } : {}),
    description: it.description,
    quantity: it.quantity,
    unit: it.unit ?? null,
    sort_order: it.sort_order ?? null,
    qty_per_sqft: it.qty_per_sqft ?? null,
    qty_per_lf: it.qty_per_lf ?? null,
    qty_min: it.qty_min ?? null,
    qty_round: it.qty_round ?? null,
    price_list_item_id: it.price_list_item_id ?? null,
    ...(linked ? { price_list_items: linkedWithoutMoney(linked) } : {}),
  };
};

/** THE SAME KITS WITH EVERY MONEY FIELD DROPPED — what the Inspector is handed. It previews a
 *  kit's hours and parts by name and count and never a price (a crew lead fills the visit in,
 *  0356), so the page sends nothing a price could be read from: no line snapshot price, no item
 *  buy price or markup, no vendor buy price or markup (the vendors' NAMES ride, so the preview
 *  names a part as the estimate will). All three levels are allow-lists. */
export function kitsWithoutMoney(kits: TaskKit[]): TaskKit[] {
  return kits.map((k) => ({ id: k.id, name: k.name, labor_minutes: k.labor_minutes, unit: k.unit, items: k.items.map(lineWithoutMoney) }));
}

/** The ORDINARY kits — everything but the task kits. The plain kit pickers (an estimate's or an
 *  invoice's Add From Kit) drop a kit's lines in as they are, with no hours and no units, so a
 *  task kit offered there would add one unit's parts and lose his hours without a word. */
export function partsKitsOnly<T>(rows: ReadonlyArray<T> | null | undefined): T[] {
  return (rows ?? []).filter((k) => !(Number((k as { labor_minutes?: unknown } | null)?.labor_minutes) > 0));
}
