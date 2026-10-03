import { describe, expect, it } from "vitest";
import {
  FLOAT_DAYS,
  NOT_SAID,
  WHY_LINE_MAX,
  channelKeyOf,
  channelLabel,
  channelNamedBy,
  channelWhyFor,
  fateOf,
  knownMethodFates,
  moneyInChannels,
  processorWordsRe,
  type ChannelPayment,
  type MoneyInLine,
} from "./bank-money-in";

/**
 * WHERE YOUR MONEY CAME IN (0376's lane). Every figure here is INVENTED - this repository is public -
 * but the SHAPE is the one that made this lane necessary: a book whose payments add up to far more than
 * the deposits in the one account the owner downloads, with no hole in it anywhere, because cash never
 * reaches a bank, app money waits to be swept, and a card arrives late and net of its fee.
 *
 * Nothing here needs a database.
 */

const WINDOW = { from: "2026-06-01", to: "2026-06-30" };

const pay = (cents: number, day: string, method: string, feeCents: number | null = null): ChannelPayment => ({ cents, day, method, feeCents });

/** A made-up month: every fate represented, and a method nobody wrote down. */
const PAYMENTS: ChannelPayment[] = [
  pay(700_000, "2026-06-03", "check"),
  pay(500_000, "2026-06-18", "Check"), // the same way of being paid, spelled another way
  pay(450_000, "2026-06-05", "card", 13_500),
  pay(350_000, "2026-06-20", "card", 10_500),
  pay(500_000, "2026-06-09", "venmo"),
  pay(300_000, "2026-06-11", "zelle"),
  pay(200_000, "2026-06-29", "transfer"), // inside the float at the end of the window
  pay(60_000, "2026-06-02", "cash"),
  pay(50_000, "2026-06-14", "cash"),
  pay(40_000, "2026-06-23", "cash"),
  pay(40_000, "2026-06-16", ""), // NOBODY WROTE DOWN HOW
  pay(25_000, "2026-06-17", "other"), // somebody CHOSE Other: a different fact
];

const DEPOSITS: MoneyInLine[] = [
  { cents: 776_000, description: "STRIPE TRANSFER 0612" },
  { cents: 1_200_000, description: "DEPOSIT" },
  { cents: 100_000, description: "ONLINE TRANSFER FROM SAVINGS XXXXXX9876" },
];

const view = (over: { payments?: ChannelPayment[]; moneyIn?: MoneyInLine[]; window?: { from: string; to: string } } = {}) =>
  moneyInChannels({ payments: over.payments ?? PAYMENTS, moneyIn: over.moneyIn ?? DEPOSITS, window: over.window ?? WINDOW });

const row = (v: ReturnType<typeof view>, key: string) => v.rows.find((r) => r.key === key)!;

describe("each way of being paid has its own fate, and the card says which", () => {
  it("cash expects NOTHING in the bank, says so, and is never a row to balance", () => {
    const cash = row(view(), "cash");
    expect(cash.recordedCents).toBe(150_000);
    expect(cash.expectedCents).toBe(0);
    expect(cash.why).toContain("Cash never reaches the bank");
    // Not a figure to chase: the statement's words can never name cash, so there is nothing to compare.
    expect(cash.namedCents).toBeNull();
  });

  it("a card is itself LESS the fees that were recorded", () => {
    const card = row(view(), "card");
    expect(card.recordedCents).toBe(800_000);
    expect(card.expectedCents).toBe(800_000 - 24_000);
    expect(card.why).toContain("$7,760.00 after $240.00 of fees");
  });

  it("a check or a transfer is expected here as itself, whatever its letter case was stored in", () => {
    expect(row(view(), "check").recordedCents).toBe(1_200_000);
    expect(row(view(), "check").expectedCents).toBe(1_200_000);
    expect(row(view(), "transfer").expectedCents).toBe(200_000);
    expect(row(view(), "check").why).toContain("Expect all of it here");
  });

  it("app money is real money, somewhere else, until it is swept", () => {
    expect(row(view(), "venmo").expectedCents).toBe(500_000);
    expect(row(view(), "venmo").why).toContain("Sits in Venmo until somebody moves it to the bank");
    expect(row(view(), "zelle").why).toContain("Sits in Zelle");
  });

  it("every method the app has a label for has a worked-out fate, and Other is the only one that does not", () => {
    // A TRIPWIRE, not a tautology: a method added to payment-method.ts with no fate here would read as
    // "nothing says where this lands" on every card, quietly, and this is where that shows up.
    expect(knownMethodFates().filter((m) => m.fate === "unsaid").map((m) => m.key)).toEqual(["other"]);
    expect(fateOf(NOT_SAID)).toBe("unsaid");
    expect(fateOf("apple cash")).toBe("unsaid");
  });
});

