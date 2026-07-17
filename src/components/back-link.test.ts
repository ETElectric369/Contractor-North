import { afterEach, describe, expect, it } from "vitest";
import { hasInAppHistory, resetBackLinkTrackingForTests, trackPathnameForBackLink } from "./back-link";

/**
 * The BackLink doctrine under test: window.history.length LIES (it counts
 * cross-site entries and never shrinks), so "can I safely history.back()?"
 * must come from signals we can vouch for. The module-flag signal (flipped
 * by <BackLinkTracker> on a client-side route change) needs a React render
 * and is exercised in the app; the document-load signals are pure logic and
 * are pinned here so the guards don't quietly regress.
 */

const ORIGIN = "https://app.example.com";

function stubBrowser({
  historyLength,
  referrer,
  pathname = "/",
}: {
  historyLength: number;
  referrer: string;
  pathname?: string;
}) {
  (globalThis as any).window = {
    history: { length: historyLength },
    location: { origin: ORIGIN, pathname },
  };
  (globalThis as any).document = { referrer };
}

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  resetBackLinkTrackingForTests();
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

describe("hasInAppHistory (module-flag signal + the retrace case)", () => {
  it("a client-side route change vouches for back() on the NEW page", () => {
    stubBrowser({ historyLength: 5, referrer: "https://www.google.com/", pathname: "/jobs/55" });
    trackPathnameForBackLink("/quotes/abc"); // cold entry
    trackPathnameForBackLink("/jobs/55"); // in-app navigation
    expect(hasInAppHistory()).toBe(true);
  });

  it("retraced BACK to the cold-entry page, the flag must NOT claim the pre-app referrer (Google) as in-app history", () => {
    // Google → /quotes/abc → /jobs/55 → Back → /quotes/abc: behind us is Google again.
    stubBrowser({ historyLength: 5, referrer: "https://www.google.com/", pathname: "/quotes/abc" });
    trackPathnameForBackLink("/quotes/abc");
    trackPathnameForBackLink("/jobs/55");
    expect(hasInAppHistory()).toBe(false); // falls back to the honest "Back to X" link
  });

  it("retraced to the cold-entry page with a SAME-ORIGIN referrer, back() is still vouched for", () => {
    stubBrowser({ historyLength: 5, referrer: `${ORIGIN}/planner`, pathname: "/quotes/abc" });
    trackPathnameForBackLink("/quotes/abc");
    trackPathnameForBackLink("/jobs/55");
    expect(hasInAppHistory()).toBe(true); // the referrer signal, not the flag, answers here
  });
});
