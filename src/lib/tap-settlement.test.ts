import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { draftPromotionOnPayment } from "@/lib/tap-settlement";
import { paidStatus, recalcTotals } from "@/lib/invoice-math";

/**
 * INV-069, 2026-09-18 — "its not sent its in draft mode thats partially why this is confusing".
 *
 * Pay Now promoted a DRAFT invoice to 'sent' the moment it built the card door: Erik opened the
 * sheet on a $6,412.64 invoice he was still building, no card was ever tapped, and the bill was
 * promoted for good — onto a status paidStatus() calls 'partial', with a $200 cash deposit on it
 * that then barred the way back to Draft.
 *
 * Two halves are pinned here. The OPEN must move nothing (the tap door is a read and a Stripe
 * call), and the DEED must move the draft, because paidStatus() never advances a draft on its own
 * and money would otherwise sit on one forever.
 */
describe("draftPromotionOnPayment — the pay door's deed, and only at the deed", () => {
  it("a settled tap on a draft promotes it to sent", () => {
    expect(draftPromotionOnPayment("draft", true)).toBe("sent");
  });

  it("a door that hands the customer a bill of its own promotes nothing here", () => {
    // The public link door (/api/pay, the QR) promoted at the handing over; a second promotion in
    // the webhook would be a rule living in two places.
    expect(draftPromotionOnPayment("draft", false)).toBeNull();
  });

  it("an invoice that already left draft is left exactly where it is", () => {
    for (const status of ["sent", "partial", "paid", "overdue"]) {
      expect(draftPromotionOnPayment(status, true)).toBeNull();
    }
  });

  it("a void invoice is never quietly un-voided by money arriving on it (the 0259 boundary)", () => {
    expect(draftPromotionOnPayment("void", true)).toBeNull();
  });

  it("a missing status is not a draft — nothing is written on a guess", () => {
    expect(draftPromotionOnPayment(null, true)).toBeNull();
    expect(draftPromotionOnPayment(undefined, true)).toBeNull();
    expect(draftPromotionOnPayment("", true)).toBeNull();
  });
});

describe("the INV-069 chain: a draft taken across the counter ends up paid, not stuck", () => {
  const lines = [6412.64];
  const deposit = 200;

  it("WITHOUT the promotion a settled draft stays a draft with money on it (the bug pointing the other way)", () => {
    // paidStatus deliberately never advances a draft (Erik 7/24: a deposit recorded on a draft
    // must not silently lock its lines), so the recalc alone cannot finish the job.
    const after = recalcTotals(lines, [deposit, 6212.64], 0, "draft");
    expect(after.amountPaid).toBe(6412.64);
    expect(after.status).toBe("draft");
  });

  it("WITH the promotion first, the same recalc lands on paid", () => {
    const promoted = draftPromotionOnPayment("draft", true);
    expect(promoted).toBe("sent");
    const after = recalcTotals(lines, [deposit, 6212.64], 0, promoted!);
    expect(after.status).toBe("paid");
  });

  it("a partial tap on a promoted draft reads 'partial' — the status the stored row disagreed with", () => {
    // INV-069's stored 'sent' with $200 on it was the one row in the table paidStatus contradicted.
    expect(paidStatus(6412.64, deposit, "sent")).toBe("partial");
  });
});

/**
 * THE TWO WRITES THAT MUST NOT COME BACK, read off the source itself.
 *
 * Neither is reachable from a pure function, and both are absences — the kind of thing that
 * reappears quietly in a later edit and that no runtime test would notice until an owner's
 * half-built invoice is sent again. Same tool as 0207's trigger pin (pdf-restamp.test.ts).
 */
describe("the tap door opens onto nothing (tap-actions.ts)", () => {
  const src = readFileSync("src/app/(app)/billing/tap-actions.ts", "utf8");

  it("never updates an invoice — minting a PaymentIntent is a read and a Stripe call", () => {
    // `.from("invoices")` may only ever be SELECTed from in this file.
    expect(src).not.toMatch(/from\("invoices"\)[\s\S]{0,200}?\.update\(/);
  });

  it("carries no 'send' option and no draft refusal to re-grow the promotion around", () => {
    expect(src).not.toMatch(/opts\?\.\s*send/);
    expect(src).not.toMatch(/still a draft/i);
  });
});

describe("the webhook promotes at the money, and never claims a delivery (route.ts)", () => {
  const src = readFileSync("src/app/api/stripe/webhook/route.ts", "utf8");

  it("the tap branch is the door allowed to move a draft", () => {
    expect(src).toMatch(/promotesDraft:\s*true/);
    expect(src).toMatch(/draftPromotionOnPayment\(/);
  });

  it("never stamps sent_at — a counter payment is not a delivery (0267)", () => {
    // The comments above the promotion name the column on purpose; what must never appear is it
    // being WRITTEN, which in a PostgREST update is always `sent_at:` in the object literal.
    expect(src).not.toMatch(/sent_at\s*:/);
  });

  it("every settle refreshes the money surfaces, so no screen can disagree with the row", () => {
    expect(src).toMatch(/revalidateMoney\(/);
  });
});
