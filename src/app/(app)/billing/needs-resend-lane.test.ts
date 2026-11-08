import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { customerHoldsOlderCopy } from "@/lib/invoice-revision";

/**
 * THE QUESTION 0269 BUILT AN INDEX FOR, AND NOBODY EVER ASKED (cn-v967, audit of v951..v966).
 *
 * 0269 said it in its own migration: the "needs re-sending" question "is asked per org on the
 * billing board", and it shipped a partial index on (org_id, revised_at) to answer it. Then
 * nothing asked. `revised_at` reached exactly one screen — the invoice's own page — so the whole
 * workflow 0269 exists to allow (fix a line on a bill the customer already has, then get on with
 * the day) left no mark on any list, count or badge in the app. The banner that says "send it
 * again" was only ever visible to someone already looking at the invoice that needed it.
 *
 * Live proof, queried 2026-09-20: INV-071, $1,875.98, status 'sent', sent_at
 * 2026-09-19T20:54:55.199Z, revised_at 2026-09-20T05:21:57.343Z, and on /billing that row rendered
 * identically to a bill that was perfectly up to date.
 *
 * NARROWED TO THE MONEY (Erik, 2026-11-07; 0405): "any change i make after its been sent reflects
 * on the link already sent so its mostly unnecessary to send it again unless they've paid and
 * something changes and a difference remains". The lane holds a bill only when the customer paid
 * against a figure that has since moved (sent_total, the total the send carried) and a difference
 * remains. INV-071 as it was that night — changed, unpaid — leaves the lane under this rule. THE
 * ORDER COUNTS (skeptic #56, the same day): paid, THEN changed. A payment made after the change was
 * made on the live figure, so it raises nothing; the payments' paid_at ride along to say which came
 * first.
 *
 * These tests pin the two halves: the RULE (one function, never re-derived) and the PROJECTION (the
 * board cannot answer a question about fields it does not select — the projection law, which is
 * how this got lost in the first place).
 */

const BOARD = "src/app/(app)/billing/page.tsx";
const src = readFileSync(join(process.cwd(), BOARD), "utf8");

/** Source with its comments removed, so an assertion about the CODE can't be satisfied — or
 *  tripped — by prose. This file's comments quote the rule verbatim; the code must not. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

/** The live INV-071 row as it was that night, plus the neighbours that decide whether this lane is
 *  built from the right set: what the board selects (total, amount_paid, the two stamps, 0405's
 *  sent_total, and each payment's paid_at). Figures are invented; INV-071's timestamps are his,
 *  straight off the database. */
