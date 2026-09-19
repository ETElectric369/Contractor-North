import "server-only";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { dbError } from "@/lib/db-error";

/**
 * STOCK ARRIVES FROM THE RECEIPT AND LEAVES THROUGH THE JOB.
 *
 * Erik, 2026-09-19, after taking 440 wire nuts off Jason Waldow's invoice with the column 0272
 * added ("billed_amount"):
 *
 *   "Maybe that will add to the stock if we have a record for it already i think we do i=but i
 *    havent used it much at all"
 *
 * He is right that it exists. `inventory_items`, a page at /inventory, four actions to keep it -
 * and ZERO rows. Not one. It has been in the app since migration 0002 and he has never once used
 * it, which is the only honest verdict on a stock list you have to remember to keep.
 *
 * ── THE RULE THIS FILE IS BUILT AROUND ──────────────────────────────────────────────────────
 * A HALF-KEPT INVENTORY IS WORSE THAN NO INVENTORY. An empty list says nothing and misleads
 * nobody. A list that was right in March reports "68 on hand" in September with exactly the same
 * confidence as a number that is true, and he orders against it, or prices against it. So the
 * only design that can work here is one with no step to forget: the count moves when the money
 * moves. Stock ARRIVES when he marks a receipt line as the company's own container (0272), and it
 * LEAVES when it goes on a job. There is no third door marked "remember to update inventory",
 * because that door is the one that rots.
 *
 * ── WHY MATCHING IS DELIBERATELY DUMB ───────────────────────────────────────────────────────
 * The second box of the same wire nuts must land on the SAME row, or the count is split across
 * twins and both are wrong. But merging two DIFFERENT parts into one count is the worse failure
 * of the two, because a twin is visible on the page (two rows, same name, he can see it and fix
 * it) and a bad merge is invisible (one row, one number, quietly the sum of two products). So the
 * matcher only ever compares on EXACT keys after normalising - part number stripped of its
 * punctuation, or the whole receipt description letter for letter. No fuzzy matching, no
 * substring, no "looks close enough". When it is not sure, it creates.
 *
 * ── THE CENT THAT ISN'T THERE ───────────────────────────────────────────────────────────────
 * IDEAL 30641: 500 Twister nuts for $108.36. Per nut that is $0.21672, and `unit_cost` is
 * numeric(12,2) - it can hold $0.22 and nothing finer. Multiply the rounded figure back out and
 * the box costs $110.00, which is $1.64 of money that never existed. So: full precision is
 * carried through the arithmetic here, the cent-rounded figure is written to the column because
 * that is all the column has, and the TRUE per-unit price is written in words into the item's
 * description ("That works out to $0.2167 each") where no rounding can eat it. When the true
 * price is under half a cent - a 5000-count bag - `unit_cost` is left NULL rather than written as
 * $0.00, because "we can't say in this column" is true and "it was free" is not.
 */

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE PURE PART. Every decision that can be made without the database is made here, so it can
   be asserted on directly - see stock-flow.test.ts. Nothing below this line touches Supabase.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

export type StockFromReceiptLineInput = {
  lineId: string;
  /** The receipt line exactly as it reads: "IDEAL 30641 500/5000 Twister 341-Tan". */
  description: string;
  /** What ONE CONTAINER cost on the receipt - $108.36 for the box, not 21 cents for a nut.
   *  (On the line that started this, `unit_price` and `amount` are both 108.36; the "500" sitting
   *  in `quantity` is the scanner reading a count out of the product NAME, which is exactly why
   *  0272 refuses to infer the count and asks a person instead.) */
  unitCost: number;
  /** How many the container holds. CONFIRMED BY A PERSON, never inferred. */
  containerCount: number;
  vendor: string | null;
  partNumber: string | null;
};

export type StockResult = { ok: true; inventoryItemId: string } | { ok: false; error: string };
export type DrawResult = { ok: true; remaining: number } | { ok: false; error: string };

/** A stock row, in the only shape the matcher needs to see it. */
export type MatchCandidate = {
  id: string;
  name: string;
  part_number: string | null;
  created_at?: string | null;
};

