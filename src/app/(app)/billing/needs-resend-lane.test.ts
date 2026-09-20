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

  it("a bill nobody ever received raises nothing", () => {
    // Telling Erik to re-send INV-069 would be a sentence about a person who does not exist.
    expect(lane(ROWS).map((r) => r.invoice_number)).not.toContain("INV-069");
  });
});

describe("the board asks the question", () => {
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
