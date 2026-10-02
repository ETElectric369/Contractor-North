import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dockCoverage, typingInto, whatTheTurnBelongsTo, whichWayToDraw } from "@/components/turns-sideways";
import {
  SCREENS_THAT_TURN,
  faceDrawsTheTurn,
  isARouteOfItsOwn,
  type ScreenThatTurns,
  type TurnedRegion,
} from "@/lib/screens-that-turn";
import { naturalGridWidth } from "@/components/time-grid";
import { faceStyle, placeTheFace, uprightTurn } from "@/lib/turned-geometry";

/**
 * THE CHROME STAYS PUT.
 *
 * Erik, on cn-v1041: "nice it rotates now on schedule but the dock and top bar rotate with it still."
 * What he asked for, twice: "lock the top bar and the dock positions and just rotate the buttons while
 * the internal screen rotates."
 *
 * So the iPhone's interface is portrait-locked and the quarter turn is DRAWN on the region between the
 * chrome. Three of the four things that makes true are only true because of a NAME agreeing across two
 * files — a class in the markup and a selector in the stylesheet, a word in Swift and a word in
 * TypeScript — which is the hand-copied-list hazard in its purest form: rename one and nothing fails,
 * the rotation just quietly stops happening on an orientation nobody tests on a laptop. Each half is
 * asserted against the other here.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const CSS = read("src/app/globals.css");
const TURNED = read("src/components/turned.tsx");
const WATCHER = read("src/components/turns-sideways.tsx");
const GEOMETRY = read("src/lib/turned-geometry.ts");
const TOPBAR = read("src/components/app-shell/topbar.tsx");
const DOCK = read("src/components/app-shell/dock.tsx");
const SHELL = read("src/app/(app)/layout.tsx");
const PDF_VIEWER = read("src/app/print/pdf-preview/viewer.tsx");
const LIGHTBOX = read("src/components/media-lightbox.tsx");
const QUICK_ADD = read("src/components/global-quick-add.tsx");
const BELL = read("src/components/app-shell/notification-bell.tsx");
const ACCOUNT = read("src/components/account-menu.tsx");

/** The full-screen photo/PDF viewer, open — the one declared LAYER there is. Innermost last. */
const VIEWER: readonly ScreenThatTurns[] = ["document-full-screen"];
/** A receipt opened on top of a receipt: two of them, which has to behave like one. */
const TWO_VIEWERS: readonly ScreenThatTurns[] = ["document-full-screen", "document-full-screen"];
const SCREEN_NAMES = Object.keys(SCREENS_THAT_TURN) as ScreenThatTurns[];
/** Every region a <Turned> can declare itself to be. */
const EVERY_REGION: readonly TurnedRegion[] = [...SCREEN_NAMES, "the route", "the chrome"];

// ── WHICH WAY THE SCREEN IS DRAWN, every way in and every way out ──────────────────────────────────

describe("every way of arriving at a turned screen, and every way of leaving one", () => {
  const sideways = { layers: [], overlays: 0, held: "clockwise" as const, typing: false };

  it("the declared screens turn; everything else stays upright", () => {
    for (const path of ["/schedule", "/schedule/2026-10-01", "/print/pdf-preview/invoice/80"]) {
      expect(whichWayToDraw({ ...sideways, pathname: path })).toBe("clockwise");
    }
    // /price-list is in this list now, not the one above — Erik, 2026-10-01: "schedule and documents
    // yes and no on everything else." Why, in lib/screens-that-turn.ts: drawn in the glass between
    // chrome that no longer moves, the 1080px table gets ~658px, against ~858px when iOS rotated
    // everything. This way of turning showed LESS of it than the old way did.
    for (const path of ["/planner", "/timecards", "/jobs/41", "/reconcile", "/price-list", "/price-lists", "/"]) {
      expect(whichWayToDraw({ ...sideways, pathname: path })).toBe("upright");
    }
  });

  it("ARRIVING ALREADY TURNED lands turned — the shell is asked on the way in", () => {
    // A deep link or a hard reload while the phone is sideways fires no change: the phone has not
    // moved. native-orientation.ts asks read() once for exactly this, and the answer arrives here.
    expect(
      whichWayToDraw({ pathname: "/schedule", layers: [], overlays: 0, held: "counterclockwise", typing: false }),
    ).toBe("counterclockwise");
  });

  it("TURNING WHILE THERE turns, and turning back comes back", () => {
    expect(whichWayToDraw({ ...sideways, pathname: "/schedule" })).toBe("clockwise");
    expect(
      whichWayToDraw({ pathname: "/schedule", layers: [], overlays: 0, held: "upright", typing: false }),
    ).toBe("upright");
  });

  it("NAVIGATING AWAY TURNED — and the back gesture — is upright the same frame", () => {
    // Nothing to wait for and nobody to ask: portrait is what the glass is already showing, so walking
    // off /schedule with the phone still sideways cannot strand anyone on a turned layout.
    expect(whichWayToDraw({ ...sideways, pathname: "/planner" })).toBe("upright");
    expect(whichWayToDraw({ ...sideways, pathname: "/jobs" })).toBe("upright");
  });

  it("A FULL-SCREEN VIEWER opens over a screen that does not turn, and closing gives it back", () => {
    const onATallList = { pathname: "/timecards", overlays: 0, held: "clockwise" as const, typing: false };
    expect(whichWayToDraw({ ...onATallList, layers: [] })).toBe("upright");
    expect(whichWayToDraw({ ...onATallList, layers: VIEWER })).toBe("clockwise"); // a receipt, opened
    expect(whichWayToDraw({ ...onATallList, layers: [] })).toBe("upright"); // closed again
  });

  it("…and a viewer closing over a screen that ALREADY turns does not take its turn with it", () => {
    // The whole reason this is one watcher and not a per-screen call: a viewer answering for itself on
    // its way out would un-turn the schedule underneath it.
    const overTheSchedule = { pathname: "/schedule", overlays: 0, held: "clockwise" as const, typing: false };
    expect(whichWayToDraw({ ...overTheSchedule, layers: VIEWER })).toBe("clockwise");
    expect(whichWayToDraw({ ...overTheSchedule, layers: [] })).toBe("clockwise");
  });

  it("TWO viewers open at once: the first to close does not take the second one's turn", () => {
    const base = { pathname: "/planner", overlays: 0, held: "counterclockwise" as const, typing: false };
    expect(whichWayToDraw({ ...base, layers: TWO_VIEWERS })).toBe("counterclockwise");
    expect(whichWayToDraw({ ...base, layers: VIEWER })).toBe("counterclockwise");
    expect(whichWayToDraw({ ...base, layers: [] })).toBe("upright");
  });

  it("DO NOT ROTATE A SCREEN A PERSON IS TYPING ON — the keyboard comes up the other way round", () => {
    // One of the three does have boxes today: /schedule's autofocused "Why?" line. With the interface
    // locked the keyboard rises from the phone's bottom edge — the person's left or right hand side —
    // so typing into a box drawn a quarter turn from it is miserable. The screen comes upright while
    // the box has focus and turns back when it is left.
    //
    // THE RULE IS FOR ALL THREE, not for the one screen that needs it today: a document gains a box the
    // day somebody adds a note to one, and this holds before that happens rather than after.
    const box = { layers: [], overlays: 0, held: "clockwise" as const };
    expect(whichWayToDraw({ ...box, pathname: "/schedule", typing: true })).toBe("upright");
    expect(whichWayToDraw({ ...box, pathname: "/print/pdf-preview/invoice/80", typing: true })).toBe("upright");
    expect(whichWayToDraw({ ...box, layers: VIEWER, pathname: "/jobs/41", typing: true })).toBe("upright");
    expect(whichWayToDraw({ ...box, pathname: "/schedule", typing: false })).toBe("clockwise");
  });
});

