import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/(app)/organize/credit-memo-actions", () => ({ creditMemoHome: vi.fn(), fileCreditMemoWithItsBill: vi.fn() }));

import { CreditMemoDoor, CreditMemoDoorView } from "./credit-memo-door";

/**
 * THE CREDIT MEMO'S ONE DOOR (cn-v1181, lane M): File With Its Bill; several bills ask which; none
 * says its sentence. English literals, Title Case, every button 44px.
 */
const buttons = (html: string) =>
  Array.from(html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)).map((m) => ({ attrs: m[1], words: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }));
const noop = () => {};

describe("CreditMemoDoor", () => {
  it("one button, File With Its Bill, 44px; the mounted door draws it (the stub drew nothing)", () => {
    const html = renderToStaticMarkup(createElement(CreditMemoDoorView, { state: { step: "idle" }, busy: false, onFind: noop, onPick: noop }));
    expect(buttons(html).map((b) => b.words)).toEqual(["File With Its Bill"]);
    expect(buttons(html)[0].attrs).toMatch(/\bh-11\b/);
    expect(buttons(renderToStaticMarkup(createElement(CreditMemoDoor, { itemId: "memo-1" }))).map((b) => b.words)).toEqual(["File With Its Bill"]);
  });

  it("several: asks which, one 44px button per bill, labelled as bills are labelled", () => {
    const html = renderToStaticMarkup(
      createElement(CreditMemoDoorView, {
        state: {
          step: "pick",
          candidates: [
            { billId: "a", label: "Northline Supply #INV-900, $244.31, 2026-11-01, on J-901 Larkspur" },
            { billId: "b", label: "Northline Supply #INV-901, $30.00, 2026-11-02, on J-902 Snowbell" },
          ],
        },
        busy: false,
        onFind: noop,
        onPick: noop,
      }),
    );
    expect(html).toContain("Which bill does this credit memo reverse?");
    const b = buttons(html);
    expect(b.map((x) => x.words)).toEqual(["Northline Supply #INV-900, $244.31, 2026-11-01, on J-901 Larkspur", "Northline Supply #INV-901, $30.00, 2026-11-02, on J-902 Snowbell"]);
    for (const x of b) expect(x.attrs).toMatch(/min-h-\[44px\]/);
  });

  it("none, or a refusal: the sentence, plain or refused, under the button", () => {
    const none = renderToStaticMarkup(createElement(CreditMemoDoorView, { state: { step: "said", words: "No bill from Northline Supply carries the lines.", tone: "plain" }, busy: false, onFind: noop, onPick: noop }));
    expect(none).toContain('role="status"');
    expect(none).toContain("No bill from Northline Supply carries the lines.");
    expect(none).not.toMatch(/amber/);
    const refused = renderToStaticMarkup(createElement(CreditMemoDoorView, { state: { step: "said", words: "Nothing was filed.", tone: "refused" }, busy: false, onFind: noop, onPick: noop }));
    expect(refused).toMatch(/text-red-700/);
  });
});

describe("homeStep: files at once only on the paper's own reversed number (skeptic #84, M7)", () => {
  const candidate = { billId: "bill-1", label: "Northline Supply #INV-900, $244.31, 2026-11-01, on J-901 Larkspur" };
  it("found by the printed reversal: files at once", async () => {
    const { homeStep } = await import("./credit-memo-door");
    expect(homeStep({ ok: true, kind: "one", by: "number", candidate })).toEqual({ file: "bill-1" });
  });
  it("found by words, even a single candidate: names the bill on a button, files nothing yet", async () => {
    const { homeStep, ONE_BY_WORDS } = await import("./credit-memo-door");
    const step = homeStep({ ok: true, kind: "one", by: "words", candidate });
    expect(step).toEqual({ step: "pick", candidates: [candidate], question: ONE_BY_WORDS });
    const html = renderToStaticMarkup(createElement(CreditMemoDoorView, { state: step as any, busy: false, onFind: noop, onPick: noop }));
    expect(html).toContain(ONE_BY_WORDS);
    expect(buttons(html).map((b) => b.words)).toEqual([candidate.label]);
  });
});
