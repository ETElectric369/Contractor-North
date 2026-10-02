import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SEND SHEET (W1-26): one door that puts an invoice or an estimate in the customer's hands,
 * generic so the invoice header, the ⋯ Send Again, the holding-an-older-bill notice and (next wave)
 * a Needs You row open the same thing. The sheet is the confirm: who, how much, how many lines, and
 * on an invoice "This marks it Sent". Two 44px choices; Text It says its not-ready refusal in place.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, title, children }: { open: boolean; title: string; children?: ReactNode }) =>
    open ? createElement("div", { "data-modal": title }, children) : null,
  ModalActions: () => null,
}));
vi.mock("@/app/(app)/billing/actions", () => ({ emailInvoice: vi.fn(), textInvoice: vi.fn() }));
vi.mock("@/app/(app)/quotes/actions", () => ({ emailQuote: vi.fn(), textQuote: vi.fn() }));

const { SendSheet, SendButton, sendConfirmSentence } = await import("./send-sheet");
const { TEXT_NOT_READY_REFUSAL } = await import("@/lib/sms-readiness");

const INV = { kind: "invoice" as const, id: "inv-078", number: "INV-078", customerName: "Andrew Crake", amount: 9590.89, lineCount: 34 };
const open = (p: Record<string, unknown>) => renderToStaticMarkup(createElement(SendSheet as any, { open: true, onClose: () => {}, ...p }));

describe("the sentence the sheet asks", () => {
  it("names the bill, the amount, the lines and who gets it - and on an invoice, that it marks it Sent", () => {
    expect(sendConfirmSentence(INV)).toBe("Send INV-078 for $9,590.89 (34 lines) to Andrew Crake? This marks it Sent.");
    expect(sendConfirmSentence({ ...INV, lineCount: 1 })).toContain("(1 line)");
  });
  it("an estimate is not marked anything by the sentence; a missing line count or name is left out, never guessed", () => {
    expect(sendConfirmSentence({ kind: "quote", number: "Q-101", customerName: "Jill", amount: 1240 })).toBe("Send Q-101 for $1,240.00 to Jill?");
    expect(sendConfirmSentence({ kind: "invoice", amount: 50 })).toBe("Send this invoice for $50.00 to the customer? This marks it Sent.");
  });
});

describe("the sheet", () => {
  it("offers two 44px choices, Email It and Text It, under the sentence", () => {
    const out = open({ ...INV, textReady: true });
    expect(out).toContain('data-modal="Send Invoice"');
    expect(out).toContain(sendConfirmSentence(INV));
    const choices = [...out.matchAll(/<button type="button"[^>]*class="([^"]*)"[^>]*>(?:(?!<\/button>).)*?(Email It|Text It)/g)];
    expect(choices.map((m) => m[2])).toEqual(["Email It", "Text It"]);
    for (const m of choices) expect(m[1]).toContain("min-h-11");
  });

  it("Text It keeps its not-ready refusal in place: said where the button is, and nothing is sent", () => {
    const out = open({ ...INV, textReady: false });
    expect(out).toContain(TEXT_NOT_READY_REFUSAL.replace(/'/g, "&#x27;"));
    expect(out).toMatch(/aria-disabled="true"[^>]*>(?:(?!<\/button>).)*Text It/);
    const src = readFileSync(join(process.cwd(), "src/components/send-sheet.tsx"), "utf8");
    // The refusal returns before any server call.
    const send = src.slice(src.indexOf("function send("), src.indexOf("setHow(via);"));
    expect(send).toContain('if (via === "text" && !textReady) {');
    expect(send).toContain("return;");
  });

  it("Open It First appears only when the caller gives a place to open, at 44px", () => {
    expect(open({ ...INV })).not.toContain("Open It First");
    expect(open({ ...INV, openHref: "/billing/inv-078" })).toMatch(/<a class="inline-flex min-h-11[^"]*" href="\/billing\/inv-078">Open It First<\/a>/);
  });

  it("an estimate is sent through the estimate's own doors", () => {
    expect(open({ kind: "quote", id: "q-1", number: "Q-101", amount: 1240 })).toContain('data-modal="Send Estimate"');
    const src = readFileSync(join(process.cwd(), "src/components/send-sheet.tsx"), "utf8");
    expect(src).toContain('const run = isInvoice ? (via === "email" ? emailInvoice : textInvoice) : via === "email" ? emailQuote : textQuote;');
  });

  it("closed, it draws nothing; its button is the trigger (the header's Send $X, a ⋯ row, an outline)", () => {
    expect(renderToStaticMarkup(createElement(SendSheet as any, { ...INV, open: false, onClose: () => {} }))).toBe("");
    expect(renderToStaticMarkup(createElement(SendButton as any, { ...INV, label: "Send $9,590.89" }))).toContain("Send $9,590.89");
    expect(renderToStaticMarkup(createElement(SendButton as any, { ...INV, label: "Send Again", variant: "menuItem" }))).toMatch(/min-h-11[^"]*"[^>]*>.*Send Again/);
  });
});

describe("the doors that send", () => {
  it("the invoice page and its older-copy notice open the Send sheet; the estimate page keeps EmailButton", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/page.tsx"), "utf8");
    const body = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/invoice-detail.tsx"), "utf8");
    expect(page).toContain("<SendButton");
    expect(page).not.toContain("<EmailButton");
    expect(body).toContain("<SendButton");
    expect(body).not.toContain("<EmailButton");
    expect(readFileSync(join(process.cwd(), "src/app/(app)/quotes/[id]/page.tsx"), "utf8")).toContain("<EmailButton");
  });
});