// ── WHOSE TURN IT IS: THE ONE REGION THAT DRAWS IT ─────────────────────────────────────────────────

describe("exactly ONE region draws the turn, and it is the one that owns it", () => {
  /**
   * The defect this is here for. "May anything turn" was taken for "so every region may draw it", and
   * the app shell's region (layout.tsx) is an ANCESTOR of the full-screen viewer, which renders in place
   * with `fixed inset-0` and no portal. Opening a job photo or a bill receipt while the phone was
   * sideways therefore turned BOTH faces: the two quarter turns composed into a half turn, the photo
   * read upside down, and because a transformed ancestor becomes the containing block for a `fixed`
   * descendant the viewer was no longer full screen either — the top bar and the dock stayed visible
   * around it and an 800x450 photo drew smaller than it does in portrait.
   */
  const heldSideways = { overlays: 0, held: "clockwise" as const, typing: false };

  it("a photo opened over a job: the VIEWER draws the turn and the page behind it does not", () => {
    // Not one of the four routes — which is every real entry point: a job's photos, a job's documents,
    // the task list, the appointment inspector, a bill's receipt.
    const standing = { ...heldSideways, pathname: "/jobs/41", layers: VIEWER };
    expect(whatTheTurnBelongsTo(standing)).toBe("document-full-screen");
    expect(faceDrawsTheTurn("document-full-screen", whatTheTurnBelongsTo(standing))).toBe(true);
    expect(faceDrawsTheTurn("the route", whatTheTurnBelongsTo(standing))).toBe(false);
  });

  it("a receipt opened over the SCHEDULE: the viewer takes the turn over, and gives it back", () => {
    const over = { ...heldSideways, pathname: "/schedule", layers: VIEWER };
    expect(whatTheTurnBelongsTo(over)).toBe("document-full-screen");
    expect(faceDrawsTheTurn("the route", whatTheTurnBelongsTo(over))).toBe(false);
    // Closed again, the schedule has its own turn back — and now IT is the one that draws it.
    const after = { ...heldSideways, pathname: "/schedule", layers: [] };
    expect(whatTheTurnBelongsTo(after)).toBe("schedule");
    expect(faceDrawsTheTurn("the route", whatTheTurnBelongsTo(after))).toBe(true);
    expect(faceDrawsTheTurn("document-full-screen", whatTheTurnBelongsTo(after))).toBe(false);
  });

  it("two viewers deep, the INNERMOST one draws it — never both", () => {
    const standing = { ...heldSideways, pathname: "/schedule", layers: TWO_VIEWERS };
    expect(whatTheTurnBelongsTo(standing)).toBe("document-full-screen");
    const drawn = EVERY_REGION.filter((r) => r !== "the chrome" && faceDrawsTheTurn(r, whatTheTurnBelongsTo(standing)));
    expect(drawn).toEqual(["document-full-screen"]);
  });

  it("for EVERY owner there is exactly one content region that draws the turn", () => {
    // The property the whole fix rests on: one quarter turn, never two composed into a half.
    for (const owner of [...SCREEN_NAMES, null]) {
      const drawn = EVERY_REGION.filter((r) => r !== "the chrome" && faceDrawsTheTurn(r, owner));
      expect(drawn.length, `owner ${owner ?? "nobody"}`).toBe(owner === null ? 0 : 1);
    }
  });

  it("the declared ROUTES are drawn by the page region; a LAYER is drawn by itself and nothing else", () => {
    for (const name of SCREEN_NAMES) {
      expect(faceDrawsTheTurn("the route", name)).toBe(isARouteOfItsOwn(name));
      // A region named after a screen is a LAYER's region — naming a route there must not make a second
      // face that also draws the turn, which is the whole class of defect being fixed.
      expect(faceDrawsTheTurn(name, name)).toBe(!isARouteOfItsOwn(name));
    }
    expect(isARouteOfItsOwn("document-full-screen")).toBe(false);
  });

  it("the chrome stands up for WHOEVER owns the turn — a button reads upright for the person", () => {
    for (const name of SCREEN_NAMES) expect(faceDrawsTheTurn("the chrome", name)).toBe(true);
    expect(faceDrawsTheTurn("the chrome", null)).toBe(false);
  });

  it("every region that can turn says WHICH region it is — the prop is not optional", () => {
    // A <Turned> with no region would fall back to some default, and a default is how the app shell's
    // region ended up drawing a turn that belonged to the viewer inside it.
    expect(TURNED).toContain("region: TurnedRegion");
    expect(TURNED).toContain("faceDrawsTheTurn(region, owns)");
    expect(SHELL).toContain('<Turned region="the route" avoidDock>');
    expect(PDF_VIEWER).toContain('<Turned region="the route">');
    expect(LIGHTBOX).toContain('<Turned region="document-full-screen">');
    expect(DOCK).toContain('<Turned region="the chrome">');
    // The viewer's region is the same declared name it registered itself under.
    expect(LIGHTBOX).toContain('useTurnsSidewaysLayer("document-full-screen")');
  });

  it("and a face inside an already-turned face refuses, so a mistake can never compose", () => {
    // The floor under the rule above: one quarter turn or none, never two.
    expect(TURNED).toContain("const AlreadyTurned = createContext(false)");
    expect(TURNED).toContain("!insideATurnedFace");
    expect(TURNED).toContain("<AlreadyTurned.Provider value={true}>");
    // Same belt on the chrome's own rule, which is a document-wide descendant selector.
    expect(CSS).toMatch(
      /html\[data-phone-held\] \.turn-face\[data-held\] \[data-upright\] \{\s*transform: none;\s*\}/,
    );
  });
});

