import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import { keyParts, materialKey, type LineRow } from "./born-with-tasks";
import { coerceTaskDetail } from "./task-lines";
import { GONE_KEY, LINE_KEY, VISIT_KEY } from "./sync-job-tasks";
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
 *  - cn-v1084, the deferred items: a KEPT orphan keeps its line under a TOMBSTONE key
 *    ("gone:line:<id>#part") — his now, "kept" said once, and the line's again if that line returns
 *    (an estimate moved away and back), not a second row to buy twice. A VISIT's row ("task:<TaskValue
 *    id>#part", Start The Job on the inspection) finds the line of the estimate drafted from that
 *    visit — by the task id the line's breakdown remembers (detail.task_id) and the same part, else by
 *    the part half like any orphan — and becomes the line's instead of doubling; one that finds no line
 *    stays the visit's, untouched. An UNKEYED row that is not his (typed by hand, or taken off before
 *    0390) under the same code or words becomes the line's too (re-keyed, said as matched) instead of
 *    being announced as "already on the list" every sync; a bought or tool row never stands in for a
 *    wanted part by code or words (the estimate wants N more; the bought one is history). A dismissal
 *    under a gone line bars one part on a line nobody has — AFTER every row that is there has claimed
 *    — the part is LEFT OFF (said) and the dismissal MOVES to the new key: one entry per deletion.
 *  Rows with no key (typed by hand, plain lines, catalog kits, born before 0390) are never changed.
 *  Every write selects what it wrote and counts it; every read is org-scoped when the caller says who.
 */

/** A keyed row on the list, as the sync reads it. */
export interface ListPartRow {
  id: string;
  /** The row's key — for a tombstoned row, the key under the "gone:" prefix. */
  source_key: string;
  description: string;
  part_number: string | null;
  quantity: number | null;
  purchased: boolean | null;
  is_tool: boolean | null;
  /** True when the stored key is "gone:<source_key>": an orphan kept earlier, said then. */
  gone?: boolean;
  vendor?: string | null;
  est_cost?: number | null;
  unit?: string | null;
}

/** A row with no key that is not his (not bought, not a tool): typed by hand, or taken off before 0390. */
export type HandRow = Pick<ListPartRow, "id" | "description" | "part_number" | "quantity">;

/** A wanted part with its row key. */
export interface KeyedPart {
  key: string;
  code: string | null;
  name: string;
  qty: number | null;
  cost: number | null;
  /** The Inspector task the line was built from (detail.task_id): how a visit's row finds its line. */
  taskId?: string | null;
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
    for (const m of keyParts(`line:${r.id}`, named)) out.push({ key: m.key, code: m.code, name: m.name.trim(), qty: m.qty, cost: m.cost, taskId: d.task_id || null });
  }
  return out;
}

/** The "#part" half of a key, without its ordinal — what survives the builder giving the line a new id. */
export const partHalf = (key: string): string => key.slice(key.indexOf("#") + 1).replace(/~\d+$/, "");
/** The "line:<id>" half. */
const lineHalf = (key: string): string => key.slice(0, key.indexOf("#"));
/** The Inspector task id inside a visit's row key ("task:<id>#part"), else null. */
const visitTaskOf = (key: string): string | null => (key.startsWith(VISIT_KEY) && key.includes("#") ? key.slice(VISIT_KEY.length, key.indexOf("#")) : null);

/** Bought, or a tool: his, and it stays. */
export const isHisRow = (r: Pick<ListPartRow, "purchased" | "is_tool">): boolean => r.purchased === true || r.is_tool === true;

/** How an UNKEYED row is recognised as the same part: by code, else by its words (slugged like a key). */
export const unkeyedHalf = (r: { part_number: string | null; description: string }): string =>
  partHalf(materialKey("x", r.part_number, r.description.replace(/ · how many\?$/, "")));

export interface CountDiffers {
  description: string;
  shows: number | null;
  estimate: number;
}

