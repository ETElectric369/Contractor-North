import { describe, it, expect } from "vitest";
import { renderers, text } from "./editor-test-mocks";
import { dict } from "@/lib/i18n";
import { words as qe } from "@/lib/words/quotes-editor";
import { titleCaseIn } from "../../../../tests/title-case-words";

/**
 * THE DEPOSIT FIELD (cn-v1177), beside Valid until in the estimate editor's header column: the figure,
 * and ONE quiet line under it saying where it came from: "10% up to $1,000, the company default",
 * "Typed for this estimate" (with Use the Default), or "No deposit on this estimate" for 0. An open
 * estimate saved before 0414 shows the figure its next save would store and says it is not on the
 * customer's copy yet. Both languages; the one clickable in Title Case.
 */
const { EstimateEditor } = await import("./estimate-editor");
const { unsaved, saved } = renderers(EstimateEditor);
const CA = { depositRule: { percent: 10, cap: 1000 } };
const line = { id: "l1", description: "Deck", quantity: 1, unit: "ea", unit_price: 4800, sort_order: 0 };

describe("the Deposit field", () => {
  it("the company's default: the figure over the live total, and where it came from", () => {
    const raw = saved({ deposit_amount: 480, deposit_by_hand: false }, [line], {}, CA);
    const html = text(raw);
    expect(html).toContain("Deposit");
    expect(raw).toMatch(/id="deposit"[^>]*value="480.00"|value="480.00"[^>]*id="deposit"/);
    expect(html).toContain("10% up to $1,000, the company default");
    expect(html).not.toContain("Use the Default");
  });

  it("typed for this estimate: the typed figure, the line, and Use the Default", () => {
    const html = text(saved({ deposit_amount: "2000.00", deposit_by_hand: true }, [line], {}, CA));
    expect(html).toContain("Typed for this estimate");
    expect(html).toContain("Use the Default");
  });

  it("0 reads No deposit on this estimate", () => {
    expect(text(saved({ deposit_amount: 0, deposit_by_hand: true }, [line], {}, CA))).toContain("No deposit on this estimate");
    expect(text(saved({ deposit_amount: 0 }, [line], {}, { depositRule: { percent: 0, cap: 1000 } }))).toContain("No deposit on this estimate");
  });

  it("a cap of 0 is no cap", () => {
    expect(text(saved({ deposit_amount: 1200 }, [line], {}, { depositRule: { percent: 25, cap: 0 } }))).toContain("25% of the total, the company default");
  });

  it("an open estimate saved before 0414 says it is not on the customer's copy yet, and offers the one way to add it", () => {
    // A draft (cn-v1178: a sent estimate is the customer's copy and is changed only after Back to Draft).
    const html = text(saved({ deposit_amount: null, status: "draft" }, [line], {}, CA));
    expect(html).toContain("Not on the customer's copy yet. Tap Use the Default to add it.");
    expect(html).toContain("Use the Default");
  });

  it("an accepted estimate reads only: no Use the Default, and none stated reads as none", () => {
    const html = text(saved({ deposit_amount: null, status: "accepted" }, [line], {}, CA));
    expect(html).toContain("No deposit on this estimate");
    expect(html).not.toContain("Use the Default");
    expect(html).not.toContain("Not on the customer's copy yet");
  });

  it("a new estimate (no row yet) shows the default figure it will be saved with", () => {
    expect(text(unsaved({ items: [{ description: "Deck", quantity: 1, unit: "ea", unit_price: 4800 }] }, CA))).toContain("10% up to $1,000, the company default");
  });

  it("cn-v1178 (decision 1): the sale's deposit request IS the deposit: a fact (number, ask, paid or not), never the stored figure, never a box", () => {
    const open = saved({ deposit_amount: 650, status: "draft" }, [line], { depositRequest: { number: "INV-900", amount: 480, balance: 480, status: "sent" } }, CA);
    expect(text(open)).toContain("INV-900 asks $480.00 and is not paid yet. It is this sale's deposit.");
    expect(open).not.toMatch(/id="deposit"/);
    expect(text(open)).not.toContain("$650.00");
    expect(text(open)).not.toContain("Use the Default");
    expect(text(saved({ status: "accepted" }, [line], { depositRequest: { number: "INV-900", amount: 480, balance: 280, status: "partial" } }, CA))).toContain(
      "INV-900 asks $480.00: $200.00 received, $280.00 left. It is this sale's deposit.",
    );
    expect(text(saved({ status: "accepted" }, [line], { depositRequest: { number: "INV-900", amount: 480, balance: 0, status: "paid" } }, CA))).toContain("INV-900 for $480.00 is paid. It is this sale's deposit.");
    expect(text(saved({ status: "draft" }, [line], { depositRequest: "unread" }, CA))).toContain("This sale's deposit request couldn't be read.");
  });

  it("cn-v1178 (decision 3): a sent estimate's lock offers ONE button under the server's sentence, Back to Draft", () => {
    const reason = "E-900 was sent: it is the customer's copy, so its lines, totals and deposit don't change while it is out. Tap Back to Draft to change it, then send it again.";
    const html = text(saved({ status: "sent" }, [line], { lock: { reason } }, CA));
    expect(html).toContain(reason);
    expect(html.match(/Back to Draft/g)?.length).toBe(2); // the sentence names it, and the one button says it
    expect(html).not.toContain("Revise");
    // An accepted estimate's lock keeps Revise and offers no Back to Draft.
    const acc = text(saved({ status: "accepted" }, [line], { lock: { reason: "E-900 is accepted and its deposit, INV-900, has $480.00 paid on it — changing it now would change the price the customer paid against. Revise it instead." } }, CA));
    expect(acc).not.toContain("Back to Draft");
    expect(titleCaseIn(qe.en.qe_btn_backToDraft, "en")).toBe(true);
    expect(titleCaseIn(qe.es.qe_btn_backToDraft, "es")).toBe(true);
  });

  it("skeptic S9: Back to Draft's refusal is the server's sentence, else a whole sentence of its own in both languages (never a fragment)", async () => {
    const { backToDraftRefusal } = await import("./estimate-editor");
    const en = (k: string) => qe.en[k];
    const es = (k: string) => qe.es[k];
    expect(backToDraftRefusal({ ok: true }, en)).toBeNull();
    expect(backToDraftRefusal({ ok: false, error: "That estimate isn't here to update." }, en)).toBe("That estimate isn't here to update.");
    expect(backToDraftRefusal(null, en)).toBe("This estimate couldn't be taken back to draft. Tap Back to Draft again.");
    expect(backToDraftRefusal({ ok: false }, es)).toBe("No se pudo volver este presupuesto a borrador. Toca Volver a Borrador otra vez.");
    expect(dict("es").qe_backToDraftFailed).toBe(qe.es.qe_backToDraftFailed);
    // A sentence: a capital first, a period last, and it names the button as the button says it.
    for (const [said, btn] of [[qe.en.qe_backToDraftFailed, qe.en.qe_btn_backToDraft], [qe.es.qe_backToDraftFailed, qe.es.qe_btn_backToDraft]]) {
      expect(said).toMatch(/^[A-ZÁÉÍÓÚÑ].*\.$/);
      expect(said).toContain(btn);
    }
  });

  it("cn-v1178 (decision 2): a new estimate starts with the word its seed says (the company's usual kind's), Estimate when none", async () => {
    const { words: qt } = await import("@/lib/words/quotes");
    const quoteBtn = (html: string) => [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)].find((m) => m[2].replace(/&amp;/g, "&").includes(qt.en.qt_btn_typeQuote))![1];
    const estBtn = (html: string) => [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)].find((m) => m[2].replace(/&amp;/g, "&").includes(qt.en.qt_btn_typeEstimate))![1];
    const asQuote = unsaved({ docType: "quote" }, CA);
    const asEstimate = unsaved({}, CA);
    // The active pill's class moves from Estimate to Quote with the seed.
    expect(quoteBtn(asQuote)).toBe(estBtn(asEstimate));
    expect(estBtn(asQuote)).toBe(quoteBtn(asEstimate));
    expect(quoteBtn(asQuote)).not.toBe(estBtn(asQuote));
  });

  it("every key in both languages; the clickable is Title Case in both", () => {
    const keys = ["qe_deposit", "qe_depositDefault", "qe_depositDefaultNoCap", "qe_depositTyped", "qe_depositNone", "qe_depositNotYet", "qe_btn_useTheDefault"];
    for (const k of keys) {
      expect(qe.en[k], k).toBeTruthy();
      expect(qe.es[k], k).toBeTruthy();
      expect(dict("es")[k], k).toBe(qe.es[k]);
    }
    expect(titleCaseIn(qe.en.qe_btn_useTheDefault, "en")).toBe(true);
    expect(titleCaseIn(qe.es.qe_btn_useTheDefault, "es")).toBe(true);
    for (const k of keys) expect(`${qe.en[k]} ${qe.es[k]}`.toLowerCase()).not.toContain("shelf");
  });
});
