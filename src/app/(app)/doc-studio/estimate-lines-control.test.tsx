import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DOC_STYLE, ESTIMATE_FORMATS, estimateFormatFor, normalizeDocStyle, type EstimateFormat } from "@/lib/doc-style";
import { dict } from "@/lib/i18n";
import { words as qt } from "@/lib/words/quotes";
import { titleCaseIn } from "../../../../tests/title-case-words";

/**
 * DOCUMENT STUDIO'S LABOR AND PARTS ON ESTIMATES: THE COMPANY'S DEFAULT HAS A THIRD CHOICE
 * (cn-v1158). Erik, 2026-11-10: "an option to group the materials into one materials line as im
 * finding that different people require different solutions." The estimate's own switch (quotes/
 * paper-format-switch) answers for one estimate; this control answers for every estimate that says
 * nothing.
 *
 *   · three segments — Hidden, Every Part, One Materials Line — in English and in Spanish, Title
 *     Case in both. RE-PINNED the same release (the owner's law: fewer words per door): they were
 *     Tasks Only, Tasks with Labor and Parts and Labor and One Materials Line, a third set of names
 *     for the three states the estimate's own switch already named. They are the switch's names now,
 *     read from the same keys, and the heading (it was "Estimate Lines", which reads wrongly over a
 *     choice called Hidden) says what the choice is about;
 *   · the third segment hands the studio 'grouped', the studio writes it through its one autosave
 *     (apply → normalizeDocStyle → updateOrgSettings), and the normalizer KEEPS it (it used to know
 *     two words and would have stored "tasks" in its place without a word);
 *   · every word the paper knows has a segment here, so a fourth cannot be a default nobody can pick;
 *   · the sample sheet beside it prints from the same word;
 *   · below `lg` the three are a list, one per row (the pill's stack="narrow"), and from `lg` up the
 *     one-line pill the studio's bar always had. That width was chosen for the three longer names
 *     the control had first; the rule is pinned where it stood (see the last describe).
 *
 * The control is drawn for real while its props are caught on the way through (a render to markup
 * cannot press a button); the studio's own wiring is read from its source, the way the studio's
 * other knobs are pinned (src/lib/doc-style.test.ts, src/components/doc-letterhead.test.ts).
 */
type Caught = { items: { id: string; label: string }[]; activeId?: string; onSelect?: (id: string) => void; stack?: "always" | "narrow"; stretch?: boolean };
const seen = vi.hoisted(() => ({ props: [] as unknown[] }));
vi.mock("@/components/ui/segmented", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ui/segmented")>();
  const { createElement: h } = await import("react");
  return {
    ...real,
    SegmentedControl: (props: Parameters<typeof real.SegmentedControl>[0]) => {
      seen.props.push(props);
      return h(real.SegmentedControl, props);
    },
  };
});

