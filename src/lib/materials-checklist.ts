/**
 * THE JOB'S MATERIALS LIST IS A CHECKLIST (Erik, 2026-09-27: "in Materials, this is really just a
 * checklist and the checked boxes can fold away and the badge should only show whats open to be
 * purchased which creates a task").
 *
 * No new state. "Checked" is the column the list has had since 0053: `purchased` (with its
 * `purchased_at`), ticked by setMaterialItemPurchased from the office's editor, the crew's editor
 * and Nort's material.markPurchased alike. This file only decides what a line MEANS:
 *
 *   Open To Buy   not checked, and not a tool. A tool is grabbed from the shop, never bought, so an
 *                 unchecked tool is never "to buy" (the rule My Day's Materials Needed feeder has
 *                 always used, action-items/query.ts). It still stays up top until it is checked.
 *   Bought        checked. Folds away into one "Bought (N)" fold; unchecking brings it back up.
 *
 * Every reader of "what's open on this list" goes through here: the Materials chip's count, the
 * job's Tasks (the one live "Buy Materials · N Open" row), My Day's Now card and the /materials
 * cards. So the chip, the row and the list can never disagree about the number.
 *
 * THE OPEN LINES RIDE THE ROW (Erik, 2026-11-07: "tasks showing buy materials should just show the
 * materials as sub items right there on that screen"). buyMaterials carries the open lines with the
 * count — id, list, description, quantity, unit, the crew's projection's own fields — so the job's
 * Tasks card draws each one under the row and a tap there buys it: the same `purchased` column, the
 * same setMaterialItemPurchased write the editor's tick makes (tickBuyLine below is the tap's one
 * round trip, the write handed in). Still no price near the row.
 */
import { fmtQty } from "@/lib/stock-take";

/** The two columns a checklist reads. Both are on the crew's projection (TECH_ITEM_COLUMNS): neither
 *  is money. */
export type ChecklistLine = { purchased?: boolean | null; is_tool?: boolean | null };

/** Still to buy: not checked off, and not a tool. */
export function isOpenToBuy(it: ChecklistLine): boolean {
  return !it.purchased && !it.is_tool;
}

/** How many lines are still to buy. The Materials badge; 0 = no badge. */
export function openToBuyCount(items: readonly ChecklistLine[] | null | undefined): number {
  return (items ?? []).filter(isOpenToBuy).length;
}

/**
 * What the list draws, top to bottom: the tools still to grab, the materials still to buy, and the
 * Bought fold (every checked line, tools too). Order inside each group is the list's own
 * (sort_order): filter() is stable, so nothing is reshuffled but the checked lines moving down.
 */
export function checklistGroups<T extends ChecklistLine>(items: readonly T[]): { tools: T[]; toBuy: T[]; bought: T[] } {
  return {
    tools: items.filter((i) => !i.purchased && !!i.is_tool),
    toBuy: items.filter((i) => !i.purchased && !i.is_tool),
    bought: items.filter((i) => !!i.purchased),
  };
}

/**
 * THE LIVE ROW ON THE JOB'S TASKS: read from the list every time, never copied into the tasks table
 * (so there is nothing to keep in sync, and nothing for a check-off to disagree with).
 *
 *   null                     nothing on the list is a thing to buy (an empty list, or tools only): no row
 *   { open: 3, lines: […] }  "Buy Materials · 3 Open", ONE open task while anything is left to buy; the
 *                            three open lines ride along, each a sub-row the card can tick
 *   { open: 0, lines: [] }   done: every line to buy is bought. It reads "Buy Materials · All Bought" in
 *                            the Tasks tab's Done fold, so "Tasks: X of Y done" never shrinks when the
 *                            buying is finished, and a new line added later reopens it.
 */
export type BuyMaterials = { open: number; lines: BuyLine[] } | null;

/** A line the row carries, ready to draw and to tick: the crew's projection's own fields
 *  (TECH_ITEM_COLUMNS), never a cost or a vendor. */
export type BuyLine = { id: string; list_id: string | null; description: string | null; quantity: number | null; unit: string | null };

/** What buyMaterials reads: the two checklist columns, and the line's fields when the reader selected
 *  them (a numeric can arrive as a string from PostgREST). */
