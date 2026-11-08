import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SEND SHEET (W1-26, review mode cn-v1155): one door that puts an invoice, an estimate, a contract,
 * a portal link or a receipt in the customer's hands. On open it asks the server for the words it
 * would send; with Send Without Review on it is the old one-tap sheet (Email It / Text It), with it
 * off the owner reads and may change the address, the subject and the message first. Only a field he
 * changed goes back. The sheet is drawn here from a server answer (SendSheetView): the effect that
 * asks is pinned in source, the rest is rendered markup and the pure reviewMessage.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, title, children, footer }: { open: boolean; title: string; children?: ReactNode; footer?: ReactNode }) =>
    open ? createElement("div", { "data-modal": title }, children, footer) : null,
  ModalActions: ({ saveLabel, cancelLabel, disabled, formId }: { saveLabel?: string; cancelLabel?: string; disabled?: boolean; formId?: string }) =>
    createElement("div", { "data-actions": `${cancelLabel} / ${saveLabel}`, "data-disabled": String(!!disabled), "data-form": formId }),
}));
vi.mock("@/app/(app)/send-actions", () => ({ previewSend: vi.fn(), sendReviewed: vi.fn() }));

const { SendSheet, SendSheetView, SendButton, sendConfirmSentence, reviewMessage } = await import("./send-sheet");
const { TEXT_NOT_READY_REFUSAL } = await import("@/lib/sms-readiness");
const { SMS_TOTAL_MAX } = await import("@/lib/send-review");
const { CATALOGS } = await import("@/lib/i18n");

const INV = { kind: "invoice" as const, id: "inv-078", number: "INV-078", customerName: "Sam Tillery", amount: 9590.89, lineCount: 34 };
const preview = (o: Record<string, unknown> = {}) => ({
  kind: "invoice",
  id: "inv-078",
  customerName: "Sam Tillery",
  to: "sam@larkspur.example",
  phone: "(530) 555-0142",
  subject: "Invoice INV-078 from Thistlewood Electric",
  body: "Hi Sam, your invoice is ready.",
  smsBody: "Hi Sam, invoice INV-078 is ready.",
  tail: { email: "View and pay: https://x.example/i/abc", sms: "https://x.example/i/abc" },
  copyMe: false,
  copyTo: "owner@thistlewood.example",
  textReady: true,
  viewerLang: "en",
  reviewOff: false,
  ...o,
});
const view = (asked: unknown, p: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(SendSheetView as any, { open: true, onClose: () => {}, asked, ...INV, ...p }));
const src = readFileSync(join(process.cwd(), "src/components/send-sheet.tsx"), "utf8");

describe("the sentence the sheet asks", () => {
  it("names the bill, the amount, the lines and who gets it - and on an invoice, that it marks it Sent", () => {
    expect(sendConfirmSentence(INV)).toBe("Send INV-078 for $9,590.89 (34 lines) to Sam Tillery? This marks it Sent.");
    expect(sendConfirmSentence({ ...INV, lineCount: 1 })).toContain("(1 line)");
  });
  it("an estimate is not marked anything; a missing line count or name is left out, never guessed", () => {
    expect(sendConfirmSentence({ kind: "quote", number: "Q-101", customerName: "Jill", amount: 1240 })).toBe("Send Q-101 for $1,240.00 to Jill?");
    expect(sendConfirmSentence({ kind: "invoice", amount: 50 })).toBe("Send this invoice for $50.00 to the customer? This marks it Sent.");
    expect(sendConfirmSentence({ kind: "receipt" })).toBe("Send this receipt to the customer?");
  });
});

describe("asking for the words", () => {
  it("the sheet calls previewSend when it opens, and the view stamps nothing by being drawn", () => {
    expect(src).toContain("previewSend(p.kind, p.id)");
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!open\) return;/);
    expect(src).toContain("sn_loading");
    expect(view(null)).toContain("Getting the words ready");
  });
  it("a failed preview shows its sentence in the error box and still offers Cancel", () => {
    const out = view({ ok: false, error: "That invoice is gone." });
    expect(out).toContain("bg-red-50");
    expect(out).toContain("That invoice is gone.");
    expect(out).toMatch(/min-h-11[^>]*>Cancel</);
  });
  it("closed, it draws nothing; its button is the trigger", () => {
    expect(renderToStaticMarkup(createElement(SendSheet as any, { ...INV, open: false, onClose: () => {} }))).toBe("");
    expect(renderToStaticMarkup(createElement(SendButton as any, { ...INV, label: "Send $9,590.89" }))).toContain("Send $9,590.89");
    expect(renderToStaticMarkup(createElement(SendButton as any, { ...INV, label: "Send Again", variant: "menuItem" }))).toMatch(/min-h-11[^"]*"[^>]*>.*Send Again/);
  });
});