const ROWS = [
  // Changed after the send, nothing paid: the live link already shows the change. Not in the lane.
  { invoice_number: "INV-071", status: "sent", total: 1875.98, amount_paid: 0, sent_at: "2026-09-19T20:54:55.199Z", revised_at: "2026-09-20T05:21:57.343Z", sent_total: 1700, payments: [] as { paid_at: string | null }[] },
  // A deposit on a $2,000 bill, then a line added: they paid against $2,000 and $2,400 stands now.
  { invoice_number: "INV-DEPOSIT", status: "partial", total: 2400, amount_paid: 800, sent_at: "2026-10-01T17:00:00.000Z", revised_at: "2026-10-03T17:00:00.000Z", sent_total: 2000, payments: [{ paid_at: "2026-10-02T17:00:00.000Z" }] },
  // THE ORDER (skeptic #56): the same $2,000 bill, the line added first, THEN the deposit through the
  // live link, which showed $2,400 already. The money moved and a balance remains - and nothing is
  // stale for anybody. Not in the lane.
  { invoice_number: "INV-LATE-PAY", status: "partial", total: 2400, amount_paid: 800, sent_at: "2026-10-01T17:00:00.000Z", revised_at: "2026-10-03T17:00:00.000Z", sent_total: 2000, payments: [{ paid_at: "2026-10-04T17:00:00.000Z" }] },
  // A deposit before the change and a second payment after it: the first was on the old figure.
  { invoice_number: "INV-BOTH", status: "partial", total: 2400, amount_paid: 1600, sent_at: "2026-10-01T17:00:00.000Z", revised_at: "2026-10-03T17:00:00.000Z", sent_total: 2000, payments: [{ paid_at: "2026-10-02T17:00:00.000Z" }, { paid_at: "2026-10-04T17:00:00.000Z" }] },
  // The same deposit, then only the title changed: the figure they paid against still stands.
  { invoice_number: "INV-WORDING", status: "partial", total: 2000, amount_paid: 800, sent_at: "2026-10-01T17:00:00.000Z", revised_at: "2026-10-03T17:00:00.000Z", sent_total: 2000, payments: [{ paid_at: "2026-10-02T17:00:00.000Z" }] },
  // Paid in full, then the total LOWERED: status 'paid', balance zero, and they are owed $300.
  { invoice_number: "INV-OWED-BACK", status: "paid", total: 3900, amount_paid: 4200, sent_at: "2026-06-01T17:00:00.000Z", revised_at: "2026-09-01T17:00:00.000Z", sent_total: 4200, payments: [{ paid_at: "2026-06-05T17:00:00.000Z" }] },
  // The one his client wrote in about: a bill settled months ago, reissued in the property owner's
  // name. Status 'paid', balance zero, the money untouched: the link shows the new name already.
  { invoice_number: "INV-RENAMED", status: "paid", total: 4200, amount_paid: 4200, sent_at: "2026-06-01T17:00:00.000Z", revised_at: "2026-09-01T17:00:00.000Z", sent_total: 4200, payments: [{ paid_at: "2026-06-05T17:00:00.000Z" }] },
  // Already put right: a re-send moved sent_at past the revision. revised_at deliberately stays.
  { invoice_number: "INV-FIXED", status: "partial", total: 900, amount_paid: 300, sent_at: "2026-09-02T18:00:00.000Z", revised_at: "2026-09-01T17:00:00.000Z", sent_total: 900, payments: [{ paid_at: "2026-08-20T17:00:00.000Z" }] },
  // Never delivered. INV-069's shape: a pay door promoted it to 'sent' without a card ever being
  // tapped (0267), so sent_at is NULL and there is no customer holding anything.
  { invoice_number: "INV-069", status: "sent", total: 6412, amount_paid: 200, sent_at: null, revised_at: "2026-09-18T21:30:00.000Z", sent_total: null, payments: [{ paid_at: "2026-09-18T20:00:00.000Z" }] },
  // Sent before 0405 (no figure recorded), part paid, then changed: the app cannot prove the money
  // did not move, so it says so rather than guess.
  { invoice_number: "INV-OLD", status: "partial", total: 1000, amount_paid: 500, sent_at: "2026-09-02T18:00:00.000Z", revised_at: "2026-09-10T17:00:00.000Z", sent_total: null, payments: [{ paid_at: "2026-09-05T17:00:00.000Z" }] },
];

/** Exactly the board's call: the three money columns, the two stamps and the payments' dates, through the one rule. */
const lane = (rows: typeof ROWS) =>
  rows.filter((i) =>
    customerHoldsOlderCopy(i.sent_at, i.revised_at, { total: i.total, amountPaid: i.amount_paid, sentTotal: i.sent_total, paidAt: i.payments.map((p) => p.paid_at) }),
  );

