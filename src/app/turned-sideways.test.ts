import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TURNED SIDEWAYS — the contract between globals.css and the markup it steers.
 *
 * Erik, 2026-10-01, from /schedule: "I'd like to be able to turn the phone sideways to see the
 * calendar in full, but it would be nice to also keep the buttons for the top bar and the dock
 * exactly where they are while spinning everything in between only."
 *
 * All of that is carried by CLASS NAMES on one side and a media query on the other, which is the
 * hand-copied-list hazard in its purest form: rename a class, or drop a clause from the query, and
 * nothing fails — the rules simply stop applying, on an orientation nobody tests on a laptop. So
 * each half is asserted against the other here.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const CSS = read("src/app/globals.css");
const TOPBAR = read("src/components/app-shell/topbar.tsx");
const DOCK = read("src/components/app-shell/dock.tsx");
const SUBNAV = read("src/components/section-subnav.tsx");
const SHELL = read("src/app/(app)/layout.tsx");
const SCHEDULE = read("src/app/(app)/schedule/page.tsx");
const CALENDAR = read("src/app/(app)/calendar/calendar-view.tsx");
const PLIST = read("ios/App/App/Info.plist");

/** The one media query, as both the `turned:` variant and the plain rules must spell it. */
const QUERY = "@media (orientation: landscape) and (max-height: 540px) and (pointer: coarse)";