export type MatchDecision =
  | { kind: "match"; id: string; why: string }
  | { kind: "create"; why: string };

/** Money is only ever rounded at an edge. This is that edge. */
const toCents = (n: number) => Math.round(n * 100) / 100;

/**
 * A part number with its punctuation taken off: "30-641", "30 641" and "30641" are one part, and
 * every supply house writes it a different way. Letters are kept (a "4S-1/2" box is not a "4S"),
 * so this only ever collapses SEPARATORS, never content.
 */
export function normalisePartNumber(raw: string | null | undefined): string | null {
  const key = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return key.length ? key : null;
}

/**
 * A description reduced to its letters, digits and single spaces, for exact comparison only.
 * Digits are KEPT because they are the whole difference between a 341-Tan nut and a 342-Red one;
 * this is a case-and-punctuation fold, not a similarity score.
 */
export function normaliseName(raw: string | null | undefined): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

/** What a container's price is per unit, at both precisions - see "THE CENT THAT ISN'T THERE". */
export type ContainerCost = {
  /** Full precision. Use this for anything that multiplies or is written out in words. */
  perUnit: number;
  /** What numeric(12,2) can hold, or null when the truth is a positive number under half a cent. */
  storedUnitCost: number | null;
};

export function splitContainerCost(containerCost: number, containerCount: number): ContainerCost {
  const perUnit = containerCost / containerCount;
  const rounded = toCents(perUnit);
  // A true zero is worth storing: a returned or comped item really did cost nothing. A positive
  // price that rounds to zero is not - $0.00 on the page reads "free" and multiplies to nothing.
  const storedUnitCost = rounded === 0 && perUnit > 0 ? null : rounded;
  return { perUnit, storedUnitCost };
}

/**
 * The sentence to refuse with, or null to go ahead. Split out from the action so the refusals
 * themselves can be read in a test - a refusal a person cannot act on is the same dead end as a
 * button that does nothing.
 */
export function stockInputProblem(input: StockFromReceiptLineInput): string | null {
  if (!String(input.lineId ?? "").trim()) return "This receipt line has no id, so there's nothing to add.";
  if (!String(input.description ?? "").trim())
    return "This receipt line has no description, so there's nothing to name the stock item. Give the line a description first.";
  const count = Number(input.containerCount);
  if (!Number.isFinite(count) || count <= 0)
    return "Say how many the container holds before this becomes stock.";
  // A typo catcher, not a policy. Nobody buys a million of anything on one line, and a slipped
  // zero here would be a count he later orders against.
  if (count > 1_000_000) return "That count looks too big to be a container. Check it and try again.";
  const cost = Number(input.unitCost);
  if (!Number.isFinite(cost) || cost < 0) return "This line's cost didn't come through as a number.";
  return null;
}

/**
 * Which existing row this receipt line belongs on, or none.
 *
 * PRECEDENCE, and the reason for each step:
 *  1. Same part number -> that row. The strongest key there is.
 *  2. A part number we have, against a row that carries NONE -> that row, and we fill its part
 *     number in. A row with a DIFFERENT part number is never matched on name, because the part
 *     numbers disagreeing is the product telling us it is a different product.
 *  3. No part number either side -> exact normalised name.
 *  4. Anything else -> create.
 *
 * When several rows share a key they are already twins (hand-entered before this existed, or made
 * by a person). Adding to the oldest is deterministic and, unlike creating, does not make a third.
 */
