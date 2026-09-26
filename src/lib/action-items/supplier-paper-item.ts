import type { SupplierPaperFeed } from "@/app/(app)/bills/supplier-papers";
import { supplierPaperTotals } from "@/app/(app)/bills/supplier-reconcile";
import { formatCurrency } from "@/lib/utils";
import { AFFORDANCES, KIND_STREAM, type ActionItem } from "./types";

/** The rollup's id. Synthetic: open-only, never dispatched (types.ts AFFORDANCES). */
export const SUPPLIER_PAPERS_ITEM_ID = "supplier-papers";

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
