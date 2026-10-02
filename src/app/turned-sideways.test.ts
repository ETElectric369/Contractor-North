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
const PDF_VIEWER = read("src/app/print/pdf-preview/viewer.tsx");
const LIGHTBOX = read("src/components/media-lightbox.tsx");
const MANIFEST = read("src/app/manifest.ts");
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
    ["pdf-preview-bar", "the document preview's toolbar", PDF_VIEWER],
    ["pdf-pages-scroll", "the sheets, scrolling", PDF_VIEWER],
    ["media-lightbox-bar", "the full-screen viewer's button row", LIGHTBOX],
    ["media-lightbox-body", "the photo or PDF itself", LIGHTBOX],
    ["media-lightbox-hint", "the line that says how to close it", LIGHTBOX],
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

describe("the documents keep their doors when the camera is on the side", () => {
  // /print/pdf-preview and the full-screen viewer are the two rotating screens with NO app shell
  // around them — no top bar, no dock, nothing holding an inset. Sideways the notch is on the side,
  // and the ONLY way off each of them (Back; the ✕) sits at an edge.
  it("the rules pad both of them past the cutout on BOTH ends", () => {
    for (const cls of ["pdf-preview-bar", "media-lightbox-bar"]) {
      const at = CSS.indexOf(`.${cls}`);
      expect(at).toBeGreaterThan(-1);
      const rule = CSS.slice(at, CSS.indexOf("}", at));
      expect(rule).toContain("env(safe-area-inset-left");
      expect(rule).toContain("env(safe-area-inset-right");
    }
  });

  it("…and each keeps its own padding as the floor, so a browser is unchanged", () => {
    // px-4 on both rows. max(1rem, inset) means every inset-less browser renders exactly what it
    // renders today; only the phone with a cutout moves.
    const at = CSS.indexOf(".pdf-preview-bar");
    const rule = CSS.slice(at, CSS.indexOf("}", at));
    expect(rule).toContain("max(1rem, env(safe-area-inset-left");
    expect(PDF_VIEWER).toContain("px-4");
  });

  it("the sheets are DRAWN AGAIN at the new width — a bitmap does not re-flow", () => {
    // Without this the whole claim is false: turning the phone would leave the same 374pt-wide page
    // in a 812pt-wide window, which is strictly worse than portrait.
    expect(PDF_VIEWER).toContain('window.addEventListener("resize"');
    expect(PDF_VIEWER).toContain('window.addEventListener("orientationchange"');
    // From the document already in hand, not a second trip to the server.
    expect(PDF_VIEWER).toMatch(/pdfRef\.current/);
    expect(PDF_VIEWER).toMatch(/void paint\(pdf, want\)/);
    // Width only: a keyboard or a browser's own chrome changes the height, and a repaint then would
    // interrupt reading for nothing. The arithmetic itself is tested in lib/pdf-page-width.test.ts.
    expect(PDF_VIEWER).toContain("worthRedrawing(want, paintedAtW.current)");
  });

  it("…and the page keeps his place instead of jumping back to page 1", () => {
    expect(PDF_VIEWER).toContain("scroller.scrollTop = was * scroller.scrollHeight");
  });

  it("a page is measured from INSIDE the scroller, which is where the insets are", () => {
    // window.innerWidth doesn't know about the camera inset, so a page sized from it would be drawn
    // partly under the cutout.
    expect(PDF_VIEWER).toContain("measureRef.current?.clientWidth");
    expect(PDF_VIEWER).toContain("pageWidthInside(");
    expect(PDF_VIEWER).not.toContain("Math.max(window.innerWidth - 32, 280)");
  });
});

describe("the installed web app's manifest", () => {
  it("still says portrait, and says WHY it cannot be the per-screen answer", () => {
    // One value for the whole app: "any" would let an installed iOS web app rotate on every screen
    // with no API to lock it back. Portrait is the one that is wrong in a safe direction.
    expect(MANIFEST).toContain('orientation: "portrait"');
    expect(MANIFEST).toContain("ONE");
    expect(MANIFEST).toContain("screens-that-turn");
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
