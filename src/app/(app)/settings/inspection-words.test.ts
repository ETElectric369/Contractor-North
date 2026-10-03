import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * THE SHEET IS THE INSPECTION SHEET (2026-10-03). The visit before a price is an Inspection, and the
 * playbook questions carried on it are its questions — the SECOND sense of the word Erik renamed,
 * and the one most likely to be left behind, because it lives in Settings rather than on the page he
 * was reading. W2-10 made this card say "walk-through" on 2026-10-02; it says Inspection again.
 */
describe("Settings' inspection sheet", () => {
  const src = () => readFileSync(new URL("./playbook-manager.tsx", import.meta.url), "utf8");

  it("the empty sheet names the sheet and how to start one, in the one word", () => {
    expect(src()).toContain("You don&rsquo;t have an inspection sheet yet. Start an inspection and it&rsquo;ll show up here.");
    // The two wordings this card has worn, neither of which it may wear again.
    expect(src()).not.toContain("Start one from an inspection");
    expect(src()).not.toMatch(/walk.?through/i);
  });

  it("the teal half says whose questions these are, and that a customer never sees them", () => {
    expect(src()).toContain("Your own inspection questions — what you ask yourself standing on the job. Never shown to a customer.");
    expect(src()).toContain('"your inspection — only you see these"');
  });
});
