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
 * job's Tasks (the one live "Buy Materials · N Open" row), My Day's Now block and the /materials
 * cards. So the chip, the row and the list can never disagree about the number.
 */

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
 *   null              nothing on the list is a thing to buy (an empty list, or tools only): no row
 *   { open: 3 }       "Buy Materials · 3 Open", ONE open task while anything is left to buy
 *   { open: 0 }       done: every line to buy is bought. It reads "Buy Materials · All Bought" in the
 *                     Tasks tab's Done fold, so "Tasks: X of Y done" never shrinks when the buying
 *                     is finished, and a new line added later reopens it.
 */
export type BuyMaterials = { open: number } | null;

export function buyMaterials(items: readonly ChecklistLine[] | null | undefined): BuyMaterials {
  const toBuy = (items ?? []).filter((i) => !i.is_tool);
  if (toBuy.length === 0) return null;
  return { open: toBuy.filter((i) => !i.purchased).length };
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

/** What a tick on this line means, in words: a tool is GOT from the shop, never bought ("Got: Hammer
 *  drill", "Not Got Yet: Hammer drill"); everything else is bought. The tick is the same column. */
export function tickWord(line: ChecklistLine): "Got" | "Bought" {
  return line.is_tool ? "Got" : "Bought";
}

/** "3 to buy" / "Nothing left to buy": the plain words under a list (the footer, the /materials card). */
export function toBuyWords(open: number): string {
  return open > 0 ? `${open} to buy` : "Nothing left to buy";
}
