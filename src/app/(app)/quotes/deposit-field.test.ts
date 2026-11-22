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
    const html = text(saved({ deposit_amount: null, status: "sent" }, [line], {}, CA));
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