// ── A SHEET OVER THE PAGE AND A TURNED PAGE CANNOT BOTH BE RIGHT ──────────────────────────────────

describe("a sheet opened over a turned screen brings it upright instead of landing in a corner", () => {
  /**
   * A turned region is painted through a transform, and a transform makes its element the containing
   * block for every `position: fixed` descendant. Modal renders IN PLACE by default, so its overlay —
   * which on iOS is given the visual viewport's portrait rect, 402 x 874 — was being interpreted inside a
   * 684 x 402 rotated box: a sliver against one physical edge with Cancel and Save off the glass. No
   * transform can avoid that, so the rule is that the page comes upright while a sheet is open.
   */
  const onATurnedSchedule = { pathname: "/schedule", layers: [], held: "clockwise" as const, typing: false };

  it("a sheet open over /schedule or a document: upright, with its keyboard the same way up", () => {
    expect(whichWayToDraw({ ...onATurnedSchedule, overlays: 1 })).toBe("upright");
    expect(whatTheTurnBelongsTo({ ...onATurnedSchedule, overlays: 1 })).toBeNull();
    expect(
      whichWayToDraw({ ...onATurnedSchedule, pathname: "/print/pdf-preview/invoice/80", overlays: 1 }),
    ).toBe("upright");
    // Closing it turns the screen back — nothing is stuck, and nothing had to remember anything.
    expect(whichWayToDraw({ ...onATurnedSchedule, overlays: 0 })).toBe("clockwise");
  });

  it("…and it does NOT depend on a field being focused, which is what left the sheet in the corner", () => {
    // The sheets on the schedule (the tile sheet, Add To Schedule, Time Off) carry no autoFocus, so
    // `typing` was false and the screen stayed turned the whole time
    // the sheet was open. And where a field WAS focused, tapping Done on the keyboard turned the screen
    // back under an open sheet, mid-use.
    expect(whichWayToDraw({ ...onATurnedSchedule, overlays: 1, typing: false })).toBe("upright");
    expect(whichWayToDraw({ ...onATurnedSchedule, overlays: 1, typing: true })).toBe("upright");
  });

  it("but the VIEWER keeps its turn — it declared itself a layer, so it is not a sheet", () => {
    // The viewer holds the same shared body lock every sheet does, so the count alone cannot tell them
    // apart. The declared layers are what does: one overlay, one layer → no sheet.
    const viewerOpen = { pathname: "/jobs/41", layers: VIEWER, overlays: 1, held: "clockwise" as const, typing: false };
    expect(whichWayToDraw(viewerOpen)).toBe("clockwise");
    expect(whatTheTurnBelongsTo(viewerOpen)).toBe("document-full-screen");
    // Two viewers, two locks, still no sheet.
    expect(whichWayToDraw({ ...viewerOpen, layers: TWO_VIEWERS, overlays: 2 })).toBe("clockwise");
    // A sheet opened ON TOP of the viewer is a sheet: one more overlay than there are layers.
    expect(whichWayToDraw({ ...viewerOpen, overlays: 2 })).toBe("upright");
  });

  it("the count comes from the ONE shared body lock, not a second list of overlays", () => {
    const LOCK = read("src/components/ui/modal-lock.ts");
    expect(LOCK).toContain("export function overlaysOpen");
    expect(LOCK).toContain("export function watchOverlays");
    // Both ends of the count tell the watchers, or a sheet that closed would hold the screen upright.
    expect(LOCK.slice(LOCK.indexOf("export function lockBodyForModal"))).toContain("tellTheWatchers()");
    expect(LOCK.slice(LOCK.indexOf("export function unlockBodyForModal"))).toContain("tellTheWatchers()");
    expect(WATCHER).toContain("watchOverlays");
    expect(WATCHER).toContain("overlaysOpen()");
    // Modal — the sheet this is about — is on that lock already, and still renders in place.
    expect(read("src/components/ui/modal.tsx")).toContain("lockBodyForModal()");
  });

  it("and an overlay that cannot take the body lock is still counted as a sheet", () => {
    // The section sheet renders INSIDE the app shell's turned region (the layout mounts SectionSubnav
    // there) and its scrim and panel are both `position: fixed`, so sideways they would be laid out
    // against the rotated box and land in a corner. It cannot use useModalLock: `modal-open` is exactly
    // what its own Escape handler stands down for, and it hides its own edge handle. So it says it
    // covers the screen, and the one count reports both.
    const LOCK = read("src/components/ui/modal-lock.ts");
    expect(LOCK).toContain("export function useCoversTheScreen");
    expect(LOCK).toContain("return openCount + coveringCount;");
    const SHEET = read("src/components/section-sheet.tsx");
    expect(SHEET).toContain("useCoversTheScreen(open)");
    // The prose explaining why it does not take the lock must not be read as taking it.
    expect(withoutComments(SHEET)).not.toContain("useModalLock");
    // Its scrim really is the shape this is about.
    expect(SHEET).toMatch(/fixed inset-0 z-\[100\]/);
  });
});

