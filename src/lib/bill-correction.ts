import { formatCurrency } from "@/lib/utils";

/**
 * A BILL MAY CORRECT AN EARLIER BILL (0381): THE PLAN, THE WORDS AND THE ROW ORDER, IN ONE PLACE.
 *
 * Erik, 2026-10-04, with the supplier's invoice in hand for a counter ticket a customer had already
 * been billed for: "i cant find where to make a correction". The counter ticket was $613.19 with the
 * fixture priced at $0.00; the supplier's invoice for the same purchase said $709.18. Editing the
 * ticket's amount reached no invoice (a claimed bill is skipped by every later import), and a second
 * bill for the difference had nothing tying it to the first.
 *
 * THE SHAPE (Erik, 2026-10-07): the original stays as filed. The difference is its OWN bill row, with
 * its own claimable id, its own lines (materials itemized, never a lump) and its own paper, attached
 * UNDER the original by bills.corrects_bill_id. The pair reads as one purchase. The next invoice picks
 * the correction up like any bill on the job, because it IS a bill on the job. A negative correction
 * (a credit) rides the supplier-return path, which matches each credited line BY ITS WORDS to the
 * purchase lines on the job and credits at most what they billed - so every credited line here is
 * made to carry the words of a line the purchase really has, and it follows that line's billing
 * switch (question 5: "billable iff that line was billed").
 *
 * Pure on purpose: no database, every sentence and every cent pinned by bill-correction.test.ts.
 * The door (correctBill in jobs/actions.ts) does the reads and the two writes and nothing else.
 */

/** Whole cents. A cent is a real correction, and float noise must never decide one. */
export const toCents = (n: unknown): number => Math.round((Number(n) || 0) * 100);
const fromCents = (c: number): number => c / 100;

/** "+$95.99" / "−$51.58" (a true minus sign, never a dash). */
export function signedMoney(n: number): string {
  const c = toCents(n);
  return `${c < 0 ? "−" : "+"}${formatCurrency(Math.abs(fromCents(c)))}`;
}

