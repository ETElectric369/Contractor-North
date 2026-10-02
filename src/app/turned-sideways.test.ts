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
 * WHICH WORLD THIS FILE IS ABOUT. In the App Store app the interface is portrait-locked and the
 * quarter turn is DRAWN on the region between the chrome — that contract lives in
 * chrome-stays-put.test.ts. Everything here is the other world: a plain mobile browser tab and an
 * installed web app, where the page rotates natively and always did, and where these rules are what
 * keep the top bar and the dock where they belong inside the rotated viewport.
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
const SECTION_SHEET = read("src/components/section-sheet.tsx");
const ROOT_LAYOUT = read("src/app/layout.tsx");

/** The one media query, as both the `turned:` variant and the plain rules must spell it. */
const QUERY =
  "@media (orientation: landscape) and (min-width: 480px) and (max-height: 540px) and (pointer: coarse)";

/**
 * The RULES of the plain @media block: brace-matched, so a rule that merely sits AFTER the block can
 * never be mistaken for one inside it (`.app-bottom-nav` has rules on both sides of that boundary),
 * and stripped of comments, so the prose explaining which class a rule must NOT use is not read as
 * that rule using it.
 */
function turnedBlock(): string {
  const at = CSS.lastIndexOf(QUERY);
  if (at < 0) throw new Error("the plain sideways @media block is missing");
  let depth = 0;
  for (let i = CSS.indexOf("{", at); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) {
      return CSS.slice(at, i + 1).replace(/\/\*[\s\S]*?\*\//g, "");
    }
  }
  throw new Error("the sideways @media block is never closed");
}