describe("a payment nobody said the method of is its own line, never folded into another", () => {
  it("counts a blank method under its own key, apart from the Other somebody chose", () => {
    const v = view();
    // paymentMethodKey("") answers "other". Folding the two together would hide the rows a person needs
    // to go and fix behind a word that looks deliberate.
    expect(channelKeyOf("")).toBe(NOT_SAID);
    expect(channelKeyOf("   ")).toBe(NOT_SAID);
    expect(channelKeyOf("Cash")).toBe("cash");
    expect(row(v, NOT_SAID).recordedCents).toBe(40_000);
    expect(row(v, "other").recordedCents).toBe(25_000);
    expect(channelLabel(NOT_SAID)).toBe("Not Said How It Was Paid");
  });

  it("works out NO expected figure for it, and keeps it out of every total", () => {
    const v = view();
    expect(row(v, NOT_SAID).expectedCents).toBeNull();
    expect(row(v, "other").expectedCents).toBeNull();
    expect(row(v, NOT_SAID).why).toContain("Nobody wrote down how these were paid");
    expect(row(v, "other").why).toContain("Nothing says where a payment marked Other lands");
    // THE TOTAL IS ONLY WHAT COULD BE WORKED OUT, and the rest is said on its own.
    expect(v.unsaidCents).toBe(65_000);
    expect(v.expectedCents).toBe(1_200_000 + 776_000 + 500_000 + 300_000 + 200_000 + 0);
    expect(v.recordedCents).toBe(v.expectedCents + 150_000 + 24_000 + v.unsaidCents);
  });
});

describe("what the statement's own words name - and what they do not", () => {
  it("names a channel from a brand the bank printed, and nothing from a bare transfer", () => {
    expect(channelNamedBy("STRIPE TRANSFER 0612")).toBe("card");
    expect(channelNamedBy("VENMO CASHOUT")).toBe("venmo");
    expect(channelNamedBy("ZELLE FROM A CUSTOMER")).toBe("zelle");
    expect(channelNamedBy("PAYPAL TRANSFER")).toBe("paypal");
    expect(channelNamedBy("CASH APP TRANSFER")).toBe("cashapp");
    // THE $7,714.09 CASE: a deposit from the owner's own other account. These words are equally a swept
    // app balance, money he put in, and a customer's bank transfer, so they name NOTHING.
    expect(channelNamedBy("ONLINE TRANSFER FROM SAVINGS XXXXXX9876")).toBeNull();
    expect(channelNamedBy("DEPOSIT")).toBeNull();
    // A whole word only: a brand is never found inside another word.
    expect(channelNamedBy("SQUARESPACE SUBSCRIPTION")).toBeNull();
  });

  it("a channel the statement never spells out says SO, not zero", () => {
    const v = view();
    // "the statement does not say" and "none of it arrived" are different claims about the money.
    expect(row(v, "check").namedCents).toBeNull();
    expect(row(v, "cash").namedCents).toBeNull();
    // One it CAN name, that it did not: zero named, and the row says which it is.
    expect(row(v, "venmo").namedCents).toBe(0);
    // AND IT SAYS WHAT IT CHECKED. "Nothing says this way of being paid" is a claim about the statement
    // this module cannot make: it reads brand names only, so a payout printed "CARD SETTLEMENT 0612" -
    // which the matcher in bank-download.ts calls a card payout - names nothing HERE.
    expect(row(v, "venmo").why).toContain("Nothing on the statement names Venmo.");
  });

  it("a channel that ties says exactly that; one that does not says BY HOW MUCH", () => {
    expect(row(view(), "card").why).toContain("The statement names exactly that much");
    const short = view({ moneyIn: [{ cents: 700_000, description: "STRIPE TRANSFER" }] });
    expect(row(short, "card").why).toContain("$7,000.00 — $760.00 short");
    const over = view({ moneyIn: [{ cents: 800_000, description: "STRIPE TRANSFER" }] });
    expect(row(over, "card").why).toContain("$8,000.00 — $240.00 more");
  });

  it("money in whose words name nothing is said on its own, never attached to a channel", () => {
    const v = view();
    expect(v.unnamedCents).toBe(1_200_000 + 100_000);
    expect(v.reachedCents).toBe(776_000 + 1_200_000 + 100_000);
    // Every named figure plus the unnamed is every deposit: nothing is counted twice and nothing is lost.
    const named = v.rows.reduce((s, r) => s + (r.namedCents ?? 0), 0);
    expect(named + v.unnamedCents).toBe(v.reachedCents);
  });
});

