import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { SegmentedControl, type SegmentItem } from "./segmented";

/**
 * THE SEGMENTED CONTROL STACKS ONLY WHERE IT IS ASKED TO (cn-v1158). The estimate's paper switch grew
 * from three segments to four ("Company Default · Every Part", "Every Part", "One Materials Line",
 * "Hidden") and Document Studio's control for the company's default from two to three; neither set
 * was sure of one line on a phone. So the control gained ONE opt-in prop, `stack`: "always" (a vertical list at every
 * width) or "narrow" (that list below Tailwind's `lg`, the one-line pill from `lg` up).
 *
 * A LIST, NOT A WRAP. The first cut wrapped the segments onto rows by their own widths. Measured in a
 * browser the rows came out 1/2/1 at one width, 1/1/2 at the next and 1/1/1/1 in Spanish on a small
 * phone: a shape that moves with the width and the language. A stack has one shape, so this file
 * also holds that nothing wraps any more.
 *
 * `lg`, NOT A PHONE'S WIDTH. The second cut stacked only below `sm` (it was called "phone"). Measured
 * again, the studio's one-line pill was wider than its bar in windows from 640px to about 800px (the
 * dock and the page padding come off a window before a pill gets any of it), ran out of the bar, and
 * the page scrolled sideways. So the rule waits for `lg`, and this file also holds that no below-`sm`
 * class and no "phone" is left in the control.
 *
 * What this file holds still:
 *   · every caller that does not pass `stack` draws the very bytes it drew before the prop existed
 *     (the first three cases below were run against the control as it stood at cn-v1157, before any
 *     prop was added, and passed unchanged);
 *   · "always": one segment per row, at least 44px tall, its label centered and free to break;
 *   · "narrow": from `lg` up it is the one-line pill BY THE SAME CLASSES (take the max-lg: ones away
 *     and the bytes are the one-line pill's), and below `lg` it is the very stack "always" draws;
 *   · `stack` changes classes and nothing else: the same buttons and links, in the same order, with
 *     the same attributes, so the keyboard and a screen reader meet what they met before;
 *   · the callers that pass `stack` are named here, so the next one is a decision and not a habit.
 */