describe("the Revised - Send Again lane, on the rows the board reads", () => {
  it("holds exactly the bills whose customer paid against a figure that has since moved", () => {
    expect(lane(ROWS).map((r) => r.invoice_number).sort()).toEqual(["INV-BOTH", "INV-DEPOSIT", "INV-OLD", "INV-OWED-BACK"]);
  });

  it("A PAYMENT MADE AFTER THE CHANGE WAS MADE ON THE LIVE FIGURE — not in the lane (skeptic #56)", () => {
    // INV-DEPOSIT and INV-LATE-PAY are the same bill with the same figures; only the order differs.
    expect(lane(ROWS).map((r) => r.invoice_number)).toContain("INV-DEPOSIT");
    expect(lane(ROWS).map((r) => r.invoice_number)).not.toContain("INV-LATE-PAY");
    // ...and one payment on the old figure is enough, however many came after it.
    expect(lane(ROWS).map((r) => r.invoice_number)).toContain("INV-BOTH");
  });

  it("A CHANGED BILL NOBODY PAID LEAVES THE LANE — the live link already says what it says", () => {
    // INV-071 as it was on 2026-09-20: changed that night, nothing paid. Under 0269 it was the one
    // row this lane was built to catch; under Erik's 2026-11-07 rule there is nothing to send.
    expect(lane(ROWS).map((r) => r.invoice_number)).not.toContain("INV-071");
  });

  it("A PAID INVOICE CAN STILL BELONG HERE — balance is the wrong filter", () => {
    // If this lane were built from the board's `unpaid` list it would be empty for INV-OWED-BACK:
    // status 'paid', balance zero, and the customer owed $300 on a figure they already paid.
    const owedBack = ROWS.find((r) => r.invoice_number === "INV-OWED-BACK")!;
    expect(Math.max(0, owedBack.total - owedBack.amount_paid)).toBe(0);
    expect(lane(ROWS).map((r) => r.invoice_number)).toContain("INV-OWED-BACK");
  });

  it("a wording change on a paid bill says nothing — the figure they paid against still stands", () => {
    expect(lane(ROWS).map((r) => r.invoice_number)).not.toContain("INV-WORDING");
    // The bill reissued in the property owner's name: squared up, money untouched. The old rule
    // kept it here because its payment came BEFORE the change; the link shows the new name already.
    expect(lane(ROWS).map((r) => r.invoice_number)).not.toContain("INV-RENAMED");
  });

  it("a re-sent bill leaves the lane, so the lane can be emptied by doing what it asks", () => {
    expect(lane(ROWS).map((r) => r.invoice_number)).not.toContain("INV-FIXED");
  });

  it("a figure nobody recorded is not guessed: sent before 0405, paid, changed stays in the lane", () => {
    expect(lane(ROWS).map((r) => r.invoice_number)).toContain("INV-OLD");
  });

  it("a bill nobody ever received raises nothing", () => {
    // Telling Erik to re-send INV-069 would be a sentence about a person who does not exist.
    expect(lane(ROWS).map((r) => r.invoice_number)).not.toContain("INV-069");
  });
});

