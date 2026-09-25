import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { paymentReachedDraft } from "@/lib/tap-settlement";
import { recalcTotals } from "@/lib/invoice-math";
import { sendFirstDetail, sendFirstQuestion } from "@/lib/pay-door-words";

/**
 * NO PAY DOOR SENDS A DRAFT WITHOUT A PERSON SAYING SO (Connected North Phase 1; the 0267 law).
 *
 * INV-069 (2026-09-18): opening Pay Now sent a $6,412 invoice Erik was still building. cn-v961
 * moved the promotion to the webhook, "at the money" - the same silent send one step later: a tap
 * on Andrew's INV-078 would have charged its whole balance and flipped the running draft to sent
 * with no send date. Now every pay door ASKS ("Send INV-078 as the bill first?") and sends it
 * properly (sent_at) only on the yes; the webhook only settles.
 */
describe("the settlement only settles", () => {
  it("money on a draft is SAID (an error_events row), never a status change", () => {
    expect(paymentReachedDraft("draft")).toBe(true);
    for (const s of ["sent", "partial", "paid", "overdue", "void", "", null, undefined]) expect(paymentReachedDraft(s)).toBe(false);
  });

  it("a draft that is paid stays a draft with the money on it, like a deposit on a draft (Erik 7/24)", () => {
    const after = recalcTotals([6412.64], [200, 6212.64], 0, "draft");
    expect(after.amountPaid).toBe(6412.64);
    expect(after.status).toBe("draft");
  });
});

describe("the question the pay doors ask", () => {
  it("names the bill, and says what sending does before the yes", () => {
    expect(sendFirstQuestion("INV-078")).toBe("Send INV-078 as the bill first?");
    expect(sendFirstQuestion(null)).toBe("Send this invoice as the bill first?");
    expect(sendFirstDetail("INV-078")).toMatch(/INV-078 is still a draft/);
    expect(sendFirstDetail("INV-078")).toMatch(/Nothing is emailed or texted/);
  });
});

/**
 * THE WRITES THAT MUST NOT COME BACK, read off the source itself. Each is an absence - the kind of
 * thing that reappears quietly in a later edit and that no runtime test would notice until an
 * owner's half-built invoice is sent again.
 */
const body = (src: string, start: RegExp): string => {
  const i = src.search(start);
  expect(i).toBeGreaterThanOrEqual(0);
  const next = src.slice(i + 1).search(/\nexport (async )?function /);
  return next < 0 ? src.slice(i) : src.slice(i, i + 1 + next);
};

describe("Tap to Pay (tap-actions.ts) sends only on the yes", () => {
  const src = readFileSync("src/app/(app)/billing/tap-actions.ts", "utf8");
  const mint = body(src, /export async function createTapPaymentIntent\(/);

  it("never writes an invoice itself — the one send stamp does, through sendDraftForPayment", () => {
    expect(src).not.toMatch(/from\("invoices"\)[\s\S]{0,200}?\.update\(/);
    expect(src).not.toMatch(/markInvoiceSent\(/);
  });

  it("a draft without sendIt is refused with needsSend BEFORE anything is sent or minted", () => {
    const refuse = mint.indexOf("if (!opts?.sendIt) return needsSendRefusal(");
    const send = mint.indexOf("sendDraftForPayment(");
    const stripe = mint.indexOf("paymentIntents.create(");
    expect(refuse).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(refuse);
    expect(stripe).toBeGreaterThan(send);
  });
});

describe("the Pay Now QR (collectArtifacts) sends only on the yes", () => {
  const src = readFileSync("src/app/(app)/billing/actions.ts", "utf8");
  const qr = body(src, /export async function collectArtifacts\(/);

  it("asks on a draft, and the send it does make is the checked one", () => {
    const refuse = qr.indexOf("if (!opts?.sendIt) return");
    const send = qr.indexOf("sendDraftForPayment(");
    expect(refuse).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(refuse);
    expect(qr).not.toMatch(/markInvoiceSent\(/);
  });
});

describe("the job header's Pay Now (settleUp) lands on the job's bill and sends only on the yes", () => {
  const src = readFileSync("src/app/(app)/billing/actions.ts", "utf8");
  const settle = body(src, /export async function settleUp\(/);

  it("a card on the job's open draft asks first", () => {
    const ask = settle.indexOf('choice.kind === "needsSend" && !input.sendIt');
    const send = settle.indexOf("sendDraftForPayment(");
    expect(ask).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(ask);
  });
});

describe("the webhook settles and never claims a delivery (route.ts)", () => {
  const src = readFileSync("src/app/api/stripe/webhook/route.ts", "utf8");

  it("no door may move a draft here any more", () => {
    expect(src).not.toMatch(/promotesDraft/);
    expect(src).not.toMatch(/from\("invoices"\)[\s\S]{0,120}?\.update\(\{\s*status/);
  });

  it("never stamps sent_at — a payment is not a delivery (0267)", () => {
    expect(src).not.toMatch(/sent_at\s*:/);
  });

  it("money on a draft is logged for a person", () => {
    expect(src).toMatch(/stripe:webhook:payment-on-draft/);
  });

  it("every settle refreshes the money surfaces, so no screen can disagree with the row", () => {
    expect(src).toMatch(/revalidateMoney\(/);
  });
});