describe("the one sentence", () => {
  it("leads with the figure, and names the likeliest plain reason", () => {
    const v = view();
    expect(v.expectedCents - v.reachedCents).toBe(900_000);
    expect(v.say).toBe(
      "$9,000.00 of what you were paid hasn't reached this account. $8,000.00 of it may still be in Venmo and Zelle \u2014 the statement doesn't say it was moved to the bank.",
    );
  });

  it("names the window's edge when there is no app money waiting", () => {
    // Only a transfer, paid inside the float at the end of the window, and no deposit yet.
    const v = view({ payments: [pay(200_000, "2026-06-29", "transfer")], moneyIn: [] });
    expect(v.say).toContain("$2,000.00 of what you were paid hasn't reached this account.");
    expect(v.say).toContain(`paid in the last ${FLOAT_DAYS} days and may bank after this statement`);
  });

  it("names fees only when nothing bigger stands, and never calls a missing fee a fee of zero", () => {
    const v = view({ payments: [pay(450_000, "2026-06-05", "card", null)], moneyIn: [{ cents: 400_000, description: "STRIPE TRANSFER" }] });
    expect(row(v, "card").why).toContain("no fee recorded");
    expect(v.say).toContain("1 card payment has no fee recorded, so the expected figure reads high.");
  });

  it("says it ties when it ties, to the cent", () => {
    const v = view({ payments: [pay(700_000, "2026-06-03", "check")], moneyIn: [{ cents: 700_000, description: "DEPOSIT" }] });
    expect(v.say).toBe("Everything you were paid that should reach this account did: $7,000.00, to the cent.");
  });

  it("says so plainly when MORE came in than was paid, and invents no reason for it", () => {
    const v = view({ payments: [pay(700_000, "2026-06-03", "check")], moneyIn: [{ cents: 900_000, description: "DEPOSIT" }] });
    expect(v.say).toBe("Everything you were paid that should reach this account did, and $2,000.00 more came in besides.");
  });

  it("says nothing happened when nothing did", () => {
    expect(view({ payments: [], moneyIn: [] }).say).toBe("No payments recorded in these days, and nothing came in.");
  });

  it("every why-line fits the why-line law", () => {
    for (const r of view().rows) expect(r.why.length, r.key).toBeLessThanOrEqual(WHY_LINE_MAX);
    for (const r of view().rows) expect(r.why.endsWith("."), r.why).toBe(true);
  });

  it("cuts a why-line VISIBLY when a company's own method name overruns it", () => {
    // A method is whatever somebody typed into Settings, so its name can be any length. A clause sliced
    // off mid-word with no mark reads like a sentence that simply ended.
    const long = "A Very Long Custom Way Of Being Paid That Somebody Typed Into Settings One Afternoon";
    const r = row(view({ payments: [pay(10_000, "2026-06-10", long)], moneyIn: [] }), long.toLowerCase());
    expect(r.why.length).toBe(WHY_LINE_MAX);
    expect(r.why.endsWith("\u2026")).toBe(true);
    expect(r.expectedCents).toBeNull();
  });
});

