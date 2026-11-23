import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/(app)/organize/credit-memo-actions", () => ({
  creditMemoHome: vi.fn(),
  fileCreditMemoWithItsBill: vi.fn(),
  returnBillHome: vi.fn(),
  fileReturnBillWithItsBill: vi.fn(),
}));

import { RETURN_ONE_BY_WORDS, ReturnBillDoor, ReturnBillDoorView, fileAnswerStep, returnHomeStep } from "./return-bill-door";
import { CreditMemoDoorView } from "./credit-memo-door";
import { ALREADY_FILED } from "@/lib/return-bill-door";

/**
 * FILE WITH ITS BILL ON A CREDIT'S ROW (cn-v1184): the tray door's own view; the first tap finds and
 * names what it would close on ONE button; it files only on that tap.
 */
const buttons = (html: string) =>
  Array.from(html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)).map((m) => ({ attrs: m[1], words: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }));
const noop = () => {};
const candidate = { billId: "bill-c", label: "3 lines on T-543, T-576 and T-677" };
const view = (state: any) => renderToStaticMarkup(createElement(ReturnBillDoorView, { state, busy: false, onFind: noop, onPick: noop }));

describe("the door's three states", () => {
  it("idle: one 44px button, File With Its Bill", () => {
    const html = view({ step: "idle" });
    expect(buttons(html).map((b) => b.words)).toEqual(["File With Its Bill"]);
    expect(buttons(html)[0].attrs).toMatch(/\bh-11\b/);
    expect(buttons(renderToStaticMarkup(createElement(ReturnBillDoor, { billId: "bill-c" }))).map((b) => b.words)).toEqual(["File With Its Bill"]);
  });

  it("found: the question and ONE 44px button naming what it found; nothing filed yet", () => {
    const html = view({ step: "pick", candidates: [candidate], question: RETURN_ONE_BY_WORDS });
    expect(html).toContain("Its lines match these bills. Tap to file the credit with them.");
    expect(buttons(html).map((b) => b.words)).toEqual(["3 lines on T-543, T-576 and T-677"]);
    expect(buttons(html)[0].attrs).toMatch(/min-h-\[44px\]/);
  });

  it("said: the sentence plain in slate, a refusal in red; never amber", () => {
    const filed = view({ step: "said", words: "CM-445: $30.23 back from the supplier.", tone: "plain" });
    expect(filed).toContain("CM-445: $30.23 back from the supplier.");
    expect(filed).toMatch(/text-slate-700/);
    expect(filed).not.toMatch(/text-red-700|amber/);
    const refused = view({ step: "said", words: "INV-905 already credited this return to the customer, so it stays as it is. Nothing changed.", tone: "refused" });
    expect(refused).toMatch(/text-red-700/);
  });
});

describe("returnHomeStep: found by words always asks", () => {
  it("one: ONE button with this door's question; never a file, even if a home ever came back by number", () => {
    for (const by of ["words", "number"] as const) {
      expect(returnHomeStep({ ok: true, kind: "one", by, candidate })).toEqual({ step: "pick", candidates: [candidate], question: RETURN_ONE_BY_WORDS });
    }
  });
  it("none: its sentence, plain; refused: red", () => {
    expect(returnHomeStep({ ok: true, kind: "none", sentence: "This credit is already filed: its lines are off the customer's bill." })).toEqual({
      step: "said",
      words: "This credit is already filed: its lines are off the customer's bill.",
      tone: "plain",
    });
    expect(returnHomeStep({ ok: false, error: "Nothing changed." })).toEqual({ step: "said", words: "Nothing changed.", tone: "refused" });
  });
  it("the file step hands the server the credit's own id only", async () => {
    const src = (await import("node:fs")).readFileSync((await import("node:path")).join(process.cwd(), "src/components/return-bill-door.tsx"), "utf8");
    expect(src).toContain("await fileReturnBillWithItsBill(billId);");
  });
});

// ── cn-v1184 fixer (skeptic #86) ──────────────────────────────────────────────────────────────────
describe("the filing's answer (S7): already filed is a plain fact, a refusal is red", () => {
  it("already filed: slate; any other refusal: red; filed: its sentence, slate", () => {
    expect(fileAnswerStep({ ok: false, error: ALREADY_FILED })).toEqual({ step: "said", words: ALREADY_FILED, tone: "plain" });
    expect(fileAnswerStep({ ok: false, error: "INV-905 already credited this return to the customer, so it stays as it is. Nothing changed." })).toMatchObject({ tone: "refused" });
    expect(fileAnswerStep({ ok: true, message: "CM-445: $29.70 back from the supplier." })).toEqual({ step: "said", words: "CM-445: $29.70 back from the supplier.", tone: "plain" });
  });
});

describe("the busy words (S10): Finding… while it searches, Filing… only on the tap that files", () => {
  const busy = (state: any) => buttons(renderToStaticMarkup(createElement(ReturnBillDoorView, { state, busy: true, onFind: noop, onPick: noop }))).map((b) => b.words);
  it("the first tap says Finding…; the found button says Filing… while it files", () => {
    expect(busy({ step: "idle" })).toEqual(["Finding…"]);
    expect(busy({ step: "pick", candidates: [candidate], question: RETURN_ONE_BY_WORDS })).toEqual(["Filing…"]);
  });
  it("the tray door's own view is unchanged: Filing… on its first tap, the bill's label on its pick", () => {
    const tray = (state: any) => buttons(renderToStaticMarkup(createElement(CreditMemoDoorView, { state, busy: true, onFind: noop, onPick: noop }))).map((b) => b.words);
    expect(tray({ step: "idle" })).toEqual(["Filing…"]);
    expect(tray({ step: "pick", candidates: [candidate] })).toEqual(["3 lines on T-543, T-576 and T-677"]);
  });
});
