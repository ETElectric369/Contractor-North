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
 * Live proof, queried 2026-09-20: INV-071, Karen Wucher, $1,875.98, status 'sent', sent_at
 * 2026-09-19T20:54:55.199Z, revised_at 2026-09-20T05:21:57.343Z. She is holding the older bill
 * right now, and on /billing that row rendered identically to a bill that is perfectly up to date.
 *
 * These tests pin the two halves of the fix: the RULE (one function, never re-derived) and the
 * PROJECTION (the board cannot answer a question about fields it does not select — the projection
 * law, which is how this got lost in the first place).
 */

const BOARD = "src/app/(app)/billing/page.tsx";
const src = readFileSync(join(process.cwd(), BOARD), "utf8");

/** Source with its comments removed, so an assertion about the CODE can't be satisfied — or
 *  tripped — by prose. This file's comments quote the rule verbatim; the code must not. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

/** The live INV-071 row, plus the three neighbours that decide whether this lane is built from
 *  the right set. Timestamps and figures are his, straight off the database. */
const ROWS = [
  { invoice_number: "INV-071", status: "sent", total: 1875.98, amount_paid: 0, sent_at: "2026-09-19T20:54:55.199Z", revised_at: "2026-09-20T05:21:57.343Z" },
  // The one his client wrote in about: a bill settled months ago, reissued in the property
  // owner's name. Status 'paid', balance zero, and it still needs to go out again.
  { invoice_number: "INV-PAID", status: "paid", total: 4200, amount_paid: 4200, sent_at: "2026-06-01T17:00:00.000Z", revised_at: "2026-09-01T17:00:00.000Z" },
  // Already put right: a re-send moved sent_at past the revision. revised_at deliberately stays.
  { invoice_number: "INV-FIXED", status: "sent", total: 900, amount_paid: 0, sent_at: "2026-09-02T18:00:00.000Z", revised_at: "2026-09-01T17:00:00.000Z" },
  // Never delivered. INV-069's shape: a pay door promoted it to 'sent' without a card ever being
  // tapped (0267), so sent_at is NULL and there is no customer holding anything.
  { invoice_number: "INV-069", status: "sent", total: 6412, amount_paid: 200, sent_at: null, revised_at: "2026-09-18T21:30:00.000Z" },
];

const lane = (rows: typeof ROWS) => rows.filter((i) => customerHoldsOlderCopy(i.sent_at, i.revised_at));

describe("the Revised - Send Again lane, on his real rows", () => {
  it("catches INV-071, which is live in this state today", () => {
    expect(lane(ROWS).map((r) => r.invoice_number)).toContain("INV-071");
  });

  it("A PAID INVOICE STILL BELONGS HERE — balance is the wrong filter", () => {
    // If this lane were built from the board's `unpaid` list it would be empty for INV-PAID,
    // which is the exact invoice the whole 0269 wave was written for. What is wrong is the piece
    // of paper in the customer's hands, and that has nothing to do with what they still owe.
    expect(lane(ROWS).map((r) => r.invoice_number)).toContain("INV-PAID");
    expect(ROWS.find((r) => r.invoice_number === "INV-PAID")!.total - ROWS.find((r) => r.invoice_number === "INV-PAID")!.amount_paid).toBe(0);
  });

  it("a re-sent bill leaves the lane, so the lane can be emptied by doing what it asks", () => {
    expect(lane(ROWS).map((r) => r.invoice_number)).not.toContain("INV-FIXED");
  });

  it("KAREN PAID THE CORRECTED BILL IN FULL, SO SHE LEAVES (7711aba4)", () => {
    // What the board reads today: status paid, her $1,875.98 through her own live link, 18 hours
    // after the change. The link shows the live bill, so she paid the one Erik is looking at.
    type Row = { total: number; amount_paid: number; sent_at: string; revised_at: string; payments: { paid_at: string }[] };
    const onBoard = (i: Row) =>
      customerHoldsOlderCopy(i.sent_at, i.revised_at, { total: i.total, amountPaid: i.amount_paid, paidAt: i.payments.map((p) => p.paid_at) });
    const karen: Row = { total: 1875.98, amount_paid: 1875.98, sent_at: ROWS[0].sent_at!, revised_at: ROWS[0].revised_at, payments: [{ paid_at: "2026-09-20T23:40:27.000Z" }] };
    expect(onBoard(karen)).toBe(false);
    // The paid-in-June bill keeps its place: its only payment came before the change.
    const june: Row = { total: 4200, amount_paid: 4200, sent_at: ROWS[1].sent_at!, revised_at: ROWS[1].revised_at, payments: [{ paid_at: "2026-06-02T17:00:00.000Z" }] };
    expect(onBoard(june)).toBe(true);
  });

  it("a bill nobody ever received raises nothing", () => {
    // Telling Erik to re-send INV-069 would be a sentence about a person who does not exist.
    expect(lane(ROWS).map((r) => r.invoice_number)).not.toContain("INV-069");
  });
});

describe("the board asks the question", () => {
  it("selects what the paid-in-full rule reads, and hands it to the one rule", () => {
    expect(code).toMatch(/select\("[^"]*\bamount_paid\b[^"]*\bpayments\(paid_at\)[^"]*"\)/);
    expect(code).toMatch(/customerHoldsOlderCopy\(i\.sent_at, i\.revised_at, \{/);
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
  it("has its own stage with words that match the invoice page's banner", () => {
    expect(src).toContain('title="Revised - Send Again"');
    expect(src).toContain("holding an older bill");
  });

  it("opens the invoice instead of inventing a second send path", () => {
    // The Send button lives on the invoice page, inside the same amber notice. A send written
    // here would be a second door, and two doors drift.
    expect(src).toContain("/billing/${inv.id}");
    expect(src).not.toContain("EmailButton");
  });

  it('"All caught up" cannot be printed over a customer holding the wrong bill', () => {
    expect(code).toMatch(/caughtUp\s*=[^;]*needsResend\.length === 0/);
  });

  it("the new copy uses hyphens, like the rest of the copy written this year", () => {
    for (const sentence of [
      "Revised - Send Again",
      "You changed these after they went out, so the customer is holding an older bill. Open one to send the corrected copy.",
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
    // The tiles still count every open invoice once.
    expect(code).toMatch(/Outstanding · \{unpaid\.length\}/);
  });

  it("prints every row's figure through <Amount, never a bare total or balance", () => {
    expect(code).not.toMatch(/money\(inv\.total\)/);
    expect(code).not.toMatch(/money\(inv\.balance\)/);
    expect(code).not.toMatch(/money\(balance\)/);
    expect(code).not.toMatch(/money\(Number\(inv\.total\)/);
    expect([...code.matchAll(/<Amount /g)].length).toBe(4);
    expect(src).toContain('from "@/lib/invoice-amount"');
  });

  it("keeps the wide detail out of the shrink-0 column on a phone", () => {
    // At 393px "of $T · $P paid" beside the verb squeezed the customer to 0-16px. Below sm the
    // detail sits under the left-hand text and the verb is its chevron.
    expect([...code.matchAll(/<AmountDetail /g)].length).toBe(4);
    expect(code).toContain('<span className="hidden whitespace-nowrap text-[11px] text-slate-500 sm:block">{a.detail}</span>');
    expect(code).toContain('<span className="hidden sm:inline">{children}&nbsp;</span>');
    expect(code).not.toMatch(/>Review &amp; Send <ChevronRight/);
    expect(code).not.toMatch(/>Record Payment <ChevronRight/);
  });
});