describe("the period is the download's own days, and only those", () => {
  it("leaves out a payment before the first day or after the last", () => {
    const v = view({
      payments: [pay(700_000, "2026-05-31", "check"), pay(100_000, "2026-06-15", "check"), pay(500_000, "2026-07-01", "check")],
      moneyIn: [],
    });
    expect(row(v, "check").recordedCents).toBe(100_000);
    expect(v.rows).toHaveLength(1);
  });

  it("counts the first and the last day themselves", () => {
    const v = view({ payments: [pay(100_000, "2026-06-01", "check"), pay(100_000, "2026-06-30", "check")], moneyIn: [] });
    expect(row(v, "check").recordedCents).toBe(200_000);
  });
});

describe("why the app thinks a deposit is already in the books", () => {
  const v = view();

  it("gives the CHANNEL'S own working for a deposit the statement names", () => {
    const why = channelWhyFor("STRIPE TRANSFER 0612", v);
    expect(why).toBe("Card: $8,000.00 this period. A payout lands days later: $7,760.00 after $240.00 of fees. The statement names exactly that much.");
    expect(why!.length).toBeLessThanOrEqual(WHY_LINE_MAX);
  });

  it("says NOTHING for a deposit whose words name no channel - the $7,714.09 case", () => {
    // Erik's own first case: three deposits from his personal account were customers paying his Venmo,
    // already recorded against their invoices. "It looks like a deposit" is not a reason, so there is
    // none, and the row shows no sentence at all rather than invented confidence.
    expect(channelWhyFor("ONLINE TRANSFER FROM SAVINGS XXXXXX9876", v)).toBeNull();
    expect(channelWhyFor("DEPOSIT", v)).toBeNull();
  });

  it("says nothing about a channel the books recorded nothing for", () => {
    // A payout with no card payment behind it: the row's words would read as reassurance about money
    // nobody wrote down.
    const none = view({ payments: [pay(700_000, "2026-06-03", "check")], moneyIn: [{ cents: 500_000, description: "STRIPE TRANSFER" }] });
    expect(channelWhyFor("STRIPE TRANSFER", none)).toBeNull();
    expect(channelWhyFor("STRIPE TRANSFER", null)).toBeNull();
  });
});

describe("one processor vocabulary, not two", () => {
  /**
   * THE LIST bank-download.ts's PROCESSOR_RE HELD BY HAND until this module took it over. Every word has
   * to still match: a brand dropped out of it stops being "a processor's payout" and starts being "a
   * transfer between the company's own accounts", which changes the guess on every statement that names
   * it. Written out here as the record of what must not be lost.
   */
  const WAS = ["stripe", "square", "sq", "venmo", "zelle", "paypal", "cash app", "clover", "toast", "shopify", "intuit", "quickbooks"];

  it("still matches every word the hand-kept list had", () => {
    const re = processorWordsRe();
    for (const w of WAS) expect(re.test(`ONLINE TRANSFER ${w.toUpperCase()} PAYOUT`), w).toBe(true);
    expect(re.test("CASHAPP TRANSFER")).toBe(true);
  });

  it("matches whole words only, so an ordinary merchant is not read as a processor", () => {
    const re = processorWordsRe();
    expect(re.test("SQUARESPACE")).toBe(false);
    expect(re.test("TOASTED BAGEL CO")).toBe(false);
    expect(re.test("TRANSFER TO SAVINGS")).toBe(false);
  });
});

describe("the arithmetic is integer cents", () => {
  it("adds to the cent on figures that would drift in dollars", () => {
    const v = view({
      payments: [pay(1_033, "2026-06-02", "card", 37), pay(2_067, "2026-06-03", "card", 71), pay(4_409, "2026-06-04", "check")],
      moneyIn: [{ cents: 2_992, description: "STRIPE TRANSFER" }],
    });
    expect(row(v, "card").expectedCents).toBe(1_033 + 2_067 - 37 - 71);
    expect(v.expectedCents).toBe(2_992 + 4_409);
    // The check has not landed, and NO reason is invented for it: nothing is waiting in an app, nothing
    // was paid near the window's edge, every fee was recorded. The gap alone is the honest answer.
    expect(v.say).toBe("$44.09 of what you were paid hasn't reached this account.");
  });
});