describe("Send Without Review on: today's two taps", () => {
  const out = view({ ok: true, preview: preview({ reviewOff: true }) }, { textReady: true });
  it("two 44px choices, Email It and Text It, under the sentence, and no field to edit", () => {
    expect(out).toContain('data-modal="Send Invoice"');
    expect(out).toContain(sendConfirmSentence(INV));
    const choices = [...out.matchAll(/<button type="button"[^>]*class="([^"]*)"[^>]*>(?:(?!<\/button>).)*?(Email It|Text It)/g)];
    expect(choices.map((m) => m[2])).toEqual(["Email It", "Text It"]);
    for (const m of choices) expect(m[1]).toContain("min-h-11");
    expect(out).not.toContain("<textarea");
  });
  it("one tap hands sendReviewed the kind, the id, the channel and an empty message", () => {
    expect(src).toContain('go(via, {}, ');
    expect(src).toContain('sendReviewed(p.kind, p.id, via === "email" ? "email" : "sms", message)');
  });
  it("Text It keeps its not-ready refusal in place and nothing is sent", () => {
    const no = view({ ok: true, preview: preview({ reviewOff: true }) }, { textReady: false });
    expect(no).toContain(TEXT_NOT_READY_REFUSAL.replace(/'/g, "&#x27;"));
    expect(no).toMatch(/aria-disabled="true"[^>]*>(?:(?!<\/button>).)*Text It/);
    const one = src.slice(src.indexOf("function sendOneTap("), src.indexOf("/** The reviewed path"));
    expect(one.indexOf('if (via === "text" && !textReady)')).toBeLessThan(one.indexOf("go("));
  });
});

describe("Send Without Review off: the review", () => {
  const email = view({ ok: true, preview: preview() });
  it("opens on Email with To, Subject and Message prefilled, 44px fields, the right autocomplete", () => {
    expect(email).toContain('data-modal="Review the Email"');
    expect(email).toContain('value="sam@larkspur.example"');
    expect(email).toContain('autoComplete="email"');
    expect(email).toContain('value="Invoice INV-078 from Thistlewood Electric"');
    expect(email).toContain('autoComplete="off"');
    expect(email).toContain("Hi Sam, your invoice is ready.</textarea>");
    expect(email).toContain("View and pay: https://x.example/i/abc");
    expect(email).toContain("What rides along can&#x27;t be changed: the greeting and the company&#x27;s sign-off on an email, and this link.");
    expect(email).toContain("Hi Sam Tillery,");
    expect(email).toContain('data-actions="Cancel / Email It"');
    expect(email).toContain('data-form="send-review-form"');
    expect(email).toContain('id="send-review-form"');
  });
  it("Copy Me is a checkbox that names where the copy goes, and is gone when there is nowhere", () => {
    expect(email).toContain("Copy Me");
    expect(email).toContain("A copy goes to owner@thistlewood.example.");
    expect(view({ ok: true, preview: preview({ copyTo: null }) })).not.toContain("Copy Me");
  });
  it("a text opens on the phone and the short words, with no subject, no copy and the counter", () => {
    const text = view({ ok: true, preview: preview() }, { via: "text", textReady: true });
    expect(text).toContain('data-modal="Review the Text"');
    expect(text).toContain('autoComplete="tel"');
    expect(text).toContain('value="(530) 555-0142"');
    expect(text).not.toContain('id="send-subject"');
    expect(text).toContain("A text has no copy.");
    expect(text).toContain("characters");
    expect(text).toContain('data-actions="Cancel / Text It"');
  });
  it("Text is disabled with the not-ready refusal when texting isn't set up", () => {
    const no = view({ ok: true, preview: preview() }, { textReady: false });
    expect(no).toContain(TEXT_NOT_READY_REFUSAL.replace(/'/g, "&#x27;"));
    expect(no).toMatch(/aria-disabled="true"[^>]*>(?:(?!<\/button>).)*Text/);
  });
  it("no address on file asks for one and keeps the button disabled", () => {
    const none = view({ ok: true, preview: preview({ to: null }) });
    expect(none).toContain("This customer has no email yet.");
    expect(none).toContain('data-disabled="true"');
    expect(email).toContain('data-disabled="false"');
  });
  it("a Spanish owner is told the customer reads English", () => {
    expect(view({ ok: true, preview: preview({ viewerLang: "es" }) })).toContain("The customer reads this in English.");
    expect(email).not.toContain("The customer reads this in English.");
  });
  it("a text past the carriers' limit says so and disables the button", () => {
    const long = view({ ok: true, preview: preview({ smsBody: "x".repeat(SMS_TOTAL_MAX) }) }, { via: "text" });
    expect(long).toContain("Shorter, please");
    expect(long).toContain('data-disabled="true"');
  });
  it("an edited body is Use Today's Words away from the original; an untouched one offers nothing", () => {
    expect(src).toContain("sn_btn_todaysWords");
    expect(src).toMatch(/min-h-11 items-center text-sm font-medium text-brand hover:underline"\s*>\s*\{t\("sn_btn_todaysWords"\)/);
    expect(email).not.toContain("Use Today");
  });
});

describe("what goes back", () => {
  const p = preview() as any;
  const same = { to: "sam@larkspur.example", subject: p.subject, body: p.body, copyMe: false };
  it("nothing changed: an empty message, so the server keeps every default", () => {
    expect(reviewMessage(p, "email", same)).toEqual({ ok: true, message: {} });
  });
  it("an edited body goes in; an unchanged subject stays absent", () => {
    expect(reviewMessage(p, "email", { ...same, body: "Hi Sam, thanks for waiting." })).toEqual({ ok: true, message: { body: "Hi Sam, thanks for waiting." } });
  });
  it("a typed address and a ticked Copy Me go in", () => {
    expect(reviewMessage(p, "email", { ...same, to: " pat@larkspur.example ", copyMe: true })).toEqual({
      ok: true,
      message: { to: "pat@larkspur.example", copyMe: true },
    });
  });
  it("a blanked box and a bad address are refused with a sentence's key", () => {
    expect(reviewMessage(p, "email", { ...same, body: "  " })).toEqual({ ok: false, key: "sn_badBody" });
    expect(reviewMessage(p, "email", { ...same, subject: "" })).toEqual({ ok: false, key: "sn_badSubject" });
    expect(reviewMessage(p, "email", { ...same, to: "sam@" })).toEqual({ ok: false, key: "sn_badEmail" });
    expect(reviewMessage(p, "sms", { to: "555", subject: "", body: p.smsBody, copyMe: false })).toEqual({ ok: false, key: "sn_badPhone" });
    expect(reviewMessage(p, "sms", { to: p.phone, subject: "", body: "x".repeat(SMS_TOTAL_MAX), copyMe: false })).toEqual({ ok: false, key: "sn_tooLong" });
  });
  it("a text's phone comes back as E.164 and never carries a subject or Copy Me", () => {
    expect(reviewMessage(p, "sms", { to: "(530) 555-0199", subject: "ignored", body: p.smsBody, copyMe: true })).toEqual({
      ok: true,
      message: { to: "+15305550199", copyMe: undefined },
    });
  });
});

describe("Cancel and the words", () => {
  it("Cancel is a button that only closes: the review's footer cancels through onClose", () => {
    expect(src).toContain("onCancel={onClose}");
  });
  it("Open It First appears only when the caller gives a place to open, at 44px", () => {
    expect(view({ ok: true, preview: preview({ reviewOff: true }) })).not.toContain("Open It First");
    expect(view({ ok: true, preview: preview({ reviewOff: true }) }, { openHref: "/billing/inv-078" })).toMatch(
      /<a class="inline-flex min-h-11[^"]*" href="\/billing\/inv-078">Open It First<\/a>/,
    );
  });
  it("every title and sentence the sheet reads is in the sn_ catalog, English and Spanish", () => {
    const keys = [...src.matchAll(/\bt\(\s*["'](sn_\w+)["']/g)].map((m) => m[1]);
    const cat = (CATALOGS as any[]).find((c) => c.prefix === "sn_");
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) {
      expect(cat.en[k], k).toBeTruthy();
      expect(cat.es[k], k).toBeTruthy();
    }
    for (const kind of ["invoice", "receipt", "quote", "contract", "portal"]) expect(cat.en[`sn_title_${kind}`]).toBeTruthy();
  });
});

describe("the greeting, the sent event and the Spanish title", () => {
  it("the greeting line is read-only text above the Message, and absent with no customer name", () => {
    const email = view({ ok: true, preview: preview() });
    expect(email.indexOf("Hi Sam Tillery,")).toBeGreaterThan(email.indexOf('for="send-body"'));
    expect(email.indexOf("Hi Sam Tillery,")).toBeLessThan(email.indexOf("<textarea"));
    const none = view({ ok: true, preview: preview({ customerName: null }) }, { customerName: null });
    expect(none).not.toContain("Hi ,");
    expect(none).not.toMatch(/>Hi [^<]*,</);
  });
  it("the greeting reads the same in both languages, and a landed send tells the Sent Messages lists", () => {
    const cat = (CATALOGS as any[]).find((c) => c.prefix === "sn_");
    expect(cat.es.sn_greetingPreview).toBe(cat.en.sn_greetingPreview);
    expect(cat.sameInBoth).toContain("sn_greetingPreview");
    expect(cat.es.sn_title_text).toBe("Revisa el Texto");
    const src = readFileSync(join(process.cwd(), "src/components/send-sheet.tsx"), "utf8");
    expect(src).toContain("window.dispatchEvent(new Event(SENT_MESSAGES_EVENT))");
  });
});

describe("the doors that send", () => {
  it("the invoice page and its older-copy notice open the Send sheet", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/page.tsx"), "utf8");
    const body = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/invoice-detail.tsx"), "utf8");
    expect(page).toContain("<SendButton");
    expect(body).toContain("<SendButton");
  });
  it("the crew's receipt doors open the same sheet as kind receipt", () => {
    const settle = readFileSync(join(process.cwd(), "src/components/settle-up-button.tsx"), "utf8");
    expect(settle).toContain('<SendButton kind="receipt" id={invoiceId}');
    expect(settle).not.toContain("textInvoice(");
    expect(settle).not.toContain("emailInvoice(");
  });
});
