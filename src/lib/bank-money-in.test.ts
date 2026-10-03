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
    expect(row(v, "venmo").why).toContain("Nothing on the statement says this way of being paid");
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
      "$9,000.00 of what you were paid hasn't reached this account. $8,000.00 of it is Venmo and Zelle nobody has moved to the bank yet.",
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
    expect(why).toBe("Card: $8,000.00 paid this period. A payout lands days later: $7,760.00 after $240.00 of fees. The statement names exactly that much.");
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