export function chooseInventoryMatch(
  candidates: MatchCandidate[],
  key: { partNumber: string | null; description: string },
): MatchDecision {
  const wantPart = normalisePartNumber(key.partNumber);
  const wantName = normaliseName(key.description);
  const oldest = (rows: MatchCandidate[]) =>
    [...rows].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))[0];

  if (wantPart) {
    const samePart = candidates.filter((c) => normalisePartNumber(c.part_number) === wantPart);
    if (samePart.length) return { kind: "match", id: oldest(samePart).id, why: "same part number" };

    const sameNameNoPart = candidates.filter(
      (c) => !normalisePartNumber(c.part_number) && normaliseName(c.name) === wantName,
    );
    if (wantName && sameNameNoPart.length)
      return {
        kind: "match",
        id: oldest(sameNameNoPart).id,
        why: "same name, and that row carries no part number to disagree with this one",
      };

    return { kind: "create", why: "nothing on hand carries this part number" };
  }

  const sameName = wantName ? candidates.filter((c) => normaliseName(c.name) === wantName) : [];
  if (sameName.length) return { kind: "match", id: oldest(sameName).id, why: "same name" };
  return { kind: "create", why: "nothing on hand goes by this name" };
}

/** $0.2167, $1.50, $0.0024 - trailing zeros trimmed, but never fewer than two decimals. */
export function formatPerUnit(perUnit: number): string {
  if (!Number.isFinite(perUnit)) return "$0.00";
  const four = perUnit.toFixed(4).replace(/(\.\d\d)0+$/, "$1");
  return `$${four}`;
}

const money = (n: number) =>
  `$${(Number.isFinite(n) ? n : 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

/**
 * The line under the item's name on /inventory: where it came from, what the container cost, and
 * the per-unit price at full precision - the one place the cent that numeric(12,2) cannot hold
 * survives. Rewritten on every restock, because it describes the LAST purchase, and the edit
 * modal has no description field, so this is never overwriting something he typed.
 */
export function provenanceLine(input: {
  containerCount: number;
  containerCost: number;
  vendor: string | null;
}): string {
  const vendor = String(input.vendor ?? "").trim();
  const from = vendor ? ` from ${vendor}` : "";
  const each = formatPerUnit(input.containerCost / input.containerCount);
  const count = Number.isInteger(input.containerCount)
    ? String(input.containerCount)
    : String(toCents(input.containerCount));
  return `Last bought ${count} for ${money(input.containerCost)}${from}. That works out to ${each} each.`;
}

/**
 * Taking stock out: what is left, or why not.
 *
 * A draw bigger than what is on hand is a REFUSAL that says the real number. Clamping to zero
 * would be the app deciding that the shelf was right and he was wrong, silently - and the next
 * thing he does with that number is order against it.
 */
export function drawFrom(onHand: number, quantity: number): DrawResult {
  const have = Number(onHand);
  const want = Number(quantity);
  if (!Number.isFinite(want) || want <= 0) return { ok: false, error: "Say how many to take out." };
  if (!Number.isFinite(have)) return { ok: false, error: "This item's count didn't come through as a number." };
  if (want > have + 0.0001) {
    const left = toCents(have);
    return {
      ok: false,
      error:
        left <= 0
          ? "There's none of this left, so none can come out. Recount the shelf or add a receipt."
          : `There ${left === 1 ? "is" : "are"} only ${left} left, so ${toCents(want)} can't come out.`,
    };
  }
  return { ok: true, remaining: toCents(have - want) };
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE SERVER PART. requireStaff, org-scoped, .select("id") on every write.

   NOTE FOR ANYONE CALLING THESE: this file is deliberately NOT a "use server" module, because
   such a module may only export async server actions and every pure function above would have to
   leave (that is exactly why bill-itemisation.ts exists, cn-v952). Call these from inside your
   own "use server" action.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A receipt line becomes stock: the container's count lands on an inventory item at the price he
 * actually paid, and the line is marked as the company's own (0272's `is_stock`).
 *
 * THE LINE IS CLAIMED FIRST, AND THE CLAIM IS THE UPDATE ITSELF - `where id = ... and is_stock =
 * false`, one statement, zero rows means somebody got there first. A read-then-write here would
 * be the same check-then-insert shape that the v951 audit called critical on the invoice claim
 * trigger: two taps on a truck's bad connection, two reads that both say "not yet", and 1000 wire
 * nuts on the shelf that never existed. If the stock itself then fails to save, the claim is
 * handed back, because a line marked as stock with no stock behind it is a hole nothing can see.
 */
