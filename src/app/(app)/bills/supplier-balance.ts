/**
 * WHAT HE OWES A SUPPLIER, AND WHAT THAT SENTENCE IS MADE OF (Erik, 2026-09-18; migration 0270).
 *
 * His Bills screen opens on Unpaid: $13,040.07 across 21 bills, and every dollar of it is ONE CED
 * account wearing five different spellings. He asked whether that was what made his margins red.
 * It is not - job profit is cash collected minus cost, and a bill costs the job the moment it
 * exists - but the question found a real hole: there was no way to record PAYING a supplier at
 * all, only a checkbox that flips one bill paid (bills-receipts.tsx:320). That checkbox has never
 * fit how he pays:
 *
 *   "yes i pay them in chunks that never match the ticckets"
 *
 * So the balance is the same Earned-minus-Paid shape payroll got two nights ago, for the same
 * reason: OWED = the account's unpaid bills MINUS its live payments. A payment is a chunk of
 * money, not a tick against a ticket, and recording one does not flip a single bill.
 *
 * `bills.status` keeps the meaning it has always had - HOW the thing was bought: 'unpaid' is on
 * account, 'paid' is settled at the register on the spot. A register receipt is not part of a
 * running balance and never was, but it is still money he spent there, so it is reported beside
 * the balance rather than swallowed. A figure that quietly disappears is the thing that makes a
 * man stop trusting a screen.
 *
 * Every function here is pure and every number is rounded to the cent at the point it is summed,
 * because the card, the payment sheet's preview and the inline sentence after a write all have to
 * agree to the penny or the screen is arguing with itself.
 *
 * ── AND THEN THE SUPPLIER SPOKE (Erik, 2026-09-19; migration 0273) ─────────────────────────────
 *
 * He got into his CED payment portal and downloaded every document. Forty-seven of them parsed and
 * reconciled to the cent, and they said the app was wrong:
 *
 *     CED says he owes $3,845.14 gross across 20 open documents.   This app said $6,476.93.
 *
 * Earned-minus-Paid was not a bug. It is the RIGHT shape when nobody can tell you which invoices a
 * cheque settled, which was true of every supplier in this app until that download. It becomes
 * WRONG the instant the supplier tells you, and it does so in the most dangerous way available -
 * quietly, and in his favour. Nine of his bills turned out to be already settled at CED, so they
 * were flipped paid; the app then read $7,360.93 of unpaid bills minus $6,000 of live payments =
 * $1,360.93. But that $6,000 is the very money CED used to CLOSE those nine. Subtracting it again
 * counts the same dollars twice, in the other direction, and hands him a number $2,484.21 too
 * small to write a cheque against. $1,360.93 is the figure this module exists to never produce
 * again, and there is a test named after it below.
 *
 * SO THERE ARE TWO MODELS AND THEY MUST NEVER BE MIXED:
 *
 *   A. no supplier data   ->  Owed = unpaid bills MINUS live payments.   Still right. Still the
 *                             shape for every account except CED today.
 *   B. supplier invoices  ->  Owed = the sum of open_balance where closed = false, and PAYMENTS
 *                             ARE NOT SUBTRACTED. They are already inside what the supplier
 *                             closed. Exact, and it is what CED itself says.
 *
 * The balance says WHICH model it used (`model`), because a card showing a number he can check
 * against a portal has to be able to explain where the number came from. Under model B the payment
 * ledger does not disappear - it stops being an input to the balance and becomes what he actually
 * SENT, for matching against his bank statement. Two true facts side by side. Never subtracted
 * from each other.
 *
 * AND A GROSS FIGURE IS NOT A CHEQUE. CED's own headline is $3,819.66, which is the $3,845.14 of
 * open balances minus $25.48 of prompt-pay discount that survives to the 10th of October. Both
 * numbers are true, they are different numbers, and the portal proves they are both printed. He
 * paid $60.42 of late interest at 1.5% a month while $25.99 of discount expired unclaimed on
 * documents he was holding, so this module names the discount out loud, names what is still
 * claimable, names what waiting costs, and names what is already gone.
 */

/** The methods migration 0270 lets `supplier_payments.method` be. */
export const SUPPLIER_PAY_METHODS = ["cash", "check", "transfer", "card", "other"] as const;
export type SupplierPayMethod = (typeof SUPPLIER_PAY_METHODS)[number];

/** Round to the cent. Money is summed in floats everywhere in this app; this is where it stops. */
export const r2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export interface SupplierPaymentRow {
  id: string;
  amount: number;
  /** A wall-calendar day, "YYYY-MM-DD". Never a timestamp - a payment happened on a DAY. */
  paidOn: string;
  method: string;
  reference: string | null;
  note: string | null;
  /** True once `voided_at` is set. A void stays on the list, crossed out: the history is his. */
  voided: boolean;
}

export interface SupplierBillRow {
  id: string;
  /** The free-text spelling the receipt reader wrote, kept so he can recognise the row. */
  supplier: string;
  billDate: string | null;
  amount: number;
  /** bills.status - 'unpaid' (on account) or 'paid' (settled at the register). */
  status: string;
  jobId: string | null;
  jobName: string | null;
  /** The supplier's OWN invoice number (CED: 8802-1101363), when it is known. */
  invoiceNumber: string | null;
  /** True when one document covers several of the supplier's invoices (the email import). */
  isStatement: boolean;
}

