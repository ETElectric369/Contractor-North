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
  return FATE_OF[key] ?? "unsaid";
}

/** The channel a payment belongs to: its method key, or NOT_SAID when the column is blank. */
export function channelKeyOf(method: string | null | undefined): string {
  return String(method ?? "").trim() ? paymentMethodKey(method) : NOT_SAID;
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
 * THESE WORDS ARE ALSO THE APP'S ONE PROCESSOR VOCABULARY (processorWordsRe below): bank-download.ts's
 * PROCESSOR_RE is built from this table, so "is this merchant a processor" and "which channel do its
 * words name" can never drift into two answers.
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

/** One payment recorded in the books: signed cents (a refund is negative), the day, the method as
 *  STORED (blank included - channelKeyOf needs to see a blank), and the processor fee if one was. */
export type ChannelPayment = { cents: number; day: string; method: string; feeCents: number | null };

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

/** What the statement says about one channel, when its words can name it at all. */
function namedClause(expected: number | null, named: number): string {
  if (expected == null) return `The statement names ${sayDollars(named / 100)} of it.`;
  if (!named) return "Nothing on the statement says this way of being paid.";
  if (named === expected) return "The statement names exactly that much.";
  const off = Math.abs(named - expected);
  return `The statement names ${sayDollars(named / 100)} — ${sayDollars(off / 100)} ${named < expected ? "short" : "more"}.`;
}

/** The row's one clause: what becomes of this money, then what the statement said if it said anything. */
function whyOf(key: string, fate: ChannelFate, expected: number | null, named: number | null, feesCents: number, feesUnsaid: number): string {
  const label = channelLabel(key);
  const head = (() => {
    switch (fate) {
      case "never_banked":
        return "Cash never reaches the bank. Its receipts are already costs.";
      case "as_itself":
        return "Expect all of it here, a few days after it was paid.";
      case "when_swept":
        return `Sits in ${label} until somebody moves it to the bank.`;
      case "net_of_fee":
        return feesUnsaid
          ? `A payout lands days later, less its fee — and ${feesUnsaid} of these have no fee recorded, so this figure reads high.`
          : `A payout lands days later: ${sayDollars((expected ?? 0) / 100)} after ${sayDollars(feesCents / 100)} of fees.`;
      case "unsaid":
        return key === NOT_SAID
          ? "Nobody wrote down how these were paid, so there is no saying where they land."
          : `Nothing says where a payment marked ${label} lands, so it is in neither total.`;
    }
  })();
  const tail = named == null ? "" : ` ${namedClause(expected, named)}`;
  return capped(`${head}${tail}`);
}

/** The why-line law's length, and a VISIBLE cut when something overruns it: a company's own custom
 *  method name can be as long as whoever typed it, and a clause sliced off mid-word with no mark looks
 *  like a sentence that simply ended. */
function capped(said: string): string {
  return said.length <= WHY_LINE_MAX ? said : `${said.slice(0, WHY_LINE_MAX - 1).trimEnd()}\u2026`;
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
    const t = at(channelKeyOf(p.method));
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
    return {
      key,
      label: channelLabel(key),
      fate,
      recordedCents: t.recorded,
      expectedCents,
      namedCents: t.named,
      why: whyOf(key, fate, expectedCents, t.named, t.fees, t.feesUnsaid),
    };
  });
  rows.sort((a, b) => Math.abs(b.recordedCents) - Math.abs(a.recordedCents) || a.label.localeCompare(b.label));

  const recordedCents = rows.reduce((s, r) => s + r.recordedCents, 0);
  const expectedCents = rows.reduce((s, r) => s + (r.expectedCents ?? 0), 0);
  const unsaidCents = rows.filter((r) => r.expectedCents == null).reduce((s, r) => s + r.recordedCents, 0);

  // ── THE ONE SENTENCE ──────────────────────────────────────────────────────────────────────────
  const gap = expectedCents - reachedCents;
  const swept = rows.filter((r) => r.fate === "when_swept");
  const sweptCents = swept.reduce((s, r) => s + r.recordedCents - (r.namedCents ?? 0), 0);
  // Money paid in the last few days of the window, on the channels that reach this account at all: the
  // plainest reason of all for a gap, and it needs no guessing about which deposit is which.
  const edgeCents = inWindow
    .filter((p) => fateOf(channelKeyOf(p.method)) !== "never_banked" && fateOf(channelKeyOf(p.method)) !== "unsaid" && dayDiff(to, p.day) < FLOAT_DAYS)
    .reduce((s, p) => s + p.cents, 0);
  const feesUnsaid = inWindow.filter((p) => fateOf(channelKeyOf(p.method)) === "net_of_fee" && p.feeCents == null).length;

  const reasons: { cents: number; said: string }[] = [
    { cents: sweptCents, said: `${sayDollars(sweptCents / 100)} of it is ${sayList(swept.map((r) => r.label))} nobody has moved to the bank yet.` },
    { cents: edgeCents, said: `${sayDollars(edgeCents / 100)} of it was paid in the last ${FLOAT_DAYS} days and may bank after this statement.` },
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

  const say = !recordedCents && !reachedCents
    ? "No payments recorded in these days, and nothing came in."
    : gap > 0
      ? [`${sayDollars(gap / 100)} of what you were paid hasn't reached this account.`, reason].filter(Boolean).join(" ")
      : gap < 0
        ? `Everything you were paid that should reach this account did, and ${sayDollars(-gap / 100)} more came in besides.`
        : `Everything you were paid that should reach this account did: ${sayDollars(expectedCents / 100)}, to the cent.`;

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
  return capped(`${row.label}: ${sayDollars(row.recordedCents / 100)} paid this period. ${row.why}`);
}

/** Every method key the app has a label for, with the fate it is read as: for a test that holds the
 *  two tables together, so a method added to payment-method.ts cannot land here as "unsaid" unnoticed. */
export function knownMethodFates(): { key: string; fate: ChannelFate }[] {
  return Object.keys(PAYMENT_METHOD_LABELS).map((key) => ({ key, fate: fateOf(key) }));
}