describe("the board asks the question", () => {
  it("selects the money facts the rule reads - the payments' dates included - and hands them to the one rule", () => {
    expect(code).toMatch(/select\("[^"]*\btotal\b[^"]*\bamount_paid\b[^"]*\bsent_total\b[^"]*"\)/);
    expect(code).toMatch(/customerHoldsOlderCopy\(i\.sent_at, i\.revised_at, \{/);
    expect(code).toMatch(/sentTotal: i\.sent_total/);
    // THE ORDER needs the payments' dates (skeptic #56): a rule that reads paid_at off rows the board
    // did not select would read nothing, and every payment would count as "before" (the conservative
    // default) - the projection law, and the exact way the lane got lost in the first place.
    expect(code).toMatch(/select\("[^"]*\bsent_total\b[^"]*payments\(paid_at\)[^"]*"\)/);
    expect(code).toMatch(/paidAt: \(\(i\.payments \?\? \[\]\) as \{ paid_at\?: string \| null \}\[\]\)\.map\(\(p\) => p\.paid_at\)/);
  });

  it("selects both stamps — a field missing at runtime is a select list", () => {
    // THE PROJECTION LAW, and the precise way this defect happened: the board's invoice select was
    // `id, invoice_number, total, amount_paid, status, due_date, customers(name)`. No sent_at, no
    // revised_at, so the board could not have answered the question even if it had wanted to.
    expect(code).toMatch(/select\("[^"]*\bsent_at\b[^"]*\brevised_at\b[^"]*"\)/);
  });

  it("only asks about rows that carry a revision, which is what 0269's partial index covers", () => {
    expect(code).toMatch(/\.not\("revised_at",\s*"is",\s*null\)/);
  });

  it("leaves void invoices out — a voided document is not a bill to re-send", () => {
    expect(code).toMatch(/\.neq\("status",\s*"void"\)/);
  });

  it("USES THE ONE RULE, never a second copy of it", () => {
    // Nine line-level writes once carried nine copies of the draft gate and one of them was wrong
    // for months. `revised_at > sent_at` gets one home (lib/invoice-revision.ts) for that reason.
    expect(src).toContain('from "@/lib/invoice-revision"');
    expect(code).toMatch(/customerHoldsOlderCopy\(/);
    expect(code).not.toMatch(/revised_at\s*>/);
    expect(code).not.toMatch(/sent_at\s*</);
  });
});

describe("the lane says the true thing, and points at a door that exists", () => {
  it("has its own stage, and its words are about the money, like the invoice page's notice", () => {
    expect(src).toContain('title="Revised - Send Again"');
    expect(src).toContain("the figure they paid against is not the figure now");
    // The old claim is gone from every sentence a person reads: the link they hold is live.
    const prose = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
    expect(prose).not.toContain("holding an older");
    expect(prose).toContain("nobody paid on a bill whose money changed afterwards");
  });

  it("opens the invoice instead of inventing a second send path", () => {
    // The Send button lives on the invoice page, inside the same amber notice. A send written
    // here would be a second door, and two doors drift.
    expect(src).toContain("/billing/${inv.id}");
    expect(src).not.toContain("EmailButton");
  });

  it('"All caught up" cannot be printed over a customer who paid against a figure that has moved', () => {
    expect(code).toMatch(/caughtUp\s*=[^;]*needsResend\.length === 0/);
  });

  it("the new copy uses hyphens, like the rest of the copy written this year", () => {
    for (const sentence of [
      "Revised - Send Again",
      "The money on these changed after a payment landed, so the figure they paid against is not the figure now. Open one to send it again.",
    ]) {
      expect(src).toContain(sentence);
      expect(sentence).not.toContain("—");
    }
  });
});

/**
 * ONE AMOUNT LANGUAGE, ONE ROW PER INVOICE, ONE HEADING STYLE (2026-09-24).
 *
 * The board printed a total on two lanes and a balance on two others in the same bold figure,
 * listed a revised bill with money owed in Revised AND in Sent, and titled its lanes in three
 * styles. Every row now reads what is due over what it is due against (invoiceAmount), an
 * invoice appears in one lane, and every heading is Title Case with a spaced hyphen.
 */
describe("the board speaks one language", () => {
  it("has no em dash in any lane title", () => {
    const titles = [...src.matchAll(/title="([^"]*)"/g)].map((m) => m[1]);
    expect(titles.length).toBeGreaterThanOrEqual(4);
    for (const t of titles) expect(t).not.toContain("—");
    for (const t of ["Done - Not Invoiced", "Draft - Not Sent", "Revised - Send Again", "Sent - Awaiting Payment"]) {
      expect(titles).toContain(t);
    }
  });

  it("lists a revised bill with money owed once, in Revised, not again in Sent", () => {
    expect(code).toMatch(/const awaiting = unpaid\.filter\(/);
    expect(code).toMatch(/awaiting\.map\(/);
    expect(code).not.toMatch(/unpaid\.map\(\(inv\)/);
    // Owed to You still counts every open invoice once: the pipeline's own outstanding total.
    expect(code).toContain("const owed = pipeline.outstandingTotal;");
  });

  it("prints every row's figure through <InvoiceAmount, never a bare total or balance", () => {
    expect(code).not.toMatch(/money\(inv\.total\)/);
    expect(code).not.toMatch(/money\(inv\.balance\)/);
    expect(code).not.toMatch(/money\(balance\)/);
    expect(code).not.toMatch(/money\(Number\(inv\.total\)/);
    // Draft, Revised, Sent, By Customer and All Invoices (d103cb9f: every row shows the total
    // inline with what is due).
    expect([...code.matchAll(/<InvoiceAmount /g)].length).toBe(5);
    expect(src).toContain('from "@/components/invoice-amount"');
  });

  it("keeps the wide line out of the shrink-0 column on a phone", () => {
    // At 393px a wide amount beside the verb squeezed the customer to 0-16px. Below sm the whole
    // "$D due of $T" line sits under the left-hand text and the verb is its chevron.
    expect([...code.matchAll(/<InvoiceAmountDetail /g)].length).toBe(5);
    expect(code).toContain('<span className="hidden sm:inline">{children}&nbsp;</span>');
    expect(code).not.toMatch(/>Review &amp; Send <ChevronRight/);
    expect(code).not.toMatch(/>Record Payment <ChevronRight/);
  });
});
