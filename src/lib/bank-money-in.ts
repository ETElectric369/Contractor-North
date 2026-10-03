import { PAYMENT_METHOD_LABELS, paymentMethodKey, paymentMethodLabel } from "@/lib/payment-method";
import { sayDollars } from "@/lib/supplier-open-list";

/**
 * WHERE YOUR MONEY CAME IN: does what you were PAID agree with what REACHED your account, and if not,
 * where is the rest?
 *
 * ════ WHY THIS IS NOT A MATCHER ════
 *
 * Erik, 2026-10-02, reading the first plan for this: "so im wondering if the money in from the
 * statement has to match invoices at all, its a total comparing to another total, everything else is
 * recorded." He was right, and the first version of this lane - which matched a bank payout to the SET
 * of payments it covered, by subset-sum, with ambiguity rules and gross-versus-net fees - was deleted
 * for one word from him: KISS.
 *
 * Revenue is counted when a PAYMENT is recorded against an invoice. A deposit landing later adds no
 * revenue; it only says the money arrived. So nothing here attaches a deposit to an invoice, nothing
 * guesses which deposit is which payment, and there is no search, no solver and no score. There are two
 * totals per way of being paid, and one sentence.
 *
 * ════ WHY IT IS NOT ONE SUBTRACTION EITHER ════
 *
 * Measured on Erik's own book, 2026-06-08 to 2026-10-01: 50 payments, $86,710.53 recorded, against
 * $34,239.56 of deposits into the one account he downloads. A naive comparison screams a $52,000 hole
 * and there is no hole - because EACH WAY OF BEING PAID HAS A DIFFERENT FATE:
 *
 *   · CASH never reaches any account at all (Erik: "i dont think anyone will be depositing cash much").
 *     It gets spent, and its receipts are already costs. Expected here: nothing. This module SAYS that
 *     and stops - it does not reconcile cash, chase it, or give it a column to be short in.
 *   · VENMO, ZELLE and the other apps reach the business account only when he SWEEPS them, and a sweep
 *     is one line covering many payments. Until then the money is real and is simply somewhere else.
 *   · CARD arrives as a processor payout, a few days late and NET OF ITS FEE (payments.processor_fee).
 *   · CHECK and TRANSFER arrive roughly as themselves, with a few days of float.
 *
 * ════ WHAT IT WILL NEVER CLAIM ════
 *
 * A figure that could not be worked out says so and is in NO total (`expectedCents` holds only the rows
 * it could work out). A payment whose method nobody recorded gets its own row, NOT_SAID, and is never
 * folded into another channel to make the arithmetic look complete. A channel the statement's own words
 * never name has `namedCents: null` - "the statement does not say", which is a different fact from
 * zero. And where there is nothing to say beyond "money in with nothing else to say", it says nothing
 * extra: invented confidence is worse than none.
 *
 * Pure: integer cents, no I/O, no database, no React. Tested with no database.
 */

// ── THE WAYS OF BEING PAID, AND WHAT BECOMES OF EACH ─────────────────────────────────────────────

/** What happens to money paid this way, on its way to the account a download covers. */
export type ChannelFate =
  /** Cash. It never reaches any account; expected here is nothing, and that is the whole answer. */
  | "never_banked"
  /** A card. It arrives as a processor payout, days later, less the processor's fee. */
  | "net_of_fee"
  /** A check, a transfer, an ACH. It arrives as itself, with a few days of float. */
  | "as_itself"
  /** A payment app. It is real money sitting in the app until somebody moves it to the bank. */
  | "when_swept"
  /** Nobody said how, or nothing says where this way of being paid lands. Worked out by NOTHING. */
  | "unsaid";