/** A line's words as the return path compares them: case, punctuation and spacing are the scanner's. */
export function lineWords(desc: unknown): string {
  return String(desc ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A line the supplier's paper prints for tax. Stored with the category the receipt reader uses, so
 *  the importer rides it in the per-bill remainder row instead of marking it up as an item. */
const TAX_WORDS = /^(sales\s+)?tax\b/i;

/** The bill being corrected, as the door read it. */
export type CorrectionOriginal = {
  amount: number | string;
  /** The number on its own paper ("8802-SO-257899"), or null. */
  billNumber: string | null;
  /** The lines a credit may name: the original's own, and those of the corrections already under it. */
  lines: { description: string | null; amount?: number | string | null; billable?: boolean | null; category?: string | null }[];
  /** Corrections already attached under it: they are part of the purchase the paper totals. */
  corrections?: { billNumber: string | null; amount: number | string }[];
};

/** One line as the person typed it. No amount = it takes what is left of the difference. */
export type CorrectionLineInput = { description: string | null | undefined; amount?: number | null };

/** The line rows the door inserts, in order. */
export type CorrectionLineRow = {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  billable: boolean;
  category: string | null;
  sort_order: number;
};

export type CorrectionPlan =
  | {
      ok: true;
      /** The correction's own amount: the paper's total less what the purchase already counts. */
      delta: number;
      /** What the purchase comes to with this correction: the paper's total. */
      together: number;
      row: { amount: number; bill_number: string };
      lines: CorrectionLineRow[];
      /** Said once it is attached. */
      sentence: string;
    }
  | { ok: false; error: string };

const NOTHING = "Nothing was attached.";

/** The label the database's own refusals use for a bill (0381: coalesce(nullif(bill_number, ''), 'that bill')). */
export function billLabel(billNumber: string | null | undefined): string {
  return String(billNumber ?? "").trim() || "that bill";
}

/** What the purchase counts before this correction: the original and every correction under it. */
export function purchaseCents(original: Pick<CorrectionOriginal, "amount" | "corrections">): number {
  return toCents(original.amount) + (original.corrections ?? []).reduce((s, c) => s + toCents(c.amount), 0);
}

/** The live line under Paper Total: how far the paper is from the bill, in words. */
export function paperGapWords(original: Pick<CorrectionOriginal, "amount" | "corrections">, paperTotal: number): string {
  const gap = toCents(paperTotal) - purchaseCents(original);
  if (gap === 0) return "The same as the bill: nothing to correct.";
  return gap > 0 ? `${signedMoney(fromCents(gap))} more than the bill` : `${signedMoney(fromCents(gap))} less: a credit`;
}

/**
 * THE PLAN FOR ONE CORRECTION, or the one sentence that says why not.
 *
 *   - the paper needs its number and its total;
 *   - delta = the paper's total less what the purchase already counts (the original, plus any
 *     correction already under it); a delta of nothing is refused, there is nothing to correct;
 *   - a line with no amount takes what is left (one such line at most), and the lines must come to
 *     the delta to the cent;
 *   - a line BELOW zero is a credit: it must carry the words of a line the purchase has, and it
 *     follows that line's billing switch and its category, so the return path holds it to what the
 *     customer was billed and a tax credit stays tax;
 *   - a line above zero is a charge: billed to the customer (its switch is on the receipt card
 *     after, like any receipt line).
 */
export function planBillCorrection(input: {
  original: CorrectionOriginal;
  paperTotal: number | null | undefined;
  paperNumber: string | null | undefined;
  lines: CorrectionLineInput[];
  /** The job the original is on, as it reads to a person ("J-011 · <name>"); null = no job. */
  jobLabel?: string | null;
}): CorrectionPlan {
  const { original } = input;
  const paperNumber = String(input.paperNumber ?? "").trim();
  if (!paperNumber) return { ok: false, error: `Type the number printed on the supplier's paper in Paper Number. ${NOTHING}` };
  const totalRaw = Number(input.paperTotal);
  if (input.paperTotal === null || input.paperTotal === undefined || !Number.isFinite(totalRaw)) {
    return { ok: false, error: `Type what the supplier's paper says the purchase comes to in Paper Total. ${NOTHING}` };
  }
  const had = purchaseCents(original);
  const paper = toCents(totalRaw);
  const delta = paper - had;
  const corrected = (original.corrections ?? []).length > 0;
  if (delta === 0) {
    return {
      ok: false,
      error: `The paper says the same ${formatCurrency(fromCents(had))} the bill ${corrected ? "and its correction say" : "says"}. Nothing to correct.`,
    };
  }

  // Blank rows the form left are not lines.
  const typed = input.lines
    .map((l) => ({ description: String(l.description ?? "").trim(), amount: l.amount ?? null }))
    .filter((l) => l.description || l.amount !== null);
  if (!typed.length) return { ok: false, error: `Say what the difference is for (What Is It For?). ${NOTHING}` };
  const nameless = typed.find((l) => !l.description);
  if (nameless) {
    return { ok: false, error: `Give every line its words: what is the ${formatCurrency(Number(nameless.amount))} for? ${NOTHING}` };
  }
  const open = typed.filter((l) => l.amount === null || !Number.isFinite(Number(l.amount)));
  if (open.length > 1) {
    return { ok: false, error: `Give each line its amount: only one line can take what is left (${open[0].description}, ${open[1].description}). ${NOTHING}` };
  }
  const fixedCents = typed.filter((l) => !open.includes(l)).reduce((s, l) => s + toCents(l.amount), 0);
  const cents = typed.map((l) => (open.includes(l) ? delta - fixedCents : toCents(l.amount)));
  const zero = typed.find((_, i) => cents[i] === 0);
  if (zero) return { ok: false, error: `${zero.description} comes to $0.00, which corrects nothing. Give it its amount, or take the line off. ${NOTHING}` };
  const sum = cents.reduce((s, c) => s + c, 0);
  if (sum !== delta) {
    return {
      ok: false,
      error: `The lines come to ${signedMoney(fromCents(sum))} and the paper is ${formatCurrency(Math.abs(fromCents(delta)))} ${delta > 0 ? "more" : "less"} than the bill. Make them match. ${NOTHING}`,
    };
  }

  // A credit names a line the purchase has, by its words, and follows it.
  const known = original.lines
    .map((l) => ({ words: lineWords(l.description), description: String(l.description ?? "").trim(), billable: l.billable !== false, category: l.category ?? null }))
    .filter((l) => l.words);
  const rows: CorrectionLineRow[] = [];
  for (let i = 0; i < typed.length; i++) {
    const c = cents[i];
    const amount = fromCents(c);
    if (c < 0) {
      const match = known.find((k) => k.words === lineWords(typed[i].description));
      if (!match) {
        return {
          ok: false,
          error: `${typed[i].description} is not a line on ${billLabel(original.billNumber)}. A credit takes back a line the purchase has: pick it from the bill's lines. ${NOTHING}`,
        };
      }
      rows.push({ description: match.description, quantity: 1, unit_price: amount, amount, billable: match.billable, category: match.category, sort_order: i });
    } else {
      const description = typed[i].description.slice(0, 500);
      rows.push({ description, quantity: 1, unit_price: amount, amount, billable: true, category: TAX_WORDS.test(description) ? "Tax" : null, sort_order: i });
    }
  }

  const deltaMoney = fromCents(delta);
  const what = rows.length <= 3 ? rows.map((r) => r.description).join("; ") : `${rows.slice(0, 2).map((r) => r.description).join("; ")} and ${rows.length - 2} more`;
  const job = String(input.jobLabel ?? "").trim();
  const credited = rows.some((r) => r.amount < 0 && r.billable);
  const nextInvoice = !job
    ? ""
    : delta > 0
      ? ` The next invoice on ${job} carries the ${formatCurrency(deltaMoney)}.`
      : credited
        ? ` The next invoice on ${job} credits back what the customer was billed for it.`
        : " None of it was billed to the customer, so no invoice credits it.";
  const sentence =
    `${paperNumber} corrects ${billLabel(original.billNumber)}: ${signedMoney(deltaMoney)} (${what}). ` +
    `${corrected ? "Together they are" : "The pair is"} one purchase, ${formatCurrency(fromCents(paper))}.${nextInvoice}`;

  return { ok: true, delta: deltaMoney, together: fromCents(paper), row: { amount: deltaMoney, bill_number: paperNumber }, lines: rows, sentence };
}

// ── THE DOOR'S OWN REFUSALS, IN THE DATABASE'S WORDS (0381 guard_bill_correction) ───────────────

/** The bill asked to be corrected is itself a correction: one level only. */
export function correctionOfCorrectionRefusal(billNumber: string | null | undefined): string {
  return `${billLabel(billNumber)} is itself a correction. Attach this one to the bill it corrects. Nothing was changed.`;
}

/** The bill asked to be corrected was set aside as a duplicate (superseded_by_bill_id). */
export function setAsideOriginalRefusal(billNumber: string | null | undefined): string {
  return `${billLabel(billNumber)} was set aside as a duplicate. Correct the bill that was kept. Nothing was changed.`;
}

/** Before 0381 is on the database the door cannot attach anything, and says so with the one step. */
export const CORRECTIONS_NOT_READY =
  "Correct This Bill needs migration 0381 on the database, and it isn't there yet. Run it, then try again. Nothing was attached.";

/**
 * THE DELETE DOORS' PRE-CHECK: a bill carrying a correction stays until its correction goes. The
 * foreign key (ON DELETE RESTRICT) refuses too; this says it in words, first. `then` is the door's
 * own next step after that ("delete it again", "press Undo again"); `nothing` its closing words.
 */
export function carriesCorrectionRefusal(numbers: (string | null | undefined)[], then?: string | null, nothing = "Nothing was deleted."): string {
  const named = numbers.map((n) => String(n ?? "").trim()).filter(Boolean);
  const many = named.length > 1;
  const which = named.length ? ` (${named.join(", ")})` : "";
  return `This bill carries ${many ? "corrections" : "a correction"}${which}. Delete the ${many ? "corrections" : "correction"} first${then ? `, then ${then}` : ""}. ${nothing}`;
}

// ── THE ROWS: A CORRECTION SITS UNDER ITS ORIGINAL, AND BOTH SAY SO ─────────────────────────────

export type CorrectionRowLike = {
  id: string;
  corrects_bill_id?: string | null;
  amount: number | string;
  bill_number?: string | null;
  /** The number the row prints (/bills works it out: typed, stored, or read off the paper). */
  shownNumber?: string | null;
};

/** What a row says about the pair it belongs to. */
export type CorrectionFace =
  | { kind: "corrects"; originalId: string; originalNumber: string | null; words: string }
  | { kind: "correctedBy"; words: string; together: number };

const numberOf = (r: CorrectionRowLike | undefined): string | null => {
  const n = String(r?.shownNumber ?? r?.bill_number ?? "").trim();
  return n || null;
};

/**
 * Each row's line about its pair. A correction: "Corrects 8802-SO-257899". An original carrying
 * corrections: "Corrected by 8802-1109100 · $709.18 together". A correction whose original is not in
 * `rows` (filtered out by a search, another job's list) still says what it corrects when `originals`
 * can name it; otherwise "Corrects an earlier bill". Totals are the rows' own amounts, summed in cents.
 */
export function correctionFaces(rows: readonly CorrectionRowLike[], originals?: ReadonlyMap<string, CorrectionRowLike>): Map<string, CorrectionFace> {
  const byId = new Map(rows.map((r) => [String(r.id), r] as const));
  const out = new Map<string, CorrectionFace>();
  const under = new Map<string, CorrectionRowLike[]>();
  for (const r of rows) {
    const of = String(r.corrects_bill_id ?? "");
    if (!of) continue;
    under.set(of, [...(under.get(of) ?? []), r]);
    const orig = byId.get(of) ?? originals?.get(of);
    const originalNumber = numberOf(orig);
    out.set(String(r.id), { kind: "corrects", originalId: of, originalNumber, words: `Corrects ${originalNumber ?? "an earlier bill"}` });
  }
  for (const [of, kids] of under) {
    const orig = byId.get(of);
    if (!orig) continue;
    const together = fromCents(toCents(orig.amount) + kids.reduce((s, k) => s + toCents(k.amount), 0));
    const named = kids.map((k) => numberOf(k) ?? "a correction");
    out.set(of, { kind: "correctedBy", words: `Corrected by ${named.join(", ")} · ${formatCurrency(together)} together`, together });
  }
  return out;
}

/**
 * THE PAPER ORDER, KEEPING A PAIR TOGETHER (cn-v1063 sorts the bills by the day on the paper): each
 * correction moves to directly under its original, in the order the corrections came; everything
 * else keeps its place. A correction whose original is not in the list stays where it is.
 */
export function correctionsUnder<T extends { id: string; corrects_bill_id?: string | null }>(rows: readonly T[]): T[] {
  const ids = new Set(rows.map((r) => String(r.id)));
  const kids = new Map<string, T[]>();
  for (const r of rows) {
    const of = String(r.corrects_bill_id ?? "");
    if (of && ids.has(of) && of !== String(r.id)) kids.set(of, [...(kids.get(of) ?? []), r]);
  }
  const moved = new Set([...kids.values()].flat());
  const out: T[] = [];
  for (const r of rows) {
    if (moved.has(r)) continue;
    out.push(r);
    for (const k of kids.get(String(r.id)) ?? []) out.push(k);
  }
  return out;
}

/** Correct This Bill is drawn on a bill that is not itself a correction and not set aside, and only
 *  where the page could read the column (0381 on the database). */
export function canCorrect(bill: { corrects_bill_id?: string | null; superseded?: boolean | null; superseded_by_bill_id?: string | null }, ready: boolean): boolean {
  return ready && !bill.corrects_bill_id && !bill.superseded && !bill.superseded_by_bill_id;
}