describe("what counts as typing", () => {
  const el = (tag: string, props: Record<string, unknown> = {}) =>
    ({ tagName: tag.toUpperCase(), ...props }) as unknown as Element;

  it("a text box, a number box, a search box, a textarea, a rich-text area — all typing", () => {
    for (const type of ["text", "search", "number", "email", "tel", "url", "password", "date", "time"]) {
      expect(typingInto(el("input", { type }))).toBe(true);
    }
    expect(typingInto(el("input", {}))).toBe(true); // an <input> with no type IS a text box
    expect(typingInto(el("textarea"))).toBe(true);
    expect(typingInto(el("div", { isContentEditable: true }))).toBe(true);
  });

  it("a checkbox, a radio, a file picker, a slider, a button — NOT typing", () => {
    // iOS draws these in its own sheet or needs no keyboard at all. Un-turning the screen for a tapped
    // checkbox would make a tick on the schedule throw the whole page a quarter turn.
    for (const type of ["checkbox", "radio", "button", "submit", "reset", "file", "range", "color"]) {
      expect(typingInto(el("input", { type }))).toBe(false);
    }
    expect(typingInto(el("select"))).toBe(false);
    expect(typingInto(el("button"))).toBe(false);
    expect(typingInto(el("a"))).toBe(false);
    expect(typingInto(null)).toBe(false);
  });

  it("moving from one box to the next does not turn the screen between two keystrokes", () => {
    // focusout and focusin are two separate events, so reading focusout as a plain "stopped typing"
    // would un-type for a frame and throw the screen a quarter turn in the middle of filling a row in.
    // The watcher reads where focus is LANDING instead.
    expect(WATCHER).toContain("typingInto(e.relatedTarget as Element | null)");
    expect(WATCHER).not.toContain("const off = () => setTyping(false)");
  });
});

describe("the dock is MEASURED, never a number copied out of dock.tsx", () => {
  it("how much of the middle the dock covers is the viewport less where the dock starts", () => {
    // 874-tall phone, a 59px dock sitting 8px off the bottom → its top edge is at 807, so it covers 67.
    expect(dockCoverage(807, 874)).toBe(67);
    expect(dockCoverage(0, 874)).toBe(874);
  });

  it("no dock on the screen (a document, a desktop window) reserves nothing", () => {
    expect(dockCoverage(null, 874)).toBe(0);
  });

  it("a dock measured BELOW the bottom of the window reserves nothing, never a negative", () => {
    expect(dockCoverage(900, 874)).toBe(0);
    expect(dockCoverage(Number.NaN, 874)).toBe(0);
  });

  it("the watcher reads the dock's own hook, and the shell draws that hook", () => {
    expect(WATCHER).toContain('document.querySelector(".app-dock")');
    expect(DOCK).toMatch(/className="[^"]*\bapp-dock\b/);
    // A dock hidden behind a modal has no height and must not be reserved against.
    expect(WATCHER).toContain("if (box.height === 0) return 0");
  });

  it("and the measurement FOLLOWS THE DOCK, not only the direction the screen is drawn", () => {
    // The 0 above is the honest answer while the dock is hidden (body.modal-open gives it
    // `display: none`) — but published only when the drawn direction changed, that 0 outlived the thing
    // that made it true. Turn the phone while a sheet is up, close the sheet, and about 67px of the
    // turned page's edge stayed drawn under the glass dock until the route or the direction happened to
    // change. So the measurement is re-published whenever the DOCK's own box changes.
    const observers = WATCHER.match(/new ResizeObserver\(/g) ?? [];
    expect(observers.length).toBeGreaterThan(0);
    const at = WATCHER.indexOf("THE DOCK IS RE-MEASURED");
    expect(at).toBeGreaterThan(-1);
    const rule = WATCHER.slice(at);
    expect(rule).toContain('document.querySelector(".app-dock")');
    expect(rule).toContain("new ResizeObserver(again)");
    expect(rule).toContain("bottomChrome: measureTheDock()");
    // It is not enough to re-measure the HOST: the dock floats over it, so the dock changing size never
    // changes the host's box and <Turned>'s own observer never fires.
    expect(read("src/components/turned.tsx")).not.toContain("measureTheDock");
  });
});

// ── AND THE WEEK ACTUALLY FITS, which is the whole warrant for turning the phone on /schedule ──────