/**
 * THE KEY A PAYMENT WITH NO METHOD WRITTEN DOWN IS COUNTED UNDER - never "other".
 *
 * paymentMethodKey("") answers "other", which is the method an office CHOSE from a list. "Nobody wrote
 * it down" and "somebody chose Other" are different facts about the books, and folding the first into
 * the second would hide, behind a word that looks deliberate, exactly the rows a person needs to go and
 * fix. So the raw column is looked at before it is normalized (channelKeyOf).
 *
 * DEFENSIVE ONLY, AND SAID SO HERE RATHER THAN IMPLIED: no payment reaches this module blank today, so
 * this row cannot be drawn from stored data. payments.method is NOT NULL (0003) and 0287's BEFORE
 * INSERT/UPDATE trigger maps '' to 'other', and the three app writers (recordPayment and updatePayment
 * write "check" for a blank sheet, the Stripe writer "card", Apply a deposit's own word), so a blank is
 * never stored either. It stays because a blank arriving from anywhere later - an import, a new door -
 * must get its own row instead of being folded in silently, and because deleting it would make
 * channelKeyOf("") answer "other", which is the one fold this module exists to refuse.
 *
 * THE FOLD THAT DOES HAPPEN IS UPSTREAM OF HERE and this module cannot see it: a sheet with no method
 * chosen is STORED as "check" (billing/actions.ts), which reads "Expect all of it here" on a row that
 * nobody actually said arrives. Fixing that means changing what those doors store, not what this reads.
 */
export const NOT_SAID = "not_said";

/**
 * WHAT BECOMES OF EACH WAY OF BEING PAID. Keys are payment-method keys (payment-method.ts's, which is
 * the one normalizer): a method not in here has no fate anyone has worked out, and answers "unsaid".
 *
 * ZELLE IS A SWEEP HERE, not a direct deposit, because that is how Erik is actually paid through it
 * (2026-10-02) - it lands in a personal account and he moves it. A company banked the other way reads
 * its Zelle row as "short by the lot" until it sweeps, which is true of its money either way; the row
 * says where the money is, not that anything is wrong.
 */
const FATE_OF: Record<string, ChannelFate> = {
  cash: "never_banked",
  card: "net_of_fee",
  check: "as_itself",
  transfer: "as_itself",
  ach: "as_itself",
  venmo: "when_swept",
  zelle: "when_swept",
  cashapp: "when_swept",
  paypal: "when_swept",
};

/** The fate of one channel key. NOT_SAID and anything nobody has worked out are "unsaid". */
export function fateOf(key: string): ChannelFate {
  // OWN KEYS ONLY. This table is indexed by whatever somebody typed into Settings, and a plain object
  // answers "constructor" and "__proto__" with Object.prototype's members - so `FATE_OF[key] ?? "unsaid"`
  // handed back a function, the row's why rendered the word "undefined", and the money was counted as
  // having arrived in full instead of landing in unsaidCents. The same hazard payment-method.ts guards
  // (review 09-24), on the same Settings-typed keys.
  return Object.hasOwn(FATE_OF, key) ? FATE_OF[key] : "unsaid";
}

/** The channel a payment belongs to: its method key, or NOT_SAID when the column is blank. */
export function channelKeyOf(method: string | null | undefined): string {
  return String(method ?? "").trim() ? paymentMethodKey(method) : NOT_SAID;
}

/**
 * THE CHANNEL ONE PAYMENT BELONGS TO. A payment STRIPE COLLECTED is a card payout whatever method the
 * office stored against it, because that is how the money reaches the bank: days later, net of its fee,
 * under a Stripe descriptor.
 *
 * Stripe's bank-debit checkout stores method 'ach' WITH a real processor_fee (record-invoice-payment.ts).
 * Read by its method alone, such a payment was expected at its gross while paying out net, and its payout
 * was filed on a Card row with nothing recorded against it - so an ordinary month printed a gap exactly
 * the size of the fees, every month, with no reason given, and the Card row claimed the payout was money
 * it had never been paid. bank-download.ts's matcher has always said `if (p.stripe) return "card"`; this
 * is the same answer, so there is one.
 */
export function channelOfPayment(p: { method: string; stripe?: boolean }): string {
  return p.stripe ? "card" : channelKeyOf(p.method);
}

/** The channel's name, Title Case, as a row reads it. */
export function channelLabel(key: string): string {
  return key === NOT_SAID ? "Not Said How It Was Paid" : paymentMethodLabel(key);
}

// ── WHICH CHANNEL A DEPOSIT'S OWN WORDS NAME ─────────────────────────────────────────────────────