describe("the `turned:` variant — a BROWSER's rotated phone", () => {
  it("is defined, and spelled the same way in both places it appears", () => {
    // Once for the variant (utilities) and once for the plain rules. Two spellings would mean the
    // utilities and the rules fired on different screens.
    expect(CSS.split(QUERY).length - 1).toBe(2);
    expect(CSS).toMatch(/@custom-variant turned \{/);
  });

  it("keeps all four clauses — each one is holding something out", () => {
    // orientation: a tall phone must not get any of this.
    // min-width: a phone standing UPRIGHT with its keyboard open (see below).
    // max-height: an iPad is 744pt tall sideways and already rotates everywhere; it keeps its own
    //   layout, which is the desktop shell.
    // pointer: a short DESKTOP window is wide and mouse-driven — it gets `shell:` (the side dock),
    //   and these rules would fight it.
    expect(QUERY).toContain("orientation: landscape");
    expect(QUERY).toContain("min-width: 480px");
    expect(QUERY).toContain("max-height: 540px");
    expect(QUERY).toContain("pointer: coarse");
  });

  it("a phone held UPRIGHT with its keyboard open is NOT turned sideways", () => {
    // The other three clauses only say "wider than it is tall, short, and touched". layout.tsx asks
    // the browser to resize the layout for the keyboard, so on Android Chrome a 360x640 phone with a
    // ~300px keyboard up is a 360x340 viewport: landscape by every one of them, on a phone that never
    // moved. The whole sideways layout then arrived mid-keystroke — on /schedule the rail that holds
    // the autofocused "Why?" box reorders BELOW the calendar as he taps into it.
    //
    // 480 is the separator: an upright phone is ~440px wide at the most (the widest is 440), and the
    // narrowest phone held sideways is 568. Both of those numbers are what the clause is made of, so
    // the arithmetic is asserted rather than described.
    expect(ROOT_LAYOUT).toContain('interactiveWidget: "resizes-content"');
    const floor = Number(/min-width: (\d+)px/.exec(QUERY)![1]);
    for (const uprightWidth of [320, 360, 390, 402, 428, 440]) expect(uprightWidth).toBeLessThan(floor);
    for (const sidewaysWidth of [568, 667, 740, 844, 874, 932]) {
      expect(sidewaysWidth).toBeGreaterThanOrEqual(floor);
    }
  });
});

describe("every selector the sideways rules target is really in the markup", () => {
  const hooks: [string, string, string][] = [
    ["app-topbar", "the top bar", TOPBAR],
    ["app-dock", "the dock — its OWN hook, not the shared marker class", DOCK],
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

describe("in a BROWSER, where the page itself rotates, the chrome still does not change shape", () => {
  // A rotated browser viewport is ~700–930px WIDE, so sm: and md: fire. Every one of them in the top
  // bar's control group has to be undone, or a control changes shape in the one place Erik said
  // nothing may change. (In the App Store app none of this can happen at all: the interface is locked
  // to portrait, the window never changes shape, and the quarter turn is drawn — see
  // chrome-stays-put.test.ts. These rules are the browser's half.)
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

  it("the section handle keeps its edge — `app-bottom-nav` has TWO users, not one", () => {
    // The handle (section-sheet.tsx) is a 36px slab pinned to the left edge, rounded on the RIGHT
    // only and with no left border, because it is drawn to look like part of that edge. It wears
    // `app-bottom-nav` for ONE reason: body.modal-open hides it with the dock. So no rule that MOVES
    // the dock may use that class — unlayered CSS beats the handle's Tailwind `left-0`, and the
    // sideways camera inset shoved it ~59pt into mid-page on every section with more than four pages
    // (Jobs, Office and Money). In a rotated BROWSER tab — which is the world this file is about —
    // every screen rotates, listed or not, so this is not limited to the declared three.
    // The handle's own class list, not the prose around it.
    const handle = /className="(app-bottom-nav[^"]*)"/.exec(SECTION_SHEET)?.[1];
    expect(handle).toBeTruthy();
    expect(handle).toContain("left-0");
    expect(handle).not.toContain("app-dock");
    const turned = turnedBlock();
    // Nothing inside the sideways block may select the class the handle wears.
    expect(turned).not.toMatch(/\.app-bottom-nav\b/);
    // The dock still gets its insets, under a hook only the dock has.
    expect(turned).toMatch(/\.app-dock\s*\{[^}]*env\(safe-area-inset-left/);
    expect(/className="[^"]*\bapp-dock\b[^"]*"/.test(DOCK)).toBe(true);
    // …and the marker still does the one job it was borrowed for.
    expect(CSS).toContain("body.modal-open .app-bottom-nav");
  });

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
    // AND THE ONE THAT ACTUALLY FIRES IN THE APP. The interface is locked to portrait, so turning the
    // phone changes NOTHING about the window: neither of the two above happens. Without this listener
    // the one screen Erik asked for rotation on first — "documents especially" — would turn and keep
    // the portrait-width bitmap, and both of its others would be left behind as well.
    expect(PDF_VIEWER).toContain('window.addEventListener("cn:screen-turned"');
    expect(PDF_VIEWER).toContain('window.removeEventListener("cn:screen-turned"');
    // From the document already in hand, not a second trip to the server.
    expect(PDF_VIEWER).toMatch(/pdfRef\.current/);
    expect(PDF_VIEWER).toMatch(/void paint\(pdf, want\)/);
    // Width only: a keyboard or a browser's own chrome changes the height, and a repaint then would
    // interrupt reading for nothing. The arithmetic itself is tested in lib/pdf-page-width.test.ts.
    expect(PDF_VIEWER).toContain("worthRedrawing(want, turns.current.drawnAtW())");
  });

  it("a rotation never outranks the margin he just tapped", () => {
    // Fetching a new document and redrawing the one in hand are two jobs with two rules, and one
    // shared counter let a rotation cancel the fetch: the Wide bytes landed, the load saw a newer
    // number, returned, and nothing re-ran it. The selector read "Wide · 1 in" over Narrow sheets with
    // no spinner and no error — silent, on a money document. The rules and their trace live in
    // lib/pdf-render-turns.ts, which is where they are tested; this pins the viewer to them.
    expect(PDF_VIEWER).toContain("renderTurns()");
    expect(PDF_VIEWER).toContain("turns.current.startLoad()");
    expect(PDF_VIEWER).toContain("turns.current.startPaint(containerW)");
    // The repaint timer DEFERS while a fetch is in flight instead of fighting it.
    expect(PDF_VIEWER).toContain("turns.current.isLoading()");
    // No counter is shared any more.
    expect(PDF_VIEWER).not.toContain("renderSeq");
  });

  it("…and an interrupted rotation cannot leave the sheets the wrong width", () => {
    // The width is claimed when the page list is emptied, because that is what the screen shows from
    // then on. Recorded at the END instead, a rotation interrupted by a rotation back was invisible to
    // the repaint guard, which declined to redraw and left a 796px sheet in a portrait window.
    expect(PDF_VIEWER).not.toContain("paintedAtW");
    const paintBody = PDF_VIEWER.slice(
      PDF_VIEWER.indexOf("const paint = useCallback"),
      PDF_VIEWER.indexOf("const load = useCallback"),
    );
    expect(paintBody.indexOf("startPaint(containerW)")).toBeLessThan(paintBody.indexOf('host.innerHTML = ""'));
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

describe("the iPhone's interface NEVER rotates; the iPad is untouched", () => {
  const list = (key: string) => {
    const at = PLIST.indexOf(`<key>${key}</key>`);
    expect(at).toBeGreaterThan(-1);
    return PLIST.slice(at, PLIST.indexOf("</array>", at));
  };

  it("the iPhone allows PORTRAIT AND NOTHING ELSE — that is the whole mechanism", () => {
    // cn-v1041 listed both landscapes here and let iOS rotate the view. Erik: "nice it rotates now on
    // schedule but the dock and top bar rotate with it still." Of course they did — iOS rotating the
    // interface is what carries them around. The only way the top bar stays against the phone's top
    // edge and the dock against its bottom edge is for nothing to move at all, so nothing does: the
    // quarter turn is DRAWN, on the region between them, from the word ScreenTurnPlugin reports.
    const phone = list("UISupportedInterfaceOrientations");
    expect(phone).toContain("UIInterfaceOrientationPortrait<");
    expect(phone).not.toContain("UIInterfaceOrientationLandscapeLeft");
    expect(phone).not.toContain("UIInterfaceOrientationLandscapeRight");
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

  it("the view controller says portrait too — both halves have to agree", () => {
    const vc = read("ios/App/App/NorthBridgeViewController.swift");
    expect(vc).toContain("override var supportedInterfaceOrientations");
    // The iPad keeps rotating everywhere; the iPhone is portrait, full stop. No page may change this
    // any more — there is nothing here for one to ask.
    expect(vc).toContain("userInterfaceIdiom == .pad ? .all : .portrait");
    expect(vc).toContain("ScreenTurnPlugin()");
    expect(vc).not.toContain("ScreenTurn.allowed");
    expect(vc).not.toContain("requestGeometryUpdate");
  });

  it("the plugin REPORTS the turn and can no longer permit one", () => {
    const plugin = read("ios/App/App/ScreenTurnPlugin.swift");
    // It reads the DEVICE's orientation, which iOS keeps reporting while the INTERFACE is locked —
    // that is the fact the whole mechanism rests on.
    expect(plugin).toContain("UIDevice.orientationDidChangeNotification");
    expect(plugin).toContain("beginGeneratingDeviceOrientationNotifications");
    expect(plugin).toContain("case .landscapeLeft: return .counterclockwise");
    expect(plugin).toContain("case .landscapeRight: return .clockwise");
    // Upside down is never a turn, and neither is a phone lying flat on a bench.
    expect(plugin).toContain("case .portrait, .portraitUpsideDown: return .upright");
    expect(plugin).toContain("default: return nil");
    // Nothing is left that changes what iOS will do.
    expect(plugin).not.toContain("UIInterfaceOrientationMask");
    expect(plugin).not.toContain('getString("turn")');
    expect(plugin).not.toContain("setNeedsUpdateOfSupportedInterfaceOrientations");
    // THE iPAD IS NEVER REPORTED AS TURNED: its interface really does rotate, so a second turn drawn
    // on top of iOS's one would be the page rotating itself into nonsense.
    expect(plugin).toContain("UIDevice.current.userInterfaceIdiom != .pad");
  });
});
