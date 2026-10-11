import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import { keyParts, materialKey, type LineRow } from "./born-with-tasks";
import { coerceTaskDetail } from "./task-lines";
import { LINE_KEY } from "./sync-job-tasks";
import { readPriceBook, taskPartRow } from "./take-off-from-quote";

/**
 * THE MATERIALS LIST FOLLOWS THE ESTIMATE (0390, 2026-10-10).
 *
 * The take-off (take-off-from-quote) writes an estimate's list ONCE: each task line's parts become
 * rows, and the list is never touched again. cn-v1079 made the job's TASKS follow a changed estimate
 * (sync-job-tasks); this does the same for the crew's buy list, now that a row remembers its line
 * and part (material_list_items.source_key, 0390).
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────────────────
 *  An estimate's keyed rows ARE the parts of its task lines, as long as the estimate is accepted.
 *  What he did to a row is his.
 *
 *  - A row whose key is still wanted stays exactly as it is (his count, vendor, cost edits stand).
 *    When its count differs from the estimate's, that is SAID by name — the row is not rewritten,
 *    because a count he typed and a count the take-off wrote look the same.
 *  - An ORPHAN (its key is on no task line) is matched by its "#part" half to a wanted part nobody
 *    has yet — the builder rewrites lines with NEW ids — and re-keyed: rows that are not his first,
 *    preferring an equal count; a bought or tool row only onto an equal count (a bought R1 must never
 *    make a new R1 read as already bought). Otherwise an orphan is removed when it is neither bought
 *    nor a tool, and KEPT (said by name) when it is.
 *  - A part he deleted by hand stays gone: the delete door writes its key to the list's
 *    dismissed_keys (dismiss_material_key, 0390); a dismissed key whose line is gone still bars the
 *    same part on the rebuilt line, and the sync re-dismisses it under the new key.
 *  - A part the list already carries UNKEYED (typed by hand, or taken off before 0390) under the same
 *    code or words is not inserted a second time.
 *  - The rest are inserted through the take-off's own row shape (taskPartRow, the same book lookup),
 *    after the list's last row.
 *  - No list for the estimate: nothing is made here — the acceptance doors run the take-off, and a
 *    list someone deleted on purpose is not re-made behind their back.
 *  Rows with no key (typed by hand, plain lines, catalog kits, born before 0390) are never changed.
 *  Every write selects what it wrote and counts it; every read is org-scoped when the caller says who.
 */

/** A keyed row on the list, as the sync reads it. */
export interface ListPartRow {
  id: string;
  source_key: string;
  description: string;
  part_number: string | null;
  quantity: number | null;
  purchased: boolean | null;
  is_tool: boolean | null;
}

/** A wanted part with its row key. */
export interface KeyedPart {
  key: string;
  code: string | null;
  name: string;
  qty: number | null;
  cost: number | null;
}

/** The parts of a quote's TASK lines, keyed as the take-off keys them (ordinals for repeats). The
 *  take-off's own predicate: a line with a breakdown, whatever its title — a nameless task line's parts
 *  are still rows on the sheet. */
export function partsFromLines(rows: ReadonlyArray<LineRow>): KeyedPart[] {
  const out: KeyedPart[] = [];
  for (const r of rows) {
    const d = coerceTaskDetail(r.detail);
    if (!d) continue;
    const named = d.materials.filter((m) => m.name.trim());
    for (const m of keyParts(`line:${r.id}`, named)) out.push({ key: m.key, code: m.code, name: m.name.trim(), qty: m.qty, cost: m.cost });
  }
  return out;
}

/** The "#part" half of a key, without its ordinal — what survives the builder giving the line a new id. */
export const partHalf = (key: string): string => key.slice(key.indexOf("#") + 1).replace(/~\d+$/, "");
/** The "line:<id>" half. */
const lineHalf = (key: string): string => key.slice(0, key.indexOf("#"));

/** Bought, or a tool: his, and it stays. */
export const isHisRow = (r: Pick<ListPartRow, "purchased" | "is_tool">): boolean => r.purchased === true || r.is_tool === true;