/**
 * THE WORDS A BANK PRINTS THAT NAME A WAY OF BEING PAID. Reading the statement's own words is not
 * matching: it says which CHANNEL a deposit came through, never which payment it is. That is the whole
 * difference between a reason a person can check ("your card payments and this account's payouts agree
 * over these weeks") and a guess he has to take on trust ("it looks like a deposit").
 *
 * ONLY A BRAND'S OWN NAME IS HERE. "ONLINE TRANSFER FROM …" names no channel: it is equally a swept
 * Venmo balance, the owner putting money in, and a customer's bank transfer - which is exactly the
 * $7,714.09 deposit Erik was offered a bare "Already Counted Or Not Income" on. Such a line stays
 * UNNAMED and gets no reason at all, which is the honest answer and is why this list stays short.
 *
 * THESE WORDS ARE ALSO THE APP'S ONE PROCESSOR WORD LIST (processorWordsRe below): bank-download.ts's
 * PROCESSOR_RE is built from this table, so "is this merchant a processor" has one answer and a brand
 * cannot be dropped from one reader and kept by the other.
 *
 * IT IS NOT THE APP'S ONLY DEPOSIT CLASSIFIER, and saying so here would be a claim this file cannot keep.
 * bank-download.ts's depositKindOf answers a DIFFERENT question for the matcher - "could this line be the
 * payout of a payment of this kind" - and reads wider words for it ("merchant", a bare "card", "wire").
 * That is deliberate on both sides: a matcher may guess and be corrected by a tap, while this module puts
 * a sentence on the card, so it reads only words that can mean one thing. The cost is that a line the
 * matcher calls a card payout ("CARD SETTLEMENT 0612") names no channel here, which is why namedClause
 * says what it CHECKED ("nothing on the statement names Card") rather than that no such money came in.
 *
 * First match wins, and the app brands are asked before the card processors: a line saying both is one
 * payout through one of them, and which one it is read as cannot change any total on the card.
 */
const CHANNEL_WORDS: readonly { key: string; words: readonly string[] }[] = [
  { key: "venmo", words: ["venmo"] },
  { key: "zelle", words: ["zelle"] },
  { key: "cashapp", words: ["cash ?app"] },
  { key: "paypal", words: ["paypal"] },
  { key: "card", words: ["stripe", "square", "clover", "toast", "shopify", "intuit", "quickbooks"] },
];

/** The words of one channel as a whole-word test ("square" never matches inside "squarespace"). */
const wordsRe = (words: readonly string[]) => new RegExp(`\\b(${words.join("|")})\\b`, "i");
const CHANNEL_RE: readonly { key: string; re: RegExp }[] = CHANNEL_WORDS.map((c) => ({ key: c.key, re: wordsRe(c.words) }));

/**
 * Words that mark a PROCESSOR but are too short or too common to name a channel on their own. "SQ
 * *COFFEE" is a Square line, so "transfer" beside it is a payout and not a move between the company's
 * own accounts - but a bare "SQ" is also "SQ FT", so it never names a channel here.
 */
const PROCESSOR_ONLY: readonly string[] = ["sq"];

/** The channel this deposit's own words name, or null when they name none. */
export function channelNamedBy(description: string): string | null {
  const text = String(description ?? "");
  for (const c of CHANNEL_RE) if (c.re.test(text)) return c.key;
  return null;
}

/**
 * EVERY PROCESSOR WORD THE APP KNOWS, as one regular expression: the channel words above plus the ones
 * too short to name a channel. bank-download.ts reads this as PROCESSOR_RE, so there is one list.
 */
export function processorWordsRe(): RegExp {
  return wordsRe([...CHANNEL_WORDS.flatMap((c) => c.words), ...PROCESSOR_ONLY]);
}

// ── WHAT GOES IN, AND WHAT COMES BACK ────────────────────────────────────────────────────────────

/**
 * One payment recorded in the books: cents, the day, the method as STORED (blank included - channelKeyOf
 * needs to see a blank), the processor fee if one was recorded, and whether STRIPE collected it.
 *
 * A REFUND IS NOT HERE, and this type used to say it arrived as negative cents, which no door can produce:
 * recordPayment, updatePayment and the Stripe writer all refuse an amount at or below zero, and a customer
 * refund is a customer_credits row with disposition 'refund'. So the Paid column is what was taken in,
 * gross of refunds, and it can stand above the app's own Received (computeCollected subtracts them) by
 * exactly a refund. Netting them here would need a second read and a decision about what Paid means - a
 * decision for the owner, not for a display block - so this says what it is instead of implying otherwise.
 */
export type ChannelPayment = { cents: number; day: string; method: string; feeCents: number | null; stripe?: boolean };

