import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SAVED ESTIMATE'S PAPER PILL (cn-v1131) follows the silent-write law: it moves only on the server's
 * ok; a refusal is said under it in the server's words and the pill stays put; a call that THREW is the
 * one "try again" line, never the error boundary. The rule (pickPaperFormat) is driven with a mocked
 * action; the control is rendered with what is stored and pinned to move only after ok (a click needs
 * a DOM the unit project does not have).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const updateQuoteMeta = vi.fn();
vi.mock("../actions", () => ({ updateQuoteMeta: (...a: unknown[]) => updateQuoteMeta(...a) }));

const { PaperFormatControl, pickPaperFormat } = await import("./paper-format-control");
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("pickPaperFormat — the write's answer becomes what the pill holds next", () => {
  it("ok: the pick is what it holds; the action got the estimate's id and the format, null for the company's", async () => {
    updateQuoteMeta.mockResolvedValueOnce({ ok: true });
    expect(await pickPaperFormat("q1", "detailed")).toEqual({ ok: true, chosen: "detailed" });
    expect(updateQuoteMeta).toHaveBeenLastCalledWith("q1", { estimate_format: "detailed" });
    updateQuoteMeta.mockResolvedValueOnce({ ok: true });
    expect(await pickPaperFormat("q1", null)).toEqual({ ok: true, chosen: null });
    expect(updateQuoteMeta).toHaveBeenLastCalledWith("q1", { estimate_format: null });
  });

  it("a refusal: the server's words and no pick; a refusal with no words gets the fallback", async () => {
    updateQuoteMeta.mockResolvedValueOnce({ ok: false, error: "That estimate could not be found." });
    expect(await pickPaperFormat("q1", "tasks")).toEqual({ ok: false, error: "That estimate could not be found." });
    updateQuoteMeta.mockResolvedValueOnce({ ok: false });
    expect(await pickPaperFormat("q1", "tasks")).toEqual({ ok: false, error: "Couldn't change the paper format — try again." });
  });

  it("a call that threw (the network, a server error) is said under the pill, not thrown into the transition", async () => {
    updateQuoteMeta.mockRejectedValueOnce(new Error("fetch failed"));
    expect(await pickPaperFormat("q1", "detailed")).toEqual({ ok: false, error: "Couldn't reach the server — try again." });
  });
});

describe("the control", () => {
  it("renders the STORED value's segment active, the company default named with what it means, and no refusal line", () => {
    const html = renderToStaticMarkup(createElement(PaperFormatControl, { quoteId: "q1", value: "detailed", companyDefault: "tasks" }));
    expect(text(html)).toContain("Labor And Parts On The Paper");
    expect(text(html)).toContain("Company Default · Off");
    expect(html).toMatch(/bg-white text-slate-900 shadow-sm">Show</);
    expect(html).not.toMatch(/bg-white text-slate-900 shadow-sm">Hide</);
    expect(html).not.toContain("text-red-600");
    const stored = renderToStaticMarkup(createElement(PaperFormatControl, { quoteId: "q1", value: null, companyDefault: "detailed" }));
    expect(stored).toMatch(/bg-white text-slate-900 shadow-sm">Company Default · On</);
  });

  it("moves the pill only after pickPaperFormat said ok, says the refusal under it otherwise, and re-seeds from the page's read", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/[id]/paper-format-control.tsx"), "utf8");
    const pick = src.slice(src.indexOf("function pick("), src.indexOf("return (", src.indexOf("function pick(")));
    expect(pick).toContain("const res = await pickPaperFormat(quoteId, v);");
    expect(pick).toMatch(/if \(!res\.ok\) \{\s*setError\(res\.error\);\s*return;\s*\}\s*setChosen\(res\.chosen\);\s*router\.refresh\(\);/);
    expect(pick).toContain("if (v === chosen || pending) return;");
    expect(src).toContain("if (seen !== value) {");
    expect(src).toContain('{error && <p className="mt-1 text-xs text-red-600">{error}</p>}');
    expect(src).toContain("disabled={pending}");
  });
});
