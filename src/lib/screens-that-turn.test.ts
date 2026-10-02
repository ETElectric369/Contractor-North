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
    //
    // IT CAME DOWN, which is the direction a list like this almost never moves. It shipped with four
    // and the person it was built for took one off after holding both builds: "schedule and documents
    // yes and no on everything else" (Erik, 2026-10-01). So the tripwire comes down with it — left at
    // six it would have had three entries of silent headroom, which is exactly the slack that lets a
    // list grow by accident. Four is three plus one: the next entry is a decision somebody writes a
    // reason for, and the one after that trips this.
    expect(names.length).toBeLessThanOrEqual(4);
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

describe("what is actually on it (the three, by name)", () => {
  it("documents first — the PDF engine's own preview, the screen he named", () => {
    expect(SCREENS_THAT_TURN["document-preview"].route).toBe("/print/pdf-preview");
  });

  it("the full-screen photo/PDF viewer is a LAYER, so it has no route of its own", () => {
    expect(SCREENS_THAT_TURN["document-full-screen"].route).toBeNull();
  });

  it("the schedule — his original report", () => {
    expect(SCREENS_THAT_TURN.schedule.route).toBe("/schedule");
  });

  it("THE PRICE LIST IS NOT ON IT — and that is a decision, not an omission", () => {
    // Erik, 2026-10-01, having held both builds on his own phone: "schedule and documents yes and no on
    // everything else." The price table was the fourth entry and it reads like the most obvious one of
    // the four — it declares min-w-[1080px], so extra width genuinely shows more of it. The arithmetic
    // is what decided: drawn in the glass between a top bar and a dock that no longer move, the table
    // gets about 658px, against about 858px when iOS rotated the whole interface. Turning the phone
    // THIS way shows LESS of it than the old way did. So it goes back to ordinary portrait rather than
    // keeping a second rotation mode alive for one screen.
    //
    // Pinned by NAME rather than by count: a future "price-list" key would have to pass the whole file
    // above, and this is the line that says somebody has to come back to this reason first.
    expect(Object.keys(SCREENS_THAT_TURN)).not.toContain("price-list");
    expect(screenTurningAt("/price-list")).toBeNull();
    expect(mayTurnSideways("/price-list")).toBe(false);
    // The reason is written down where the next person will look for it, in his words.
    const file = read("src/lib/screens-that-turn.ts");
    expect(file).toContain("schedule and documents yes and no on everything else");
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
    // Off the list on 2026-10-01, and listed HERE now so it is held portrait by the same test that
    // holds the rest of the app portrait, rather than merely being absent from the other one.
    "/price-list",
    "/price-list/kits",
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
    expect(screenTurningAt("/schedule/2026-10-01")).toBe("schedule");
  });

  it("a NEIGHBOUR with the same prefix does not inherit the warrant", () => {
    // The whole reason this isn't a bare startsWith: a future /schedules would otherwise rotate
    // without anybody declaring it.
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
  it("only turns-sideways.tsx watches how the phone is held", () => {
    // Two writers is the race this design exists to avoid: a layer un-turning the screen on its way
    // out while the route underneath is still allowed to be turned.
    //
    // The CALL changed shape with cn-v1042 and the rule did not. It used to ask the shell to unlock
    // the interface so iOS would rotate the whole view — which is exactly what carried the top bar and
    // the dock around with it (Erik: "nice it rotates now on schedule but the dock and top bar rotate
    // with it still"). The shell is portrait-locked again and REPORTS which way the phone is held;
    // this watcher is still the one and only thing that listens, and the one and only thing that
    // decides what gets drawn.
    const callers = read("src/components/turns-sideways.tsx");
    expect(callers).toContain("watchHowThePhoneIsHeld");
    const lib = read("src/lib/native-orientation.ts");
    expect(lib).toContain("export function watchHowThePhoneIsHeld");
    // Nothing else in the app may listen for the shell's report directly.
    const others = ["src/components/turned.tsx", "src/components/media-lightbox.tsx", "src/app/print/pdf-preview/viewer.tsx"];
    for (const f of others) expect(read(f)).not.toContain("watchHowThePhoneIsHeld");
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
