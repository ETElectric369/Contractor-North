import { afterEach, describe, expect, it } from "vitest";
import { hasInAppHistory } from "./back-link";

/**
 * The BackLink doctrine under test: window.history.length LIES (it counts
 * cross-site entries and never shrinks), so "can I safely history.back()?"
 * must come from signals we can vouch for. The module-flag signal (flipped
 * by <BackLinkTracker> on a client-side route change) needs a React render
 * and is exercised in the app; the document-load signals are pure logic and
 * are pinned here so the guards don't quietly regress.
 */

const ORIGIN = "https://app.example.com";

function stubBrowser({ historyLength, referrer }: { historyLength: number; referrer: string }) {
  (globalThis as any).window = {
    history: { length: historyLength },
    location: { origin: ORIGIN },
  };
  (globalThis as any).document = { referrer };
}

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

describe("hasInAppHistory (document-load signals)", () => {
  it("is false during SSR (no window)", () => {
    expect(hasInAppHistory()).toBe(false);
  });

  it("is false on a cold entry (empty referrer, fat history from other sites)", () => {
    stubBrowser({ historyLength: 7, referrer: "" });
    expect(hasInAppHistory()).toBe(false);
  });

  it("is false when the referrer is another site — back() would EXIT the app", () => {
    stubBrowser({ historyLength: 3, referrer: "https://www.google.com/search?q=quote" });
    expect(hasInAppHistory()).toBe(false);
  });

  it("is false in a fresh new tab even with a same-origin referrer — no entry to pop, back() would look frozen", () => {
    stubBrowser({ historyLength: 1, referrer: `${ORIGIN}/quotes/abc` });
    expect(hasInAppHistory()).toBe(false);
  });

  it("is true after a same-origin hard navigation (e.g. into a print page) with history to pop", () => {
    stubBrowser({ historyLength: 2, referrer: `${ORIGIN}/quotes/abc` });
    expect(hasInAppHistory()).toBe(true);
  });

  it("does not treat a same-PREFIX foreign origin as ours", () => {
    stubBrowser({ historyLength: 2, referrer: "https://app.example.com.evil.io/quotes" });
    expect(hasInAppHistory()).toBe(false);
  });
});
