import { formatCurrency } from "@/lib/utils";

/**
 * SHOP STOCK, TYPED IN (W1-FU-misc B): a stock purchase with no paper, from Add By Hand's Type It In.
 *
 * Before this, Shop Stock on the typed sheet was a door to Snap Or Note that threw away what was
 * typed, and a purchase with no ticket had no way in at all (an opening roll is a count, not a
 * purchase: its cost never lands in the month it was bought). Now the sheet saves it the way Snap Or
 * Note's Shop Stock does: a bill with no job, on_shelf, category Shop Stock, with ONE line (the item,
 * how many, the amount) that goes into stock as one roll (shelveLines), so Stock Bought counts it in
 * the month on the purchase, exactly like a ticket. No new money reader.
 *
 * Pure, so the sheet and the server action (inventory/actions addStockPurchase) say the same thing.
 */

export const STOCK_PICK_ITEM = "Pick or name the item.";
export const STOCK_HOW_MANY = "Type how many.";
export const STOCK_SAY_UNIT = "Say the unit.";
export const STOCK_SAY_WHERE = "Say where it was bought.";

/** What a typed stock purchase is: an item in stock (itemId) or a new one by name, how many in what
 *  unit, what it cost, the day, where it was bought, paid or on account, and a Bill # if it has one. */
export type StockPurchaseInput = {
  itemId?: string | null;
  newItemName?: string | null;
  pieces: number;
  unit: string;
  amount: number;
  date: string;
  where: string;
  paid: "paid" | "unpaid";
  billNumber?: string | null;
};

/** Pieces and money as they are stored: pieces to the hundredth (the ticket line's quantity
 *  column), money to the cent. */
export const roundPieces = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
export const roundMoney = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

/** "250", "12.5": a count the way a person writes it. */
export const piecesWords = (n: number) => String(roundPieces(n));

/**
 * WHY A TYPED STOCK PURCHASE CAN'T BE SAVED YET, in plain words, or null. The sheet checks the amount
 * and the day first (the typed sheet's own rules); these are the stock half, in this order.
 */
export function stockPurchaseProblem(f: Pick<StockPurchaseInput, "itemId" | "newItemName" | "pieces" | "unit" | "where">): string | null {
  if (!String(f.itemId ?? "").trim() && !String(f.newItemName ?? "").trim()) return STOCK_PICK_ITEM;
  if (!(roundPieces(f.pieces) > 0)) return STOCK_HOW_MANY;
  if (!String(f.unit ?? "").trim()) return STOCK_SAY_UNIT;
  if (!String(f.where ?? "").trim()) return STOCK_SAY_WHERE;
  return null;
}

/** On Account is never saved as paid: only Already Paid is. */
export const stockPurchaseStatus = (paid: unknown): "paid" | "unpaid" => (paid === "paid" ? "paid" : "unpaid");

/**
 * The purchase's ONE ticket line: the item's name, how many, and the amount (the extension is the
 * price). unit_price is the amount over the count, so the line's own columns agree with the count
 * (the shelf's receipt check reads them), and a Materials line, never Tax or Freight.
 */
export function stockPurchaseLine(input: { item: string; pieces: number; amount: number }) {
  const quantity = roundPieces(input.pieces);
  const amount = roundMoney(input.amount);
  return {
    description: input.item.trim().slice(0, 300),
    quantity,
    unit_price: quantity > 0 ? roundMoney(amount / quantity) : 0,
    amount,
    category: "Materials",
    billable: true,
  };
}

/** The toast, after it saved: "250 ft of 12/2 NM-B in stock, $180.00 from CED." */
export function stockPurchaseWords(input: { pieces: number; unit: string; item: string; amount: number; where: string }): string {
  return `${piecesWords(input.pieces)} ${input.unit.trim()} of ${input.item.trim()} in stock, ${formatCurrency(roundMoney(input.amount))} from ${input.where.trim()}.`;
}