export type BuyMaterialsInput = ChecklistLine & {
  id?: string | null;
  list_id?: string | null;
  description?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  sort_order?: number | null;
};

/** The list's own order: sort_order, a line with none last; then the words, so two lines that share
 *  a slot (or came with none) still land the same way every read. */
const lineOrder = (i: BuyMaterialsInput) => (typeof i.sort_order === "number" && Number.isFinite(i.sort_order) ? i.sort_order : Number.MAX_SAFE_INTEGER);
const byList = (a: BuyMaterialsInput, b: BuyMaterialsInput) => lineOrder(a) - lineOrder(b) || (a.description ?? "").localeCompare(b.description ?? "");

export function buyMaterials(items: readonly BuyMaterialsInput[] | null | undefined): BuyMaterials {
  const toBuy = (items ?? []).filter((i) => !i.is_tool);
  if (toBuy.length === 0) return null;
  const open = toBuy.filter((i) => !i.purchased);
  // THE COUNT IS EVERY OPEN LINE, id or not: My Day's Now card reads the list with only the two
  // checklist columns (material_list_items(purchased, is_tool)) and its count must stay the badge's
  // (openToBuyCount's, to the line). THE LINES ARE THE ONES A TAP CAN REACH: a line with no id has
  // no row to write, so it is counted and not drawn. In the list's own order whatever order the rows
  // came in (never trusting the read's order, like newestListPerJob).
  const lines: BuyLine[] = [...open]
    .filter((i) => !!i.id)
    .sort(byList)
    .map((i) => {
      const q = Number(i.quantity);
      return {
        id: String(i.id),
        list_id: i.list_id ?? null,
        description: i.description ?? null,
        quantity: i.quantity == null || i.quantity === "" || !Number.isFinite(q) ? null : q,
        unit: i.unit ?? null,
      };
    });
  return { open: open.length, lines };
}

/** The sub-row's words: "12/2 Romex · 250 ft", "Wire Nuts · 2 ea", and "Wire Nuts" alone when the line
 *  has no count (null or 0). The count the way a person says it (fmtQty: 2, never 2.00) and the unit
 *  only beside a count. The description is the list's own words, so it is never re-cased. */
export function buyLineWords(line: Pick<BuyLine, "description" | "quantity" | "unit">): string {
  const name = (line.description ?? "").trim();
  const q = line.quantity ?? 0;
  const unit = (line.unit ?? "").trim();
  const count = q > 0 ? (unit ? `${fmtQty(q)} ${unit}` : fmtQty(q)) : "";
  return [name, count].filter(Boolean).join(" · ");
}

/** What a tick on a sub-row names, in the toast and the aria ("Bought: 12/2 Romex"): the description,
 *  or the whole line's words when the description is empty, so nothing is ever "Bought: ". */
export function buyLineName(line: Pick<BuyLine, "description" | "quantity" | "unit">): string {
  return (line.description ?? "").trim() || buyLineWords(line);
}

/**
 * THE SUB-ROW'S TAP: one tick's round trip, the write handed in (materials/actions
 * setMaterialItemPurchased, the same door the editor's checkbox and Nort's markPurchased use), so the
 * card's tests run it against a stub the way lib/job-tasks undoCheckOff takes its reopen (this harness
 * renders markup, it clicks nothing). The line is struck first (show), the write runs, and a refusal
 * puts it back and says why — with the write's own sentence when it has one, else `failed`, and
 * `offline` when the server could not be reached at all. A tick that landed says "Bought: 12/2 Romex"
 * with an Undo that is this same round trip the other way, quiet when it lands (the line back on the
 * list is the answer). The page is re-read after a write that landed, so the count, the row's words
 * and the fold follow the server, never a client-side guess. Resolves true when the write landed.
 */
export type BuyLineWrite = (itemId: string, listId: string, purchased: boolean) => Promise<{ ok: boolean; error?: string }>;
export type BuyLineTickPorts = {
  write: BuyLineWrite;
  /** Draw the line struck (true) or open again (false): the optimistic mark, before the write answers. */
  show: (bought: boolean) => void;
  /** Say it (the toast); a tick that landed carries its Undo. */
  say: (text: string, tone: "success" | "error", undo?: { label: string; onClick: () => void }) => void;
  /** Re-read the page once a write landed. */
  refresh: () => void;
  /** The words in the person's language (this file reads no catalog): the tick's sentence, the Undo
   *  door, a refusal that came with no words, and no server. */
  words: { ticked: string; undo: string; failed: string; offline: string };
};

