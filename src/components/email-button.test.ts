import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE TEXT CHIP NEVER PROMISES WHAT CAN'T HAPPEN (2026-09-24). It asked "Text this $150.00 invoice
 * to Nora? This marks it Sent." and only after he said yes did it say texting isn't set up. With
 * the page's readiness answer it shows as not active, and its tap says why instead of confirming.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/app/(app)/quotes/actions", () => ({ emailQuote: vi.fn(), textQuote: vi.fn() }));
vi.mock("@/app/(app)/billing/actions", () => ({ emailInvoice: vi.fn(), textInvoice: vi.fn() }));

import { EmailButton } from "./email-button";

/** The Text chip's opening tag. */
function textChip(html: string) {
  const at = html.lastIndexOf("<button", html.indexOf("Text</button>"));
  return html.slice(at, html.indexOf(">", at) + 1);
}

describe("the Text chip", () => {
  it("texting not set up: shown as not active, carrying the refusal it gives on a tap", () => {
    const html = renderToStaticMarkup(createElement(EmailButton, { id: "inv-1", kind: "invoice", customerName: "Nora", amount: 150, textReady: false }));
    const chip = textChip(html);
    expect(chip).toContain('aria-disabled="true"');
    expect(chip).toMatch(/title="Texting isn(&#x27;|')t set up yet, so nothing was texted\./);
    // The email door is untouched.
    expect(html).toContain("Send Invoice");
  });

  it("texting set up: an ordinary chip", () => {
    const html = renderToStaticMarkup(createElement(EmailButton, { id: "q-1", kind: "quote", textReady: true }));
    const chip = textChip(html);
    expect(chip).not.toContain("aria-disabled");
    expect(chip).not.toContain("title=");
  });
});