/** One money-in line off the download. */
export type MoneyInLine = { cents: number; description: string };

export type ChannelRow = {
  key: string;
  label: string;
  fate: ChannelFate;
  /** What was recorded in the period, this way. */
  recordedCents: number;
  /** What would be expected to reach THIS account. Null = it could not be worked out, and then this
   *  row is in no total on the card. */
  expectedCents: number | null;
  /** What the statement's OWN WORDS name as this channel. Null = its words never say this way of being
   *  paid, which is not the same claim as zero. */
  namedCents: number | null;
  /** The card's one clause for this row, at most WHY_LINE_MAX characters (the why-line law). */
  why: string;
  /** The clauses `why` is made of, in order. Carried so a line that puts something in FRONT of them
   *  (channelWhyFor's label and period total) can drop a clause whole instead of slicing the word that
   *  says which way the statement is off. */
  whyParts: readonly string[];
};

export type MoneyInChannels = {
  /** Biggest recorded first; a channel the statement names but nothing was recorded for comes after. */
  rows: ChannelRow[];
  recordedCents: number;
  /** The rows whose expected could be worked out, added up. Never includes an "unsaid" row. */
  expectedCents: number;
  /** Every money-in line on the download. */
  reachedCents: number;
  /** Recorded money whose fate nobody has worked out. Said on its own row, in no total. */
  unsaidCents: number;
  /** Money in on the download whose words name no channel: "money in with nothing else to say". */
  unnamedCents: number;
  /** THE ONE SENTENCE a person can act on. Leads with the figure. */
  say: string;
};

/** A why-line is where the answer lands in the price (this repo's own law): short enough to read in
 *  one go, on a phone, between jobs. */
export const WHY_LINE_MAX = 140;

/**
 * HOW MANY DAYS OF FLOAT A PAYMENT AT THE END OF THE WINDOW GETS. A check written on the 30th clears in
 * October; a card charged on the 29th pays out in October. So money paid in the last few days of a
 * statement is the plainest reason of all for a gap, and the sentence names it with its own figure
 * rather than leaving a person to work out which days are near the edge.
 */
export const FLOAT_DAYS = 5;

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);

/** "a", "a and b", "a, b and c". */
function sayList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What the statement says about one channel, when its words can name it at all.
 *
 * THE "NONE OF IT" ARM SAYS WHAT WAS CHECKED. It used to read "Nothing on the statement says this way of
 * being paid", which is a claim about the statement this module is in no position to make: it reads brand
 * names only (CHANNEL_WORDS), so a payout the bank printed "CARD SETTLEMENT 0612" or "MERCHANT BANKCD DEP"
 * - which bank-download.ts's own matcher calls a card payout - names nothing HERE. Naming the label is the
 * narrower, true statement, and it is the one a person can check against the lines in front of him.
 */
function namedClause(label: string, expected: number | null, named: number): string {
  if (expected == null) return `The statement names ${sayDollars(named / 100)} of it.`;
  if (!named) return `Nothing on the statement names ${label}.`;
  if (named === expected) return "The statement names exactly that much.";
  const off = Math.abs(named - expected);
  return `The statement names ${sayDollars(named / 100)} — ${sayDollars(off / 100)} ${named < expected ? "short" : "more"}.`;
}

/** The row's clauses: what becomes of this money, then what the statement said if it said anything. */
function whyPartsOf(key: string, fate: ChannelFate, expected: number | null, named: number | null, feesCents: number, feesUnsaid: number): string[] {
  const label = channelLabel(key);
  const head = (() => {
    switch (fate) {
      case "never_banked":
        return "Cash never reaches the bank. Its receipts are already costs.";
      case "as_itself":
        return "Expect all of it here, a few days after it was paid.";
      case "when_swept":
        // THE ROW SAYS WHERE THE MONEY IS (see the top of this file), so it may not say money is waiting
        // in Venmo over a statement that names the cashout in full: the very next clause ("the statement
        // names exactly that much") then disproved the one before it, on the deposit this lane exists for.
        // The module already treats named app money as moved when it works out the gap (sweptLeft below).
        return named != null && named > 0 && named >= (expected ?? 0)
          ? `Already moved to the bank, not sitting in ${label}.`
          : `Sits in ${label} until somebody moves it to the bank.`;
      case "net_of_fee":
        // SHORT ENOUGH TO LEAVE ROOM FOR ITS SECOND CLAUSE. At 105 characters this head crowded out what
        // the statement named, so every card row with an unrecorded fee - a card payment taken outside
        // the app's own Stripe flow, which is ordinary - lost it.
        return feesUnsaid
          ? `A payout lands days later, less its fee — ${feesUnsaid} with no fee recorded, so this reads high.`
          : `A payout lands days later: ${sayDollars((expected ?? 0) / 100)} after ${sayDollars(feesCents / 100)} of fees.`;
      case "unsaid":
        return key === NOT_SAID
          ? "Nobody wrote down how these were paid, so there is no saying where they land."
          : `Nothing says where a payment marked ${label} lands, so it is in neither total.`;
    }
  })();
  return named == null ? [head] : [head, namedClause(label, expected, named)];
}

