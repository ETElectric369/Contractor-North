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
   * Charged minus paid - or NULL for a pay-at-the-register supplier, which has no running
   * balance and must not be given one. A zero would read as "paid up", which is a different
   * sentence and not a true one.
   */
  owed: number | null;
  oldestUnpaid: string | null;
  /** How old that oldest unpaid bill is, in days, against the ORG's today (never the browser's). */
  oldestUnpaidDays: number | null;
  lastPayment: SupplierPaymentRow | null;
  /** True when one of the open bills is a STATEMENT covering several of their invoices. A payment
   *  sheet that offers to match an invoice number needs to know it cannot here. */
  hasStatements: boolean;
  /**
   * A register account that somehow carries unpaid bills. Not a crash and not a number to bury:
   * the card says it out loud and points at the door that fixes it.
   */
  unpaidOnRegisterAccount: boolean;
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

/**
 * THE BALANCE. One function, so the card, the sheet's preview and the sentence after a write can
 * never disagree - the payroll board's rule, arrived at the same way.
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

  let paid = 0;
  let livePayments = 0;
  let lastPayment: SupplierPaymentRow | null = null;
  for (const payment of account.payments ?? []) {
    if (payment.voided) continue;
    paid = r2(paid + (Number(payment.amount) || 0));
    livePayments += 1;
    // Newest by the day it was paid, not by the order the rows came back - he records Friday's
    // cheque on Monday, and the list must still name the latest payment.
    if (!lastPayment || String(payment.paidOn) > String(lastPayment.paidOn)) lastPayment = payment;
  }

  return {
    charged,
    chargedBills,
    settledAtRegister,
    settledBills,
    paid,
    livePayments,
    owed: account.onAccount ? r2(charged - paid) : null,
    oldestUnpaid,
    oldestUnpaidDays: daysBetweenYmd(oldestUnpaid, today),
    lastPayment,
    hasStatements,
    unpaidOnRegisterAccount: !account.onAccount && chargedBills > 0,
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
 * knows - CED reads $6,476.93 today, and joining the Sunnyvale ticket makes it $6,944.80.
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