/**
 * EVERY ONE OF THESE FAILED BEFORE THE FIX IT NAMES. They are here because the suite was green while the
 * card said, out loud, things the figures beside them disproved.
 */
describe("the one sentence never says more than it worked out", () => {
  it("never names a reason LARGER than the gap it explains", () => {
    // A part cannot be larger than its whole. Two $1,000 card payments, one inside the float, against a
    // $970 payout: the edge figure was summed GROSS while the gap is net of the fee, so the card read
    // "$970.00 hasn't reached this account. $1,000.00 of it was paid in the last 5 days".
    const a = view({
      payments: [pay(100_000, "2026-06-05", "card", 3_000), pay(100_000, "2026-06-29", "card", 3_000)],
      moneyIn: [{ cents: 97_000, description: "STRIPE TRANSFER" }],
    });
    expect(a.say).toBe(
      "$970.00 of what you were paid hasn't reached this account. $970.00 of it was paid in the last 5 days and may bank after this statement.",
    );
    // And a reason bigger than the gap for any other reason is held to the gap: a $5,000 check paid on the
    // 28th cannot explain more than the $44.09 that is actually missing.
    const b = view({ payments: [pay(500_000, "2026-06-28", "check")], moneyIn: [{ cents: 495_591, description: "DEPOSIT" }] });
    expect(b.say).toContain("$44.09 of what you were paid hasn't reached this account. $44.09 of it was paid in the last 5 days");
  });

  it("does not say nobody moved app money the statement might have carried", () => {
    // "ONLINE TRANSFER FROM …" names no channel and is equally the sweep itself - Erik's own $7,714.09
    // deposits were customers paying his Venmo. The clause used to assert "nobody has moved" as a fact.
    const v = view({
      payments: [pay(1_000_000, "2026-06-05", "check"), pay(300_000, "2026-06-06", "venmo")],
      moneyIn: [{ cents: 300_000, description: "ONLINE TRANSFER FROM CHK XXXXXX9876" }],
    });
    expect(v.say).toContain("$3,000.00 of it may still be in Venmo — the statement doesn't say it was moved to the bank.");
    expect(v.say).not.toContain("nobody has moved");
  });

  it("names only a channel with something actually left, row by row", () => {
    // Venmo swept IN FULL and $500 of Zelle waiting: added across rows, Venmo's nothing-left offset
    // Zelle's, and the sentence still named Venmo - a channel its own namedCents proves was moved.
    const moved = view({
      payments: [pay(100_000, "2026-06-05", "venmo"), pay(50_000, "2026-06-06", "zelle")],
      moneyIn: [{ cents: 100_000, description: "VENMO CASHOUT" }],
    });
    expect(moved.say).toContain("$500.00 of it may still be in Zelle —");
    expect(moved.say).not.toContain("Venmo");
    // And a row with a cashout named but NOTHING recorded is below nothing, never a negative to net off.
    const nothingRecorded = view({
      payments: [pay(200_000, "2026-06-05", "zelle")],
      moneyIn: [{ cents: 100_000, description: "VENMO CASHOUT" }],
    });
    expect(nothingRecorded.say).toContain("$1,000.00 of it may still be in Zelle —");
    expect(nothingRecorded.say).not.toContain("Venmo");
  });

  it("gives no all-clear where NOT ONE payment had a worked-out landing", () => {
    // $5,000 marked Other and no deposits used to read "Everything you were paid that should reach this
    // account did: $0.00, to the cent." - a check nobody could make, said as a verification.
    const v = view({ payments: [pay(500_000, "2026-06-05", "other")], moneyIn: [] });
    expect(v.say).toBe(
      "$5,000.00 of what you were paid doesn't say how it was paid, so there is no saying whether it reached this account.",
    );
    expect(v.say).not.toContain("Everything you were paid");
  });

  it("names the money it could NOT check beside a tie or a surplus", () => {
    const tie = view({
      payments: [pay(100_000, "2026-06-05", "check"), pay(500_000, "2026-06-06", "other")],
      moneyIn: [{ cents: 100_000, description: "DEPOSIT" }],
    });
    expect(tie.say).toBe(
      "Everything you were paid that should reach this account did: $1,000.00, to the cent. Another $5,000.00 doesn't say how it was paid, so there was nothing to check it against.",
    );
    // And it is left off entirely when there was nothing of the sort: no clause for a fact with no figure.
    const clean = view({ payments: [pay(700_000, "2026-06-03", "check")], moneyIn: [{ cents: 700_000, description: "DEPOSIT" }] });
    expect(clean.say).not.toContain("doesn't say how it was paid");
  });

  it("says nothing was recorded when nothing was, whatever came in", () => {
    // No payment at all plus two deposits used to read "Everything you were paid that should reach this
    // account did, and $12,000.00 more came in besides." - an all-clear over a month nobody had entered.
    const v = view({ payments: [], moneyIn: [{ cents: 500_000, description: "STRIPE TRANSFER" }, { cents: 700_000, description: "DEPOSIT" }] });
    expect(v.say).toBe("No payments recorded in these days, and $12,000.00 came in.");
  });

  it("never says money came in besides when none came in at all", () => {
    // A guard, not a path a door can reach: every payment writer refuses an amount at or below zero (see
    // ChannelPayment). Fed one anyway, the surplus wording announced $500.00 arriving on a statement with
    // no money in at all, because it read the difference of two totals and never what reached the account.
    const v = view({ payments: [pay(-50_000, "2026-06-05", "check")], moneyIn: [] });
    expect(v.say).not.toContain("more came in besides");
  });
});

