import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import { partsFromLines, type KeyedPart, type LineRow } from "./born-with-tasks";
import { GONE_KEY, LINE_KEY, VISIT_KEY } from "./sync-job-tasks";
import { HOW_MANY, few, insertKeyedRows, isClaimableKey, plainLineOf, plainRowHalf, plural, readPriceBook, taskPartRow } from "./take-off-from-quote";

/** The parts reader and its row type live with the birth (born-with-tasks, cn-v1133) so the figure a
 *  door reads before its write (estimateLines' partCounts) is the sync's own reading; found here still. */
export { partsFromLines, type KeyedPart } from "./born-with-tasks";

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
 *    because a count he typed and a count the take-off wrote look the same — UNLESS the row still
 *    holds the count its line said BEFORE this change (`partsBefore`, read by the door before its
 *    write, the twin of the tasks' `tasksBefore`, cn-v1133): then the count is still the estimate's
 *    and FOLLOWS, compare-and-set on the count just read, never a bought or tool row. A count that
 *    moved meanwhile is his, and the difference is said.
 *  - A RENAME IS A RENAME (cn-v1133). An uncoded part's key is a slug of its words, so renaming it
 *    changed its key: the old row went under the tombstone (bought) or away, and a new row was
 *    inserted — two rows for one part. When ONE line has exactly one key gone and one key new, at
 *    the same count, AND BOTH ARE UNCODED, the existing row takes the new words and the new key
 *    (bought or not; a bought row keeps its mark). A coded part's key IS its book code, so a changed
 *    key on either side is a different book item — another part number, vendor and cost — and takes
 *    the old path (kept or removed; the new one inserted, priced from the book): writing "3/4 in EMT"
 *    onto a bought row of 1/2 in EMT would misname what he bought (skeptic #39, B2). Anything but
 *    that exact 1:1 is handled as before.
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

/** A row with no key — or a typed row's "capture:" key (isClaimableKey) — that is not his (not bought, not a
 *  tool): typed by hand or on site, or taken off before 0390. */
export type HandRow = Pick<ListPartRow, "id" | "description" | "part_number" | "quantity">;

/** The "#part" half of a key, without its ordinal — what survives the builder giving the line a new id. */
export const partHalf = (key: string): string => key.slice(key.indexOf("#") + 1).replace(/~\d+$/, "");
/** The "line:<id>" half. */
const lineHalf = (key: string): string => key.slice(0, key.indexOf("#"));
/** An UNCODED part's half: materialKey slugs words to lowercase and upper-cases a code, so a half with a
 *  lowercase letter in it is words, never a book code. (A slug of digits alone reads as a code — the
 *  safe side: the old path, never a rename onto a row that may be another part.) */
export const isSlugHalf = (half: string): boolean => /[a-z]/.test(half);
/** The Inspector task id inside a visit's row key ("task:<id>#part"), else null. */
const visitTaskOf = (key: string): string | null => (key.startsWith(VISIT_KEY) && key.includes("#") ? key.slice(VISIT_KEY.length, key.indexOf("#")) : null);

/** Bought, or a tool: his, and it stays. */
export const isHisRow = (r: Pick<ListPartRow, "purchased" | "is_tool">): boolean => r.purchased === true || r.is_tool === true;

/** How an UNKEYED row is recognised as the same part: by code, else by its words (slugged like a key) —
 *  the take-off's own reading (plainRowHalf), so a plain line and its row match the same way everywhere. */
export const unkeyedHalf = (r: { part_number: string | null; description: string }): string => plainRowHalf(r);

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
  /** A placeholder row ("… · how many?", riding as one, not his) whose part now has a count: filled in. */
  fill: Array<{ id: string; description: string; qty: number }>;
  /** A row still holding the count its line said BEFORE this change (partsBefore), not his: moved to the
   *  line's count now — compare-and-set on `from` (cn-v1133). */
  move: Array<{ id: string; description: string; from: number; to: number }>;
  /** ONE line's one gone UNCODED key and one new UNCODED key at the same count: the row takes the new
   *  words and key (a rename, not a tombstone + an insert), bought or not (cn-v1133). */
  rename: Array<{ id: string; source_key: string; description: string }>;
}

/** A row as the plan compares it: the keyed rows carry purchased/is_tool and their key as read (what
 *  `partsBefore` is keyed by), a hand row is not his by definition and has no key. */
type RowLike = Pick<ListPartRow, "id" | "description" | "quantity"> & Partial<Pick<ListPartRow, "purchased" | "is_tool" | "source_key">>;

/** THE PLAN, pure. `hand` = unkeyed rows that are not his: they may be a wanted part's row. `partsBefore`
 *  = each part's count as its line said it BEFORE the change (by the row key as read), from the door. */
export function planPartSync(
  wanted: ReadonlyArray<KeyedPart>,
  have: ReadonlyArray<ListPartRow>,
  dismissed: ReadonlySet<string> = new Set(),
  hand: ReadonlyArray<HandRow> = [],
  partsBefore?: ReadonlyMap<string, number>,
): PartSyncPlan {
  const wantedByKey = new Map(wanted.map((p) => [p.key, p]));
  const haveKeys = new Set(have.map((r) => r.source_key)); // live and tombstoned alike: neither is inserted again
  const currentLines = new Set(wanted.map((p) => lineHalf(p.key)));
  const countsDiffer: CountDiffers[] = [];
  const fill: PartSyncPlan["fill"] = [];
  const move: PartSyncPlan["move"] = [];
  const differs = (r: RowLike, p: KeyedPart) => {
    if (p.qty === null || Number(r.quantity) === p.qty) return;
    const his = isHisRow({ purchased: r.purchased ?? null, is_tool: r.is_tool ?? null });
    // THE ANSWER REACHES THE ROW (audit v1085, carried): a part the visit listed without a count ("how
    // many?", riding as one) takes the count the estimate gives it — only that untouched placeholder, never
    // a count someone typed (he keeps the words but not the 1) and never a bought or tool row.
    if (!his && r.description.endsWith(HOW_MANY) && Number(r.quantity) === 1 && p.qty !== 1) {
      fill.push({ id: r.id, description: r.description.slice(0, -HOW_MANY.length), qty: p.qty });
      return;
    }
    // THE COUNT FOLLOWS, LIKE THE MINUTES DO (cn-v1133): the row still says what its line said before
    // this change (under the key the row had when the door read it), so the count is the estimate's,
    // not his — it moves. A count he typed, and a bought or tool row, stay: said.
    const before = r.source_key ? partsBefore?.get(r.source_key) : undefined;
    if (!his && before !== undefined && Number(r.quantity) === before) {
      move.push({ id: r.id, description: r.description, from: before, to: p.qty });
      return;
    }
    countsDiffer.push({ description: r.description, shows: r.quantity, estimate: p.qty });
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
  const take = (r: RowLike, i: number) => {
    const p = unmatched[i];
    unmatched.splice(i, 1);
    rekey.push({ id: r.id, source_key: p.key });
    claimed.add(r.id);
    differs(r, p);
  };
  /** Claim by the part half: an equal count first; any count unless `equalOnly`. */
  const claimHalf = (r: RowLike, half: string, equalOnly: boolean) => {
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

  // A RENAME IS A RENAME (cn-v1133): an uncoded part's key is a slug of its words, so his rename made
  // one key gone and one key new on the SAME line. When that is all that changed on the line — exactly
  // one of each, at the same count — the row is renamed and re-keyed in place, bought or not, instead
  // of going under the tombstone (or away) beside a second row for the same part. ONLY UNCODED TO
  // UNCODED (skeptic #39, B2): a coded part's key is its book code, so a changed key there is a swap to
  // a DIFFERENT book item (E1 → E2: another part number, vendor and cost), and renaming the row would
  // put the new words on a bought row of the old part — that pair takes the old path. Anything else on
  // a line (two gone, two new, a count that moved too) is read as before. After the claims, so a part
  // the same key or half still wants is never mistaken for a rename.
  const rename: PartSyncPlan["rename"] = [];
  const goneByLine = new Map<string, ListPartRow[]>();
  for (const r of orphans) {
    if (claimed.has(r.id) || !r.source_key.startsWith(LINE_KEY)) continue;
    const line = lineHalf(r.source_key);
    if (!currentLines.has(line)) continue;
    goneByLine.set(line, [...(goneByLine.get(line) ?? []), r]);
  }
  for (const [line, gone] of goneByLine) {
    const added = unmatched.filter((p) => lineHalf(p.key) === line);
    if (gone.length !== 1 || added.length !== 1) continue;
    const [r] = gone;
    const [p] = added;
    if (p.qty === null || Number(r.quantity) !== p.qty) continue;
    if (p.code !== null || !isSlugHalf(partHalf(r.source_key))) continue;
    rename.push({ id: r.id, source_key: p.key, description: p.name });
    claimed.add(r.id);
    unmatched.splice(unmatched.indexOf(p), 1);
  }

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
    fill,
    move,
    rename,
  };
}

export interface MaterialsSyncWho {
  jobId: string;
  orgId: string | null;
  userId: string | null;
  /** Each part's count as its line said it BEFORE the change (estimateLines().partCounts, by row key), read
   *  by the door before its write: a row still holding it follows its line (cn-v1133). undefined = only a
   *  "how many?" placeholder follows; every other difference is said. */
  partsBefore?: ReadonlyMap<string, number>;
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
  /** Placeholder rows ("how many?") that took the estimate's count, by name. */
  filled?: string[];
  /** Rows still at the count their line said before that moved to the line's count now (cn-v1133), by name. */
  moved?: string[];
  /** Rows that took a renamed part's new words and key in place of a tombstone + an insert (cn-v1133), by their new name. */
  renamed?: string[];
  error?: string;
}

const NONE: MaterialsSyncResult = { inserted: 0, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [] };
const names = (key: "filled" | "moved" | "renamed", a: MaterialsSyncResult, b: MaterialsSyncResult) =>
  a[key]?.length || b[key]?.length ? { [key]: [...(a[key] ?? []), ...(b[key] ?? [])] } : {};
const add = (a: MaterialsSyncResult, b: MaterialsSyncResult): MaterialsSyncResult => ({
  inserted: a.inserted + b.inserted,
  rekeyed: a.rekeyed + b.rekeyed,
  removed: a.removed + b.removed,
  removedNames: [...a.removedNames, ...b.removedNames],
  kept: a.kept + b.kept,
  keptNames: [...a.keptNames, ...b.keptNames],
  leftOff: [...a.leftOff, ...b.leftOff],
  countsDiffer: [...a.countsDiffer, ...b.countsDiffer],
  ...names("filled", a, b),
  ...names("moved", a, b),
  ...names("renamed", a, b),
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

  // `quantity` rides with the breakdown (cn-v1133): "this many of the task" multiplies each part's count.
  const { data: lines, error: qErr } = await org(sb.from("quote_line_items").select("id, description, sort_order, quantity, detail, unit").eq("quote_id", who.quoteId), who.orgId).order("sort_order");
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
  // one — and the sync remove it when the task line went. One row per plain line, by code else words,
  // read EXACTLY as the take-off wrote the row — its own reading, plainLineOf (take-off-from-quote).
  const plainHalves = new Map<string, number>();
  for (const l of (lines ?? []) as Array<{ description: string | null; detail: unknown; unit?: string | null }>) {
    const p = plainLineOf(l, findPl);
    if (p) plainHalves.set(p.half, (plainHalves.get(p.half) ?? 0) + 1);
  }
  const hand: HandRow[] = all.filter((r) => {
    if (!isClaimableKey(r.source_key) || isHisRow(r)) return false; // a typed row's "capture:" key is no claim (cn-v1134)
    const half = unkeyedHalf(r);
    const n = plainHalves.get(half) ?? 0;
    if (!n) return true;
    plainHalves.set(half, n - 1);
    return false; // the estimate's own plain row: left exactly as it is
  });

  const plan = planPartSync(wanted, have, dismissed, hand, who.partsBefore);

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

  // A RENAME IS A RENAME (cn-v1133): the row takes the part's new words and key in place — a bought row
  // keeps its mark, its part number, vendor and cost (only the words and the key are written — right
  // ONLY because the plan renames uncoded → uncoded; a coded swap never reaches here). Zero rows is a
  // refusal, said.
  const renamed: string[] = [];
  for (const r of plan.rename) {
    const { data, error } = await org(sb.from("material_list_items").update({ source_key: r.source_key, description: r.description }).eq("id", r.id).eq("list_id", listId), who.orgId).select("id");
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    if (!data?.length) return { ...NONE, rekeyed, error: "A renamed part could not be matched to its line." };
    renamed.push(r.description);
  }

  // THE ANSWER REACHES THE ROW: conditional on the placeholder being untouched still (count 1, not bought,
  // not a tool) — a count typed or a buy made meanwhile is his, and the difference is said instead.
  const filled: string[] = [];
  for (const f of plan.fill) {
    const { data, error } = await org(
      sb.from("material_list_items").update({ quantity: f.qty, description: f.description }).eq("id", f.id).eq("list_id", listId).eq("purchased", false).eq("is_tool", false).eq("quantity", 1),
      who.orgId,
    ).select("id");
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    if (data?.length) filled.push(f.description);
    else plan.countsDiffer.push({ description: f.description, shows: 1, estimate: f.qty });
  }

  // THE COUNT FOLLOWS, LIKE THE MINUTES DO (cn-v1133): compare-and-set on the count the plan read (still
  // the line's figure before), never a bought or tool row. Zero rows = someone moved it meanwhile: his
  // now, and the difference is said instead of written over.
  const moved: string[] = [];
  for (const m of plan.move) {
    const { data, error } = await org(
      sb.from("material_list_items").update({ quantity: m.to }).eq("id", m.id).eq("list_id", listId).eq("purchased", false).eq("is_tool", false).eq("quantity", m.from),
      who.orgId,
    ).select("id");
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    if (data?.length) moved.push(m.description);
    else plan.countsDiffer.push({ description: m.description, shows: m.from, estimate: m.to });
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
    // TWO DOORS IN THE SAME SECOND (0393, material_items_list_source_key_uq): the other door (the take-off,
    // or another sync) may have written some of these keyed parts between this read and this write —
    // insertKeyedRows answers a refused batch by writing only the keys the list does not hold now.
    const k = await insertKeyedRows(sb, listId, who.orgId, newRows);
    inserted = k.inserted;
    if (k.error) return { ...NONE, rekeyed, removed, removedNames, kept, keptNames, inserted, error: dbError(k.error) };
  }

  return {
    inserted,
    rekeyed,
    removed,
    removedNames,
    kept,
    keptNames,
    leftOff: plan.leftOff,
    countsDiffer: plan.countsDiffer,
    ...(filled.length ? { filled } : {}),
    ...(moved.length ? { moved } : {}),
    ...(renamed.length ? { renamed } : {}),
  };
}

/** EVERY ACCEPTED ESTIMATE OF THE JOB that has a list, each brought in step. */
export async function syncJobMaterials(sb: SupabaseClient, who: MaterialsSyncWho): Promise<MaterialsSyncResult> {
  const { data: quotes, error } = await org(sb.from("quotes").select("id, accepted_at, created_at").eq("job_id", who.jobId).eq("status", "accepted"), who.orgId).order("accepted_at");
  if (error) return { ...NONE, error: dbError(error) };
  let total = NONE;
  for (const q of (quotes ?? []) as Array<{ id: string }>) total = add(total, await syncQuoteMaterials(sb, { ...who, quoteId: q.id }));
  return total;
}

/** What the estimate's materials list did, as a sentence — or null when nothing changed. */
export function materialsWords(r: MaterialsSyncResult, lead = "The estimate's materials list follows too"): string | null {
  const bits: string[] = [];
  if (r.inserted) bits.push(`${plural(r.inserted, "part", "parts")} added`);
  if (r.rekeyed) bits.push(`${r.rekeyed} matched`);
  if (r.removed) bits.push(`${r.removed} removed${few(r.removedNames)}`);
  if (r.kept) bits.push(`${r.kept} kept${few(r.keptNames)} — bought, or a tool`);
  if (r.leftOff.length) bits.push(`${r.leftOff.length} left off${few(r.leftOff)} — deleted from the list before`);
  if (r.filled?.length) bits.push(`${plural(r.filled.length, "count", "counts")} filled in${few(r.filled)}`);
  if (r.moved?.length) bits.push(`${r.moved.length} re-counted${few(r.moved)}`);
  if (r.renamed?.length) bits.push(`${r.renamed.length} renamed${few(r.renamed)}`);
  for (const c of r.countsDiffer.slice(0, 3)) bits.push(`${c.description} shows ${c.shows ?? "no count"}, the estimate says ${c.estimate}`);
  if (r.countsDiffer.length > 3) bits.push(`${r.countsDiffer.length - 3} more counts differ`);
  return bits.length ? `${lead}: ${bits.join(" · ")}.` : null;
}