/**
 * THE WHY-LINE LAW'S LENGTH, MET BY LEAVING A CLAUSE OUT WHOLE RATHER THAN SLICING ONE.
 *
 * Cut at 140 characters by hand, the last clause lost the word that carried it. At ordinary five-figure
 * sums a card's working ended "$1,228.55 sh\u2026", which no longer says WHICH WAY the channel is off, and
 * that was the whole of what it was there to say. So a clause that will not fit is left out entirely, and
 * only a single clause longer than the law on its own is sliced - which is a company's own custom method
 * name, as long as whoever typed it into Settings - and then the cut is marked, so it cannot read as a
 * sentence that simply ended.
 */
function capped(clauses: readonly string[]): string {
  let said = "";
  for (const c of clauses) {
    if (!c) continue;
    const next = said ? `${said} ${c}` : c;
    if (next.length > WHY_LINE_MAX) break;
    said = next;
  }
  return said || `${String(clauses[0] ?? "").slice(0, WHY_LINE_MAX - 1).trimEnd()}\u2026`;
}

/**
 * THE CHANNEL VIEW: what you were paid, what of it should reach THIS account, and what did.
 *
 * `window` is the download's own first and last day, and the payments are filtered to it HERE rather
 * than by each caller - so "the period" has one meaning, and a test can prove a payment outside it is
 * left out.
 */
