import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import type { TaskDetail } from "./line-map";

/**
 * REMEMBER A PRICED TASK AS A KIT (W4, cn-v1076). Erik (2026-10-09, his fourth answer): a task he
 * has priced once — his hours, his parts — should be remembered, so the next visit's Inspector
 * offers it by name and he types a count instead of the whole thing again.
 *
 * The kit is PER UNIT (0386: kits.labor_minutes for ONE unit, kits.unit = his word for it). A task
 * line carries TOTAL hours and TOTAL counts for ×N units, so the kit divides by N: "Footings ×7,
 * 14 h, 28 bags" → "Footing: 120 minutes, 4 bags". A task without units is one unit of itself.
 *
 * NO SPECULATION ([[no-speculation]]): a kit that would have to guess is refused with the ONE
 * action that would let it be made — the hours he hasn't given, the part he hasn't counted. A
 * part with no count is never a silent 1 (expandTaskKit treats a missing quantity as one, so a
 * missing count would quietly become one per unit on every future task).
 *
 * Pure rule + one database rule taking the client it is given (the server action is a wrapper).
 */

export const MAX_KIT_NAME = 120;
export const MAX_KIT_UNIT = 40;

export interface KitFromTaskItem {
  code: string | null;
  description: string;
  /** Per ONE unit of the kit (the task's count ÷ its units), to the cent. */
  quantity: number;
  unit: string;
  /** A hand-typed part keeps the sell he typed; a coded part carries 0 — it prices LIVE from the
   *  book when the code links (0240), and an orphaned code asks ("price?") rather than carrying
   *  one customer's marked-up number into every other customer's estimate. */
  unit_price: number;
  sort_order: number;
  /** Exact arithmetic on the way back out (kitQty): a per-unit count × the units is the count he
   *  gave, to the cent, never rounded up to the next whole one. */
  qty_round: "none";
}

export interface KitFromTask {
  kit: { name: string; unit: string; labor_minutes: number };
  items: KitFromTaskItem[];
}

export type KitFromTaskResult = { ok: true; value: KitFromTask } | { ok: false; error: string };

const round2 = (n: number): number => Math.round(n * 100) / 100;
const refuse = (error: string): KitFromTaskResult => ({ ok: false, error });

/** The task's name without the units the line's description carries ("Footings ×7" → "Footings"). */
export function kitNameFromLine(description: string): string {
  return description
    .replace(/\s*×\s*\d+(?:[.,]\d+)?\s*$/u, "")
    .trim()
    .slice(0, MAX_KIT_NAME);
}

export function kitFromTaskDetail(detail: TaskDetail, input: { name: string; unit: string }): KitFromTaskResult {
  const name = (typeof input.name === "string" ? input.name : "").trim().slice(0, MAX_KIT_NAME);
  if (!name) return refuse("Give the kit a name.");
  const unit = (typeof input.unit === "string" ? input.unit : "").trim().slice(0, MAX_KIT_UNIT) || "ea";
  const hours = detail.hours;
  if (hours === null || !(hours > 0)) return refuse("Give the task its hours first — a kit remembers your hours per unit.");
  const units = detail.units !== null && detail.units > 0 ? detail.units : 1;
  // THE ROUND TRIP MUST HOLD (the skeptic's probe): the kit stores whole minutes per unit and
  // counts to the cent, and the next task multiplies them back. What would come back different
  // from what he gave is refused, not rounded — 1 h across 100 units is not "1 minute each".
  const labor_minutes = Math.round((hours * 60) / units);
  if (labor_minutes < 1) return refuse("The hours come to less than a minute per unit — give the task more hours.");
  const hoursBack = (labor_minutes * units) / 60;
  if (Math.abs(hoursBack - hours) > hours * 0.02) {
    return refuse(`${hours} h does not split into whole minutes across ${units} — give the task hours that do.`);
  }

  const named = detail.materials.filter((m) => m.name.trim());
  const uncounted = named.filter((m) => m.qty === null || !(m.qty > 0));
  if (uncounted.length) return refuse(`Give every part a count first: ${uncounted.map((m) => m.name.trim()).join(", ")}.`);

  const items: KitFromTaskItem[] = [];
  for (const m of named) {
    const qty = m.qty as number;
    const quantity = round2(qty / units);
    if (quantity <= 0 || round2(quantity * units) !== round2(qty)) {
      return refuse(`${m.name.trim()}: ${qty} does not split evenly across ${units} — give it a count that does.`);
    }
    items.push({
      code: m.code,
      description: m.name.trim(),
      quantity,
      unit: "ea",
      unit_price: m.code ? 0 : m.sell !== null && m.sell > 0 ? round2(m.sell) : 0,
      sort_order: items.length,
      qty_round: "none",
    });
  }
  return { ok: true, value: { kit: { name, unit, labor_minutes }, items } };
}