describe("turned sideways, the whole week is on screen — not still scrolling sideways", () => {
  /**
   * The warrant in lib/screens-that-turn.ts promises: "Portrait shows three and scrolls sideways for the
   * rest; sideways the whole week is on screen at once." It did not. The seven-day grid asked for 48px of
   * hour gutter plus 7 readable columns = 692px, and the turned box on Erik's phone gives the week's
   * scroller about 656 — so it still scrolled sideways and still clipped Sunday, and the one screen he
   * reported from did not deliver the thing it was put on the list for.
   */
  /** Erik's phone, turned: the face is ~684 wide, less 0.75rem of face padding each side and the Card's
   *  two 1px borders — the room the week's own scroller gets. */
  const ROOM_TURNED = 684 - 24 - 2;

  it("a seven-day week wants more than the turned box has — that is the whole problem", () => {
    expect(naturalGridWidth(7)).toBe(692);
    expect(naturalGridWidth(7)).toBeGreaterThan(ROOM_TURNED);
  });

  it("so inside a turned face it is capped at the room there is, and nothing scrolls sideways", () => {
    // What the CSS does, in arithmetic: min(what it wants, the room). 658 of 658 fits exactly, and the
    // columns come out at (658 - 48) / 7 ≈ 87px — five under the portrait minimum, with Sunday on screen.
    const laidOutAt = Math.min(naturalGridWidth(7), ROOM_TURNED);
    expect(laidOutAt).toBe(ROOM_TURNED);
    expect(laidOutAt).toBeLessThanOrEqual(ROOM_TURNED); // ⇒ scrollWidth ≤ clientWidth: no sideways scroll
    expect(Math.floor((laidOutAt - 48) / 7)).toBeGreaterThanOrEqual(80);
  });

  it("and the stylesheet really is that min(), scoped to a turned face only", () => {
    // Upright this must NOT apply: a 370px portrait phone would squeeze seven columns to 46px each,
    // which is the layout the sideways scroll exists to avoid.
    expect(CSS).toMatch(
      /\.turn-face\[data-held\] \.time-grid-columns \{\s*min-width: min\(var\(--grid-natural-w, 0px\), 100%\);\s*\}/,
    );
    expect(CSS).toMatch(/\n\.time-grid-columns \{\s*min-width: var\(--grid-natural-w, 0px\);\s*\}/);
  });

  it("the class and the number both come from the grid, and the width is no longer inline", () => {
    // An inline min-width cannot be capped by a stylesheet without `!important`, so the grid hands over
    // its one arithmetic as a custom property instead. The number still lives in exactly one place.
    const GRID = read("src/components/time-grid.tsx");
    expect(GRID).toContain('className="time-grid-columns"');
    expect(GRID).toContain('"--grid-natural-w": `${naturalGridWidth(days.length)}px`');
    expect(GRID).not.toMatch(/minWidth:\s*days\.length/);
    expect(GRID).toContain("export function naturalGridWidth");
    // The day view needs no minimum at all — it already fits.
    expect(naturalGridWidth(1)).toBe(0);
  });
});

// ── A DOCUMENT KEEPS HIS PLACE ACROSS THE TURN ────────────────────────────────────────────────────

describe("turning the phone on page 5 of an invoice does not send him back to page 1", () => {
  /**
   * The repaint has kept his place since it was written — but the turn CHANGES WHICH ELEMENT SCROLLS
   * (the box upright, the quarter-turned face inside it once turned), and by the time the repaint ran the
   * old scroller's content was gone (scrollTop forced to 0) and the new one had not been scrolled. So the
   * fraction read at the top of the repaint was 0 every single time, and `if (was > 0)` meant the restore
   * never ran: page 1, every turn, silently.
   */
  it("the fraction is REMEMBERED as he scrolls, not read when the repaint starts", () => {
    expect(PDF_VIEWER).toContain("const placeKept = useRef(0)");
    expect(PDF_VIEWER).toContain("const was = placeKept.current");
    // The old shape — reading the scroller at paint time — is gone.
    expect(PDF_VIEWER).not.toMatch(/const was =\s*\n?\s*scroller && scroller\.scrollHeight/);
  });

  it("…from whichever element is scrolling, which is why the listener captures", () => {
    // A `scroll` event does not bubble, so a listener on the box only hears the box. Capture hears the
    // quarter-turned face inside it too, which is the element that scrolls once the phone is turned.
    expect(PDF_VIEWER).toContain('box.addEventListener("scroll", remember, true)');
    expect(PDF_VIEWER).toContain('box.removeEventListener("scroll", remember, true)');
    // And an empty list's scroll-to-0 during a repaint is not a place he chose.
    expect(PDF_VIEWER).toContain("if (repainting.current) return");
    expect(PDF_VIEWER).toContain("repainting.current = true");
  });

  it("and it is written back onto whichever element is scrolling AFTER the paint", () => {
    // Resolved before the awaits, the element can have stopped being the scroller by the time the last
    // page lands — and a scrollTop written to a box that is not scrolling is silently a no-op.
    const paint = PDF_VIEWER.slice(PDF_VIEWER.indexOf("const paint = useCallback"));
    const restore = paint.indexOf("scroller.scrollTop = was * scroller.scrollHeight");
    expect(restore).toBeGreaterThan(-1);
    const resolve = paint.lastIndexOf("const scroller = theScroller(scrollRef.current)", restore);
    expect(resolve).toBeGreaterThan(-1);
    // The resolve sits with the restore at the END of the paint, not up at the top with the measurement.
    expect(paint.slice(resolve, restore)).not.toContain("host.innerHTML");
    expect(PDF_VIEWER).toContain("function theScroller");
  });
});

// ── THE GEOMETRY ACTUALLY REACHES THE ELEMENT ─────────────────────────────────────────────────────