export interface PartSyncPlan {
  insert: KeyedPart[];
  /** Orphans, a visit's rows, hand rows and returning tombstones: re-keyed to the line's part that is theirs. */
  rekey: Array<{ id: string; source_key: string }>;
  remove: ListPartRow[];
  kept: ListPartRow[];
  /** The kept orphans, re-keyed under the tombstone so "kept" is said once and the line can find them again. */
  tombstone: Array<{ id: string; source_key: string }>;
  /** Wanted parts a dismissal under a gone line barred (he deleted that part before), by name. */
  leftOff: string[];
  /** The dismissal entries that did the barring: replaced by `redismiss` (one entry per deletion). */
  consumed: string[];
  /** The same deletions under the rebuilt lines' keys. */
  redismiss: string[];
  /** A kept or re-keyed row whose count is not the estimate's: said, never rewritten. */
  countsDiffer: CountDiffers[];
}

/** THE PLAN, pure. `hand` = unkeyed rows that are not his: they may be a wanted part's row. */
export function planPartSync(
  wanted: ReadonlyArray<KeyedPart>,
  have: ReadonlyArray<ListPartRow>,
  dismissed: ReadonlySet<string> = new Set(),
  hand: ReadonlyArray<HandRow> = [],
): PartSyncPlan {
  const wantedByKey = new Map(wanted.map((p) => [p.key, p]));
  const haveKeys = new Set(have.map((r) => r.source_key)); // live and tombstoned alike: neither is inserted again
  const currentLines = new Set(wanted.map((p) => lineHalf(p.key)));
  const countsDiffer: CountDiffers[] = [];
  const differs = (r: Pick<ListPartRow, "description" | "quantity">, p: KeyedPart) => {
    if (p.qty !== null && Number(r.quantity) !== p.qty) countsDiffer.push({ description: r.description, shows: r.quantity, estimate: p.qty });
  };

  // Kept by key: counts compared.
  for (const r of have) {
    if (r.gone) continue;
    const p = wantedByKey.get(r.source_key);
    if (p) differs(r, p);
  }

  // Wanted parts nobody has (by key) and he did not dismiss.
  const unmatched = wanted.filter((p) => !haveKeys.has(p.key) && !dismissed.has(p.key));
  const rekey: PartSyncPlan["rekey"] = [];
  const claimed = new Set<string>();
  const take = (r: Pick<ListPartRow, "id" | "description" | "quantity">, i: number) => {
    const p = unmatched[i];
    unmatched.splice(i, 1);
    rekey.push({ id: r.id, source_key: p.key });
    claimed.add(r.id);
    differs(r, p);
  };
  /** Claim by the part half: an equal count first; any count unless `equalOnly`. */
  const claimHalf = (r: Pick<ListPartRow, "id" | "description" | "quantity">, half: string, equalOnly: boolean) => {
    if (claimed.has(r.id)) return;
    const same = (p: KeyedPart) => partHalf(p.key) === half;
    const equal = unmatched.findIndex((p) => same(p) && p.qty !== null && Number(r.quantity) === p.qty);
    const i = equal !== -1 ? equal : equalOnly ? -1 : unmatched.findIndex(same);
    if (i !== -1) take(r, i);
  };

  // A TOMBSTONE whose line is back (an estimate moved away and back) is the line's again — not a second row.
  for (const r of have) {
    if (!r.gone) continue;
    const p = wantedByKey.get(r.source_key);
    if (!p) continue;
    rekey.push({ id: r.id, source_key: r.source_key });
    claimed.add(r.id);
    differs(r, p);
  }

  // Orphans: a live row whose key is on no task line. A VISIT's row ("task:<id>#part") is an orphan of the
  // visit, not of a line: it claims first and exactly — the line built from its task, the same part, any
  // count (it IS that part; a differing count is said) — then like any orphan by the part half; one that
  // finds no line stays the visit's.
  const orphans = have.filter((r) => !r.gone && !wantedByKey.has(r.source_key));
  for (const r of orphans) {
    const t = visitTaskOf(r.source_key);
    if (!t) continue;
    const i = unmatched.findIndex((p) => p.taskId === t && partHalf(p.key) === partHalf(r.source_key));
    if (i !== -1) take(r, i);
  }
  // Equal counts claim first across ALL orphans that are not his, then the rest of them by name; a
  // bought or tool row only ever onto an equal count. Then the hand rows (not his by definition).
  const notHis = orphans.filter((o) => !isHisRow(o));
  for (const r of notHis) claimHalf(r, partHalf(r.source_key), true);
  for (const r of notHis) claimHalf(r, partHalf(r.source_key), false);
  for (const r of orphans.filter((o) => isHisRow(o))) claimHalf(r, partHalf(r.source_key), true);
  for (const r of hand) claimHalf(r, unkeyedHalf(r), true);
  for (const r of hand) claimHalf(r, unkeyedHalf(r), false);

  // A dismissal under a line that is gone bars the same part on a line nobody has (one part per
  // dismissal) — AFTER the claims, so a row that is there always wins — and MOVES to the new key.
  const leftOff: string[] = [];
  const consumed: string[] = [];
  const redismiss: string[] = [];
  const orphanEntries = [...dismissed].filter((k) => k.includes("#") && !currentLines.has(lineHalf(k)));
  const insert = unmatched.filter((p) => {
    const i = orphanEntries.findIndex((k) => partHalf(k) === partHalf(p.key));
    if (i === -1) return true;
    consumed.push(orphanEntries[i]);
    orphanEntries.splice(i, 1);
    redismiss.push(p.key);
    leftOff.push(p.name);
    return false;
  });

  const remove: ListPartRow[] = [];
  const kept: ListPartRow[] = [];
  for (const r of orphans) {
    if (claimed.has(r.id)) continue;
    if (!r.source_key.startsWith(LINE_KEY)) continue; // the visit's: not the estimate's to remove or keep
    (isHisRow(r) ? kept : remove).push(r);
  }
  return {
    insert,
    rekey,
    remove,
    kept,
    tombstone: kept.map((r) => ({ id: r.id, source_key: `${GONE_KEY}${r.source_key}` })),
    leftOff,
    consumed,
    redismiss,
    countsDiffer,
  };
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
  /** Wanted parts a dismissal under a gone line barred (he deleted that part before), by name. */
  leftOff: string[];
  countsDiffer: CountDiffers[];
  error?: string;
}