/** What the kit will say, in his words, before he saves it: "2 h and Concrete ×4 per footing". */
export function kitSummary(v: KitFromTask, fromUnits: number | null): string {
  const labor = v.kit.labor_minutes % 60 === 0 ? `${v.kit.labor_minutes / 60} h` : `${v.kit.labor_minutes} min`;
  const parts = v.items.map((i) => `${i.description} ×${i.quantity}`).join(", ");
  const from = fromUnits !== null && fromUnits !== 1 ? ` (from this line's ×${fromUnits})` : " (this line is one unit)";
  return `${labor}${parts ? ` and ${parts}` : ""} per ${v.kit.unit}${from}`;
}

export interface RememberResult {
  ok: boolean;
  id?: string;
  name?: string;
  error?: string;
}

/**
 * WRITE THE KIT. The caller's client (RLS scopes the org; set_org_id stamps it). One name, one kit:
 * a second "Footing" would make the picker a coin toss. The parts' codes become 0240 links to the
 * book's items so a line prices LIVE; a code the book no longer carries stays a frozen line at the
 * sell the task had. Both inserts read back their ids (silent-write law) and a kit whose parts
 * failed is taken away again — half a kit would price every future task short.
 */
export async function rememberKit(sb: SupabaseClient, value: KitFromTask): Promise<RememberResult> {
  // Case-blind, in code: a LIKE pattern would read his "*" or "%" as wildcards.
  const names = await sb.from("kits").select("id, name");
  if (names.error) return { ok: false, error: dbError(names.error) };
  const wanted = value.kit.name.trim().toLowerCase();
  if (((names.data ?? []) as { name: string | null }[]).some((k) => String(k.name ?? "").trim().toLowerCase() === wanted)) {
    return { ok: false, error: `A kit named ${value.kit.name} already exists — pick another name.` };
  }

  const codes = [...new Set(value.items.map((i) => i.code).filter((c): c is string => !!c))];
  const byCode = new Map<string, string>();
  if (codes.length) {
    const book = await sb.from("price_list_items").select("id, code").in("code", codes).eq("archived", false);
    if (book.error) return { ok: false, error: dbError(book.error) };
    for (const r of (book.data ?? []) as { id: string; code: string | null }[]) {
      if (r.code && !byCode.has(r.code)) byCode.set(r.code, r.id);
    }
  }

  const kit = await sb
    .from("kits")
    .insert({ name: value.kit.name, unit: value.kit.unit, labor_minutes: value.kit.labor_minutes })
    .select("id")
    .single();
  if (kit.error || !kit.data) return { ok: false, error: dbError(kit.error ?? "Could not save the kit.") };
  const kitId = (kit.data as { id: string }).id;

  if (value.items.length) {
    const rows = value.items.map((i) => {
      const linkId = i.code ? byCode.get(i.code) : undefined;
      return {
        kit_id: kitId,
        description: i.description,
        quantity: i.quantity,
        unit: i.unit,
        unit_price: i.unit_price,
        sort_order: i.sort_order,
        qty_round: i.qty_round,
        ...(linkId ? { price_list_item_id: linkId } : {}),
      };
    });
    const ins = await sb.from("kit_items").insert(rows).select("id");
    const n = ins.data?.length ?? 0;
    if (ins.error || n !== rows.length) {
      // The clean-up is a write too: read it back, and if the kit could not be taken away, say
      // exactly what is left and the one thing to do about it.
      const gone = await sb.from("kits").delete().eq("id", kitId).select("id");
      const why = ins.error ? dbError(ins.error) : `only ${n} of ${rows.length} parts were saved`;
      if (gone.error || !gone.data?.length) {
        return { ok: false, error: `The kit ${value.kit.name} was saved without its parts (${why}) — delete it from the Price List.` };
      }
      return { ok: false, error: `The kit was not kept (${why}) — press Save The Kit again.` };
    }
  }
  return { ok: true, id: kitId, name: value.kit.name };
}