export function moneyInChannels(input: {
  payments: readonly ChannelPayment[];
  moneyIn: readonly MoneyInLine[];
  window: { from: string; to: string };
}): MoneyInChannels {
  const { from, to } = input.window;
  const inWindow = input.payments.filter((p) => !!p.day && p.day >= from && p.day <= to);

  type Tally = { recorded: number; fees: number; feesUnsaid: number; named: number | null };
  const tally = new Map<string, Tally>();
  const at = (key: string): Tally => {
    let t = tally.get(key);
    // `named: null` until a word on the statement CAN name this channel: a channel the bank never
    // spells out must come back "the statement does not say", never a confident zero.
    if (!t) tally.set(key, (t = { recorded: 0, fees: 0, feesUnsaid: 0, named: CHANNEL_WORDS.some((c) => c.key === key) ? 0 : null }));
    return t;
  };

  for (const p of inWindow) {
    const t = at(channelOfPayment(p));
    t.recorded += p.cents;
    // A FEE NOBODY RECORDED IS NOT A FEE OF ZERO. Counting null as 0 would quietly say the whole charge
    // reached the bank, which is the one thing a card row must not say.
    if (p.feeCents == null) t.feesUnsaid += 1;
    else t.fees += p.feeCents;
  }

  let reachedCents = 0;
  let unnamedCents = 0;
  for (const l of input.moneyIn) {
    if (l.cents <= 0) continue;
    reachedCents += l.cents;
    const key = channelNamedBy(l.description);
    if (!key) {
      unnamedCents += l.cents;
      continue;
    }
    const t = at(key);
    t.named = (t.named ?? 0) + l.cents;
  }

  const rows: ChannelRow[] = [...tally.entries()].map(([key, t]) => {
    const fate = fateOf(key);
    // THE WHOLE OF THE ARITHMETIC, in one switch. Cash expects nothing; a card expects itself less the
    // fees that were recorded; a check, a transfer and an app expect themselves; and a channel with no
    // worked-out fate expects NOTHING SAYABLE, which is null and reaches no total.
    const expectedCents =
      fate === "never_banked" ? 0 : fate === "net_of_fee" ? t.recorded - t.fees : fate === "unsaid" ? null : t.recorded;
    const whyParts = whyPartsOf(key, fate, expectedCents, t.named, t.fees, t.feesUnsaid);
    return {
      key,
      label: channelLabel(key),
      fate,
      recordedCents: t.recorded,
      expectedCents,
      namedCents: t.named,
      why: capped(whyParts),
      whyParts,
    };
  });
  rows.sort((a, b) => Math.abs(b.recordedCents) - Math.abs(a.recordedCents) || a.label.localeCompare(b.label));

  const recordedCents = rows.reduce((s, r) => s + r.recordedCents, 0);
  const expectedCents = rows.reduce((s, r) => s + (r.expectedCents ?? 0), 0);
  const unsaidCents = rows.filter((r) => r.expectedCents == null).reduce((s, r) => s + r.recordedCents, 0);

  // ── THE ONE SENTENCE ────────────────────────────────────────────────────────
  const gap = expectedCents - reachedCents;

  // WHAT IS STILL WAITING IN AN APP, ROW BY ROW AND NEVER BELOW NOTHING. Added up across rows, a channel
  // the statement named in FULL offset one it had not, so a Venmo balance the statement itself showed
  // moved was named as unmoved - and a row with nothing recorded but a cashout named (recorded 0, named
  // $1,000) subtracted from its neighbour and was still listed. Each row answers only for itself, and
  // only a row with something actually left is named.
  const sweptLeft = rows
    .filter((r) => r.fate === "when_swept")
    .map((r) => ({ label: r.label, cents: Math.max(0, r.recordedCents - (r.namedCents ?? 0)) }))
    .filter((r) => r.cents > 0);
  const sweptCents = sweptLeft.reduce((s, r) => s + r.cents, 0);
  // Money paid in the last few days of the window, on the channels that reach this account at all: the
  // plainest reason of all for a gap, and it needs no guessing about which deposit is which.
  //
  // NET, LIKE THE GAP IT EXPLAINS. Summed gross, two $1,000 card payments against a $970 payout printed
  // "$970.00 hasn't reached this account. $1,000.00 of it was paid in the last 5 days" - a part larger
  // than its whole, in the very case this clause is best at.
  const edgeCents = inWindow
    .filter((p) => {
      const fate = fateOf(channelOfPayment(p));
      return fate !== "never_banked" && fate !== "unsaid" && dayDiff(to, p.day) < FLOAT_DAYS;
    })
    .reduce((s, p) => s + p.cents - (fateOf(channelOfPayment(p)) === "net_of_fee" ? (p.feeCents ?? 0) : 0), 0);
  const feesUnsaid = inWindow.filter((p) => fateOf(channelOfPayment(p)) === "net_of_fee" && p.feeCents == null).length;

  // A PART CANNOT BE LARGER THAN ITS WHOLE. "$X of it" is a claim that the figure is part of the gap, so
  // each reason is held to the gap: a $5,000 check paid on the 28th cannot explain more than the $44.09
  // that is actually missing, and printing it whole said something impossible out loud.
  const part = (cents: number) => Math.min(cents, gap);
  const reasons: { cents: number; said: string }[] = [
    {
      cents: sweptCents,
      // NOT "NOBODY HAS MOVED IT", WHICH THIS CANNOT KNOW. An unnamed "ONLINE TRANSFER FROM …" names no
      // channel (see CHANNEL_WORDS) and is equally the sweep itself - Erik's own $7,714.09 deposits were
      // customers paying his Venmo. So this says what was CHECKED, the statement's own words, and hedges
      // the conclusion the way the float clause below already does.
      said: `${sayDollars(part(sweptCents) / 100)} of it may still be in ${sayList(sweptLeft.map((r) => r.label))} — the statement doesn't say it was moved to the bank.`,
    },
    { cents: edgeCents, said: `${sayDollars(part(edgeCents) / 100)} of it was paid in the last ${FLOAT_DAYS} days and may bank after this statement.` },
  ];
  // THE LIKELIEST PLAIN REASON: the biggest of the ones that are actually there. Fees only when no
  // bigger reason stands, because an unrecorded fee moves a figure by cents and a sweep by thousands.
  const reason =
    reasons
      .filter((r) => r.cents > 0)
      .sort((a, b) => b.cents - a.cents)[0]?.said ??
    (feesUnsaid
      ? `${feesUnsaid} card ${feesUnsaid === 1 ? "payment has" : "payments have"} no fee recorded, so the expected figure reads high.`
      : null);

  // MONEY NOBODY WORKED OUT A LANDING FOR IS NAMED BESIDE AN ALL-CLEAR, never left to the rows to
  // disclose. "that should reach this account" is honest about what was compared, but read on its own,
  // over a book with $5,000 nobody wrote the method of, "to the cent" is heard as a verification of the
  // lot. Each sentence below is written out WHOLE for the same reason the equity note on the Net Profit
  // card is: a clause spliced onto a branching head is how a sentence comes to say the opposite.
  const unchecked = unsaidCents
    ? ` Another ${sayDollars(unsaidCents / 100)} doesn't say how it was paid, so there was nothing to check it against.`
    : "";

  const say = !recordedCents
    ? // NOTHING WAS RECORDED, so there is no "everything you were paid" to give an all-clear over: said
      // whole, that sentence read as verification of a month nobody had entered a payment for.
      reachedCents
      ? `No payments recorded in these days, and ${sayDollars(reachedCents / 100)} came in.`
      : "No payments recorded in these days, and nothing came in."
    : gap > 0
      ? [`${sayDollars(gap / 100)} of what you were paid hasn't reached this account.`, reason].filter(Boolean).join(" ")
      : !expectedCents && unsaidCents
        ? // NOT ONE PAYMENT HAD A WORKED-OUT LANDING, so there is nothing to tie and nothing to be short
          // by: "$0.00, to the cent" over $5,000 marked Other claims a check nobody could make.
          `${sayDollars(unsaidCents / 100)} of what you were paid doesn't say how it was paid, so there is no saying whether it reached this account.`
        : gap < 0 && reachedCents > 0
          ? `Everything you were paid that should reach this account did, and ${sayDollars(-gap / 100)} more came in besides.${unchecked}`
          : `Everything you were paid that should reach this account did: ${sayDollars(expectedCents / 100)}, to the cent.${unchecked}`;

  return { rows, recordedCents, expectedCents, reachedCents, unsaidCents, unnamedCents, say };
}