const NONE: MaterialsSyncResult = { inserted: 0, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [] };
const add = (a: MaterialsSyncResult, b: MaterialsSyncResult): MaterialsSyncResult => ({
  inserted: a.inserted + b.inserted,
  rekeyed: a.rekeyed + b.rekeyed,
  removed: a.removed + b.removed,
  removedNames: [...a.removedNames, ...b.removedNames],
  kept: a.kept + b.kept,
  keptNames: [...a.keptNames, ...b.keptNames],
  leftOff: [...a.leftOff, ...b.leftOff],
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

  const { data: lines, error: qErr } = await org(sb.from("quote_line_items").select("id, description, sort_order, detail, unit").eq("quote_id", who.quoteId), who.orgId).order("sort_order");
  if (qErr) return { ...NONE, error: dbError(qErr) };
  const wanted = partsFromLines((lines ?? []) as LineRow[]);

  // THE BOOK, once, first (audit v1085): it names the estimate's own plain-line rows below (the take-off
  // wrote their part number from the book), prices a claimed visit row's blanks and the rows inserted.
  // A lost read is an error here — the list is left exactly as it was, never priced around.
  const book = await readPriceBook(sb, who.orgId);
  if (book.error) return { ...NONE, error: `The price book could not be read (${book.error}); the list was left as it was.` };
  const findPl = book.findPl;

  const { data: rows, error: rErr } = await org(sb.from("material_list_items").select("id, source_key, description, part_number, quantity, purchased, is_tool, vendor, est_cost, unit").eq("list_id", listId), who.orgId).order("sort_order");
  if (rErr) return { ...NONE, error: dbError(rErr) };
  const all = (rows ?? []) as Array<Omit<ListPartRow, "source_key"> & { source_key: string | null }>;
  // The estimate's rows — live ("line:") and tombstoned ("gone:line:", kept earlier) — AND the visit's
  // ("task:"): a line may be theirs. Unkeyed rows that are not his may be a wanted part's row too; a
  // bought or tool hand row never stands in for a wanted part — the estimate wants N more, the bought
  // one is history.
  const keyed = (k: string | null): k is string => typeof k === "string" && (k.startsWith(LINE_KEY) || k.startsWith(VISIT_KEY) || k.startsWith(`${GONE_KEY}${LINE_KEY}`));
  const have: ListPartRow[] = all
    .filter((r) => keyed(r.source_key))
    .map((r) => {
      const k = r.source_key as string;
      return k.startsWith(GONE_KEY) ? { ...r, source_key: k.slice(GONE_KEY.length), gone: true } : { ...r, source_key: k };
    });
  // THE ESTIMATE'S OWN PLAIN-LINE ROWS ARE NOT HAND ROWS (audit v1085): the take-off wrote them
  // unkeyed (a plain line is not a task), and a task part with the same code would otherwise claim
  // one — and the sync remove it when the task line went. One row per plain line, by code else words.
  // Exactly as the take-off wrote the row (take-off-from-quote): the FIRST "[CODE]" is the code, the words
  // are the text without it, the row's part number is the book's code when the book knows it, and a
  // labor line never made a row.
  const plainHalves = new Map<string, number>();
  const CODE_RE = /\[([^\]]+)\]/;
  for (const l of (lines ?? []) as Array<{ description: string | null; detail: unknown; unit?: string | null }>) {
    if (coerceTaskDetail(l.detail)) continue;
    const text = String(l.description ?? "");
    if (String(l.unit ?? "").toLowerCase() === "hr" || /^\s*labor\b/i.test(text)) continue;
    const m = text.match(CODE_RE);
    const code = m ? m[1].trim() : null;
    const cleanDesc = text.replace(CODE_RE, "").trim();
    const pl = findPl(code, cleanDesc);
    const half = unkeyedHalf({ part_number: pl?.code ?? code ?? null, description: cleanDesc || text });
    plainHalves.set(half, (plainHalves.get(half) ?? 0) + 1);
  }
  const hand: HandRow[] = all.filter((r) => {
    if (r.source_key || isHisRow(r)) return false;
    const half = unkeyedHalf(r);
    const n = plainHalves.get(half) ?? 0;
    if (!n) return true;
    plainHalves.set(half, n - 1);
    return false; // the estimate's own plain row: left exactly as it is
  });

  const plan = planPartSync(wanted, have, dismissed, hand);

  // THE BOOK, once, when anything needs pricing: a claimed visit or hand row with no vendor or cost
  // takes the book's (audit v1085: a PO seeded from such a row read $0), never a value someone set.
  // A lost book read is an error here, not an unpriced row.
  const byId = new Map(all.map((r) => [r.id, r]));
  const wantedByKey = new Map(wanted.map((p) => [p.key, p]));

  let rekeyed = 0;
  for (const r of plan.rekey) {
    const row = byId.get(r.id);
    const part = wantedByKey.get(r.source_key);
    const patch: Record<string, unknown> = { source_key: r.source_key };
    if (row && part && (row.vendor == null || row.est_cost == null)) {
      const fresh = taskPartRow(listId, who.orgId, { code: part.code, name: part.name, qty: part.qty, cost: part.cost, source_key: part.key }, findPl(part.code, part.name));
      if (row.vendor == null && fresh.vendor != null) patch.vendor = fresh.vendor;
      if (row.est_cost == null && fresh.est_cost != null) {
        patch.est_cost = fresh.est_cost;
        // The unit rides ONLY with the cost it prices (a $45 roll is "2 ea", never "2 ft" at $45).
        if ((row.unit == null || row.unit === "ea") && fresh.unit && fresh.unit !== "ea") patch.unit = fresh.unit;
      }
    }
    const { data, error } = await org(sb.from("material_list_items").update(patch).eq("id", r.id).eq("list_id", listId), who.orgId).select("id");
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    if (!data?.length) return { ...NONE, rekeyed, error: "A part could not be matched to its line." };
    rekeyed++;
  }

  for (const t of plan.tombstone) {
    // A KEPT ORPHAN IS HIS NOW: its key goes under the tombstone ("gone:line:<id>#part") — "kept" is said
    // this once, not on every sync after, and the line can still find it if it ever comes back.
    const { data, error } = await org(sb.from("material_list_items").update({ source_key: t.source_key }).eq("id", t.id).eq("list_id", listId), who.orgId).select("id");
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    if (!data?.length) return { ...NONE, rekeyed, error: "A kept part could not be marked." };
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
    // The same deletions, MOVED to the rebuilt lines' keys: the entries that barred are replaced, never
    // piled up. Read again right before the write so a delete made meanwhile (the crew's
    // dismiss_material_key) is kept, not overwritten. Staff or service writes this directly.
    const { data: fresh, error: fErr } = await org(sb.from("material_lists").select("dismissed_keys").eq("id", listId), who.orgId).maybeSingle();
    if (fErr) return { ...NONE, rekeyed, removed, removedNames, kept, keptNames, error: dbError(fErr) };
    const now = (Array.isArray((fresh as { dismissed_keys?: unknown } | null)?.dismissed_keys) ? (fresh as { dismissed_keys: unknown[] }).dismissed_keys : dismissedList).filter(
      (k): k is string => typeof k === "string",
    );
    const consumed = new Set(plan.consumed);
    const next = [...now.filter((k) => !consumed.has(k)), ...plan.redismiss.filter((k) => !now.includes(k))];
    const { data, error } = await org(sb.from("material_lists").update({ dismissed_keys: next }).eq("id", listId), who.orgId).select("id");
    if (error) return { ...NONE, rekeyed, removed, removedNames, kept, keptNames, error: dbError(error) };
    if (!data?.length) return { ...NONE, rekeyed, removed, removedNames, kept, keptNames, error: "The list's dismissed parts could not be kept up." };
  }

  let inserted = 0;
  if (plan.insert.length) {
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

  return { inserted, rekeyed, removed, removedNames, kept, keptNames, leftOff: plan.leftOff, countsDiffer: plan.countsDiffer };
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
export function materialsWords(r: MaterialsSyncResult, lead = "The estimate's materials list follows too"): string | null {
  const bits: string[] = [];
  if (r.inserted) bits.push(`${plural(r.inserted, "part", "parts")} added`);
  if (r.rekeyed) bits.push(`${r.rekeyed} matched`);
  if (r.removed) bits.push(`${r.removed} removed${few(r.removedNames)}`);
  if (r.kept) bits.push(`${r.kept} kept${few(r.keptNames)} — bought, or a tool`);
  if (r.leftOff.length) bits.push(`${r.leftOff.length} left off${few(r.leftOff)} — deleted from the list before`);
  for (const c of r.countsDiffer.slice(0, 3)) bits.push(`${c.description} shows ${c.shows ?? "no count"}, the estimate says ${c.estimate}`);
  if (r.countsDiffer.length > 3) bits.push(`${r.countsDiffer.length - 3} more counts differ`);
  return bits.length ? `${lead}: ${bits.join(" · ")}.` : null;
}