/** How an UNKEYED row is recognised as the same part: by code, else by its words (slugged like a key). */
const unkeyedHalf = (r: { part_number: string | null; description: string }): string =>
  partHalf(materialKey("x", r.part_number, r.description.replace(/ · how many\?$/, "")));

export interface CountDiffers {
  description: string;
  shows: number | null;
  estimate: number;
}

export interface PartSyncPlan {
  insert: KeyedPart[];
  rekey: Array<{ id: string; source_key: string }>;
  remove: ListPartRow[];
  kept: ListPartRow[];
  /** Wanted parts already on the list without a key (by code or words): not inserted again. */
  alreadyListed: KeyedPart[];
  /** Dismissed under an old line id, barred again under the new one: to be dismissed under the new key too. */
  redismiss: string[];
  /** A kept or re-keyed row whose count is not the estimate's: said, never rewritten. */
  countsDiffer: CountDiffers[];
}

/** THE PLAN, pure. */
export function planPartSync(
  wanted: ReadonlyArray<KeyedPart>,
  have: ReadonlyArray<ListPartRow>,
  dismissed: ReadonlySet<string> = new Set(),
  unkeyed: ReadonlyArray<{ part_number: string | null; description: string }> = [],
): PartSyncPlan {
  const wantedByKey = new Map(wanted.map((p) => [p.key, p]));
  const haveKeys = new Set(have.map((r) => r.source_key));
  const currentLines = new Set(wanted.map((p) => lineHalf(p.key)));
  const countsDiffer: CountDiffers[] = [];
  const differs = (r: ListPartRow, p: KeyedPart) => {
    if (p.qty !== null && Number(r.quantity) !== p.qty) countsDiffer.push({ description: r.description, shows: r.quantity, estimate: p.qty });
  };

  // Kept by key: counts compared.
  for (const r of have) {
    const p = wantedByKey.get(r.source_key);
    if (p) differs(r, p);
  }

  // Wanted parts nobody has (by key), not dismissed, not already on the list unkeyed.
  let unmatched = wanted.filter((p) => !haveKeys.has(p.key) && !dismissed.has(p.key));
  const unkeyedHalves = new Map<string, number>();
  for (const u of unkeyed) unkeyedHalves.set(unkeyedHalf(u), (unkeyedHalves.get(unkeyedHalf(u)) ?? 0) + 1);
  const alreadyListed: KeyedPart[] = [];
  unmatched = unmatched.filter((p) => {
    const n = unkeyedHalves.get(partHalf(p.key)) ?? 0;
    if (!n) return true;
    unkeyedHalves.set(partHalf(p.key), n - 1);
    alreadyListed.push(p);
    return false;
  });

  // A dismissal under a line that is gone bars the same part on the rebuilt line.
  const redismiss: string[] = [];
  const orphanDismissals = [...dismissed].filter((k) => k.includes("#") && !currentLines.has(lineHalf(k))).map(partHalf);
  unmatched = unmatched.filter((p) => {
    const i = orphanDismissals.indexOf(partHalf(p.key));
    if (i === -1) return true;
    orphanDismissals.splice(i, 1);
    redismiss.push(p.key);
    return false;
  });

  // Orphans: re-key by the "#part" half — rows that are not his first, preferring an equal count; a
  // bought or tool row only onto an equal count. Else remove (not his) or keep (his).
  const orphans = have.filter((r) => !wantedByKey.has(r.source_key));
  const rekey: PartSyncPlan["rekey"] = [];
  const claimed = new Set<string>();
  const claim = (r: ListPartRow, equalOnly: boolean) => {
    if (claimed.has(r.id)) return;
    const half = partHalf(r.source_key);
    const same = (p: KeyedPart) => partHalf(p.key) === half;
    const equal = unmatched.findIndex((p) => same(p) && p.qty !== null && Number(r.quantity) === p.qty);
    const i = equal !== -1 ? equal : equalOnly ? -1 : unmatched.findIndex(same);
    if (i === -1) return;
    const p = unmatched[i];
    unmatched.splice(i, 1);
    rekey.push({ id: r.id, source_key: p.key });
    claimed.add(r.id);
    differs(r, p);
  };
  // Equal counts claim first across ALL orphans that are not his, then the rest of them by name; a
  // bought or tool row only ever onto an equal count.
  const notHis = orphans.filter((o) => !isHisRow(o));
  for (const r of notHis) claim(r, true);
  for (const r of notHis) claim(r, false);
  for (const r of orphans.filter((o) => isHisRow(o))) claim(r, true);
  const remove: ListPartRow[] = [];
  const kept: ListPartRow[] = [];
  for (const r of orphans) {
    if (claimed.has(r.id)) continue;
    (isHisRow(r) ? kept : remove).push(r);
  }
  return { insert: unmatched, rekey, remove, kept, alreadyListed, redismiss, countsDiffer };
}