const ROOT = process.cwd();
const two: SegmentItem[] = [
  { id: "a", label: "Set a Time" },
  { id: "b", label: "Propose Times" },
];
const links: SegmentItem[] = [
  { id: "day", label: "By Day", href: "/timecards?week=0" },
  { id: "person", label: "By Person", href: "/timecards?week=0&group=person" },
];
const four: SegmentItem[] = [
  { id: "default", label: "Company Default · Every Part" },
  { id: "detailed", label: "Every Part" },
  { id: "grouped", label: "One Materials Line" },
  { id: "tasks", label: "Hidden" },
];
const draw = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(SegmentedControl, props as never));
/** The markup with every class taken out: what the keyboard and a screen reader are given. */
const bare = (html: string) => html.replace(/ class="[^"]*"/g, "");
/** Every class attribute in the markup, as lists of classes. */
const classLists = (html: string) => [...html.matchAll(/ class="([^"]*)"/g)].map((m) => m[1].split(" "));
/** The markup as a screen from `lg` up reads it: the below-`lg` classes are not in force, so they are taken out. */
const fromLgUp = (html: string) => html.replace(/ max-lg:[^\s"]+/g, "");
/** Any class that waits for, or stops at, a breakpoint (sm: and max-sm: alike). */
const BREAKPOINT = /(sm|md|lg|xl):/;

const ON = "bg-white text-slate-900 shadow-sm";
const OFF = "text-slate-500 hover:text-slate-700";
/** The one-line pill, as it has always been written. */
const SEG = "whitespace-nowrap rounded-md px-3 py-1.5 font-medium transition-colors";
const PILL = "flex shrink-0 gap-0.5 rounded-lg bg-slate-100 p-0.5 text-sm";
/** What a stack gives a segment (display flex to center the label in its 44px, min-h-11 = 2.75rem = 44px). */
const STACK = ["flex", "min-h-11", "items-center", "justify-center", "whitespace-normal", "text-center"];
const STACKED_SEG = `${STACK.join(" ")} rounded-md px-3 py-1.5 font-medium transition-colors`;
const STACKED_PILL = "flex flex-col gap-0.5 rounded-lg bg-slate-100 p-0.5 text-sm";
/** "narrow": the one-line classes, then the stack's behind max-lg: (and max-lg:shrink, which takes shrink-0 back). */
const NARROW_SEG = `${SEG} ${STACK.map((c) => `max-lg:${c}`).join(" ")}`;
const NARROW_PILL = `${PILL} max-lg:flex-col max-lg:shrink`;

describe("a caller that does not ask to stack draws what it always drew, byte for byte", () => {
  it("the plain pill: buttons, the active one white", () => {
    expect(draw({ items: two, activeId: "a" })).toBe(
      `<div class="${PILL}"><button type="button" class="${SEG} ${ON}">Set a Time</button><button type="button" class="${SEG} ${OFF}">Propose Times</button></div>`,
    );
    // Nothing active is a pill with no white segment (a caller between two states).
    expect(draw({ items: two })).toBe(
      `<div class="${PILL}"><button type="button" class="${SEG} ${OFF}">Set a Time</button><button type="button" class="${SEG} ${OFF}">Propose Times</button></div>`,
    );
  });

  it("stretch: the pill fills its row and the segments share it equally", () => {
    expect(draw({ items: two, activeId: "b", stretch: true })).toBe(
      `<div class="${PILL} w-full"><button type="button" class="${SEG} flex-1 text-center ${OFF}">Set a Time</button><button type="button" class="${SEG} flex-1 text-center ${ON}">Propose Times</button></div>`,
    );
  });

  it("a segment with an href is a link, and the caller's own className rides the pill", () => {
    expect(draw({ items: links, activeId: "day" })).toBe(
      `<div class="${PILL}"><a class="${SEG} ${ON}" href="/timecards?week=0">By Day</a><a class="${SEG} ${OFF}" href="/timecards?week=0&amp;group=person">By Person</a></div>`,
    );
    expect(draw({ items: two, activeId: "a", className: "mt-2" })).toContain(`<div class="${PILL} mt-2">`);
  });

  it("no stack is the same as not saying it, and nothing in a one-line pill is scoped to a breakpoint", () => {
    for (const props of [{ items: two, activeId: "a" }, { items: two, activeId: "a", stretch: true }, { items: links, activeId: "person" }]) {
      expect(draw({ ...props, stack: undefined })).toBe(draw(props));
      expect(draw(props)).not.toMatch(BREAKPOINT);
      expect(draw(props)).not.toMatch(/flex-col|min-h-11/);
    }
  });
});

describe('stack="always": a vertical list at every width', () => {
  it("one segment per row: the pill is a column, each segment at least 44px tall with its label centered and free to break", () => {
    const html = draw({ items: four, activeId: "grouped", stack: "always" });
    expect(html).toBe(
      `<div class="${STACKED_PILL}">` +
        `<button type="button" class="${STACKED_SEG} ${OFF}">Company Default · Every Part</button>` +
        `<button type="button" class="${STACKED_SEG} ${OFF}">Every Part</button>` +
        `<button type="button" class="${STACKED_SEG} ${ON}">One Materials Line</button>` +
        `<button type="button" class="${STACKED_SEG} ${OFF}">Hidden</button>` +
        `</div>`,
    );
    // A column: a row is one segment, as wide as the pill (a column's items stretch across it).
    expect(html).toContain("flex flex-col");
    // Never the one-line classes: shrink-0 would hold the pill at its widest label's one-line width,
    // and whitespace-nowrap would run a long label off the screen instead of breaking it in its row.
    expect(html).not.toMatch(/shrink-0|whitespace-nowrap/);
    // NOTHING WRAPS: the shape does not depend on how wide the labels are, or on the language.
    expect(html).not.toMatch(/flex-wrap|flex-auto|flex-1/);
    // The same at every width: no class is scoped to a breakpoint.
    expect(html).not.toMatch(BREAKPOINT);
  });

  it("a link segment stacks the same way; with stretch the pill takes its row's full width and the segments are left alone", () => {
    expect(draw({ items: links, activeId: "day", stack: "always" })).toBe(
      `<div class="${STACKED_PILL}"><a class="${STACKED_SEG} ${ON}" href="/timecards?week=0">By Day</a><a class="${STACKED_SEG} ${OFF}" href="/timecards?week=0&amp;group=person">By Person</a></div>`,
    );
    const both = draw({ items: two, activeId: "a", stack: "always", stretch: true });
    expect(both).toContain(`<div class="${STACKED_PILL} w-full">`);
    // flex-1 shares a ROW equally; a stacked row has one segment, and in a column flex-1 would share the height.
    expect(both).not.toContain("flex-1");
    expect(draw({ items: two, activeId: "a", stack: "always", className: "mt-2" })).toContain(`<div class="${STACKED_PILL} mt-2">`);
  });
});

describe('stack="narrow": that list below lg, the one-line pill from lg up', () => {
  it("the one-line classes as they have always been written, and the stack's behind max-lg:", () => {
    expect(draw({ items: four, activeId: "grouped", stack: "narrow" })).toBe(
      `<div class="${NARROW_PILL}">` +
        `<button type="button" class="${NARROW_SEG} ${OFF}">Company Default · Every Part</button>` +
        `<button type="button" class="${NARROW_SEG} ${OFF}">Every Part</button>` +
        `<button type="button" class="${NARROW_SEG} ${ON}">One Materials Line</button>` +
        `<button type="button" class="${NARROW_SEG} ${OFF}">Hidden</button>` +
        `</div>`,
    );
    expect(draw({ items: links, activeId: "day", stack: "narrow" })).toBe(
      `<div class="${NARROW_PILL}"><a class="${NARROW_SEG} ${ON}" href="/timecards?week=0">By Day</a><a class="${NARROW_SEG} ${OFF}" href="/timecards?week=0&amp;group=person">By Person</a></div>`,
    );
  });

  it("FROM lg UP IT IS THE ONE-LINE PILL, BY THE SAME CLASSES: take the max-lg: classes away and the bytes are the one-line pill's", () => {
    for (const props of [{ items: four, activeId: "grouped" }, { items: two }, { items: links, activeId: "day" }, { items: two, activeId: "a", stretch: true }, { items: two, activeId: "b", className: "mt-2" }]) {
      expect(fromLgUp(draw({ ...props, stack: "narrow" })), JSON.stringify(props)).toBe(draw(props));
    }
    // Nothing is switched ON from lg up (no lg: class, nor any other min-width one): the wide screen
    // is not a second set of rules that could drift from the other pills', it is their rules.
    expect(draw({ items: four, activeId: "grouped", stack: "narrow" })).not.toMatch(/(^|[\s"])(sm|md|lg|xl):/);
  });

  it("BELOW lg IT IS THE VERY STACK \"always\" DRAWS: every class a stack adds is there behind max-lg:, and each one-line class it must beat has its answer", () => {
    const [alwaysPill, alwaysSeg] = classLists(draw({ items: two, stack: "always" }));
    const [plainPill, plainSeg] = classLists(draw({ items: two }));
    const [narrowPill, narrowSeg] = classLists(draw({ items: two, stack: "narrow" }));
    const below = (list: string[]) => list.filter((c) => c.startsWith("max-lg:")).map((c) => c.slice("max-lg:".length));
    // A segment: what "always" has that the one-line segment has not, is exactly what "narrow" has below lg.
    expect(below(narrowSeg)).toEqual(alwaysSeg.filter((c) => !plainSeg.includes(c)));
    expect(below(narrowSeg)).toEqual(STACK);
    // …and the one class the one-line segment has that a stack must not, is answered: nowrap ← normal.
    expect(plainSeg.filter((c) => !alwaysSeg.includes(c))).toEqual(["whitespace-nowrap"]);
    expect(below(narrowSeg)).toContain("whitespace-normal");
    // The pill: a column in place of shrink-0. "shrink" is flex-shrink 1, which is what no shrink-0 means.
    expect(alwaysPill.filter((c) => !plainPill.includes(c))).toEqual(["flex-col"]);
    expect(plainPill.filter((c) => !alwaysPill.includes(c))).toEqual(["shrink-0"]);
    expect(below(narrowPill)).toEqual(["flex-col", "shrink"]);
  });

  it("with stretch too: from lg up the segments share the row as they always did, and below lg no row is shared (as \"always\" never shares one)", () => {
    const html = draw({ items: two, activeId: "a", stack: "narrow", stretch: true });
    expect(html).toBe(
      `<div class="${NARROW_PILL} w-full"><button type="button" class="${NARROW_SEG} flex-1 text-center max-lg:flex-none ${ON}">Set a Time</button><button type="button" class="${NARROW_SEG} flex-1 text-center max-lg:flex-none ${OFF}">Propose Times</button></div>`,
    );
    expect(fromLgUp(html)).toBe(draw({ items: two, activeId: "a", stretch: true }));
    // flex-1 in a column would share the pill's HEIGHT between the rows; "always" has no flex-1 at all.
    expect(draw({ items: two, activeId: "a", stack: "always", stretch: true })).not.toMatch(/flex-1|flex-none/);
    // Without stretch there is nothing to take back, so the class is not there.
    expect(draw({ items: two, activeId: "a", stack: "narrow" })).not.toContain("flex-none");
  });

  it("the below-lg classes are WRITTEN OUT in the control's source: Tailwind makes a class only when it reads it whole", () => {
    const src = readFileSync(join(ROOT, "src/components/ui/segmented.tsx"), "utf8");
    expect(src).toContain('"max-lg:flex-col max-lg:shrink"');
    expect(src).toContain('"max-lg:flex max-lg:min-h-11 max-lg:items-center max-lg:justify-center max-lg:whitespace-normal max-lg:text-center"');
    expect(src).toContain('"max-lg:flex-none"');
    // Never assembled: a `max-lg:${…}` in the source is a class the stylesheet will not have.
    expect(src).not.toMatch(/max-lg:\$\{/);
  });

  it("THE SECOND CUT IS GONE: no class stops at a phone's width, and no mode is called \"phone\"", () => {
    const src = readFileSync(join(ROOT, "src/components/ui/segmented.tsx"), "utf8");
    // A rule that stacks only below sm leaves the one line wider than its place from 640px to about
    // 800px of window (measured in Document Studio's bar): it must not come back by a copied class.
    expect(src).not.toMatch(/max-sm:|max-md:/);
    expect(src).not.toMatch(/"phone"/);
    expect(draw({ items: two, stack: "narrow" })).not.toMatch(/max-sm:|max-md:/);
    // A word the control does not know stacks nothing: it draws the one-line pill, never half a stack.
    expect(draw({ items: two, activeId: "a", stack: "phone" })).toBe(draw({ items: two, activeId: "a" }));
  });
});

describe("only classes change", () => {
  it("the same buttons and links, in the same order, with the same attributes, in all three", () => {
    for (const props of [{ items: four, activeId: "grouped" }, { items: links, activeId: "day" }]) {
      expect(bare(draw({ ...props, stack: "always" }))).toBe(bare(draw(props)));
      expect(bare(draw({ ...props, stack: "narrow" }))).toBe(bare(draw(props)));
    }
    // Nothing a keyboard or a screen reader reads was added or taken away to make it stack.
    for (const stack of [undefined, "always", "narrow"]) expect(draw({ items: four, activeId: "grouped", stack }), String(stack)).not.toMatch(/ (role|tabindex|aria-[a-z]+)=/);
  });
});

describe("who asks to stack", () => {
  /** The pills one file draws, and what each says for `stack`: "always" / "narrow" as written,
   *  "computed" for anything that is not one of the two words as a plain string (the retired "phone"
   *  among them), "spread" when a {...props} could carry it unseen, nothing when it says nothing; and
   *  whether any still passes the retired `wrap`. Read with the compiler, tag by tag (the way
   *  tests/title-case.test.ts reads every clickable): a regex stops at the first ">" of an arrow
   *  function and would miss a prop written after onSelect. */
  function pills(source: string, fileName: string): { tags: number; stacks: string[]; wraps: number } {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let tags = 0;
    let wraps = 0;
    const stacks: string[] = [];
    const visit = (n: ts.Node): void => {
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === "SegmentedControl") {
        tags++;
        for (const a of n.attributes.properties) {
          if (ts.isJsxSpreadAttribute(a)) {
            stacks.push("spread");
            continue;
          }
          const name = a.name.getText(sf);
          if (name === "wrap") wraps++;
          if (name !== "stack") continue;
          const init = a.initializer;
          const value = init && ts.isJsxExpression(init) ? init.expression : init;
          if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) && (value.text === "always" || value.text === "narrow")) stacks.push(value.text);
          else if (value && ts.isIdentifier(value) && value.text === "undefined") continue; // stack={undefined}: says nothing
          else stacks.push("computed");
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return { tags, stacks, wraps };
  }
  /** Every screen file that draws the control. */
  function callers(): { file: string; tags: number; stacks: string[]; wraps: number }[] {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") && !p.endsWith(".test.tsx") ? [p] : [];
      });
    return walk(join(ROOT, "src"))
      .map((p) => ({ p, source: readFileSync(p, "utf8") }))
      // Only a file that names the pill is parsed: the compiler over every screen in the app is seconds
      // of work a loaded machine does not have inside one test (the cn-v1156 lesson), and a file that
      // never writes "<SegmentedControl" has no pill to count.
      .filter(({ source }) => source.includes("<SegmentedControl"))
      .map(({ p, source }) => ({ file: relative(ROOT, p), ...pills(source, p) }))
      .filter((c) => c.tags > 0)
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  it("the scan reads the prop wherever it is written on the tag, and in whichever way", () => {
    const one = (tag: string) => pills(`const A = () => (<>${tag}</>);`, "a.tsx");
    expect(one(`<SegmentedControl items={x} onSelect={(id) => go(id)} stack="always" />`)).toEqual({ tags: 1, stacks: ["always"], wraps: 0 }); // after an arrow's ">"
    expect(one(`<SegmentedControl stack={"narrow"} items={x} />`)).toEqual({ tags: 1, stacks: ["narrow"], wraps: 0 });
    expect(one("<SegmentedControl stack={`narrow`} items={x} />")).toEqual({ tags: 1, stacks: ["narrow"], wraps: 0 });
    expect(one(`<SegmentedControl items={x} stack={small ? "always" : undefined} />`)).toEqual({ tags: 1, stacks: ["computed"], wraps: 0 });
    expect(one(`<SegmentedControl {...rest} />`)).toEqual({ tags: 1, stacks: ["spread"], wraps: 0 });
    expect(one(`<SegmentedControl items={x} stack={undefined} />`)).toEqual({ tags: 1, stacks: [], wraps: 0 });
    expect(one(`<SegmentedControl items={x} stretch />`)).toEqual({ tags: 1, stacks: [], wraps: 0 });
    // The second cut's word and the first cut's prop, should either ever come back.
    expect(one(`<SegmentedControl items={x} stack="phone" />`)).toEqual({ tags: 1, stacks: ["computed"], wraps: 0 });
    expect(one(`<SegmentedControl items={x} wrap />`)).toEqual({ tags: 1, stacks: [], wraps: 1 });
    // Another element's props, and a comment, are not the pill's.
    expect(one(`<div className="flex-col"><Other stack="always" wrap /></div>`)).toEqual({ tags: 0, stacks: [], wraps: 0 });
    expect(one(`{/* stack="always" one day */}<SegmentedControl items={x} />`)).toEqual({ tags: 1, stacks: [], wraps: 0 });
  });

  it("the estimate's paper switch (always: four segments in a narrow card) and Document Studio's Labor and Parts on Estimates (narrow: three in a bar that was sure of room for one line only on a desktop); no other pill in the app changed", () => {
    const all = callers();
    // The scan found the app's pills: it cannot pass by reading nothing.
    expect(all.length).toBeGreaterThanOrEqual(12);
    expect(all.reduce((n, c) => n + c.tags, 0)).toBeGreaterThanOrEqual(15);
    // A NEW NAME HERE IS A DECISION: a stacked pill is a list of 44px rows, so the place it sits in has
    // to have been built for that. Every other caller is pinned to its old bytes above.
    expect(all.filter((c) => c.stacks.length > 0).map((c) => `${c.file}: ${c.stacks.join(", ")}`)).toEqual([
      "src/app/(app)/doc-studio/estimate-lines-control.tsx: narrow",
      "src/app/(app)/quotes/paper-format-switch.tsx: always",
    ]);
    // Nothing wraps any more: the prop is gone from the control and from every caller.
    expect(all.reduce((n, c) => n + c.wraps, 0)).toBe(0);
    expect(readFileSync(join(ROOT, "src/components/ui/segmented.tsx"), "utf8")).not.toMatch(/flex-wrap|\bwrap\??:/);
    // Document Studio's own toolbar pills (Invoice / Estimate, Template, Density) stay one-line.
    expect(all.find((c) => c.file === "src/app/(app)/doc-studio/studio.tsx")).toEqual({ file: "src/app/(app)/doc-studio/studio.tsx", tags: 3, stacks: [], wraps: 0 });
  }, 60_000); // it reads every screen file from disk: the time a loaded machine needs, like the other app-wide scans
});