describe("the content gets the swapped dimensions, and the element really wears them", () => {
  it("the inline style a turned region gets is the swapped box, pinned by its centre", () => {
    // Erik's phone: 402 wide, the middle 751 tall, 67 of it under the dock. The page is laid out at
    // 684 x 402 and painted a quarter turn into the 402 x 684 of glass.
    const style = faceStyle(placeTheFace({ width: 402, height: 751 }, "clockwise", 67));
    expect(style).toEqual({
      width: "684px",
      height: "402px",
      left: "201px",
      top: "342px",
      transform: "translate(-50%, -50%) rotate(-90deg)",
      "--turn-w": "684px",
      "--turn-h": "402px",
    });
  });

  it("the two rules that ask the WINDOW instead of their container are told the box's own size", () => {
    // A media query inside the turned box is still answered by the window — 402 x 874, however the
    // phone is held. Below `lg` the schedule's rail stacks ABOVE the calendar, so without this,
    // turning the phone to see the week lands on "Waiting For A Day"; and the week stack's 70dvh is
    // 612px inside a 402px room, which makes the box scroll as well — two scrollers for one list.
    expect(CSS).toContain(".turn-face[data-held] .schedule-split > aside");
    const order = CSS.slice(CSS.indexOf(".turn-face[data-held] .schedule-split > aside"));
    expect(order.slice(0, order.indexOf("}"))).toContain("order: 1");
    expect(CSS).toMatch(/\.turn-face\[data-held\] \.cal-stack \{\s*max-height: calc\(var\(--turn-h/);
    // The var the rule reads is the one the face is given.
    expect(faceStyle(placeTheFace({ width: 402, height: 751 }, "clockwise", 67))["--turn-h"]).toBe("402px");
    // Both hooks really exist in the markup they steer.
    expect(read("src/app/(app)/schedule/page.tsx")).toContain("schedule-split");
    expect(read("src/app/(app)/calendar/calendar-view.tsx")).toContain("cal-stack");
  });

  it("<Turned> places the face from that one function and nothing else", () => {
    // If the component ever worked its own numbers out, the arithmetic above would stop being the
    // arithmetic the phone uses.
    expect(TURNED).toContain("placeTheFace(box, held, reserve)");
    expect(TURNED).toContain("faceStyle(place)");
    expect(TURNED).not.toMatch(/rotate\(\$\{/);
    // MEASURED off the real host, not from a phone's dimensions.
    expect(TURNED).toContain("host.clientWidth");
    expect(TURNED).toContain("host.clientHeight");
    expect(TURNED).toContain("new ResizeObserver(measure)");
  });

  it("upright it has NO BOX — so no screen's layout changes at all", () => {
    // `display: contents` is the whole reason this is safe to put in the root of the app shell: with the
    // phone upright the wrapper is not in the layout, and every screen renders what it renders today.
    expect(CSS).toMatch(/\.turn-face \{\s*display: contents;\s*\}/);
    // The upright return is a bare `turn-face` div: no data-held, so the CSS above applies, and no inline
    // style, so there is no box and nothing to position against.
    const upright = TURNED.slice(TURNED.indexOf("if (!turned)"), TURNED.indexOf("\n  return ("));
    expect(upright).toContain('<div ref={face} className="turn-face">{children}</div>');
    expect(upright).not.toContain("data-held");
    expect(upright).not.toContain("style=");
  });

  it("the host becomes the frame, and only while a face inside it is turned", () => {
    expect(CSS).toContain("main.turn-host:has(> .turn-face[data-held])");
    // Every host in the markup carries the hook, and every hook in the CSS has a host in the markup.
    for (const [src, what] of [
      [SHELL, "the scrolling middle of the app shell"],
      [PDF_VIEWER, "the document preview's sheets"],
      [LIGHTBOX, "the full-screen photo/PDF viewer"],
      [DOCK, "a dock tile"],
    ] as [string, string][]) {
      expect(src, what).toContain("turn-host");
      expect(src, what).toContain("<Turned");
    }
  });

  it("the three content regions give their padding to the turned box and clip the rest", () => {
    // NAMED ONE BY ONE, not as a bare `.turn-host`. `position` is a REPLACEMENT, not an addition: a
    // blanket rule would undo the positioning of a host that had its own, and a host whose height came
    // from top/bottom would collapse to nothing the frame the phone was turned. (Found by building the
    // rules into a 402x874 harness and turning it: an absolutely-positioned host measured 0 tall.)
    const at = CSS.indexOf("main.turn-host:has(> .turn-face[data-held]),");
    expect(at).toBeGreaterThan(-1);
    const rule = CSS.slice(at, CSS.indexOf("}", at));
    for (const host of [".pdf-pages-scroll.turn-host", ".media-lightbox-body.turn-host"]) {
      expect(rule).toContain(host);
    }
    expect(rule).toContain("position: relative;");
    expect(rule).toContain("padding: 0;");
    expect(rule).toContain("overflow: hidden;");
    expect(CSS).not.toMatch(/^\.turn-host:has\([^)]*\)\s*\{/m);
  });
});

// ── THE CHROME IS NOT TRANSFORMED ─────────────────────────────────────────────────────────────────

describe("the chrome itself is never transformed — only the faces of its controls", () => {
  it("no rule turns the top bar, the dock, or anything they are inside", () => {
    // THE point. If a rule reached `.app-topbar` or `.app-dock` the bar would travel with the content,
    // which is exactly what he reported. And a transform on either would make it the containing block
    // for its position:fixed descendants — the cn-v344 regression that trapped Nort's panel.
    expect(turnedRules()).not.toMatch(/\.app-topbar\b/);
    expect(turnedRules()).not.toMatch(/\.app-dock\b/);
    expect(turnedRules()).not.toMatch(/\.app-bottom-nav\b/);
    // The only transforms in the whole block are the ONE quarter turn, the origin it turns about, and an
    // explicit `none` that takes a second turn back off (the belt on the chrome's document-wide rule).
    // Anything else — a hand-written rotate, a translate, a scale — is a second spelling of the turn.
    const transforms = turnedRules().match(/^\s*transform(-origin)?:.*$/gm) ?? [];
    expect(transforms.length).toBeGreaterThan(0);
    for (const line of transforms) {
      expect(line).toMatch(/rotate\(var\(--turn-deg, 0deg\)\);$|transform-origin|transform: none;$/);
    }
  });

  it("the top bar's own element carries no marker — the marker is on each button", () => {
    const header = withoutComments(TOPBAR).split("\n").find((l) => l.includes('className="app-topbar'));
    expect(header).toBeTruthy();
    expect(header).not.toContain("data-upright");
    const nav = withoutComments(DOCK).split("\n").find((l) => l.includes('className="app-dock'));
    expect(nav).toBeTruthy();
    expect(nav).not.toContain("data-upright");
  });

  it("EVERY marked control is a 44px SQUARE — a quarter turn must not change a tap target", () => {
    // The shortcut only holds for a square: turning a 140 x 34 pill would paint it 34 x 140 and spill
    // out of a bar that is 44 tall. A control that is not square gets the swapped-box treatment (the
    // dock's tiles) or is left alone (a filename, a company logo) — never this.
    for (const [src, where] of [
      [TOPBAR, "the top bar"],
      [QUICK_ADD, "the + button"],
      [BELL, "the bell"],
      [ACCOUNT, "the account avatar"],
      [LIGHTBOX, "the full-screen viewer's bar"],
    ] as [string, string][]) {
      const marked = openingTagsWith(src, "data-upright");
      expect(marked.length, `${where} has a marked control`).toBeGreaterThan(0);
      for (const tag of marked) expect(tag, `${where}: ${tag.slice(0, 60)}`).toContain("h-11 w-11");
    }
  });

  it("the marker is on a BUTTON or a LINK, never on a wrapper that holds a floating panel", () => {
    // Nort's panel, the notification list, the account menu and the + menu are all position:fixed and
    // all SIBLINGS of their trigger. A marker one level up would make the trigger's parent their
    // containing block and trap them inside the bar.
    for (const src of [TOPBAR, QUICK_ADD, BELL, ACCOUNT, LIGHTBOX]) {
      for (const tag of openingTagsWith(src, "data-upright")) {
        expect(tag).toMatch(/^<(button|a)\b/);
      }
    }
  });

  it("…and the number of marked controls is the number of controls in the top bar", () => {
    // Six doors on the phone's bar: Back, Search Or Ask, Nort (two states, one button), +, the bell and
    // the account avatar. Five of them live in these four files; the sixth is Nort's other state.
    expect(openingTagsWith(TOPBAR, "data-upright").length).toBe(4); // Back, Search, Stop Nort, Talk To Nort
    expect(openingTagsWith(QUICK_ADD, "data-upright").length).toBe(1);
    expect(openingTagsWith(BELL, "data-upright").length).toBe(1);
    expect(openingTagsWith(ACCOUNT, "data-upright").length).toBe(1);
    expect(openingTagsWith(LIGHTBOX, "data-upright").length).toBe(3); // Open, Download, Close
  });
});

describe("THE BUTTONS READ UPRIGHT — one number, written in one place", () => {
  it("the stylesheet paints a marked control through --turn-deg", () => {
    expect(CSS).toMatch(
      /html\[data-phone-held\] \[data-upright\] \{\s*transform: rotate\(var\(--turn-deg, 0deg\)\);\s*\}/,
    );
  });

  it("--turn-deg is written ONLY by the watcher, and only from uprightTurn()", () => {
    // Two spellings of the same quarter turn — one for the content, one for the chrome — would be two
    // things to get out of step, and the one that drifted would be the one nobody is looking at.
    expect(WATCHER).toContain('root.style.setProperty("--turn-deg", uprightTurn(now))');
    expect(WATCHER).toContain('root.style.removeProperty("--turn-deg")');
    expect(GEOMETRY).toContain("export function uprightTurn");
    for (const src of [TOPBAR, DOCK, TURNED, CSS.replace(/var\(--turn-deg, 0deg\)/g, "")]) {
      expect(src).not.toContain("setProperty(\"--turn-deg\"");
    }
    expect(uprightTurn("clockwise")).toBe("-90deg");
  });

  it("the attribute that the rule keys on is set and cleared in the same place", () => {
    expect(WATCHER).toContain("root.dataset.phoneHeld = now");
    expect(WATCHER).toContain("delete root.dataset.phoneHeld");
  });

  it("a dock tile is NOT square, so its face gets the swapped box instead of the shortcut", () => {
    expect(DOCK).toContain("dock-tile");
    expect(DOCK).not.toContain("data-upright");
    expect(CSS).toContain("html[data-phone-held] .dock-tile > .turn-face[data-held]");
    // Icon over label, in the face's own frame — which is the frame the person is reading in.
    const rule = CSS.slice(CSS.indexOf("html[data-phone-held] .dock-tile > .turn-face[data-held]"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("flex-direction: column");
    // And the dock keeps the height it has upright, so the bar itself does not change size when the
    // face leaves the flow — otherwise the thing that must not move would move by 3px every turn.
    const tileHost = CSS.slice(CSS.indexOf("html[data-phone-held] .dock-tile {"));
    expect(tileHost.slice(0, tileHost.indexOf("}"))).toContain("min-height: 2.9375rem;");
  });
});

// ── THE FLOATING PANELS: SIDEWAYS IS A COST HE TOOK; A CORNER IS NOT ──────────────────────────────

/**
 * WHAT WAS AUDITED, AND WHAT THE TWO HONEST OUTCOMES ARE.
 *
 * Every panel a person can reach from a turned screen is drawn in the phone's own portrait glass,
 * because the chrome never moves — so it reads a quarter turn wrong to someone holding the phone
 * sideways. Erik saw that called out and went ahead on the schedule and the documents anyway. An ugly
 * panel is a cost he accepted.
 *
 * A panel laid out against the ROTATED BOX is a different thing entirely, and is not a cost anybody
 * accepted: `position: fixed` inside a transformed ancestor resolves against that ancestor, so a
 * full-screen sheet rendered inside the turned face becomes a sliver hugging one physical edge with its
 * Cancel and Save off the glass. That is a dead end, and the two rules below are what stop it:
 *   · a sheet takes the shared body lock (or says useCoversTheScreen), and the page comes upright
 *     while it is open — so the sheet is laid out against the window, where it belongs;
 *   · the chrome's own menus are siblings of their trigger, outside the face, pinned to the viewport.
 *
 * SO THE TRIPWIRE IS ON THE THIRD CASE: a page on a turning screen growing its own `position: fixed`
 * overlay that declares neither. There is none today. The day somebody adds one, this is what tells
 * them which of the two doors to use, instead of a person finding a sliver in a corner.
 */
describe("nothing on a turning screen may float without declaring itself", () => {
  /** The screens whose own content is drawn INSIDE the rotated box, and the viewer that draws its own. */
  const TURNING_TREES = [
    "src/app/(app)/schedule",
    "src/app/print/pdf-preview",
    "src/components/media-lightbox.tsx",
    "src/components/time-grid.tsx",
    "src/app/(app)/calendar/calendar-view.tsx",
  ];

  const everyFile = (p: string): string[] => {
    const full = join(process.cwd(), p);
    if (!statSync(full).isDirectory()) return [p];
    return readdirSync(full, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? everyFile(join(p, e.name)) : /\.tsx$/.test(e.name) ? [join(p, e.name)] : [],
    );
  };

  it("every fixed overlay on one of them either locks the page upright or covers the screen", () => {
    const floating: string[] = [];
    for (const tree of TURNING_TREES) {
      for (const file of everyFile(tree)) {
        const src = withoutComments(read(file));
        const fixed = /className="[^"]*\bfixed\b|position: "fixed"/.test(src);
        if (!fixed) continue;
        // Either it holds the lock itself, or it IS the shared Modal (which holds it for every caller).
        const declares = /useModalLock|useCoversTheScreen|lockBodyForModal/.test(src);
        if (!declares) floating.push(file);
      }
    }
    // The full-screen viewer is the one file here with a fixed overlay, and it holds the lock.
    expect(floating).toEqual([]);
  });

  it("…and the one that does float declares it, which is why it is not in a corner", () => {
    // Belt on the test above: if the detector ever stops finding anything at all it would pass empty.
    expect(LIGHTBOX).toMatch(/className="media-lightbox fixed inset-0/);
    expect(LIGHTBOX).toContain("useModalLock(true)");
  });

  it("a TOAST is inside the turned region, so it is the one panel that reads upright", () => {
    // Not an accident worth losing: ToastProvider wraps the page INSIDE <Turned>, so a toast's `fixed`
    // resolves against the face and it is painted through the same quarter turn as the page — upright
    // for the person, centred across their view. Every other panel in the app is in the glass.
    const face = SHELL.slice(SHELL.indexOf("<Turned"), SHELL.indexOf("</Turned>"));
    expect(face).toContain("<ToastProvider>");
  });

  it("NORT'S PANEL KEEPS ITS OWN TURN, so the two buttons on it have to be real 44px targets", () => {
    // Nort's panel is one of the few things that does NOT bring the page upright — it holds no body lock
    // and it is pinned to the viewport, outside the face — so a person on a sideways schedule gets the
    // panel a quarter turn round, and aims at its Collapse and Close. They were 24px squares (`p-1`
    // around a 16px glyph), which is under the rule in EVERY orientation; a quarter turn leaves a square
    // a square, so this was never "the turn shrank it", it was always short. Now they set the handle's
    // height instead of being padded inside it.
    const panel = read("src/components/global-assistant.tsx");
    for (const label of ["Collapse", "Close assistant"]) {
      const at = panel.indexOf(`aria-label=${label === "Collapse" ? "{collapsed" : `"${label}"`}`);
      expect(at, label).toBeGreaterThan(-1);
      // The className that goes with that button, read from the tag it is in.
      const tag = panel.slice(panel.lastIndexOf("<button", at), panel.indexOf(">", panel.indexOf("className", at)));
      expect(tag, label).toContain("h-11 w-11");
      expect(tag, label).not.toMatch(/\bp-1\b/);
    }
  });

  it("the section sheet covers the screen, so the strip's own sheet is never laid out in the box", () => {
    // It renders inside the turned region (the layout mounts SectionSubnav there) and its scrim and
    // sheet are both `fixed` — the exact shape that lands in a corner. It cannot take the body lock
    // (`modal-open` is what its Escape handler stands down for), so it says the other thing.
    expect(read("src/components/section-sheet.tsx")).toContain("useCoversTheScreen(open)");
  });
});

describe("a browser is left alone", () => {
  it("nothing turns where there is no shell to report a turn", () => {
    // A tab (and an installed web app) rotates natively and always did. There is no plugin there, so
    // the watcher is never told anything, data-phone-held is never set, and the `turned:` rules are what
    // keep the chrome where it belongs in the rotated viewport. If BOTH fired, a rotated tab would be
    // drawn through a second quarter turn on top of the browser's own.
    expect(read("src/lib/native-orientation.ts")).toContain("isNativeShell()");
    expect(CSS).toContain("@custom-variant turned");
    // The two worlds key off different things, so they cannot both apply.
    expect(CSS).toContain("html[data-phone-held]");
    expect(CSS).not.toContain("html[data-phone-held] .turned");
  });
});

/** The prose explaining a rule must never be read as the rule. Every one of these files EXPLAINS the
 *  marker in a comment as well as carrying it, so a scan that counts comments finds twice as many. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

/** The sideways rules themselves, bounded at both ends: `.app-bottom-nav` has rules further down the
 *  stylesheet and a slice that ran to the end of the file would read them as these. */
function turnedRules(): string {
  const from = CSS.indexOf("THE PHONE IS TURNED, THE CHROME IS NOT");
  const to = CSS.indexOf("The iOS shell (Capacitor WKWebView", from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return CSS.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The JSX opening tags that carry an attribute. Walks back to the `<` that starts the tag and forward
 * to the `>` that closes it, counting braces so an arrow function inside an `onClick` is not mistaken
 * for the end of the tag — which is exactly the shape every one of these buttons has.
 */
function openingTagsWith(source: string, attr: string): string[] {
  const src = withoutComments(source);
  const found: string[] = [];
  for (let at = src.indexOf(attr); at >= 0; at = src.indexOf(attr, at + 1)) {
    let start = at;
    while (start > 0 && !(src[start] === "<" && /[A-Za-z]/.test(src[start + 1] ?? ""))) start--;
    if (src[start] !== "<") continue;
    let depth = 0;
    let end = start;
    for (; end < src.length; end++) {
      const c = src[end];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    found.push(src.slice(start, end + 1));
  }
  return found;
}