const { LangProvider } = await import("@/components/lang-provider");
const { EstimateLinesControl } = await import("./estimate-lines-control");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
function draw(lang: "en" | "es", value: EstimateFormat = "tasks") {
  seen.props = [];
  const onChange = vi.fn();
  const html = renderToStaticMarkup(createElement(LangProvider, { lang } as never, createElement(EstimateLinesControl, { value, onChange })));
  expect(seen.props).toHaveLength(1);
  return { html, pill: seen.props[0] as Caught, onChange };
}
const lit = (html: string) => [...html.matchAll(/bg-white text-slate-900 shadow-sm">([^<]+)</g)].map((m) => m[1]);

/** The ONE name each format has, here and on the estimate's own switch. */
const WORDS: Record<EstimateFormat, { en: string; es: string }> = {
  tasks: { en: "Hidden", es: "Oculto" },
  detailed: { en: "Every Part", es: "Cada Pieza" },
  grouped: { en: "One Materials Line", es: "Una Línea de Materiales" },
};
const HEADING = { en: "Labor and Parts on Estimates", es: "Mano de Obra y Piezas en Presupuestos" };

beforeEach(() => {
  seen.props = [];
});

describe("three segments, in both languages", () => {
  it("English: the heading says what the choice is about, and the three segments wear the formats' one name each, each id the stored word", () => {
    const { html, pill } = draw("en");
    expect(pill.items).toEqual([
      { id: "tasks", label: "Hidden" },
      { id: "detailed", label: "Every Part" },
      { id: "grouped", label: "One Materials Line" },
    ]);
    expect(text(html)).toBe("Labor and Parts on Estimates Hidden Every Part One Materials Line");
  });

  it("Spanish: the house words (Mano de Obra, Piezas, Presupuestos), and no English left on the control", () => {
    const { html, pill } = draw("es");
    expect(pill.items.map((i) => i.label)).toEqual(["Oculto", "Cada Pieza", "Una Línea de Materiales"]);
    expect(text(html)).toBe("Mano de Obra y Piezas en Presupuestos Oculto Cada Pieza Una Línea de Materiales");
  });

  it("every segment and the heading are Title Case in both languages; 'Una' opens its own name, so it is capital", () => {
    for (const lang of ["en", "es"] as const) {
      for (const item of draw(lang).pill.items) expect(titleCaseIn(item.label, lang), `${lang}: "${item.label}"`).toBe(true);
      expect(titleCaseIn(HEADING[lang], lang), `${lang}: "${HEADING[lang]}"`).toBe(true);
      expect(dict(lang).qt_estimateLines).toBe(HEADING[lang]);
    }
    // The rule, said on these labels: a function word is lowercase after the first word and capital as the first.
    expect(titleCaseIn("Una Línea de Materiales", "es")).toBe(true);
    expect(titleCaseIn("una Línea de Materiales", "es")).toBe(false);
    expect(titleCaseIn("Mano de Obra y Piezas en Presupuestos", "es")).toBe(true);
    expect(titleCaseIn("Mano De Obra Y Piezas En Presupuestos", "es")).toBe(false);
    expect(titleCaseIn("Labor And Parts On Estimates", "en")).toBe(false);
  });

  it("ONE NAME FOR EACH FORMAT, EVERYWHERE: this control and the estimate's own switch read the same three keys, so the two cannot name one state two ways", async () => {
    const { FORMAT_NAME } = await import("../quotes/paper-format-switch");
    for (const lang of ["en", "es"] as const) {
      const { pill } = draw(lang);
      for (const f of ESTIMATE_FORMATS) expect(pill.items.find((i) => i.id === f)!.label, `${lang}: ${f}`).toBe(dict(lang)[FORMAT_NAME[f]]);
    }
    // Read from the one table, never from keys of its own: the third set of names is gone with its keys.
    const source = readFileSync(join(process.cwd(), "src/app/(app)/doc-studio/estimate-lines-control.tsx"), "utf8");
    expect(source).toContain('import { FORMAT_NAME } from "../quotes/paper-format-switch";');
    expect([...source.matchAll(/t\(FORMAT_NAME\.(\w+)\)/g)].map((m) => m[1])).toEqual(["tasks", "detailed", "grouped"]);
    expect([...source.matchAll(/"(qt_[A-Za-z_]+)"/g)].map((m) => m[1])).toEqual(["qt_estimateLines"]);
    for (const gone of ["qt_btn_linesTasksOnly", "qt_btn_linesLaborAndParts", "qt_btn_linesOneMaterialsLine"]) {
      expect(qt.en, gone).not.toHaveProperty(gone);
      expect(qt.es, gone).not.toHaveProperty(gone);
    }
  });

  it("every word the paper knows has a segment here, with words in both languages, and the stored word lights it", () => {
    expect(Object.keys(WORDS).sort()).toEqual([...ESTIMATE_FORMATS].sort());
    for (const f of ESTIMATE_FORMATS) {
      const en = draw("en", f);
      expect(en.pill.items.filter((i) => i.id === f), f).toEqual([{ id: f, label: WORDS[f].en }]);
      expect(en.pill.activeId).toBe(f);
      expect(lit(en.html), f).toEqual([WORDS[f].en]); // exactly one white segment, the stored one
      expect(lit(draw("es", f).html), f).toEqual([WORDS[f].es]);
    }
    expect(draw("en").pill.items).toHaveLength(ESTIMATE_FORMATS.length);
  });
});

describe("the third segment writes 'grouped'", () => {
  it("tapping One Materials Line hands the studio 'grouped'; each of the others hands its own word", () => {
    for (const f of ESTIMATE_FORMATS) {
      const { pill, onChange } = draw("en");
      pill.onSelect!(pill.items.find((i) => i.label === WORDS[f].en)!.id);
      expect(onChange.mock.calls, f).toEqual([[f]]);
    }
    const spanish = draw("es");
    spanish.pill.onSelect!(spanish.pill.items.find((i) => i.label === "Una Línea de Materiales")!.id);
    expect(spanish.onChange).toHaveBeenCalledExactlyOnceWith("grouped");
  });

  it("an id that is not one of the paper's words writes nothing (the one check, lib/doc-style isEstimateFormat)", () => {
    const { pill, onChange } = draw("en");
    for (const junk of ["itemized", "default", "", "Grouped"]) pill.onSelect!(junk);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the studio writes what it is handed through its one autosave, and the sample sheet prints from the same word", () => {
    const studio = readFileSync(join(process.cwd(), "src/app/(app)/doc-studio/studio.tsx"), "utf8");
    // Only on the Estimate view, and the write is apply(): history, the page, and the debounced save.
    expect(studio).toContain('{docKind === "quote" && <EstimateLinesControl value={style.estimate_format} onChange={(estimate_format) => apply({ ...style, estimate_format })} />}');
    expect(studio).toContain('import { EstimateLinesControl } from "./estimate-lines-control";');
    expect(studio).toContain("const clean = normalizeDocStyle(next);");
    expect(studio).toContain("if (opts?.save !== false) queueSave(clean);");
    expect(studio).toContain("updateOrgSettings({ doc_style: next as unknown as Record<string, unknown> })");
    expect(studio).toContain("estimateFormat={style.estimate_format}");
    // The control's words are not literals in the studio: they live in the catalog, in both languages.
    for (const literal of ['"Tasks Only"', '"Tasks with Labor and Parts"', ">Estimate Lines<", '"Hidden"', '"Every Part"', ">Labor and Parts on Estimates<"]) expect(studio, literal).not.toContain(literal);
    for (const key of ["qt_estimateLines", "qt_btn_hidden", "qt_btn_everyPart", "qt_btn_oneMaterialsLine"]) {
      expect(qt.en[key], key).toBeTruthy();
      expect(qt.es[key], key).toBeTruthy();
    }
    expect(qt.files).toContain("src/app/(app)/doc-studio/estimate-lines-control.tsx");
  });

  it("RESET THE LOOK, NOT WHAT EVERY ESTIMATE PRINTS: the studio's layout reset keeps the company's format, as it keeps the tagline", () => {
    // The format is the company's default for the labor and the parts under each task, read by every
    // estimate that has no word of its own. Reset used to put the WHOLE style back, so a reset of the
    // margins quietly set every such estimate back to 'tasks' (no parts, no Materials line) with no word.
    const studio = readFileSync(join(process.cwd(), "src/app/(app)/doc-studio/studio.tsx"), "utf8");
    expect(studio).toContain("onClick={() => apply({ ...DEFAULT_DOC_STYLE, tagline: style.tagline, estimate_format: style.estimate_format })}");
    // The one place the studio spreads the defaults: there is no second reset that forgets it.
    expect(studio.split("...DEFAULT_DOC_STYLE").length - 1).toBe(1);
    // What that expression makes of a dialled-in style, through the normalizer apply() runs it through:
    // every knob of the look back to standard, the tagline and the format as the company set them.
    for (const f of ESTIMATE_FORMATS) {
      const style = normalizeDocStyle({ col_gap: 40, density: "airy", logo_size: "l", show_breakdown: false, show_billing_type: false, closing_quote: "See you soon.", margin_x: 1.2, margin_y: 1.1, tagline: "Fast and Fair", estimate_format: f });
      const reset = normalizeDocStyle({ ...DEFAULT_DOC_STYLE, tagline: style.tagline, estimate_format: style.estimate_format });
      expect(reset, f).toEqual({ ...DEFAULT_DOC_STYLE, tagline: "Fast and Fair", estimate_format: f });
      expect(estimateFormatFor({ estimate_format: null }, reset), f).toBe(f); // an estimate that says nothing prints what it printed before the reset
    }
  });

  it("normalizeDocStyle keeps 'grouped' — through apply(), through the stored JSON, and back out to the paper", () => {
    // What apply() does with the tap: the whole style with the one word changed, through the normalizer.
    const next = normalizeDocStyle({ ...DEFAULT_DOC_STYLE, estimate_format: "grouped" });
    expect(next.estimate_format).toBe("grouped");
    expect(next).toEqual({ ...DEFAULT_DOC_STYLE, estimate_format: "grouped" }); // nothing else moved
    // What the page reads back after a reload (settings.doc_style is JSON): still the third word.
    expect(normalizeDocStyle(JSON.parse(JSON.stringify(next))).estimate_format).toBe("grouped");
    // An estimate that says nothing prints the company's word; one that says its own keeps its own.
    expect(estimateFormatFor({ estimate_format: null }, next)).toBe("grouped");
    expect(estimateFormatFor({ estimate_format: "detailed" }, next)).toBe("detailed");
    expect(estimateFormatFor({ estimate_format: "grouped" }, DEFAULT_DOC_STYLE)).toBe("grouped");
    // Every word the paper knows survives the normalizer; anything else is still one line per task.
    for (const f of ESTIMATE_FORMATS) expect(normalizeDocStyle({ estimate_format: f }).estimate_format, f).toBe(f);
    for (const junk of ["itemized", "Grouped", "", 3, null, undefined]) expect(normalizeDocStyle({ estimate_format: junk }).estimate_format, String(junk)).toBe("tasks");
    // A company that never chose prints one line per task. (The layout reset does NOT put this back:
    // the case above.)
    expect(DEFAULT_DOC_STYLE.estimate_format).toBe("tasks");
  });
});

describe("three segments: a list below lg, one line from lg up", () => {
  // The first cut let the three wrap onto rows by their own widths, and the rows changed shape with
  // the width and the language (segmented.test.tsx says how). A stack has one shape.
  //
  // WHY lg AND NOT A PHONE'S WIDTH. The second cut stacked only below `sm`. Measured in a browser in
  // the app's own font WITH THE THREE LONGER NAMES THE CONTROL HAD THEN, the one line was 518px wide
  // in English and 640.5px in Spanish, and the bar has that much only once the window is 676px
  // (English) or 799px (Spanish) with a mouse: in between the pill ran out of its bar, by 156px in
  // Spanish at 640px, and the page scrolled sideways. From `lg` the bar has 680px with the dock and
  // the section column both standing. The names are shorter now and nobody has measured them; the
  // rule is pinned where it stood, because a list never runs out of its place.
  it('asks the pill to stack while "narrow", in both languages: below lg one segment per row at least 44px tall, from lg up the studio\'s one-line pill', () => {
    for (const lang of ["en", "es"] as const) {
      const { html, pill } = draw(lang);
      expect(pill.stack, lang).toBe("narrow");
      expect(pill.stretch, lang).toBeUndefined();
      // From lg up: the one-line classes every other pill in the studio's bars has, as written…
      expect(html, lang).toContain('<div class="flex shrink-0 gap-0.5 rounded-lg bg-slate-100 p-0.5 text-sm max-lg:flex-col max-lg:shrink">');
      // …and below it each of the three is a row of its own, 44px at least, its label free to break.
      expect(html.match(/<button type="button" class="whitespace-nowrap rounded-md px-3 py-1\.5 font-medium transition-colors max-lg:flex max-lg:min-h-11 max-lg:items-center max-lg:justify-center max-lg:whitespace-normal max-lg:text-center /g), lang).toHaveLength(3);
      // Nothing wraps segments onto shared rows any more, and nothing stops at a phone's width.
      expect(html, lang).not.toMatch(/flex-wrap|flex-auto|max-sm:|max-md:/);
    }
  });

  it("below lg the control takes the bar's whole width, so a row of the list is as wide as the bar; from lg up it is the plain box it was", () => {
    const { html } = draw("en");
    // The wrapper is the first thing drawn: the language provider draws nothing of its own.
    expect(html.startsWith('<div class="max-lg:w-full"><label class="mb-1.5 block text-sm font-medium text-slate-700">Labor and Parts on Estimates</label>')).toBe(true);
    // Take the below-lg classes away (a screen from lg up does not have them in force) and the wrapper
    // has no class left that could move it: the cn-v1157 control was a bare <div> around the same two.
    expect(html.replace(/ ?max-lg:[^\s"]+/g, "").startsWith('<div class=""><label')).toBe(true);
  });

  it("the wrapper and the pill change at the same width: one that changed alone would be a full-width box around a one-line pill, or a list in a box as wide as its longest label", () => {
    const { html } = draw("en");
    const prefixes = new Set([...html.matchAll(/[\s"]((?:max-)?(?:sm|md|lg|xl|2xl)):/g)].map((m) => m[1]));
    expect([...prefixes]).toEqual(["max-lg"]);
  });
});