export async function stockFromReceiptLine(input: StockFromReceiptLineInput): Promise<StockResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This is staff-only." };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: "Your sign-in isn't attached to a company, so there's nowhere to put this stock." };

  const problem = stockInputProblem(input);
  if (problem) return { ok: false, error: problem };

  const containerCount = Number(input.containerCount);
  const containerCost = Number(input.unitCost);
  const description = String(input.description).trim();
  const partNumber = String(input.partNumber ?? "").trim() || null;
  const vendor = String(input.vendor ?? "").trim() || null;

  // ── 1. CLAIM THE LINE ───────────────────────────────────────────────────────────────────────
  const { data: claimed, error: claimErr } = await supabase
    .from("bill_line_items")
    .update({ is_stock: true })
    .eq("id", input.lineId)
    .eq("org_id", orgId)
    .eq("is_stock", false)
    .select("id");
  if (claimErr) return { ok: false, error: dbError(claimErr) };
  if (!claimed?.length) {
    // Zero rows has two causes and they are different sentences: the line is gone, or it was
    // already counted. Say which, because "it didn't work" is not something he can act on.
    const { data: row } = await supabase
      .from("bill_line_items")
      .select("id")
      .eq("id", input.lineId)
      .eq("org_id", orgId)
      .maybeSingle();
    return {
      ok: false,
      error: row
        ? "That line is already counted into stock, so nothing was added a second time."
        : "That receipt line isn't there any more. Reload the receipt and try again.",
    };
  }
  /** Hand the line back and say so if that itself did not take. The claim is a gate, not a record
   *  of anything having happened - and a line left claimed with no stock behind it is a hole that
   *  refuses every future attempt ("already counted") while the shelf stays empty. */
  const failed = async (message: string): Promise<StockResult> => {
    const { data: handedBack } = await supabase
      .from("bill_line_items")
      .update({ is_stock: false })
      .eq("id", input.lineId)
      .eq("org_id", orgId)
      .select("id");
    return {
      ok: false,
      error: handedBack?.length
        ? message
        : `${message} That line is also still marked as the company's own - reload the receipt and check it.`,
    };
  };

  // ── 2. FIND THE ROW IT BELONGS ON ───────────────────────────────────────────────────────────
  // The whole (active) list comes back and the matching happens in the pure function above,
  // because the keys are normalised ones Postgres cannot index on without a migration. One truck
  // and one shop is hundreds of rows, not thousands; the limit is a seatbelt, and if a list ever
  // reaches it the worst case is a visible twin, never a silent merge.
  const { data: rows, error: readErr } = await supabase
    .from("inventory_items")
    .select("id, name, part_number, quantity_on_hand, vendor, created_at")
    .eq("org_id", orgId)
    .eq("active", true)
    .order("created_at", { ascending: true })
    .limit(5000);
  if (readErr) return failed(dbError(readErr));

  type Row = MatchCandidate & { quantity_on_hand: number | string | null; vendor: string | null };
  const candidates = (rows ?? []) as Row[];
  const decision = chooseInventoryMatch(candidates, { partNumber, description });
  const cost = splitContainerCost(containerCost, containerCount);
  const provenance = provenanceLine({ containerCount, containerCost, vendor });

  // ── 3. ADD THE COUNT ────────────────────────────────────────────────────────────────────────
  if (decision.kind === "match") {
    const existing = candidates.find((c) => c.id === decision.id)!;
    // Number() it before adding. PostgREST hands this column back as a JSON number today, but the
    // Supabase client here is untyped, so nothing in the code says so - and if a string ever does
    // reach this line, "460" + 500 is "460500" and the shelf grows by a factor of a thousand.
    const onHand = Number(existing.quantity_on_hand ?? 0);
    if (!Number.isFinite(onHand))
      return failed("That stock item's count didn't come through as a number.");
    const patch: Record<string, unknown> = {
      quantity_on_hand: toCents(onHand + containerCount),
      description: provenance,
    };
    // The LAST price paid, not an average of it with older ones: what he wants off this page is
    // what the next box costs, and averaging cent-rounded figures only drifts further from the
    // receipt every time. Left alone entirely when the true per-unit is under half a cent, so a
    // 5000-count bag can never blank a price that was already there.
    if (cost.storedUnitCost !== null) patch.unit_cost = cost.storedUnitCost;
    if (partNumber && !normalisePartNumber(existing.part_number)) patch.part_number = partNumber;
    if (vendor && !String(existing.vendor ?? "").trim()) patch.vendor = vendor;

    const { data: saved, error: saveErr } = await supabase
      .from("inventory_items")
      .update(patch)
      .eq("id", existing.id)
      .eq("org_id", orgId)
      // Optimistic guard: if the count moved between the read above and this write, the add would
      // land on top of somebody else's and quietly lose theirs. Refuse instead and let him tap
      // again - a lost box is money, and a second tap is four seconds.
      .eq("quantity_on_hand", existing.quantity_on_hand)
      .select("id");
    if (saveErr) return failed(dbError(saveErr));
    if (!saved?.length)
      return failed("The count for that item changed while this was saving, so nothing was added. Try again.");
    revalidatePath("/inventory");
    return { ok: true, inventoryItemId: existing.id };
  }

  const { data: created, error: insertErr } = await supabase
    .from("inventory_items")
    .insert({
      org_id: orgId,
      // The receipt's own words. He recognises them, because they are what is printed on the
      // paper in his hand - "plain words" is sometimes just not paraphrasing.
      name: description.slice(0, 200),
      part_number: partNumber,
      description: provenance,
      unit: "ea",
      quantity_on_hand: toCents(containerCount),
      reorder_point: 0,
      unit_cost: cost.storedUnitCost,
      vendor,
    })
    .select("id");
  if (insertErr) return failed(dbError(insertErr));
  const newId = created?.[0]?.id as string | undefined;
  if (!newId) return failed("That stock item didn't save. Nothing was added - try again.");
  revalidatePath("/inventory");
  return { ok: true, inventoryItemId: newId };
}

