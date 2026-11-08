import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/app/(app)/sent-messages-actions", () => ({ listSentMessages: vi.fn(async () => []) }));

import { LangProvider } from "@/components/lang-provider";
import { SentMessagesView } from "./sent-messages-list";
import type { SentMessage } from "@/lib/sent-messages";

/**
 * THE SENT MESSAGES LIST (cn-v1155): newest first, one 44px row per message, a tap opens the words,
 * empty hides the block unless the page asks for the line.
 */
const row = (o: Partial<SentMessage>): SentMessage => ({
  id: "m1",
  channel: "email",
  to: "sam@larkspur.example",
  subject: "Invoice INV-0042",
  body: "Hi Sam,\nYour invoice is ready.",
  copyTo: null,
  sentBy: "u1",
  sentByName: "Sam Tillery",
  sentAt: "2026-11-07T18:00:00Z",
  auto: false,
  ...o,
});
const rows = [
  row({ id: "new", channel: "sms", to: "+15305550100", subject: null, body: "Your invoice is ready.", sentAt: "2026-11-08T09:00:00Z" }),
  row({ id: "old", copyTo: "owner@thistlewood.example", sentAt: "2026-11-07T18:00:00Z" }),
  row({ id: "auto", sentByName: null, auto: true, to: "pat@thistlewood.example", sentAt: "2026-11-01T18:00:00Z" }),
];
const draw = (props: Parameters<typeof SentMessagesView>[0], lang = "en") =>
  renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(SentMessagesView, props) } as never));
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("SentMessagesView", () => {
  it("lists the rows in the order it was handed (the action sends newest first), each a 44px tap", () => {
    const h = draw({ rows, open: null, onToggle: () => {} });
    expect(h.indexOf("+15305550100")).toBeLessThan(h.indexOf("sam@larkspur.example"));
    expect(h.indexOf("sam@larkspur.example")).toBeLessThan(h.indexOf("pat@thistlewood.example"));
    expect((h.match(/min-h-11/g) ?? []).length).toBe(3);
    expect(text(h)).toContain("Sent Messages");
    expect(text(h)).toContain("Text");
    expect(text(h)).toContain("Sam Tillery");
    expect(text(h)).toContain("Automatic");
  });

  it("a closed row hides the words; the open one shows subject, body as written, and the copy line", () => {
    const closed = draw({ rows, open: null, onToggle: () => {} });
    expect(closed).not.toContain("Your invoice is ready.");
    const opened = draw({ rows, open: "old", onToggle: () => {} });
    expect(opened).toContain("Invoice INV-0042");
    expect(opened).toContain("whitespace-pre-wrap");
    expect(opened).toContain("Hi Sam,\nYour invoice is ready.");
    expect(text(opened)).toContain("A copy went to owner@thistlewood.example.");
    expect(opened).toContain('aria-expanded="true"');
  });

  it("hides the whole block when empty, unless the page asks for the line", () => {
    expect(draw({ rows: [], open: null, onToggle: () => {} })).toBe("");
    expect(text(draw({ rows: [], open: null, onToggle: () => {}, showEmpty: true }))).toContain("Nothing sent yet.");
  });

  it("reads in Spanish for a Spanish viewer", () => {
    const h = text(draw({ rows, open: null, onToggle: () => {} }, "es"));
    expect(h).toContain("Mensajes Enviados");
    expect(h).toContain("Automático");
  });

  it("its two taps are Title Case in both languages", async () => {
    const { dict } = await import("@/lib/i18n");
    for (const lang of ["en", "es"] as const) {
      for (const k of ["sn_btn_showWords", "sn_btn_hideWords"]) {
        const w = dict(lang)[k];
        expect(w, k).toBeTruthy();
        expect(w.split(" ")[0][0]).toBe(w.split(" ")[0][0].toUpperCase());
      }
    }
  });

  it("the list is named in the catalog's leak scan", () => {
    const cat = readFileSync(join(process.cwd(), "src/lib/words/send.ts"), "utf8");
    expect(cat).toContain("src/components/sent-messages-list.tsx");
  });
});