describe("the `turned:` variant", () => {
  it("is defined, and spelled the same way in both places it appears", () => {
    // Once for the variant (utilities) and once for the plain rules. Two spellings would mean the
    // utilities and the rules fired on different screens.
    expect(CSS.split(QUERY).length - 1).toBe(2);
    expect(CSS).toMatch(/@custom-variant turned \{/);
  });

  it("keeps all three clauses — each one is holding something out", () => {
    // orientation: a tall phone must not get any of this.
    // max-height: an iPad is 744pt tall sideways and already rotates everywhere; it keeps its own
    //   layout, which is the desktop shell.
    // pointer: a short DESKTOP window is wide and mouse-driven — it gets `shell:` (the side dock),
    //   and these rules would fight it.
    expect(QUERY).toContain("orientation: landscape");
    expect(QUERY).toContain("max-height: 540px");
    expect(QUERY).toContain("pointer: coarse");
  });
});

describe("every selector the sideways rules target is really in the markup", () => {
  const hooks: [string, string, string][] = [
    ["app-topbar", "the top bar", TOPBAR],
    ["app-bottom-nav", "the dock", DOCK],
    ["app-subnav", "the section strip", SUBNAV],
    ["app-backdrop", "the shell root (main's padding hangs off it)", SHELL],
    ["schedule-split", "the schedule's rail-and-calendar split", SCHEDULE],
    ["cal-stack", "the week/month scroller", CALENDAR],
  ];
  for (const [cls, what, src] of hooks) {
    it(`${cls} — ${what}`, () => {
      expect(CSS).toContain(`.${cls}`);
      expect(src).toContain(cls);
    });
  }

  it("BOTH stacks carry cal-stack — the week's and the month's", () => {
    // They are two sibling scrollers with identical classes; one of them getting the hook and the
    // other not is the kind of half-fix that only shows up in the view nobody opened.
    expect(CALENDAR.split("cal-stack").length - 1).toBe(2);
  });
});

describe("the chrome does not move when the phone turns", () => {
  // A phone held sideways is ~700–930px WIDE, so sm: and md: fire. Every one of them in the top
  // bar's control group has to be undone, or a control changes shape in the one place Erik said
  // nothing may change.
  const pairs: [RegExp, RegExp, string][] = [
    [/sm:gap-3/, /turned:gap-2/, "the gap between the controls"],
    [/md:w-auto/, /turned:w-11/, "Search Or Ask stays a 44px square"],
    [/md:px-3/, /turned:px-0/, "…and keeps its square padding"],
    [/md:inline/, /turned:hidden/, "…and does not grow a text label"],
  ];
  for (const [wide, undo, what] of pairs) {
    it(`${what}`, () => {
      expect(TOPBAR).toMatch(wide);
      expect(TOPBAR).toMatch(undo);
    });
  }

  it("the dock is still the bottom bar sideways — `shell:` cannot reach a phone width", () => {
    // The bottom bar is drawn below `shell:`, which needs 1024px OR a fine pointer. A landscape
    // phone is neither, so the bar stays the bar and never becomes a side rail. If that floor ever
    // moves, this is the line that says why it mattered.
    expect(CSS).toContain("@media (min-width: 1024px), ((min-width: 640px) and (pointer: fine))");
    expect(DOCK).toContain("shell:hidden");
  });
});

describe("where the phone may turn", () => {
  it("the schedule's calendar says so, and the map and Everyone's Day do not", () => {
    expect(SCHEDULE).toContain("<TurnsSideways />");
    // Exactly once: the map and crew branches return above it, so walking to either turns the
    // phone back upright on the way.
    expect(SCHEDULE.split("<TurnsSideways />").length - 1).toBe(1);
  });

  it("no other screen mounts it", () => {
    // A grep across the app would be the real guard; this at least pins the two files that know
    // the component exists, so adding a third is a deliberate act with a test to update.
    const comp = read("src/components/turns-sideways.tsx");
    expect(comp).toContain("letTheScreenTurn");
  });
});

describe("the iPhone may rotate at all; the iPad is untouched", () => {
  const list = (key: string) => {
    const at = PLIST.indexOf(`<key>${key}</key>`);
    expect(at).toBeGreaterThan(-1);
    return PLIST.slice(at, PLIST.indexOf("</array>", at));
  };

  it("the iPhone allows portrait and both ways sideways — never upside down", () => {
    const phone = list("UISupportedInterfaceOrientations");
    expect(phone).toContain("UIInterfaceOrientationPortrait<");
    expect(phone).toContain("UIInterfaceOrientationLandscapeLeft");
    expect(phone).toContain("UIInterfaceOrientationLandscapeRight");
    expect(phone).not.toContain("UIInterfaceOrientationPortraitUpsideDown");
  });

  it("the iPad still allows all four", () => {
    const pad = list("UISupportedInterfaceOrientations~ipad");
    for (const o of ["Portrait<", "PortraitUpsideDown", "LandscapeLeft", "LandscapeRight"]) {
      expect(pad).toContain(`UIInterfaceOrientation${o}`);
    }
  });

  it("the plugin file is IN THE XCODE PROJECT — a Swift file on disk is not a Swift file in the build", () => {
    // Caught by actually building the shell (2026-10-01): App.xcodeproj lists its sources one by
    // one, so a new .swift file sitting next to the others compiles into nothing and the build
    // fails with "cannot find 'ScreenTurn' in scope". All three entries are needed — the file
    // reference, the build file, and the line in the Sources phase.
    const proj = read("ios/App/App.xcodeproj/project.pbxproj");
    expect(proj).toMatch(/isa = PBXFileReference;.*path = ScreenTurnPlugin\.swift;/);
    expect(proj).toMatch(/\/\* ScreenTurnPlugin\.swift in Sources \*\/ = \{isa = PBXBuildFile;/);
    expect(proj).toMatch(/\/\* ScreenTurnPlugin\.swift in Sources \*\/,/);
  });

  it("the shell answers portrait by default and never gates the iPad", () => {
    const vc = read("ios/App/App/NorthBridgeViewController.swift");
    const plugin = read("ios/App/App/ScreenTurnPlugin.swift");
    expect(vc).toContain("override var supportedInterfaceOrientations");
    expect(vc).toContain("userInterfaceIdiom == .pad ? .all");
    expect(vc).toContain("ScreenTurnPlugin()");
    // Portrait is the floor: the app opens portrait and an unknown word locks rather than unlocks.
    expect(plugin).toMatch(/static var allowed: UIInterfaceOrientationMask = \.portrait/);
    expect(plugin).toContain('call.getString("turn") == "sideways"');
  });
});
