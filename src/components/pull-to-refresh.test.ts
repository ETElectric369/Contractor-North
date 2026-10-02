import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * PULL DOWN TO REFRESH (bug report 44aeec9c, Erik on /billing 2026-09-22: "can we pull down to
 * refresh?").
 *
 * There was none anywhere in the app, and in the iOS shell there cannot be the browser's own: the
 * shell's root is h-dvh + overflow-hidden and globals.css turns the document's rubber-band off on
 * purpose, so `main` is the one scroller and a pull on it did nothing. Built ONCE here, so the next
 * screen gets it by mounting one component.
 *
 * No DOM in this project's unit runtime (the suite is plain Node, react-dom/server), so what is
 * pinned here is what can be: at rest it draws NOTHING (no spinner parked on every screen), it finds
 * the right scroller to listen on, and the rules that keep the gesture from stealing a scroll or a
 * sideways swipe are the ones written in it.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PullToRefresh, pullReleases, readPullMove, scrollerOf } from "./pull-to-refresh";
import { codeOnly } from "@/lib/migration-body.test-util";

const src = readFileSync(join(process.cwd(), "src/components/pull-to-refresh.tsx"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

describe("at rest it draws nothing", () => {
  it("no indicator, no spinner, no words — only the anchor that finds the scroller", () => {
    const html = renderToStaticMarkup(createElement(PullToRefresh));
    expect(html).not.toContain("Refreshing");
    expect(html).not.toContain("Pull To Refresh");
    expect(html).not.toContain("animate-spin");
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("which element it listens on", () => {
  /** A stand-in for the app shell: a non-scrolling wrapper inside the scrolling <main>. */
  const fakeTree = (overflowY: string) => {
    const page = { parentElement: null as any };
    const main = { parentElement: null as any };
    page.parentElement = { parentElement: main };
    main.parentElement = null;
    const styles = new Map<any, string>([
      [page.parentElement, "visible"],
      [main, overflowY],
    ]);
    const realGetComputedStyle = globalThis.getComputedStyle;
    const realDocument = globalThis.document;
    (globalThis as any).getComputedStyle = (el: any) => ({ overflowY: styles.get(el) ?? "visible" });
    (globalThis as any).document = { scrollingElement: "the document" };
    try {
      return scrollerOf(page as any);
    } finally {
      (globalThis as any).getComputedStyle = realGetComputedStyle;
      (globalThis as any).document = realDocument;
    }
  };

  it("the nearest scrolling ancestor — <main>, in the app shell", () => {
    expect(fakeTree("auto")).not.toBe("the document");
    expect(fakeTree("scroll")).not.toBe("the document");
  });

  it("a page with no scrolling ancestor falls back to the document, so it still works off the shell", () => {
    expect(fakeTree("visible")).toBe("the document");
  });

  it("it does NOT require something to scroll: an empty screen still pulls down to refresh", () => {
    // The guard that would have broken this is a scrollHeight > clientHeight test. It isn't there.
    expect(code).not.toMatch(/scrollHeight/);
  });
});

describe("what one move of the thumb means", () => {
  const move = (dy: number, dx = 0, claimed = false) => readPullMove({ dy, dx, claimed });

  it("a small drag is nobody's yet: the first pixels belong to the browser", () => {
    expect(move(0)).toEqual({ kind: "ignore" });
    expect(move(6)).toEqual({ kind: "ignore" });
    expect(move(12)).toEqual({ kind: "ignore" });
  });

  it("a drag that goes UP is the page's — scrolling back up a long list never trips it", () => {
    expect(move(-3)).toEqual({ kind: "notOurs" });
    expect(move(-80)).toEqual({ kind: "notOurs" });
  });

  it("a sideways swipe is not a pull (a back gesture, a horizontal strip)", () => {
    expect(move(20, 60)).toEqual({ kind: "notOurs" });
    expect(move(20, -60)).toEqual({ kind: "notOurs" });
    // Mostly down, drifting a little sideways, is still a pull.
    expect(move(40, 10)).toEqual({ kind: "pull", px: 28 });
  });

  it("a downward pull reports how far, measured past the slop and capped", () => {
    expect(move(20)).toEqual({ kind: "pull", px: 8 });
    expect(move(76)).toEqual({ kind: "pull", px: 64 });
    expect(move(400)).toEqual({ kind: "pull", px: 96 });
  });

  it("once it IS a pull it stays one, even if the thumb wanders sideways", () => {
    expect(move(80, 200, true)).toEqual({ kind: "pull", px: 68 });
    // …and it never reports a negative pull on the way back up.
    expect(move(-50, 0, true)).toEqual({ kind: "pull", px: 0 });
  });

  it("letting go refreshes only past the trigger, so a twitch never re-reads the page", () => {
    expect(pullReleases(0)).toBe(false);
    expect(pullReleases(63)).toBe(false);
    expect(pullReleases(64)).toBe(true);
    // The pull has to travel about three quarters of an inch of real thumb before it counts.
    expect(readPullMove({ dy: 75, dx: 0, claimed: true }).kind === "pull" && pullReleases(63)).toBe(false);
    expect(pullReleases((readPullMove({ dy: 76, dx: 0, claimed: true }) as { px: number }).px)).toBe(true);
  });
});

/**
 * THE WIRING, which has no pure form: these are tripwires on the three decisions that live in the
 * listener itself, not a stand-in for the rules above (those are read for real).
 */
describe("the wiring the listener can only do once", () => {
  it("the pull starts only when the scroller is already at the top", () => {
    expect(code).toContain("scroller.scrollTop <= 0");
  });

  it("never while a sheet is open — a refresh there breaks the back gesture out of it", () => {
    expect(code).toContain('document.body.classList.contains("modal-open")');
  });

  it("the touchmove listener can claim the gesture (a passive one cannot preventDefault)", () => {
    expect(code).toMatch(/addEventListener\("touchmove", onMove, \{ passive: false \}\)/);
  });

  it("the spinner ends when the new page is actually in, not after a guessed delay", () => {
    // router.refresh() inside a transition: isPending stays true until the server answers.
    expect(code).toContain("startRefresh(() => router.refresh())");
    expect(code).not.toMatch(/setTimeout/);
  });

  it("every listener it adds, it takes off again", () => {
    const added = [...code.matchAll(/addEventListener\("(\w+)"/g)].map((m) => m[1]).sort();
    const removed = [...code.matchAll(/removeEventListener\("(\w+)"/g)].map((m) => m[1]).sort();
    expect(added).toEqual(removed);
  });
});

/**
 * THE SCREENS THAT HAVE IT: ALL OF THEM (Erik, 2026-10-01).
 *
 * This file's own headline has said "ONE OF THEM, FOR EVERY SCREEN" since cn-v1039, and it shipped
 * mounted on exactly one page — /billing, where the bug report came from. Every other screen in the
 * iOS shell still did nothing when a thumb pulled it down: the shell's root is h-dvh + overflow-hidden
 * and the document's rubber-band is off on purpose, so there is no browser gesture to fall back on.
 * It needs no per-page data — it finds its own scroller — so the headline was right and the wiring was
 * short. It is mounted ONCE in the app shell's <main>, which IS that scroller.
 */
describe("the screens that have it", () => {
  const layout = readFileSync(join(process.cwd(), "src/app/(app)/layout.tsx"), "utf8");

  it("the app shell mounts it once, inside the one scroller, so every screen pulls down to refresh", () => {
    expect(layout).toContain('import { PullToRefresh } from "@/components/pull-to-refresh"');
    expect(layout.match(/<PullToRefresh \/>/g) ?? []).toHaveLength(1);
    // Inside <main>, which is the scroller it walks up to find (overflow-y-auto on the shell's main).
    const main = layout.slice(layout.indexOf("<main"), layout.indexOf("</main>"));
    expect(main).toContain("<PullToRefresh />");
    expect(main).toContain("overflow-y-auto");
  });

  it("and no page mounts a second one: two of them would refresh twice on one pull", () => {
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          /\.tsx$/.test(e.name) &&
          !p.endsWith(join("app", "(app)", "layout.tsx")) &&
          codeOnly(readFileSync(p, "utf8")).includes("<PullToRefresh")
        )
          pages.push(p);
      }
    };
    walk(join(process.cwd(), "src"));
    expect(pages).toEqual([]);
  });
});