export interface MaterialsSyncWho {
  jobId: string;
  orgId: string | null;
  userId: string | null;
}

export interface MaterialsSyncResult {
  inserted: number;
  rekeyed: number;
  removed: number;
  removedNames: string[];
  kept: number;
  keptNames: string[];
  alreadyListed: number;
  countsDiffer: CountDiffers[];
  error?: string;
}

const NONE: MaterialsSyncResult = { inserted: 0, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], alreadyListed: 0, countsDiffer: [] };
const add = (a: MaterialsSyncResult, b: MaterialsSyncResult): MaterialsSyncResult => ({
  inserted: a.inserted + b.inserted,
  rekeyed: a.rekeyed + b.rekeyed,
  removed: a.removed + b.removed,
  removedNames: [...a.removedNames, ...b.removedNames],
  kept: a.kept + b.kept,
  keptNames: [...a.keptNames, ...b.keptNames],
  alreadyListed: a.alreadyListed + b.alreadyListed,
  countsDiffer: [...a.countsDiffer, ...b.countsDiffer],
  ...(a.error || b.error ? { error: [a.error, b.error].filter(Boolean).join(" ") } : {}),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const org = (q: any, orgId: string | null): any => (orgId ? q.eq("org_id", orgId) : q);

/** ONE ESTIMATE'S LIST, brought in step with its task lines. No list → nothing (the acceptance doors make it). */
export async function syncQuoteMaterials(sb: SupabaseClient, who: MaterialsSyncWho & { quoteId: string }): Promise<MaterialsSyncResult> {
  const { data: list, error: lErr } = await org(sb.from("material_lists").select("id, dismissed_keys").eq("quote_id", who.quoteId), who.orgId).limit(1).maybeSingle();
  if (lErr) return { ...NONE, error: dbError(lErr) };
  if (!list) return NONE;
  const listId = (list as { id: string }).id;
  const dismissedList = (Array.isArray((list as { dismissed_keys?: unknown }).dismissed_keys) ? (list as { dismissed_keys: unknown[] }).dismissed_keys : []).filter(
    (k): k is string => typeof k === "string",
  );
  const dismissed = new Set<string>(dismissedList);

  const { data: lines, error: qErr } = await org(sb.from("quote_line_items").select("id, description, sort_order, detail").eq("quote_id", who.quoteId), who.orgId).order("sort_order");
  if (qErr) return { ...NONE, error: dbError(qErr) };
  const wanted = partsFromLines((lines ?? []) as LineRow[]);

  const { data: rows, error: rErr } = await org(sb.from("material_list_items").select("id, source_key, description, part_number, quantity, purchased, is_tool").eq("list_id", listId), who.orgId).order("sort_order");
  if (rErr) return { ...NONE, error: dbError(rErr) };
  const all = (rows ?? []) as Array<ListPartRow & { source_key: string | null }>;
  const have = all.filter((r): r is ListPartRow => typeof r.source_key === "string" && r.source_key.startsWith(LINE_KEY));
  const unkeyed = all.filter((r) => !r.source_key);

  const plan = planPartSync(wanted, have, dismissed, unkeyed);

  let rekeyed = 0;
  for (const r of plan.rekey) {
    const { data, error } = await org(sb.from("material_list_items").update({ source_key: r.source_key }).eq("id", r.id).eq("list_id", listId), who.orgId).select("id");
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    if (!data?.length) return { ...NONE, rekeyed, error: "A part could not be matched to its line." };
    rekeyed++;
  }

  let removed = 0;
  let kept = plan.kept.length;
  const keptNames = plan.kept.map((r) => r.description);
  const removedNames: string[] = [];
  if (plan.remove.length) {
    // Conditional on what was read: a part bought in the meantime is kept, not removed.
    const { data, error } = await org(sb.from("material_list_items").delete().in("id", plan.remove.map((r) => r.id)).eq("list_id", listId).eq("purchased", false).eq("is_tool", false), who.orgId).select("id");
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    const gone = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    removed = gone.size;
    for (const r of plan.remove) (gone.has(r.id) ? removedNames : keptNames).push(r.description);
    kept += plan.remove.length - removed;
  }

  if (plan.redismiss.length) {
    // The same part, barred again under its rebuilt line's key — staff or service writes this directly.
    const next = [...dismissedList, ...plan.redismiss.filter((k) => !dismissed.has(k))];
    const { data, error } = await org(sb.from("material_lists").update({ dismissed_keys: next }).eq("id", listId), who.orgId).select("id");
    if (error) return { ...NONE, rekeyed, removed, removedNames, kept, keptNames, error: dbError(error) };
    if (!data?.length) return { ...NONE, rekeyed, removed, removedNames, kept, keptNames, error: "The list's dismissed parts could not be kept up." };
  }

  let inserted = 0;
  if (plan.insert.length) {
    const { findPl } = await readPriceBook(sb, who.orgId);
    const { data: last } = await org(sb.from("material_list_items").select("sort_order").eq("list_id", listId), who.orgId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
    let so = ((last as { sort_order?: number } | null)?.sort_order ?? -1) + 1;
    const newRows = plan.insert.map((p) => ({
      ...taskPartRow(listId, who.orgId, { code: p.code, name: p.name, qty: p.qty, cost: p.cost, source_key: p.key }, findPl(p.code, p.name)),
      sort_order: so++,
    }));
    const { data, error } = await sb.from("material_list_items").insert(newRows).select("id");
    if (error) return { ...NONE, rekeyed, removed, removedNames, kept, keptNames, error: dbError(error) };
    inserted = data?.length ?? 0;
    if (inserted !== newRows.length) return { ...NONE, rekeyed, removed, removedNames, kept, keptNames, inserted, error: `${newRows.length - inserted} of ${newRows.length} parts did not save.` };
  }

  return { inserted, rekeyed, removed, removedNames, kept, keptNames, alreadyListed: plan.alreadyListed.length, countsDiffer: plan.countsDiffer };
}

/** EVERY ACCEPTED ESTIMATE OF THE JOB that has a list, each brought in step. */
export async function syncJobMaterials(sb: SupabaseClient, who: MaterialsSyncWho): Promise<MaterialsSyncResult> {
  const { data: quotes, error } = await org(sb.from("quotes").select("id, accepted_at, created_at").eq("job_id", who.jobId).eq("status", "accepted"), who.orgId).order("accepted_at");
  if (error) return { ...NONE, error: dbError(error) };
  let total = NONE;
  for (const q of (quotes ?? []) as Array<{ id: string }>) total = add(total, await syncQuoteMaterials(sb, { ...who, quoteId: q.id }));
  return total;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const few = (names: string[]): string => (names.length ? ` (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""})` : "");

/** What the estimate's materials list did, as a sentence — or null when nothing changed. */
export function materialsWords(r: MaterialsSyncResult): string | null {
  const bits: string[] = [];
  if (r.inserted) bits.push(`${plural(r.inserted, "part", "parts")} added`);
  if (r.rekeyed) bits.push(`${r.rekeyed} matched by name`);
  if (r.removed) bits.push(`${r.removed} removed${few(r.removedNames)}`);
  if (r.kept) bits.push(`${r.kept} kept${few(r.keptNames)} — bought, or a tool`);
  if (r.alreadyListed) bits.push(`${r.alreadyListed} already on the list by hand`);
  for (const c of r.countsDiffer.slice(0, 3)) bits.push(`${c.description} shows ${c.shows ?? "no count"}, the estimate says ${c.estimate}`);
  if (r.countsDiffer.length > 3) bits.push(`${r.countsDiffer.length - 3} more counts differ`);
  return bits.length ? `The estimate's materials list follows too: ${bits.join(" · ")}.` : null;
}