/**
 * WHY THE APP THINKS A DEPOSIT IS ALREADY IN THE BOOKS - the channel's own figures, or nothing.
 *
 * Erik, on a $7,714.09 deposit offered "Already Counted Or Not Income": the guess asked him to take its
 * word for it. A guess with no reason is a guess you can only trust; a guess with its working is one you
 * can check. "Your card payments and this account's payouts agree over these weeks" is a real reason;
 * "it looks like a deposit" is not, so where the statement's words name no channel this answers null and
 * the card says nothing extra.
 *
 * It is the CHANNEL's sentence, not a sentence about this line: nothing here attaches a deposit to a
 * payment, and the figures are the period's two totals for that way of being paid.
 */
export function channelWhyFor(description: string, channels: Pick<MoneyInChannels, "rows"> | null | undefined): string | null {
  const key = channelNamedBy(description);
  if (!key || !channels) return null;
  const row = channels.rows.find((r) => r.key === key);
  // A channel the statement names but the books recorded nothing for has nothing worked out to say:
  // the row's own why would read as reassurance about money nobody wrote down.
  if (!row || !row.recordedCents) return null;
  // BUILT FROM THE ROW'S OWN CLAUSES, not from its finished sentence: prefixed to a why-line already at the
  // law's length and then cut again by character, a card's working ended "$1,228.55 sh\u2026" and stopped saying
  // which way the statement was off. capped leaves a clause out whole instead - and this opening is kept
  // short ("$X this period", not "$X paid this period") so that at ordinary five-figure sums there is nothing
  // to leave out. "this period" is the part that must not go: these are the CHANNEL's period totals, never
  // this one deposit's.
  return capped([`${row.label}: ${sayDollars(row.recordedCents / 100)} this period.`, ...row.whyParts]);
}

/** Every method key the app has a label for, with the fate it is read as: for a test that holds the
 *  two tables together, so a method added to payment-method.ts cannot land here as "unsaid" unnoticed. */
export function knownMethodFates(): { key: string; fate: ChannelFate }[] {
  return Object.keys(PAYMENT_METHOD_LABELS).map((key) => ({ key, fate: fateOf(key) }));
}