/**
 * ONE DOCUMENT THE SUPPLIER ITSELF ISSUED (`supplier_invoices`, migration 0273) - as opposed to a
 * `bills` row, which is a piece of paper this app scanned. Only the supplier can say whether one
 * of these is settled, which is the entire reason the table, and model B, exist.
 */
export interface SupplierInvoiceRow {
  id: string;
  /** Their number, branch and all: "8802-1103832". What he reads off the portal. */
  invoiceNumber: string;
  /** invoice | credit_memo | service_charge | statement. A string, not a union, because a kind
   *  some later migration adds must not crash a balance - see `openBalanceOf` below. */
  kind: string;
  invoiceDate: string | null;
  dueDate: string | null;
  /** CED's own JOB NAME, verbatim: "5659 RHODESIA", "5661 RHODESIA", "5659 RODESSIA". Kept raw
   *  and never matched to a job by machine - he has five jobs on that one road. */
  jobNameRaw: string | null;
  /** Where a PERSON said it belongs. Null until one does. */
  jobId: string | null;
  total: number;
  /**
   * What the supplier says is STILL OWED on this document. Nullable in the schema, so a document
   * that is open and prints no open balance falls back to its total - see `openBalanceOf`.
   */
  openBalance: number | null;
  /** The supplier's verdict. The only authority on this question there has ever been. */
  closed: boolean;
  /** "CASH DISCOUNT 11.87 OFF TOTAL DUE IF PAID BY THE 10TH OF THE MONTH FOLLOWING PURCHASE." */
  discountAmount: number | null;
  /** The day that discount stops being available. Both halves matter or neither does. */
  discountBy: string | null;
  /** The file it was read out of, so a figure on screen can be traced back to a document. */
  sourceFile?: string | null;
}

export interface SupplierAccountRow {
  id: string;
  /** What he calls them: "CED Truckee". */
  name: string;
  /** The number on the statement: TR-34426. Null for a counter with no account. */
  accountNumber: string | null;
  branchCode: string | null;
  /** False for a vendor he pays at the register. Those have no running balance, ever. */
  onAccount: boolean;
  note: string | null;
  /** Every spelling filed onto this account, with the branch it is when it is a branch. */
  aliases: { alias: string; branchLabel: string | null }[];
  bills: SupplierBillRow[];
  /** Newest first, voided ones included. */
  payments: SupplierPaymentRow[];
  /**
   * THE SUPPLIER'S OWN DOCUMENTS, when they have been loaded. Optional, and absent is the normal
   * case: every account in this app except CED has none, and an account with none keeps model A
   * exactly as it was. The presence of even one row here is what switches the balance to model B,
   * because one row means somebody has told us which documents are settled.
   */
  supplierInvoices?: SupplierInvoiceRow[];
}

/**
 * WHICH ARITHMETIC PRODUCED `owed`. The card has to be able to say this out loud: one of these
 * numbers can be checked line by line against a portal and the other cannot, and a man deciding
 * how much to trust a figure is entitled to know which one he is looking at.
 */
export type SupplierBalanceModel =
  /** A. Unpaid bills minus live payments. Right when nobody knows which invoices a cheque settled. */
  | "bills-minus-payments"
  /** B. The sum of what the supplier still calls open. Payments are NOT subtracted - they are
   *  already inside what the supplier closed, and taking them off again is the $1,360.93 bug. */
  | "supplier-invoices";

/**
 * WHAT THE SUPPLIER SAYS, with the discount broken out, because a gross figure and a cheque are
 * different numbers and his portal prints both.
 */
export interface SupplierSaysBalance {
  /** Sum of open_balance where closed = false. CED: $3,845.14. THE GROSS. */
  gross: number;
  /** How many documents that is. CED: 20. */
  openDocuments: number;
  /**
   * Open documents that printed no open balance, so their full total was used instead. Surfaced
   * rather than buried: it is the one place this figure is an assumption, and the lean is toward
   * money he may still owe rather than a number that is quietly too small.
   */
  assumedFromTotal: number;
  /** Credit memos among the open documents - money the supplier owes HIM, which is why the gross
   *  can be smaller than the invoices in it. Counted, never skipped. */
  creditMemos: number;
  /** Prompt-pay discount still claimable as of `today`: discount_by >= today, not closed. */
  discountStillClaimable: number;
  /**
   * Discount on documents he is still holding whose day has already gone. CED: $25.99 - lost
   * while $60.42 of late interest was being charged at 1.5% a month. This number is the reason
   * the rest of this interface exists.
   */
  discountExpiredUnclaimed: number;
  /** Discount printed with no date to claim it by. Neither claimable nor expired - unknown, and
   *  said so rather than folded into whichever bucket flatters the screen. */
  discountUndated: number;
  /** gross minus discountStillClaimable: the cheque if he writes it TODAY. */
  netIfPaidToday: number;
  /** The soonest discount deadline still ahead, so the card can name a date. */
  nextDiscountBy: string | null;
  /** What is riding on that date - what he loses by letting it pass. */
  nextDiscountAmount: number;
  /** Oldest open document, and its age against the ORG's today. */
  oldestOpen: string | null;
  oldestOpenDays: number | null;
}

/**
 * A CHEQUE DATED A PARTICULAR DAY. `supplierNetIfPaidBy(invoices, "2026-10-10", today)` is how
 * CED's own headline is reproduced: $3,845.14 gross, $25.48 of discount alive on the 10th,
 * $3,819.66 net. Waiting that long forfeits $4.14 that is claimable today, and `forfeited` is
 * that number, named, so nothing about the decision is hidden behind a date picker.
 */
