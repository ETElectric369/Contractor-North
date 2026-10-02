import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dockCoverage, typingInto, whichWayToDraw } from "@/components/turns-sideways";
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

// ── WHICH WAY THE SCREEN IS DRAWN, every way in and every way out ──────────────────────────────────

describe("every way of arriving at a turned screen, and every way of leaving one", () => {
  const sideways = { layers: 0, held: "clockwise" as const, typing: false };

  it("the four declared screens turn; everything else stays upright", () => {
    for (const path of ["/schedule", "/schedule/2026-10-01", "/price-list", "/print/pdf-preview/invoice/80"]) {
      expect(whichWayToDraw({ ...sideways, pathname: path })).toBe("clockwise");
    }
    for (const path of ["/planner", "/timecards", "/jobs/41", "/reconcile", "/price-lists", "/"]) {
      expect(whichWayToDraw({ ...sideways, pathname: path })).toBe("upright");
    }
  });

  it("ARRIVING ALREADY TURNED lands turned — the shell is asked on the way in", () => {
    // A deep link or a hard reload while the phone is sideways fires no change: the phone has not
    // moved. native-orientation.ts asks read() once for exactly this, and the answer arrives here.
    expect(whichWayToDraw({ pathname: "/schedule", layers: 0, held: "counterclockwise", typing: false })).toBe(
      "counterclockwise",
    );
  });

  it("TURNING WHILE THERE turns, and turning back comes back", () => {
    expect(whichWayToDraw({ ...sideways, pathname: "/price-list" })).toBe("clockwise");
    expect(whichWayToDraw({ pathname: "/price-list", layers: 0, held: "upright", typing: false })).toBe("upright");
  });

  it("NAVIGATING AWAY TURNED — and the back gesture — is upright the same frame", () => {
    // Nothing to wait for and nobody to ask: portrait is what the glass is already showing, so walking
    // off /schedule with the phone still sideways cannot strand anyone on a turned layout.
    expect(whichWayToDraw({ ...sideways, pathname: "/planner" })).toBe("upright");
    expect(whichWayToDraw({ ...sideways, pathname: "/jobs" })).toBe("upright");
  });

  it("A FULL-SCREEN VIEWER opens over a screen that does not turn, and closing gives it back", () => {
    const onATallList = { pathname: "/timecards", held: "clockwise" as const, typing: false };
    expect(whichWayToDraw({ ...onATallList, layers: 0 })).toBe("upright");
    expect(whichWayToDraw({ ...onATallList, layers: 1 })).toBe("clockwise"); // a receipt, opened
    expect(whichWayToDraw({ ...onATallList, layers: 0 })).toBe("upright"); // closed again
  });

  it("…and a viewer closing over a screen that ALREADY turns does not take its turn with it", () => {
    // The whole reason this is one watcher and not a per-screen call: a viewer answering for itself on
    // its way out would un-turn the schedule underneath it.
    const overTheSchedule = { pathname: "/schedule", held: "clockwise" as const, typing: false };
    expect(whichWayToDraw({ ...overTheSchedule, layers: 1 })).toBe("clockwise");
    expect(whichWayToDraw({ ...overTheSchedule, layers: 0 })).toBe("clockwise");
  });

  it("TWO viewers open at once: the first to close does not take the second one's turn", () => {
    const base = { pathname: "/planner", held: "counterclockwise" as const, typing: false };
    expect(whichWayToDraw({ ...base, layers: 2 })).toBe("counterclockwise");
    expect(whichWayToDraw({ ...base, layers: 1 })).toBe("counterclockwise");
    expect(whichWayToDraw({ ...base, layers: 0 })).toBe("upright");
  });

  it("DO NOT ROTATE A SCREEN A PERSON IS TYPING ON — the keyboard comes up the other way round", () => {
    // Two of the four do have boxes: /schedule's autofocused "Why?" line and /price-list's search and
    // its inline price cells. With the interface locked the keyboard rises from the phone's bottom
    // edge — the person's left or right hand side — so typing into a box drawn a quarter turn from it
    // is miserable. The screen comes upright while the box has focus and turns back when it is left.
    expect(whichWayToDraw({ pathname: "/schedule", layers: 0, held: "clockwise", typing: true })).toBe("upright");
    expect(whichWayToDraw({ pathname: "/price-list", layers: 0, held: "clockwise", typing: true })).toBe("upright");
    expect(whichWayToDraw({ pathname: "/schedule", layers: 0, held: "clockwise", typing: false })).toBe("clockwise");
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
    // checkbox would make the price table's Select All throw the whole page a quarter turn.
    for (const type of ["checkbox", "radio", "button", "submit", "reset", "file", "range", "color"]) {
      expect(typingInto(el("input", { type }))).toBe(false);
    }
    expect(typingInto(el("select"))).toBe(false);
    expect(typingInto(el("button"))).toBe(false);
    expect(typingInto(el("a"))).toBe(false);
    expect(typingInto(null)).toBe(false);
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
    });
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
    expect(TURNED).toContain('if (!turned) return <div ref={face} className="turn-face">{children}</div>');
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
    // The only transforms in the whole block are on a control's face and on a turned region.
    const transforms = turnedRules().match(/^\s*transform(-origin)?:.*$/gm) ?? [];
    expect(transforms.length).toBeGreaterThan(0);
    for (const line of transforms) expect(line).toMatch(/rotate\(var\(--turn-deg|transform-origin/);
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