describe("how the money reaches the bank is what decides its fate", () => {
  it("reads a payment STRIPE collected as a card payout, whatever method was stored", () => {
    // Stripe's bank-debit checkout stores 'ach' WITH a real fee. Read by its method alone it was expected
    // at its gross while paying out net under a Stripe descriptor, so an ordinary month printed a gap
    // exactly the size of the fees, with no reason, and the Card row claimed a payout it was never paid.
    const v = moneyInChannels({
      payments: [{ cents: 100_000, day: "2026-06-05", method: "ach", feeCents: 800, stripe: true }],
      moneyIn: [{ cents: 99_200, description: "STRIPE TRANSFER" }],
      window: WINDOW,
    });
    expect(v.rows.map((r) => r.key)).toEqual(["card"]);
    expect(row(v, "card").recordedCents).toBe(100_000);
    expect(row(v, "card").expectedCents).toBe(99_200);
    expect(v.say).toBe("Everything you were paid that should reach this account did: $992.00, to the cent.");
  });

  it("leaves an ACH nobody collected through Stripe as itself", () => {
    const v = view({ payments: [pay(100_000, "2026-06-05", "ach")], moneyIn: [] });
    expect(row(v, "ach").expectedCents).toBe(100_000);
    expect(row(v, "ach").why).toContain("Expect all of it here");
  });

  it("gives a method named like a member of Object.prototype no fate at all", () => {
    // A plain object answers "constructor" with Object itself, so `FATE_OF[key] ?? "unsaid"` handed back a
    // function: the row's why rendered the word "undefined" and the money was counted as having ARRIVED IN
    // FULL instead of landing in unsaidCents. Settings takes any text, so this is reachable (review 09-24).
    for (const key of ["constructor", "__proto__"]) {
      expect(fateOf(key)).toBe("unsaid");
      const v = view({ payments: [pay(500_000, "2026-06-05", key)], moneyIn: [] });
      expect(row(v, key).expectedCents).toBeNull();
      expect(v.unsaidCents).toBe(500_000);
      expect(v.expectedCents).toBe(0);
      expect(v.rows[0].why).not.toContain("undefined");
    }
  });
});

