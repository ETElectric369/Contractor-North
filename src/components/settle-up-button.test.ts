import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
// The sheet drawn open, so what it says can be read (the real Modal renders nothing while closed).
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: string; children?: ReactNode; footer?: ReactNode }) =>
    createElement("div", { "data-modal": title }, children, footer),
  ModalActions: () => null,
}));

const { doorAmountStillMatches, holdCardLine, GetPaidButton, SettleUpButton } = await import("./settle-up-button");

/**
 * THE FIGURE ON THE CARD IS THE FIGURE ON THE INVOICE, OR NOTHING IS CHARGED.
 *
 * Tap to Pay hands Stripe a PaymentIntent minted at one moment and reads a card at another. Every
 * gap between those two moments is a gap the office can edit the invoice through, and the phone
 * has no idea: the reader charges the figure the intent was minted with, not the one the invoice
 * now says. The press already re-read the balance. The OTHER way to the reader did not — the
 * retry after Apple's terms sheet and Apple's how-to guide, which on this codebase's own clocks
 * is allowed eight minutes for the connect and ten more for the guide, and which only ever runs
 * on a company's very first tap: the day the office is most likely to still be building the bill.
 *
 * Fixtures are his own invoices as they stand (2026-09-20):
 *   INV-069  $6,268.03 total, $200.00 deposit taken  → $6,068.03 owed. The deposit is the one that
 *            cost him: it is what made INV-069 unfixable from the page once it had moved.
 *   INV-070  $1.23     the real charge that proved Tap to Pay end to end on 2026-09-18.
 *   INV-071  $1,875.98 sent, nothing paid.
 */

const INV_069 = { ok: true, total: 6268.03, amountPaid: 200 };
const INV_070 = { ok: true, total: 1.23, amountPaid: 0 };
const INV_071 = { ok: true, total: 1875.98, amountPaid: 0 };

describe("doorAmountStillMatches — does this PaymentIntent still say what the invoice says", () => {
  it("agrees to the cent on his own numbers", () => {
    expect(doorAmountStillMatches(606803, INV_069)).toBe(true);
    expect(doorAmountStillMatches(123, INV_070)).toBe(true);
    expect(doorAmountStillMatches(187598, INV_071)).toBe(true);
  });

  it("refuses a door minted before the deposit landed", () => {
    // The intent was minted for the whole $6,268.03; the $200 arrived while the sheet was open.
    expect(doorAmountStillMatches(626803, INV_069)).toBe(false);
  });

  it("refuses a door minted before a line was added — the new figure is HIGHER, and that is worse", () => {
    // A tech quoted $1,875.98 out loud; the office added $124.02 of material behind him.
    expect(doorAmountStillMatches(187598, { ok: true, total: 2000, amountPaid: 0 })).toBe(false);
  });

  it("is false by one cent, because a cent is a wrong charge too", () => {
    expect(doorAmountStillMatches(606802, INV_069)).toBe(false);
    expect(doorAmountStillMatches(606804, INV_069)).toBe(false);
  });

  it("a read that did not answer is NOT agreement", () => {
    // Not knowing what the invoice says is not the same as knowing it agrees. Both of these are
    // a door thrown away and a fresh one minted, never a card read on faith.
    expect(doorAmountStillMatches(606803, null)).toBe(false);
    expect(doorAmountStillMatches(606803, { ok: false })).toBe(false);
  });

  it("survives the float the balance is carried in", () => {
    // 0.1 + 0.2 arithmetic: invoiceBalance rounds to cents, and the comparison is integers.
    expect(doorAmountStillMatches(10, { ok: true, total: 0.3, amountPaid: 0.2 })).toBe(true);
    expect(doorAmountStillMatches(606803, { ok: true, total: 6268.029999, amountPaid: 200 })).toBe(true);
  });

  it("a paid-off invoice matches nothing a door could have been minted for", () => {
    // INV-070 after the webhook wrote it: zero owed, so no door onto it is good any more.
    expect(doorAmountStillMatches(123, { ok: true, total: 1.23, amountPaid: 1.23 })).toBe(false);
  });
});

describe("holdCardLine — the last sentence before Apple owns the screen", () => {
  it("prints the intent's own cents, formatted the way the rest of the screen prints money", () => {
    expect(holdCardLine(606803)).toBe("Hold their card to the top of the phone: $6,068.03");
    expect(holdCardLine(123)).toBe("Hold their card to the top of the phone: $1.23");
    expect(holdCardLine(187598)).toBe("Hold their card to the top of the phone: $1,875.98");
  });
});