/**
 * Stock leaves. Takes `quantity` off an item's count and says what is left.
 *
 * THE NOTE HAS NOWHERE TO LIVE YET, and pretending otherwise would be the silent half of a lie.
 * There is no stock-movement ledger in this schema - `inventory_items` holds a count and nothing
 * about how it got there - and this wave deliberately adds no migration. So `note` travels as far
 * as this function and no further: it is NOT saved. Whatever calls this must not tell a person
 * their note was kept. When the ledger lands (one row per arrival and per draw, with the job on
 * it), this is where it gets written, and the signature will not have to change.
 */
export async function drawStockForJob(input: {
  inventoryItemId: string;
  quantity: number;
  note: string | null;
}): Promise<DrawResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This is staff-only." };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: "Your sign-in isn't attached to a company." };

  const { data: item, error: readErr } = await supabase
    .from("inventory_items")
    .select("id, quantity_on_hand")
    .eq("id", input.inventoryItemId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: dbError(readErr) };
  if (!item) return { ok: false, error: "That stock item isn't there any more. Reload the page and try again." };

  // Untyped client: Number() on the way in, so the arithmetic can't be string concatenation.
  const decided = drawFrom(Number(item.quantity_on_hand), input.quantity);
  if (!decided.ok) return decided;

  const { data: saved, error: saveErr } = await supabase
    .from("inventory_items")
    .update({ quantity_on_hand: decided.remaining })
    .eq("id", input.inventoryItemId)
    .eq("org_id", orgId)
    // Same optimistic guard as the arrival path, for the sharper reason: two jobs drawing the
    // last of something at the same time must not both be told they got it.
    .eq("quantity_on_hand", item.quantity_on_hand)
    .select("id");
  if (saveErr) return { ok: false, error: dbError(saveErr) };
  if (!saved?.length)
    return {
      ok: false,
      error: "What's on hand changed while this was saving, so nothing was taken out. Reload and try again.",
    };

  revalidatePath("/inventory");
  return { ok: true, remaining: decided.remaining };
}