describe("a row says where the money IS, and a working is never sliced mid-word", () => {
  it("does not say app money is waiting when the statement names the cashout in full", () => {
    const v = view({ payments: [pay(300_000, "2026-06-05", "venmo")], moneyIn: [{ cents: 300_000, description: "VENMO CASHOUT" }] });
    expect(row(v, "venmo").why).toBe("Already moved to the bank, not sitting in Venmo. The statement names exactly that much.");
    expect(channelWhyFor("VENMO CASHOUT", v)).toBe(
      "Venmo: $3,000.00 this period. Already moved to the bank, not sitting in Venmo. The statement names exactly that much.",
    );
    // A PART sweep still reads as waiting, because part of it is.
    const part = view({ payments: [pay(300_000, "2026-06-05", "venmo")], moneyIn: [{ cents: 100_000, description: "VENMO CASHOUT" }] });
    expect(row(part, "venmo").why).toContain("Sits in Venmo until somebody moves it to the bank.");
  });

  it("keeps the word that says WHICH WAY the statement is off, at ordinary five-figure sums", () => {
    // Card $17,751.63, fees $523.08, a $16,000.00 payout. The hint used to be cut by character at 140 and
    // ended "$1,228.55 sh…", which no longer says short or more - the whole of what it was there to say.
    const v = view({ payments: [pay(1_775_163, "2026-06-05", "card", 52_308)], moneyIn: [{ cents: 1_600_000, description: "STRIPE TRANSFER" }] });
    const hint = channelWhyFor("STRIPE TRANSFER", v)!;
    expect(hint).toBe(
      "Card: $17,751.63 this period. A payout lands days later: $17,228.55 after $523.08 of fees. The statement names $16,000.00 — $1,228.55 short.",
    );
    expect(hint.length).toBeLessThanOrEqual(WHY_LINE_MAX);
  });

  it("leaves a clause out WHOLE when it cannot fit, rather than slicing the word that carries it", () => {
    // Six figures on a card: the statement clause will not fit behind the channel's own figures, so it is
    // left out and every sentence that IS said is complete. Nothing ends mid-word.
    const v = view({ payments: [pay(11_775_163, "2026-06-05", "card", 352_308)], moneyIn: [{ cents: 10_600_000, description: "STRIPE TRANSFER" }] });
    const hint = channelWhyFor("STRIPE TRANSFER", v)!;
    expect(hint.length).toBeLessThanOrEqual(WHY_LINE_MAX);
    expect(hint.endsWith("of fees.")).toBe(true);
    expect(hint).not.toContain("…");
    // The row's own why still carries it in full, on the same card.
    expect(row(v, "card").why).toContain("$8,228.55 short.");
  });

  it("keeps a card row's statement clause when a fee was never recorded", () => {
    // The unrecorded-fee head was 105 characters, so every card row with a fee nobody recorded - a card
    // payment taken outside the app's own Stripe flow, which is ordinary - lost what the statement named.
    const v = view({ payments: [pay(1_775_163, "2026-06-05", "card", null)], moneyIn: [{ cents: 1_775_163, description: "STRIPE TRANSFER" }] });
    const why = row(v, "card").why;
    expect(why).toContain("1 with no fee recorded, so this reads high.");
    expect(why).toContain("The statement names exactly that much.");
    expect(why.length).toBeLessThanOrEqual(WHY_LINE_MAX);
    expect(why).not.toContain("…");
  });
});

describe("what the module says about itself is true of the database", () => {
  it("counts the method nobody CHOSE under Other, which is where the database actually puts a blank", () => {
    // 0287's trigger maps '' to 'other' and payments.method is NOT NULL, so NOT_SAID cannot be drawn from
    // stored data and every test of it feeds an input the table cannot hold. What a company that never
    // records a method ACTUALLY gets is this row, and the arithmetic has to be right for it: no worked-out
    // landing, in no total, and said on its own rather than folded into a channel.
    const v = view({ payments: [pay(500_000, "2026-06-05", "other")], moneyIn: [] });
    expect(row(v, "other").expectedCents).toBeNull();
    expect(row(v, "other").why).toContain("Nothing says where a payment marked Other lands");
    expect(v.unsaidCents).toBe(500_000);
    expect(v.expectedCents).toBe(0);
    // The blank row stays DEFENSIVE, and keeps its own key so a blank arriving later is never folded in.
    expect(channelKeyOf("")).toBe(NOT_SAID);
    expect(channelKeyOf("other")).toBe("other");
  });
});
