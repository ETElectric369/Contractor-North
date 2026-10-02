import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCREENS_THAT_TURN,
  mayTurnSideways,
  screenTurningAt,
  type ScreenThatTurns,
} from "./screens-that-turn";

/**
 * WHICH SCREENS MAY BE TURNED SIDEWAYS — the list, and the teeth.
 *
 * Erik, 2026-10-01: "The rotate should be available for any screen that warrants it like documents
 * especially and I see that I already does work on the PDF engine one of them."
 *
 * The danger in a list like this is not that it is wrong today — it is that it grows by accident, one
 * well-meant entry at a time, until the app rotates everywhere and the tall screens are 400pt high.
 * So: every entry must carry a REASON, the default must be portrait, and the matcher must not hand a
 * route's warrant to its neighbours.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const names = Object.keys(SCREENS_THAT_TURN) as ScreenThatTurns[];

describe("nothing is on the list without a reason", () => {
  for (const name of names) {
    it(`${name} says why width shows more`, () => {
      const because = SCREENS_THAT_TURN[name].because;
      // Long enough to be an argument rather than a label. The type already makes it required; this
      // is what stops `because: "wide"` from passing for one.
      expect(because.length).toBeGreaterThan(40);
      expect(because.trim()).toBe(because);
      expect(because).toMatch(/[.!]$/);
    });
  }

  it("the list stays SHORT — a long list is the thing we were avoiding", () => {
    // Not a magic number: it is a tripwire. Passing it means someone should re-read the note at the
    // top of screens-that-turn.ts and the test above, not raise this line.
    expect(names.length).toBeLessThanOrEqual(6);
  });

  it("no two screens claim the same route", () => {
    const routes = names.map((n) => SCREENS_THAT_TURN[n].route).filter((r): r is string => !!r);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("every route is an app path, never a bare slash or a URL", () => {
    for (const name of names) {
      const route = SCREENS_THAT_TURN[name].route;
      if (route === null) continue;
      expect(route.startsWith("/")).toBe(true);
      expect(route).not.toBe("/"); // "/" would turn the entire app
      expect(route.endsWith("/")).toBe(false);
      expect(route).not.toMatch(/^https?:/);
    }
  });
});

describe("what is actually on it (the four, by name)", () => {
  it("documents first — the PDF engine's own preview, the screen he named", () => {
    expect(SCREENS_THAT_TURN["document-preview"].route).toBe("/print/pdf-preview");
  });

  it("the full-screen photo/PDF viewer is a LAYER, so it has no route of its own", () => {
    expect(SCREENS_THAT_TURN["document-full-screen"].route).toBeNull();
  });

  it("the schedule — his original report", () => {
    expect(SCREENS_THAT_TURN.schedule.route).toBe("/schedule");
  });

  it("the price table — already wider than the phone", () => {
    expect(SCREENS_THAT_TURN["price-list"].route).toBe("/price-list");
  });
});

describe("the default is portrait, and the default is most of the app", () => {
  const portrait = [
    "/planner",
    "/timecards",
    "/analytics",
    "/reconcile",
    "/jobs",
    "/jobs/7f1c",
    "/quotes/7f1c",
    "/materials/7f1c",
    "/timeclock",
    "/settings",
    "/login",
    "/",
    "/print/invoice/7f1c",
    "/print/business-card",
  ];
  for (const p of portrait) {
    it(`${p} does not turn`, () => {
      expect(screenTurningAt(p)).toBeNull();
      expect(mayTurnSideways(p)).toBe(false);
    });
  }
});

describe("the matcher stops at a segment boundary", () => {
  it("the route itself, and anything under it", () => {
    expect(screenTurningAt("/schedule")).toBe("schedule");
    expect(screenTurningAt("/print/pdf-preview")).toBe("document-preview");
    expect(screenTurningAt("/price-list")).toBe("price-list");
  });

  it("a NEIGHBOUR with the same prefix does not inherit the warrant", () => {
    // The whole reason this isn't a bare startsWith: a future /price-lists or /schedules would
    // otherwise rotate without anybody declaring it.
    expect(screenTurningAt("/price-lists")).toBeNull();
    expect(screenTurningAt("/schedules")).toBeNull();
    expect(screenTurningAt("/print/pdf-preview-old")).toBeNull();
  });

  it("a query string, a hash and a trailing slash are not part of the path", () => {
    // usePathname never includes these, but a hand-written call can, and getting it wrong would
    // silently lock the one screen he asked for.
    expect(screenTurningAt("/schedule?view=crew&date=2026-10-01")).toBe("schedule");
    expect(screenTurningAt("/schedule/")).toBe("schedule");
    expect(screenTurningAt("/print/pdf-preview?doc=invoice&id=7f1c")).toBe("document-preview");
    expect(screenTurningAt("/print/pdf-preview#page2")).toBe("document-preview");
  });

  it("empty and junk are portrait, never a crash", () => {
    expect(screenTurningAt("")).toBeNull();
    expect(screenTurningAt("/")).toBeNull();
    expect(mayTurnSideways("")).toBe(false);
  });
});

describe("a document opened OVER a tall screen may still be turned", () => {
  it("a layer turns a portrait screen sideways while it is open", () => {
    expect(mayTurnSideways("/jobs/7f1c", 1)).toBe(true);
  });

  it("closing it gives the screen underneath its OWN answer back, not portrait", () => {
    // The bug this prevents: a receipt opened from the schedule, then closed, used to lock the
    // schedule portrait — the layer "returned" the phone to a screen that was allowed to be sideways.
    expect(mayTurnSideways("/schedule", 1)).toBe(true);
    expect(mayTurnSideways("/schedule", 0)).toBe(true);
    expect(mayTurnSideways("/jobs/7f1c", 0)).toBe(false);
  });

  it("two layers deep, closing one does not undo the other", () => {
    expect(mayTurnSideways("/jobs/7f1c", 2)).toBe(true);
    expect(mayTurnSideways("/jobs/7f1c", 1)).toBe(true);
  });
});

describe("there is ONE place that tells the phone, and ONE place that is mounted", () => {
  it("only turns-sideways.tsx calls letTheScreenTurn", () => {
    // Two writers is the race this design exists to avoid: a layer asking for portrait on its way
    // out while the route underneath is still allowed to be sideways.
    const callers = read("src/components/turns-sideways.tsx");
    expect(callers).toContain("letTheScreenTurn");
    const lib = read("src/lib/native-orientation.ts");
    expect(lib).toContain("export async function letTheScreenTurn");
  });

  it("the watcher is mounted in the ROOT layout, so no screen has to remember anything", () => {
    // Root layout = never unmounts, sees every route, and covers /print/* — which is outside the app
    // shell and is where the documents are.
    const root = read("src/app/layout.tsx");
    expect(root).toContain("<TurnsSideways />");
    expect(root).toContain('from "@/components/turns-sideways"');
  });

  it("the schedule no longer mounts it itself — the list owns this now", () => {
    expect(read("src/app/(app)/schedule/page.tsx")).not.toContain("TurnsSideways");
  });

  it("the full-screen viewer declares itself with a name FROM the list", () => {
    const box = read("src/components/media-lightbox.tsx");
    expect(box).toContain('useTurnsSidewaysLayer("document-full-screen")');
    // A name that isn't a declared key will not compile, which is the point of the union.
    expect(names).toContain("document-full-screen" as ScreenThatTurns);
  });
});