export interface SupplierPayByFigure {
  /** Unchanged whatever day he pays. */
  gross: number;
  /** Prompt-pay discount still alive on `payBy`. */
  discount: number;
  /** gross minus discount. THE AMOUNT ON THE CHEQUE. */
  net: number;
  /** Discount alive today that would be gone by `payBy`. What waiting costs. */
  forfeited: number;
  /** The documents that would forfeit it, by invoice number, so the card can name them. */
  forfeitedInvoices: string[];
}

export interface SupplierBalance {
  /** Bills bought ON ACCOUNT (status 'unpaid') - the only thing a balance is made of. */
  charged: number;
  chargedBills: number;
  /** Bills settled at the register. Reported, never in the balance. */
  settledAtRegister: number;
  settledBills: number;
  /** Live (non-voided) payments. */
  paid: number;
  livePayments: number;
  /**
   * THE NUMBER. Under model A it is charged minus paid. Under model B it is `supplierSays.gross`
   * and the payments are NOT in it - see the header, and the $1,360.93 test.
   *
   * NULL for a pay-at-the-register supplier with no supplier documents, which has no running
   * balance and must not be given one. A zero would read as "paid up", which is a different
   * sentence and not a true one. If the supplier itself has issued open documents against that
   * account, the figure is theirs and it is shown - that is not pretending, that is a fact with a
   * document behind it - and `unpaidOnRegisterAccount` goes up beside it so the contradiction is
   * on screen rather than in the arithmetic.
   */
  owed: number | null;
  /** Which arithmetic produced `owed`. The card explains the number with this. */
  model: SupplierBalanceModel;
  /** Model B's working, or NULL under model A. Never zeros: an account with no supplier documents
   *  has no gross, no discount and no deadline, and inventing a $0.00 discount for it would be a
   *  figure nobody wrote. */
  supplierSays: SupplierSaysBalance | null;
  oldestUnpaid: string | null;
  /** How old that oldest unpaid bill is, in days, against the ORG's today (never the browser's). */
  oldestUnpaidDays: number | null;
  lastPayment: SupplierPaymentRow | null;
  /**
   * The EARLIEST live payment, so the ledger can say "you have sent them $6,000.00 since 5 August"
   * beside "CED says you owe $3,845.14". Two true facts. Under model B they are never subtracted
   * from each other; the sentence exists so he can tick the chunks off against his bank statement,
   * which is the job the ledger actually does once the supplier is the authority on the balance.
   */
  firstPayment: SupplierPaymentRow | null;
  /** True when one of the open bills is a STATEMENT covering several of their invoices. A payment
   *  sheet that offers to match an invoice number needs to know it cannot here. */
  hasStatements: boolean;
  /**
   * A register account that somehow carries unpaid bills. Not a crash and not a number to bury:
   * the card says it out loud and points at the door that fixes it.
   *
   * THIS STAYS EXACTLY WHAT IT WAS - unpaid BILLS, nothing else. The card writes a sentence off
   * it that counts bills and quotes `charged` ("2 bills are still marked unpaid ... holding
   * $456.02"), so widening it to cover supplier documents would have made that sentence read
   * "0 bills ... holding $0.00" on the one account it fired for. A second flag below carries the
   * new case instead, with its own number to say.
   */
  unpaidOnRegisterAccount: boolean;
  /**
   * A register account against which the SUPPLIER still has open documents. The same contradiction
   * wearing the 0273 clothes, and it needs its own sentence because it has its own figure:
   * `supplierSays.gross`, not `charged`.
   */
  openDocumentsOnRegisterAccount: boolean;
}

/** On account, i.e. still carrying a balance. Anything not explicitly 'paid' counts as owed.
 *
 *  The lean is deliberate: a null status, a typo, a status some later migration adds should all
 *  show up as money he may still owe and be argued with on screen, rather than quietly leave the
 *  balance and make the number he is trusting too small. */
export const isOnAccountBill = (bill: { status: string }) => String(bill?.status ?? "").toLowerCase() !== "paid";

/**
 * Whole days between two wall-calendar days. Date-only strings anchor at NOON UTC before they are
 * compared, the same trick formatDate uses: parsed as midnight they land a day early in Pacific,
 * which is the off-by-one that has bitten every date in this app at least once.
 */