export async function tickBuyLine(line: Pick<BuyLine, "id" | "list_id">, next: boolean, ports: BuyLineTickPorts): Promise<boolean> {
  ports.show(next);
  // The list id rides the write for the list page's revalidation only (the row is found by its id), so
  // a line read without one still writes.
  const res = await ports.write(line.id, line.list_id ?? "", next).catch((): { ok: boolean; error?: string } => ({ ok: false, error: ports.words.offline }));
  if (!res.ok) {
    ports.show(!next);
    ports.say(res.error ?? ports.words.failed, "error");
    return false;
  }
  if (next) ports.say(ports.words.ticked, "success", { label: ports.words.undo, onClick: () => void tickBuyLine(line, false, ports) });
  ports.refresh();
  return true;
}

/** The row's words: "Buy Materials · 3 Open", or "Buy Materials · All Bought". */
export function buyMaterialsTitle(row: { open: number }): string {
  return row.open > 0 ? `Buy Materials · ${row.open} Open` : "Buy Materials · All Bought";
}

/** How the live row counts on the Tasks chip and in "Tasks: X of Y done": one task, open while
 *  anything is left to buy. */
export function buyMaterialsCounts(row: BuyMaterials): { total: number; done: number; open: number } {
  if (!row) return { total: 0, done: 0, open: 0 };
  return row.open > 0 ? { total: 1, done: 0, open: 1 } : { total: 1, done: 1, open: 0 };
}

/**
 * THE JOB'S LIST, when a reader has every list on a set of jobs: the newest per job, id breaking a
 * created_at tie (canonicalListIdForJob's rule in materials/actions, the job page's jobLists[0], the
 * planner's Now card). A job can hold an older list too (the office's New List, a lost race in
 * ensureJobMaterialList), and a reader that summed every list would badge lines nobody can see on
 * the job's Materials tab. Order-independent: it never trusts the rows' order.
 */
export function newestListPerJob<T extends { job_id: string | null; created_at: string | null; id: string }>(
  lists: readonly T[] | null | undefined,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const l of lists ?? []) {
    if (!l.job_id) continue;
    const have = out.get(l.job_id);
    const newer =
      !have ||
      (l.created_at ?? "") > (have.created_at ?? "") ||
      ((l.created_at ?? "") === (have.created_at ?? "") && l.id > have.id);
    if (newer) out.set(l.job_id, l);
  }
  return out;
}

/** What a tick on this line means, in words: a tool is GOT from the shop, never bought ("Got: Hammer
 *  drill", "Not Got Yet: Hammer drill"); everything else is bought. The tick is the same column. */
export function tickWord(line: ChecklistLine): "Got" | "Bought" {
  return line.is_tool ? "Got" : "Bought";
}

/** How long a crew member's Tell the Office ask may be AS A LINE. The line is a thing to buy: it rides
 *  the Materials badge, Buy Materials, the PO seed and the pick-list print, so it stays a line's
 *  length (the old task title's 120). The whole ask still reaches the office, in the bell. */
export const ASK_LINE_MAX = 120;

/** The list line a Tell the Office ask becomes: one line (newlines and runs of spaces folded), and
 *  at most ASK_LINE_MAX characters, cut at a word where one is near and marked "…" when cut. */
export function askLine(text: string): string {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  if (one.length <= ASK_LINE_MAX) return one;
  const room = one.slice(0, ASK_LINE_MAX - 1);
  const space = room.lastIndexOf(" ");
  return `${(space >= ASK_LINE_MAX * 0.6 ? room.slice(0, space) : room).trimEnd()}…`;
}

/** "3 to buy" / "Nothing left to buy": the plain words under a list (the footer, the /materials card). */
export function toBuyWords(open: number): string {
  return open > 0 ? `${open} to buy` : "Nothing left to buy";
}
