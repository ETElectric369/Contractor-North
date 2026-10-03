import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TellNort } from "./tell-nort";

/**
 * JUST TELL NORT, OPENED. The inspection's 44px count (appointments/[id]/inspector.test.ts) renders
 * it closed, where its one door is the full-width button; one tap opens this panel, and a crew lead on
 * the truck reaches every door in it too. The close X was a ~24px icon with no name.
 */
const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(TellNort, {
      hear: async () => ({ ok: false, error: "unused" }) as never,
      answers: {},
      onFilled: () => {},
      label: "Just Tell Nort",
      defaultOpen: true,
      ...over,
    }),
  );

const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({
    open: m[0].match(/^<button[^>]*>/)![0],
    text: m[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  }));
const TARGET = /min-h-\[44px\]|\bh-11\b|\bh-12\b/;
const titleCase = (s: string) => s.split(/\s+/).filter((w) => /^[a-z]/i.test(w)).every((w) => /^[A-Z]/.test(w));

describe("the opened Tell Nort panel", () => {
  const html = render();

  it("is the panel, not the closed button", () => {
    expect(html).toContain("<textarea");
    expect(buttons(html).map((b) => b.text)).toEqual(["", "Talk", "Fill It In"]);
  });

  it("every door in it is 44px and Title Case", () => {
    for (const b of buttons(html)) {
      expect(b.open, b.text || b.open).toMatch(TARGET);
      expect(titleCase(b.text), b.text).toBe(true);
    }
  });

  it("the close X is 44 by 44 and has a name", () => {
    const close = buttons(html)[0].open;
    expect(close).toMatch(/\bh-11\b/);
    expect(close).toMatch(/\bw-11\b/);
    expect(close).toContain('aria-label="Close"');
  });

  it("closed by default, as the inspection draws it", () => {
    const closed = render({ defaultOpen: undefined });
    expect(closed).not.toContain("<textarea");
    expect(buttons(closed).map((b) => b.text)).toEqual(["Just Tell Nort"]);
  });
});
