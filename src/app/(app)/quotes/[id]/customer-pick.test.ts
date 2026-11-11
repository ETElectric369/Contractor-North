import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commitCustomerPick } from "./customer-pick";

const FALLBACK = "Couldn't change the customer.";

describe("commitCustomerPick: the pick is the save", () => {
  it("success calls the action once with the picked id and reports ok", async () => {
    const action = vi.fn(async () => ({ ok: true }));
    const res = await commitCustomerPick("q1", "c-sam-tillery", { setQuoteCustomer: action, fallbackError: FALLBACK });
    expect(res).toEqual({ ok: true });
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith("q1", "c-sam-tillery");
  });
  it("a refusal returns the server's own sentence", async () => {
    const action = vi.fn(async () => ({ ok: false, error: "That estimate isn't available." }));
    const res = await commitCustomerPick("q1", "c1", { setQuoteCustomer: action, fallbackError: FALLBACK });
    expect(res).toEqual({ ok: false, error: "That estimate isn't available." });
  });
  it("a refusal with no sentence, or a thrown call, says the fallback", async () => {
    const quiet = await commitCustomerPick("q1", "c1", { setQuoteCustomer: async () => ({ ok: false }), fallbackError: FALLBACK });
    expect(quiet).toEqual({ ok: false, error: FALLBACK });
    const boom = await commitCustomerPick("q1", "c1", { setQuoteCustomer: async () => { throw new Error("net"); }, fallbackError: FALLBACK });
    expect(boom).toEqual({ ok: false, error: FALLBACK });
  });
  it("the empty value is sent as a clear (null)", async () => {
    const action = vi.fn(async () => ({ ok: true }));
    await commitCustomerPick("q1", "", { setQuoteCustomer: action, fallbackError: FALLBACK });
    expect(action).toHaveBeenCalledWith("q1", null);
  });
});

describe("customer-select.tsx source pins", () => {
  const src = readFileSync(join(__dirname, "customer-select.tsx"), "utf8");
  it("the select's onChange commits through the helper", () => {
    expect(src).toMatch(/onChange=\{\(e\) => pick\(e\.target\.value\)\}/);
    expect(src).toContain("commitCustomerPick(quoteId, next");
  });
  it("no separate save button remains; Cancel stays", () => {
    expect(src).not.toContain("qt_saveCustomer");
    expect(src).not.toMatch(/\bCheck\b/);
    expect(src).not.toContain("onClick={save}");
    expect(src).toContain('aria-label={t("qt_btn_cancel")}');
  });
});