export function daysBetweenYmd(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The age of a bill, spoken the way he would say it. */
export function sayAge(days: number | null): string {
  if (days === null) return "no date on it";
  if (days < 0) return "dated ahead";
  if (days === 0) return "from today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}

// ── WHAT THE SUPPLIER SAYS ──────────────────────────────────────────────────────────────────────

/**
 * A real wall-calendar day. Every date comparison below is a plain string compare, which is exact
 * for "YYYY-MM-DD" and wrong for anything else - and "" >= "2026-09-19" is FALSE, which would have
 * quietly filed every undated discount under "expired unclaimed" and shown him money he never lost.
 * So a date has to look like a date before it is allowed to answer a question about time.
 */
const isYmd = (d: unknown): d is string => /^\d{4}-\d{2}-\d{2}$/.test(String(d ?? ""));

/**
 * WHAT ONE OPEN DOCUMENT STILL HOLDS.
 *
 * `open_balance` is nullable, so a document the supplier calls open that printed no open balance
 * falls back to its own total. The lean matches `isOnAccountBill` above and for the same reason:
 * a missing figure must show up as money he may still owe and be argued with on screen, never
 * leave the balance and make the number he is trusting too small.
 *
 * A CREDIT MEMO IS NOT SKIPPED. Its open balance is negative, it reduces what he owes, and both
 * of his are among the twenty open documents. Dropping it because the sign looked wrong is how a
 * man gets billed for a return he already made.
 */
/**
 * THE FOUR FIELDS THESE TWO FUNCTIONS ACTUALLY READ, named so a caller holding raw database rows
 * cannot slip past the type by casting (2026-09-19). `open_balance` is snake_case out of PostgREST
 * and `openBalance` is what this file reads; a cast to SupplierInvoiceRow compiles either way and
 * the balance silently falls back to the total, so a part-paid invoice reads as fully owed and the
 * reversal rule stops firing. Asking for exactly these four makes the caller do the mapping.
 */
export type InvoiceBalanceShape = Pick<SupplierInvoiceRow, "id" | "total" | "openBalance" | "closed">;

export function openBalanceOf(invoice: InvoiceBalanceShape): number {
  const stated = invoice?.openBalance;
  if (stated !== null && stated !== undefined && Number.isFinite(Number(stated))) return r2(Number(stated));
  return r2(Number(invoice?.total) || 0);
}

/** The open documents - the supplier's verdict, and nothing else's. */
const openInvoices = (invoices: SupplierInvoiceRow[] | null | undefined): SupplierInvoiceRow[] =>
  (invoices ?? []).filter((i) => !i?.closed);

/** The discount on one document, or 0 - never a negative, which would ADD to a cheque. */
const discountOf = (invoice: SupplierInvoiceRow): number => {
  const d = r2(Number(invoice?.discountAmount) || 0);
  return d > 0 ? d : 0;
};

/**
 * A DISCOUNT ON AN INVOICE A CREDIT MEMO HAS ALREADY REVERSED IS NOT A DISCOUNT (review, 2026-09-19).
 *
 * This is worth exactly $4.14 and it is the whole gap between what this app said a cheque would be
 * and what CED's own portal said. On his TTP 106 order they billed $225.47 (invoice 8802-1107230,
 * prompt-pay discount $4.14), reversed it to the cent with credit memo 8802-1107337 (-$225.47),
 * and rebilled $223.29 on 8802-1107338. Both halves of the reversal are still OPEN documents, so
 * they cancel in the gross - correctly - but the discount was still being counted against a line
 * that nobody is going to pay. CED does not offer a discount on money it has taken back, and the
 * headline proves it: $3,845.14 gross less $25.48 is their $3,819.66, not our $3,815.52.
 *
 * The rule is deliberately narrow: an OPEN invoice whose open balance is matched to the cent by an
 * OPEN credit memo, each memo spending itself only once, so a single credit cannot silently cancel
 * the discount on two different invoices. Anything less exact than to-the-cent is a judgement call
 * about his money and is left alone.
 */
export function reversedInvoiceIds(invoices: InvoiceBalanceShape[]): Set<string> {
  const open = invoices.filter((i) => !i?.closed);
  const credits = open.filter((i) => openBalanceOf(i) < 0).map((i) => ({ i, spent: false }));
  const out = new Set<string>();
  for (const inv of open) {
    const bal = openBalanceOf(inv);
    if (!(bal > 0)) continue;
    /**
     * UNTOUCHED, NOT MERELY UNPAID (review, 2026-09-19). The match was against the OPEN balance
     * alone, so a $10.29 credit memo for a small return landed on a $998.77 invoice that had been
     * paid down to $10.29 and called the whole $998.77 reversed - a screen telling him a thousand
     * dollars of merchandise came back when a tube of sealant did. An invoice a credit memo
     * cancels has had nothing paid against it, so its open balance IS its total, and requiring
     * that is what keeps this rule as narrow as its own header promises.
     */
    if (Math.round(bal * 100) !== Math.round((Number((inv as { total?: unknown })?.total) || 0) * 100)) continue;
    const hit = credits.find((c) => !c.spent && Math.round(openBalanceOf(c.i) * 100) === -Math.round(bal * 100));
    if (hit) {
      hit.spent = true;
      const id = String((inv as { id?: unknown })?.id ?? "");
      if (id) out.add(id);
    }
  }
  return out;
}

/**
 * A PURCHASE A CREDIT MEMO CANCELLED — EVER, NOT JUST WHILE IT IS STILL OPEN.
 *
 * `reversedInvoiceIds` above answers a question about money still owed, so it only looks at OPEN
 * documents: once CED closes a pair, there is no balance left to reverse and no discount left to
 * lose. "Did he keep what was on this invoice?" is a different question and the answer never
 * expires. It came up the day the Record button was wired (review, 2026-09-19): the moment Erik
 * pays the September statement and CED marks 8802-1107230 and its credit memo closed, the pairing
 * above stops matching and the five light almond receptacles he SENT BACK reappear on "Purchases
 * Not In Your Books" with a job already on them and a live button offering to put $225.47 of
 * merchandise he does not have onto his customer's job.
 *
 * So this pairs on the TOTAL, which does not move, and within the closed and open sets separately
 * so a live credit can never be spent against a settled purchase or the other way round. Same
 * narrowness: to the cent, each memo spending itself once.
 */
export function reversedPurchaseIds(invoices: InvoiceBalanceShape[]): Set<string> {
  const out = new Set<string>();
  const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);
  for (const settled of [false, true]) {
    const side = (invoices ?? []).filter((i) => !!i?.closed === settled);
    const credits = side.filter((i) => cents((i as { total?: unknown })?.total) < 0).map((i) => ({ i, spent: false }));
    for (const inv of side) {
      const total = cents((inv as { total?: unknown })?.total);
      if (!(total > 0)) continue;
      const hit = credits.find((c) => !c.spent && cents((c.i as { total?: unknown })?.total) === -total);
      if (!hit) continue;
      hit.spent = true;
      const id = String((inv as { id?: unknown })?.id ?? "");
      if (id) out.add(id);
    }
  }
  return out;
}

/**
 * MODEL B, WORKED OUT. Pure, cents-safe at every summation the way lib/invoice-math.ts is, and
 * exported on its own so a screen that wants only the supplier's side (the reconciliation view,
 * a payment sheet's preview) does not have to build a whole account row to get it.
 *
 * Returns null when there are no supplier documents at all, which is the signal `supplierBalance`
 * uses to stay on model A. An account with documents that are ALL closed is a different thing and
 * gets a real answer: gross $0.00, and "the supplier says you are paid up" is a sentence worth
 * being able to say.
 */
export function supplierSaysBalance(
  invoices: SupplierInvoiceRow[] | null | undefined,
  today: string,
): SupplierSaysBalance | null {
  if (!invoices?.length) return null;

  let gross = 0;
  let openDocuments = 0;
  let assumedFromTotal = 0;
  let creditMemos = 0;
  let discountStillClaimable = 0;
  let discountExpiredUnclaimed = 0;
  let discountUndated = 0;
  let nextDiscountBy: string | null = null;
  let nextDiscountAmount = 0;
  let oldestOpen: string | null = null;

  // Discounts on invoices a credit memo has already reversed do not count - see reversedInvoiceIds.
  // Hoisted out of the loop: it was being paired afresh on every iteration (twenty times over his
  // twenty open documents, on every render), and the indentation read as if it were outside
  // already - which is how a future edit would have added per-invoice state to a set that silently
  // resets each time round.
  const reversed = reversedInvoiceIds(invoices ?? []);

  for (const invoice of openInvoices(invoices)) {
    openDocuments += 1;
    const open = openBalanceOf(invoice);
    gross = r2(gross + open);
    if (invoice.openBalance === null || invoice.openBalance === undefined) assumedFromTotal += 1;
    if (String(invoice.kind ?? "") === "credit_memo") creditMemos += 1;
    if (isYmd(invoice.invoiceDate) && (!oldestOpen || invoice.invoiceDate < oldestOpen)) oldestOpen = invoice.invoiceDate;

    const discount = reversed.has(String((invoice as { id?: unknown })?.id ?? "")) ? 0 : discountOf(invoice);
    if (discount <= 0) continue;
    if (!isYmd(invoice.discountBy)) {
      discountUndated = r2(discountUndated + discount);
    } else if (invoice.discountBy >= today) {
      discountStillClaimable = r2(discountStillClaimable + discount);
      // The soonest deadline still ahead. Ties add up: two invoices due the same day are one
      // decision, and naming half of it would be naming the wrong number.
      if (!nextDiscountBy || invoice.discountBy < nextDiscountBy) {
        nextDiscountBy = invoice.discountBy;
        nextDiscountAmount = discount;
      } else if (invoice.discountBy === nextDiscountBy) {
        nextDiscountAmount = r2(nextDiscountAmount + discount);
      }
    } else {
      discountExpiredUnclaimed = r2(discountExpiredUnclaimed + discount);
    }
  }

  return {
    gross,
    openDocuments,
    assumedFromTotal,
    creditMemos,
    discountStillClaimable,
    discountExpiredUnclaimed,
    discountUndated,
    netIfPaidToday: r2(gross - discountStillClaimable),
    nextDiscountBy,
    nextDiscountAmount,
    oldestOpen,
    oldestOpenDays: daysBetweenYmd(oldestOpen, today),
  };
}

/**
 * THE CHEQUE, DATED. CED's portal headline is $3,819.66 and its open balances are $3,845.14; the
 * gap is $25.48 of discount that survives to the 10th of October. Both figures are printed on the
 * same page, and a man writing a cheque has to know which one he is writing - so both are named
 * here rather than one of them being chosen for him.
 *
 * `forfeited` is the other half of that: $4.14 of his discount expires before the 10th, so paying
 * on the 10th rather than this week costs him that. The app SUGGESTS the arithmetic; the date is
 * entirely his.
 */
export function supplierNetIfPaidBy(
  invoices: SupplierInvoiceRow[] | null | undefined,
  payBy: string,
  today: string,
): SupplierPayByFigure {
  let gross = 0;
  let discount = 0;
  let forfeited = 0;
  const forfeitedInvoices: string[] = [];

  // Discounts on invoices a credit memo has already reversed do not count - see reversedInvoiceIds.
  // Paired once, outside the loop, for the reason given in supplierSaysBalance above.
  const reversed = reversedInvoiceIds(invoices ?? []);

  for (const invoice of openInvoices(invoices)) {
    gross = r2(gross + openBalanceOf(invoice));
    const amount = reversed.has(String((invoice as { id?: unknown })?.id ?? "")) ? 0 : discountOf(invoice);
    if (amount <= 0 || !isYmd(invoice.discountBy)) continue;
    if (isYmd(payBy) && invoice.discountBy >= payBy) {
      discount = r2(discount + amount);
    } else if (isYmd(today) && invoice.discountBy >= today) {
      // Alive today, dead by the day he is thinking of paying. This is the money the late-interest
      // story is made of, and it is worth nothing unless the screen names it before the day passes.
      forfeited = r2(forfeited + amount);
      forfeitedInvoices.push(String(invoice.invoiceNumber ?? ""));
    }
  }

  return { gross, discount, net: r2(gross - discount), forfeited, forfeitedInvoices };
}

/**
 * THE BALANCE. One function, so the card, the sheet's preview and the sentence after a write can
 * never disagree - the payroll board's rule, arrived at the same way.
 *
 * IT PICKS A MODEL AND SAYS SO. Supplier documents present -> model B, the supplier's own open
 * balances, payments left out of it. None present -> model A, unchanged, which is every account in
 * his book except CED. The two are never averaged, blended or added; mixing them is exactly the
 * double-count that produced $1,360.93.
 */
export function supplierBalance(account: SupplierAccountRow, today: string): SupplierBalance {
  let charged = 0;
  let chargedBills = 0;
  let settledAtRegister = 0;
  let settledBills = 0;
  let oldestUnpaid: string | null = null;
  let hasStatements = false;

  for (const bill of account.bills ?? []) {
    const amount = r2(Number(bill.amount) || 0);
    if (isOnAccountBill(bill)) {
      charged = r2(charged + amount);
      chargedBills += 1;
      if (bill.isStatement) hasStatements = true;
      // A bill with no date cannot be the oldest - it has no age to compare. It still counts in
      // the money; it just never becomes the sentence "oldest 64 days old".
      if (bill.billDate && (!oldestUnpaid || bill.billDate < oldestUnpaid)) oldestUnpaid = bill.billDate;
    } else {
      settledAtRegister = r2(settledAtRegister + amount);
      settledBills += 1;
    }
  }

  // THE LEDGER IS COMPUTED UNDER BOTH MODELS, ALWAYS. Under model A it is an input to the
  // balance; under model B it stops being one and becomes what he actually SENT them, for ticking
  // off against his bank statement. It never stops being computed, because a payment ledger that
  // vanished the day the supplier's documents arrived would be the app hiding his own money from
  // him - and the whole reason model B exists is that a screen has to be checkable.
  let paid = 0;
  let livePayments = 0;
  let lastPayment: SupplierPaymentRow | null = null;
  let firstPayment: SupplierPaymentRow | null = null;
  for (const payment of account.payments ?? []) {
    if (payment.voided) continue;
    paid = r2(paid + (Number(payment.amount) || 0));
    livePayments += 1;
    // Newest by the day it was paid, not by the order the rows came back - he records Friday's
    // cheque on Monday, and the list must still name the latest payment.
    if (!lastPayment || String(payment.paidOn) > String(lastPayment.paidOn)) lastPayment = payment;
    if (!firstPayment || String(payment.paidOn) < String(firstPayment.paidOn)) firstPayment = payment;
  }

  const supplierSays = supplierSaysBalance(account.supplierInvoices, today);

  return {
    charged,
    chargedBills,
    settledAtRegister,
    settledBills,
    paid,
    livePayments,
    // MODEL B DOES NOT SUBTRACT THE PAYMENTS. His $6,000 is already inside what CED closed, and
    // taking it off the open balances counts the same money twice in the other direction: the
    // night this shipped that read $1,360.93 against CED's $3,845.14.
    owed: supplierSays ? supplierSays.gross : account.onAccount ? r2(charged - paid) : null,
    model: supplierSays ? "supplier-invoices" : "bills-minus-payments",
    supplierSays,
    oldestUnpaid,
    oldestUnpaidDays: daysBetweenYmd(oldestUnpaid, today),
    lastPayment,
    firstPayment,
    hasStatements,
    unpaidOnRegisterAccount: !account.onAccount && chargedBills > 0,
    // A register account holding open supplier documents is the same contradiction as one holding
    // unpaid bills, and it gets the same treatment: the figure is shown, and the card says out
    // loud that this account is not supposed to carry one.
    openDocumentsOnRegisterAccount: !account.onAccount && (supplierSays?.openDocuments ?? 0) > 0,
  };
}

// ── THE MERGE REVIEW ────────────────────────────────────────────────────────────────────────────
// A proposal is a SUGGESTION and nothing else. Nothing merges, renames or re-files without Erik
// pressing something: the mapping is his judgement (is that Sunnyvale counter the same account?)
// and a backfill that decides for him is the opposite of this wave.

export interface SupplierSpelling {
  /** The `bills.supplier` string exactly as it was scanned. */
  alias: string;
  bills: number;
  /** Everything billed under this spelling. */
  total: number;
  /** The slice of it still on account. */
  unpaid: number;
  /**
   * Set when this spelling is a DIFFERENT STOREFRONT rather than a sloppy spelling. CED branches
   * are independently owned; Erik charged a Sunnyvale counter to his Truckee account, so the money
   * rolls up while the ticket stays with its branch - the price book learns from these receipts,
   * and a Sunnyvale price is not a Truckee price.
   */
  branchLabel?: string | null;
}

export interface SupplierMergeProposal {
  id: string;
  /** What the account would be called. Editable before he accepts - it is his name for them. */
  suggestedName: string;
  accountNumber?: string | null;
  branchCode?: string | null;
  spellings: SupplierSpelling[];
  /** When the spellings would join an account that already exists instead of making a new one. */
  existingAccountId?: string | null;
  existingAccountName?: string | null;
  /** Why these look like one account, in plain words, from supplier-identity.ts. */
  because?: string | null;
}

export function proposalTotals(proposal: SupplierMergeProposal): { bills: number; total: number; unpaid: number } {
  let bills = 0;
  let total = 0;
  let unpaid = 0;
  for (const s of proposal.spellings ?? []) {
    bills += Number(s.bills) || 0;
    total = r2(total + (Number(s.total) || 0));
    unpaid = r2(unpaid + (Number(s.unpaid) || 0));
  }
  return { bills, total, unpaid };
}

// ── THE QUESTION THE MATCHER WILL NOT ANSWER ────────────────────────────────────────────────────
//
// suggestSupplierGroups hands back `{ groups, candidates }` and the page read only the groups, so
// every candidate it worked out was thrown away (review of cn-v963). On Erik's book that discarded
// exactly one question, and it is the only genuine judgement call in this whole feature:
// "Contractors Electrical Distributors" ($467.87) against his four "Consolidated Electrical ..."
// spellings. Both reduce to the initials CED, they share two of their three words, the first word
// differs. It turns out to be one account used at two separately owned branches - "its the local
// distributor near sunnyvale for the job so i used my truckee account number, thats how they roll"
// - which is precisely the fact no amount of string cleverness gets out of a string. It came from
// him, and so must the answer.
//
// A CANDIDATE IS NOT A PROPOSAL. A proposal says "these are the same, press Accept". This says "I
// cannot tell", and it carries both doors: join them onto one account, or keep them apart. Neither
// is preselected and neither happens on its own.

export interface SupplierCandidateSide {
  /** What it is called on screen: the account's name when it already is one, else the spelling
   *  exactly as the scanner wrote it. */
  label: string;
  /** The spelling the matcher compared. It is what a press would move, so it is what gets quoted -
   *  never a tidied-up version of it. */
  spelling: string;
  /** Set when this side is an account he has already made. Those sides are never moved by either
   *  button: "keep them separate" gives every spelling it is handed an account of its own, and
   *  handing it a spelling that is currently an alias of CED Truckee would tear that spelling off
   *  the account he just built. */
  accountId: string | null;
  /** Bills scanned under this spelling that are on no account yet, and what they hold. Zero on a
   *  side that is already an account: that money is in its balance below, and counting it twice on
   *  one row is how a money screen starts arguing with itself. */
  bills: number;
  total: number;
  unpaid: number;
  /** What the account already owes, for a side that is one. Null for a loose spelling, and null
   *  for a register supplier, which has no running balance and must not be given one. */
  owed: number | null;
}

export interface SupplierCandidateQuestion {
  /** The spellings BOTH doors would move, as JSON, in the same id shape the merge actions parse. */
  id: string;
  sides: [SupplierCandidateSide, SupplierCandidateSide];
  /** Why the matcher stopped short of proposing anything, in its own words. */
  because: string;
  /** The account a join would file onto, when one of the two already is one. Null when a join
   *  would make a new account out of both spellings. */
  existingAccountId: string | null;
  existingAccountName: string | null;
  /** A starting point for the name box when a join would make a NEW account. His to change. */
  suggestedName: string;
}

/** The sides a press actually moves: the ones not already on an account of their own. A question
 *  with none of these has nothing left to ask and must not be shown. */
export function candidateMoving(question: SupplierCandidateQuestion): SupplierCandidateSide[] {
  return (question?.sides ?? []).filter((s) => !s.accountId);
}

/**
 * WHAT THE JOINED ACCOUNT WOULD OWE: each side's own balance plus the unpaid bills that would be
 * filed onto it. On his book this is the sentence that lets him check the app against what he
 * knows - joining the Sunnyvale ticket adds its $467.87 to whatever CED's card is reading.
 *
 * IT ADDS TO WHICHEVER MODEL THE SIDE IS ON, and that is correct under both. `side.owed` comes
 * straight from `supplierBalance`, so for CED it is now the supplier's own $3,845.14 rather than
 * bills-minus-payments; a loose spelling has no supplier documents by definition, so its unpaid
 * bills are the only thing it can contribute. (The comment here used to quote $6,476.93 as CED's
 * balance. That was the figure the portal proved wrong on 2026-09-19 - it is written down in the
 * module header now, as the mistake, and no longer stands in a comment as a fact.)
 *
 * Null when one side is a register supplier: that account has no running balance, so there is no
 * number to add to and inventing one would be a figure he never wrote.
 */
export function candidateJoinedOwed(question: SupplierCandidateQuestion): number | null {
  let owed = 0;
  for (const side of question?.sides ?? []) {
    if (side.accountId) {
      if (side.owed === null) return null;
      owed = r2(owed + side.owed);
    } else {
      owed = r2(owed + (Number(side.unpaid) || 0));
    }
  }
  return owed;
}

/** What the book knows about one spelling, for the question builder below. */
export interface SupplierBookEntry {
  id: string;
  name: string;
  /** Null for a register supplier, which has no running balance. */
  owed: number | null;
}

/**
 * The exact string, trimmed and lowercased - `aliasKey` in supplier-identity, which is what
 * `supplier_aliases` is unique on and what actually moves bills. A local copy rather than an
 * import so the fuzzy matcher does not get dragged into the client bundle for three lines; the
 * rule itself must never diverge, because the row he reads and the rows a press moves would then
 * be two different sets.
 */
const sameSpelling = (raw: unknown): string => String(raw ?? "").trim().toLowerCase();

/**
 * THE PAIRS THE MATCHER WILL NOT DECIDE, TURNED INTO SOMETHING WITH DOORS ON IT.
 *
 * Fed `suggestSupplierGroups().candidates` plus what the book already knows, it works out for each
 * pair which side is loose (a spelling on no account at all) and which is an account he has
 * already made.
 *
 * TWO RULES, AND BOTH ARE LOAD-BEARING:
 *
 *  · A QUESTION WITH NO LOOSE SIDE IS NOT ASKED. Nothing on that row could move without tearing a
 *    spelling off an account he built, so both doors could only refuse.
 *
 *  · THAT SAME RULE IS WHAT MAKES "KEEP THEM SEPARATE" STICK. Nothing anywhere records "he said
 *    no": the dismissal works by becoming TRUE - the loose bills land on an account of their own,
 *    the spelling leaves the unfiled pile, and the pair stops qualifying. The matcher still sees
 *    both names next time, because it reads account names too, so without this rule the question
 *    he just answered would be waiting for him on the next page load.
 */
export function supplierCandidateQuestions(
  candidates: { a: string; b: string; reasons?: string[] }[] | null | undefined,
  book: {
    /** Money on a spelling that is on no account yet, keyed by the spelling lowercased. */
    unfiled: Map<string, SupplierSpelling>;
    /** The account a spelling is already filed under, keyed the same way. */
    accounts: Map<string, SupplierBookEntry>;
  },
): SupplierCandidateQuestion[] {
  const sideOf = (name: string): SupplierCandidateSide | null => {
    const key = sameSpelling(name);
    const account = book?.accounts?.get(key);
    if (account) {
      // Its money is its balance. The spelling may ALSO have unfiled bills of its own (a receipt
      // scanned after the account was made); those are left at zero here because they have their
      // own one-press row in the proposals, and one dollar shown twice on one screen is the
      // 24%-vs-82% budget bug wearing a new hat.
      return {
        label: account.name,
        spelling: name,
        accountId: account.id,
        bills: 0,
        total: 0,
        unpaid: 0,
        owed: account.owed,
      };
    }
    const g = book?.unfiled?.get(key);
    if (!g) return null;
    return {
      label: g.alias,
      spelling: g.alias,
      accountId: null,
      bills: Number(g.bills) || 0,
      total: r2(Number(g.total) || 0),
      unpaid: r2(Number(g.unpaid) || 0),
      owed: null,
    };
  };

  const questions: SupplierCandidateQuestion[] = [];
  for (const candidate of candidates ?? []) {
    const a = sideOf(String(candidate?.a ?? ""));
    const b = sideOf(String(candidate?.b ?? ""));
    if (!a || !b) continue;
    const moving = [a, b].filter((s) => !s.accountId);
    if (!moving.length) continue;
    const home = a.accountId ? a : b.accountId ? b : null;
    questions.push({
      // THE ID CARRIES ONLY THE SPELLINGS A PRESS MAY MOVE, as JSON, in the shape the merge
      // actions already parse. The account side is never in it, because "keep them separate"
      // gives every spelling it is handed an account of its own.
      id: `merge:${JSON.stringify(moving.map((s) => s.spelling))}`,
      sides: [a, b],
      because: candidate?.reasons?.[0] ?? "",
      existingAccountId: home?.accountId ?? null,
      existingAccountName: home?.label ?? null,
      // Only a starting point for the name box, and only when a join would make a new account:
      // the longer spelling is usually the fuller one. It is his to retype either way.
      suggestedName:
        home?.label ?? [...moving].sort((x, y) => y.spelling.length - x.spelling.length)[0]?.spelling ?? "",
    });
  }
  return questions;
}

// ── THE SAME TICKET, FILED TWICE ────────────────────────────────────────────────────────────────
// An identical CED ticket ($95.27, 8 lines, line for line to the penny) sits on BOTH "13631
// Northwoods" (07-29) and "85 Whitney Place" (08-28). One of those jobs is carrying a cost that is
// not its own. WHICH ONE IS ERIK'S KNOWLEDGE, NOT OURS: nothing here deletes either copy, and the
// group is built from whatever matched, never hard-coded to that one bill.

export interface DuplicateBillCopy {
  billId: string;
  jobId: string | null;
  jobName: string | null;
  billDate: string | null;
  supplier: string;
  /** Where it came from: the CED portal filename, "85 Whit.pdf", whatever the scanner kept. */
  source?: string | null;
}

export interface DuplicateBillGroup {
  id: string;
  amount: number;
  /** How many lines matched, to the penny. The whole claim rests on this. */
  lineCount: number;
  copies: DuplicateBillCopy[];
  /** Set once he has picked which job keeps it. */
  resolution?: { keptBillId: string; at?: string | null } | null;
}

/** "13631 Northwoods", "Overhead (no job)" - a copy named the way it reads on the card. */
export function copyPlace(copy: DuplicateBillCopy): string {
  return copy.jobName?.trim() || "Overhead (no job)";
}

/**
 * What every action on this card hands back. The same shape payroll's money actions use: `message`
 * is the SENTENCE THE ACTION ITSELF WRITES, because only the server knows what actually landed in
 * the database, and a screen guessing at that is how a man ends up trusting a number nobody wrote.
 */
export type SupplierActionResult = {
  ok: boolean;
  error?: string;
  message?: string;
  /** recordPayment hands back the row it wrote, so Undo voids exactly that payment. */
  paymentId?: string;
};
