import type { SupplierDesk, SupplierPaperFeed } from "@/app/(app)/bills/supplier-papers";
import { supplierPaperTotals } from "@/app/(app)/bills/supplier-reconcile";
import { formatCurrency } from "@/lib/utils";
import { AFFORDANCES, KIND_STREAM, type ActionItem } from "./types";

/** The rollup's id. Synthetic: open-only, never dispatched (types.ts AFFORDANCES). */
export const SUPPLIER_PAPERS_ITEM_ID = "supplier-papers";
/** The "couldn't check" line's id. Synthetic too. */
export const SUPPLIER_DESK_UNREAD_ITEM_ID = "supplier-papers-unread";

/**
 * THE SUPPLIER BILLS, AS ONE LINE ON MY DAY (Bills plan, Wave A, 2026-09-25).
 *
 * "Hey you, here's a bill, what's it for?" Every paper that needs a person rides as a card inside
 * ONE item, so eleven CED papers badge the dock +1, not +11. The BADGE INVARIANT (types.ts) says a
 * count may never be the length of an unbounded set, and a supplier's backlog is exactly that: the
 * rollup is what makes it a bounded, decidable line. Null when nothing is waiting, so it never
 * sits on My Day saying "0".
 */
export function supplierPaperActionItem(feed: SupplierPaperFeed | null | undefined): ActionItem | null {
  const cards = feed?.cards ?? [];
  if (!cards.length) return null;
  const { count, total } = supplierPaperTotals(cards);
  const from = Array.from(new Set(cards.map((c) => c.supplier)));
  return {
    id: SUPPLIER_PAPERS_ITEM_ID,
    kind: "supplier_paper",
    stream: KIND_STREAM.supplier_paper,
    title: `Supplier Bills · ${count}`,
    subtitle: `${formatCurrency(total)} from ${from.length === 1 ? from[0] : "your suppliers"}, not in your books yet`,
    who: null,
    // Undated on purpose: the oldest paper is months old, and "98d overdue" in red would be a
    // deadline nobody set. The cards say their own dates.
    when: null,
    urgency: 1,
    done: false,
    href: "/bills#needs-you",
    affordances: AFFORDANCES.supplier_paper,
    supplierPapers: feed,
  };
}

/**
 * A FAILED READ SAYS SO ON MY DAY (audit v1018, class 2). The supplier desk (loadSupplierDesk) used
 * to turn any failed read into no cards and no Pay By line, which reads exactly like "nothing
 * waiting, no discount due": on Oct 8 that is a discount lost without a word. One undated,
 * staff-only line instead (the caller only asks for staff), badging once, pointing at /bills where
 * the same papers and figures are. Null when every read answered.
 */
export function supplierDeskFailedItem(desk: Pick<SupplierDesk, "failed"> | null | undefined): ActionItem | null {
  const failed = desk?.failed;
  if (!failed || !(failed.papers || failed.pay)) return null;
  return {
    id: SUPPLIER_DESK_UNREAD_ITEM_ID,
    kind: "supplier_paper",
    stream: KIND_STREAM.supplier_paper,
    title: "Supplier Bills · Couldn't Check",
    subtitle: failed.papers
      ? "Couldn't read your supplier papers just now, so any bill or discount waiting on you isn't here. Open Bills to see them."
      : "Couldn't check what's due to your suppliers just now, so a discount deadline may be missing here. Open Bills to see it.",
    who: null,
    // Undated on purpose: it is not a deadline, and it must never read as one.
    when: null,
    urgency: 1,
    done: false,
    href: "/bills",
    affordances: AFFORDANCES.supplier_paper,
  };
}