const SRC = readFileSync(join(process.cwd(), "src/components/settle-up-button.tsx"), "utf8");

/**
 * The rest of this is shape, not behaviour: the defect was control flow inside one async function
 * that needs a card reader, Apple's terms sheet and a second device editing an invoice to
 * reproduce. What CAN be pinned is that there is one door-builder and that nothing reaches the
 * reader around it — so the next hand that adds a third way in cannot quietly skip the check.
 */
describe("every way to the reader goes through doorFor", () => {
  it("both card reads are handed a door that was just checked", () => {
    // The card reads go through tapToPay's `collect` wrapper (it marks the reader as collecting, so
    // a Cancel before the read is honoured and one during it is left to the reader's answer). The
    // bridge itself is called in exactly one place: inside that wrapper.
    expect([...SRC.matchAll(/await collectTapPayment\(/g)]).toHaveLength(1);
    expect(SRC).toMatch(/const collect = async \([^)]*\) => \{\s*tapCollecting\.current = true;\s*try \{\s*return await collectTapPayment\(/);
    const collects = [...SRC.matchAll(/await collect\(/g)].map((m) => m.index ?? 0);
    expect(collects).toHaveLength(2);
    for (const at of collects) {
      const before = SRC.slice(0, at);
      const lastDoor = before.lastIndexOf("await doorFor(");
      expect(lastDoor).toBeGreaterThan(-1);
      // Nothing between the check and the card except painting the prompt.
      const between = before.slice(lastDoor);
      expect(between).not.toContain("showHowToTap(");
      expect(between).not.toContain("enableTapToPay(");
      expect(between).not.toContain("termsGate(");
    }
  });

  it("Cancel before the card read retires the press; a finished read is never thrown away", () => {
    // Review of the 09-23 wave: the busy screen shows Cancel from the press on, but before this the
    // press waited on the probe, the invoice door and the mint, then armed the reader regardless.
    expect(SRC).toMatch(/const press = \+\+tapPress\.current;/);
    // Pre-collect checks honour a retired press; the post-read check (armed) looks only at the
    // sheet, so a card read a moment before Cancel is still reported as the charge it is.
    expect(SRC).toMatch(/const retired = !armed && tapPress\.current !== press;/);
    // The button retires the press, tells the bridge, and only puts the sheet back itself when no
    // read is running (during one, the reader's cancelled-or-charged answer sets the screen).
    expect(SRC).toMatch(/tapPress\.current \+= 1;\s*void cancelTapPayment\(\);\s*(?:\/\/[^\n]*\s*)*if \(!tapCollecting\.current\) setTap\(\{ kind: "idle" \}\);/);
  });

  it("the prompt's figure is read off the door at the moment it is painted, never captured earlier", () => {
    // `const holdCard = ...` above the terms gate was the bug's other half: a re-minted door
    // would have repainted the pre-terms number on the card prompt.
    expect(SRC).not.toMatch(/const holdCard\s*=/);
    expect([...SRC.matchAll(/label: holdCardLine\(pi\.amount\)/g)]).toHaveLength(2);
  });

  it("the balance re-check lives in exactly one place", () => {
    // One definition, one call site. A second call site would mean a second place deciding what
    // "still good" means, which is how two answers to one money question get shipped.
    expect([...SRC.matchAll(/doorAmountStillMatches\(/g)]).toHaveLength(2);
    expect([...SRC.matchAll(/(?<!function )doorAmountStillMatches\(/g)]).toHaveLength(1);
    expect([...SRC.matchAll(/async function doorFor\(/g)]).toHaveLength(1);
  });

  it("a moved balance stops the retry in words, and names a button that is on the screen", () => {
    expect(SRC).toContain("The balance changed while Apple's terms were up. Press Tap to Pay again for the new amount.");
    // NO DEAD ENDS: the sentence names Tap to Pay, and that button renders on both outcome
    // screens (Apple 5.3 keeps it enabled), so there is something to press.
    expect([...SRC.matchAll(/<TapToPayGlyph \/> Tap to Pay/g)].length).toBeGreaterThanOrEqual(2);
  });
});

describe("a PaymentIntent nobody can reach is cancelled, not left open on the tenant's Stripe", () => {
  it("every mint in this file self-cancels when the sheet closed under it", () => {
    const mints = [...SRC.matchAll(/createTapPaymentIntent\(/g)].map((m) => m.index ?? 0);
    // Two: the open-time pre-mint (Apple 5.6), and doorFor's (the press, the job/appointment tap, the
    // post-terms retry and the yes to "Send INV-078 as the bill first?" all come through it). The
    // third was the open-time mint's own ask on a draft; in the one Get Paid sheet (W1-26) a card
    // door asks when it is PRESSED, so the cash half of the sheet is never stopped by a card question.
    expect(mints).toHaveLength(2);
    for (const at of mints) {
      // Within the handful of lines after the mint resolves, the closed-sheet branch has to let
      // the intent go. Before this wave doorFor's mint just `return`ed and the intent stayed
      // live on the tenant's account with a customer's invoice on it.
      const after = SRC.slice(at, at + 900);
      expect(after).toContain("cancelTapPaymentIntent(r.paymentIntentId)");
    }
  });
});

/**
 * RECORDING A VENMO PAYMENT NEEDS NO QR, AND SHOWING THE QR SENDS NOTHING (2026-09-24, INV-078).
 *
 * The Record Payment modal's Venmo chip used to swap "Record It" for "Show Venmo QR" and fetch
 * the QR through collectArtifacts, the card door, which promotes a draft to sent. So a Venmo
 * payment made weeks ago could not be written down without first sending the invoice, and a
 * company with no Venmo handle could not record one at all.
 */
describe("Or They Paid Another Way (Record Payment's machine) records Venmo like cash, and its QR writes nothing", () => {
  const start = SRC.indexOf("function useOtherWay(");
  const end = SRC.indexOf("export function GetPaidButton(");
  const BODY = SRC.slice(start, end);

  it("finds the component", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("never goes through the card door, which promotes a draft", () => {
    expect(BODY).not.toContain("collectArtifacts(");
    expect(BODY).toContain("venmoQrFor(");
  });

  it("always offers Record It, whatever chip is picked", () => {
    expect(BODY).toMatch(/onClick=\{go\} disabled=\{pending \|\| qrPending\}>\s*\{pending \? "Saving…" : "Record It"\}/);
    expect(BODY).not.toMatch(/saveLabel=\{key === "venmo"/);
    expect(BODY).not.toMatch(/key === "venmo" \? [^:]*"Record It"/);
  });

  it("stores the picked chip, not a hard-coded venmo", () => {
    expect(BODY).not.toContain('method: "venmo"');
  });

  it("does not refuse a Venmo payment for want of a handle", () => {
    const go = BODY.slice(BODY.indexOf("function go()"), BODY.indexOf("function showVenmoQr()"));
    expect(go).not.toContain("venmoConfigured");
    expect(go).not.toContain('"later"');
    expect(go).toContain('ensureInvoice(props, method, "record"');
  });

  it("reads the QR for an existing invoice without minting or recording", () => {
    const qr = BODY.slice(BODY.indexOf("function showVenmoQr()"), BODY.indexOf("function venmoPaid()"));
    expect(qr).toMatch(/if \(props\.source === "invoice"\) \{\s*id = props\.invoiceId;/);
    expect(qr).not.toContain('"record"');
  });

  it("drops Card by its key, so a \"Credit Card\" chip can't file a manual payment as a Stripe card", () => {
    expect(BODY).toContain('source.filter((m) => paymentMethodKey(m) !== "card")');
    expect(BODY).toContain("const key = paymentMethodKey(method);");
  });

  it("says the QR sends the bill when it does, and never reads Saving over a read", () => {
    expect(BODY).toContain('props.source === "invoice" ? "Show Venmo QR" : "Send the Bill & Show Venmo QR"');
    const qr = BODY.slice(BODY.indexOf("function showVenmoQr()"), BODY.indexOf("function venmoPaid()"));
    expect(qr).toContain("startQr(");
    expect(qr).not.toMatch(/\bstart\(/);
  });
});

describe("venmoQrFor only reads and draws", () => {
  const ACTIONS = readFileSync(join(process.cwd(), "src/app/(app)/billing/actions.ts"), "utf8");
  const at = ACTIONS.indexOf("export async function venmoQrFor(");
  const next = ACTIONS.indexOf("\nexport ", at + 1);
  const FN = ACTIONS.slice(at, next === -1 ? undefined : next);

  it("exists", () => {
    expect(at).toBeGreaterThan(-1);
    expect(FN).toContain("requireStaff()");
  });

  it("never sends, recalculates, revalidates or writes", () => {
    for (const s of ["markInvoiceSent", "recalcInvoice", "revalidateMoney", ".update(", ".insert(", ".upsert(", ".delete("]) {
      expect(FN).not.toContain(s);
    }
  });

  it("refuses a paid-in-full invoice instead of drawing a $0.00 QR", () => {
    expect(FN).toMatch(/if \(balance < 0\.005\) \{\s*return \{ ok: false/);
    expect(FN.indexOf("balance < 0.005")).toBeLessThan(FN.indexOf("venmoQrData("));
  });

  it("builds its QR with the same helper as the card door", () => {
    expect(FN).toContain("venmoQrData(");
    const card = ACTIONS.slice(
      ACTIONS.indexOf("export async function collectArtifacts("),
      ACTIONS.indexOf("async function venmoQrData("),
    );
    expect(card).toContain("venmoQrData(");
    expect(card).not.toContain("venmo.com/u/");
  });
});

/**
 * ONE GET PAID SHEET (W1-26). Pay Now and Record Payment were two buttons with two sheets; they are
 * two panels of one sheet, "Get Paid $<balance>": the card first (Tap to Pay first, primary, full
 * width, never greyed - Apple 5.1/5.2/5.3), then "Or They Paid Another Way". SettleUpButton keeps its
 * name and props and opens the same sheet on the job hub and the visit.
 */
describe("the one Get Paid sheet", () => {
  const INV_078 = { source: "invoice" as const, invoiceId: "09ff65de-2ec8-4884-a31f-583a8943b09a", balance: 1558.62 };
  const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(GetPaidButton as any, props));

  it("is titled with what is owed, and the card comes before every other way", () => {
    const out = html({ ...INV_078, cardEnabled: true, methods: ["Cash", "Check", "Credit Card", "Venmo"] });
    expect(out).toContain('data-modal="Get Paid $1,558.62"');
    const card = out.indexOf("Show Card QR");
    const other = out.indexOf("Or They Paid Another Way");
    expect(card).toBeGreaterThan(-1);
    expect(other).toBeGreaterThan(card);
    // Card is the card panel's; the other way's chips drop it by key ("Credit Card" is card).
    expect(out).not.toContain(">Credit Card<");
    expect(out).toContain(">Cash<");
    expect(out).toContain("Record It");
    expect(out).not.toContain("Card payments go through Pay Now");
  });

  it("with cards off there is no card panel, and the sheet says where cards get switched on", () => {
    const out = html({ ...INV_078, cardEnabled: false, methods: ["Cash"] });
    expect(out).not.toContain("Show Card QR");
    expect(out).toContain("How They Paid");
    expect(out).not.toContain("Or They Paid Another Way");
    expect(out).toContain("Set Up Card Payments");
  });

  it("a bank transfer on its way is said inside the sheet: don't record it by hand", () => {
    const out = html({ ...INV_078, cardEnabled: true, transferPending: "A $1,558.62 bank transfer is on its way." });
    expect(out).toContain("A $1,558.62 bank transfer is on its way. Don&#x27;t record it by hand, or it counts twice.");
  });

  it("every door into it is 44px: the method chips, the fields and the small Getting Paid Now? link", () => {
    const out = html({ ...INV_078, cardEnabled: true, methods: ["Cash", "Check"] });
    expect(out).toMatch(/class="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-semibold capitalize/);
    expect(out).toMatch(/id="rp-date"[^>]*class="h-11/);
    const link = html({ ...INV_078, trigger: "link" });
    expect(link).toMatch(/<button type="button" class="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">Getting Paid Now\?<\/button>/);
  });

  it("the job hub and the visit keep SettleUpButton, and it opens the same sheet", () => {
    const out = renderToStaticMarkup(createElement(SettleUpButton as any, { source: "job", id: "j-1", compact: true, cardEnabled: true, methods: ["Cash"] }));
    expect(out).toContain('data-modal="Get Paid"');
    expect(out).toContain("Send The Bill &amp; Show Card QR");
    expect(SRC).toMatch(/export function SettleUpButton\(props: Mode & \{/);
    expect(SRC).toContain('return <GetPaidButton {...(rest as Mode & Omit<typeof rest, "source">)} trigger={compact ? "outline" : "primary"} />;');
  });

  it("Tap to Pay is FIRST in the card panel, primary, full width, never disabled (Apple 5.1/5.2/5.3)", () => {
    const panel = SRC.slice(SRC.indexOf("const panel: React.ReactNode = !props.cardEnabled ? null : !art ? ("), SRC.indexOf("return { onOpen, reset, takeover, panel };"));
    const tap = panel.indexOf("<TapToPayGlyph /> Tap to Pay");
    const qr = panel.indexOf('"Show Card QR"');
    expect(tap).toBeGreaterThan(-1);
    expect(qr).toBeGreaterThan(tap);
    for (const m of panel.matchAll(/<Button className="w-full" onClick=\{\(\) => void tapToPay\(\)\}>/g)) expect(m[0]).not.toContain("disabled");
    // The sheet draws the card panel before the other way, every time.
    expect(SRC).toMatch(/\{card\.panel\}\s*\{other\.panel\(!!card\.panel, transferPending\)\}/);
  });

  it("opening the sheet on a draft asks nothing yet: the card doors ask when pressed, and the cash half stays in reach", () => {
    expect(SRC).toContain("if (r.needsSend && gen.current === g) setDraftAtOpen(r.invoiceNumber ?? null);");
    expect(SRC).not.toMatch(/then: "mint"/);
    // Not Now on a card's question goes back to the sheet, never closes it.
    expect(SRC).toContain('<Button variant="outline" onClick={() => setAsk(null)}>Not Now</Button>');
  });
});

/**
 * TAP TO PAY TELLS THE TRUTH (0e2cb937 — Rich Seiler, INV-083, $420, 2026-09-30), the sheet's half.
 *
 * The bridge's ok is a claim; tapPaymentOutcome is the check; lib/tap-verdict is what the sheet
 * says for each answer and the watch that ends. tapToPay() wires them: a "paid" verdict is the
 * Paid screen, an "error" verdict is the "Not charged — try again" box with tapPi KEPT (the
 * retry re-uses the same PaymentIntent), a "confirmed" verdict is an honest line and a watch
 * that asks Stripe once more after ~20 s.
 */
const { verdictAfterConfirm, watchConfirmedTap, notChargedSentence, NOT_CHARGED_LEAD, UNCHECKED_LINE, UNCHECKED_TIMEOUT_SENTENCE, SUCCEEDED_LINE, CHARGED_NOT_RECORDED_SENTENCE } =
  await import("@/lib/tap-verdict");

const succeeded = (recorded = true) => ({ ok: true as const, status: "succeeded", amountReceived: 42000, lastError: null, booked: recorded, recorded });
const notCharged = (lastError: string | null = "the card has insufficient funds") => ({
  ok: true as const,
  status: "requires_payment_method",
  amountReceived: 0,
  lastError,
  booked: false,
  recorded: false,
});

describe("verdictAfterConfirm — what the sheet says once Stripe has been asked", () => {
  it("bridge ok + server says requires_payment_method → the 'Not charged — try again' box, Stripe's reason in plain words, on the same PaymentIntent", () => {
    const v = verdictAfterConfirm(notCharged());
    expect(v).toEqual({
      kind: "error",
      error: "Not charged — try again. The phone said approved, but Stripe shows no charge: the card has insufficient funds.",
      // "failed" is the outcome tapToPay keeps tapPi for and offers Try Again on (retry = declined | failed).
      outcome: "failed",
    });
  });

  it("no reason from Stripe → the lead sentence alone, never a blank or a raw code", () => {
    expect(notChargedSentence(null)).toBe(`${NOT_CHARGED_LEAD}.`);
    expect(notChargedSentence("Your card was declined.")).toBe(`${NOT_CHARGED_LEAD}: Your card was declined.`);
  });

  it("bridge ok + server says succeeded (recorded) → Paid", () => {
    expect(verdictAfterConfirm(succeeded())).toEqual({ kind: "paid" });
    expect(verdictAfterConfirm({ ...succeeded(), status: "requires_capture" })).toEqual({ kind: "paid" });
  });

  it("server says succeeded but the row didn't land → honest confirmed line, watching", () => {
    expect(verdictAfterConfirm(succeeded(false))).toEqual({ kind: "confirmed", note: SUCCEEDED_LINE, checked: true });
  });

  it("the server read itself failed → confirmed, but 'couldn't double-check with Stripe yet' — never 'Stripe confirmed the charge'", () => {
    expect(verdictAfterConfirm(null)).toEqual({ kind: "confirmed", note: UNCHECKED_LINE, checked: false });
    expect(verdictAfterConfirm({ ok: false, error: "Couldn't read this payment back from Stripe." })).toEqual({ kind: "confirmed", note: UNCHECKED_LINE, checked: false });
    expect(UNCHECKED_LINE).toContain("couldn't double-check with Stripe yet");
    expect(UNCHECKED_LINE).not.toContain("Stripe confirmed");
  });
});

describe("watchConfirmedTap — the confirmed watch has an end", () => {
  /** A clock that moves 4 s per poll, so twenty seconds is five polls. */
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it("past 20 s with no Paid, Stripe is asked a second time; succeeded → Paid", async () => {
    const c = clock();
    const poll = vi.fn(async () => "open" as const);
    const verify = vi.fn(async () => succeeded());
    const r = await watchConfirmedTap({ poll, verify, ...c });
    expect(r).toEqual({ kind: "paid" });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(5);
  });

  it("past 20 s and the second look says not charged → the 'Not charged — try again' box", async () => {
    const c = clock();
    const r = await watchConfirmedTap({ poll: async () => "open", verify: async () => notCharged("the bank said try again later"), ...c });
    expect(r).toEqual({ kind: "error", error: notChargedSentence("the bank said try again later"), outcome: "failed" });
  });

  it("the invoice reads Paid before the timeout → Paid, and Stripe is not asked again", async () => {
    const c = clock();
    let polls = 0;
    const verify = vi.fn(async () => succeeded());
    const r = await watchConfirmedTap({ poll: async () => (++polls >= 2 ? "paid" : "open"), verify, ...c });
    expect(r).toEqual({ kind: "paid" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("the second look can't be taken either → a sentence that says so and what to check, never a spinner forever", async () => {
    const c = clock();
    const r = await watchConfirmedTap({ poll: async () => "unknown", verify: async () => null, ...c });
    expect(r).toEqual({ kind: "error", error: UNCHECKED_TIMEOUT_SENTENCE, outcome: "failed" });
  });

  it("Stripe says succeeded twice but the row never lands → 'don't tap again', with no Try Again", async () => {
    const c = clock();
    const r = await watchConfirmedTap({ poll: async () => "open", verify: async () => succeeded(false), ...c });
    expect(r).toEqual({ kind: "error", error: CHARGED_NOT_RECORDED_SENTENCE, outcome: "setup" });
  });

  it("the sheet closing stops the watch: nothing is asked, nothing is painted", async () => {
    const c = clock();
    let alive = true;
    const verify = vi.fn(async () => succeeded());
    const r = await watchConfirmedTap({
      poll: async () => {
        alive = false;
        return "open";
      },
      verify,
      alive: () => alive,
      ...c,
    });
    expect(r).toEqual({ kind: "stopped" });
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("the sheet's own words (settle-up-button.tsx)", () => {
  const src = readFileSync(join(__dirname, "settle-up-button.tsx"), "utf8");

  it("never claims 'Stripe confirmed the charge' on the bridge's word alone", () => {
    // The old confirmed paint said it outright; now the note comes from the verdict.
    expect(src).not.toContain("Stripe confirmed the charge. This flips to Paid");
    expect(src).toContain("tapPaymentOutcome(id, pi.paymentIntentId)");
    expect(src).toContain("watchConfirmedTap(");
  });

  it("keeps the PaymentIntent on a 'Not charged' verdict (tapPi is only let go on Paid)", () => {
    const branch = src.slice(src.indexOf("if (c.ok) {"), src.indexOf("if (c.cancelled)"));
    // Two Paid exits let go of the door; the error exits do not touch it.
    expect(branch.match(/tapPi\.current = null;/g)).toHaveLength(2);
    expect(branch).toContain('if (verdict.kind === "error") {\n          setTap({ kind: "error", error: verdict.error, outcome: verdict.outcome });\n          return;\n        }');
  });
});
