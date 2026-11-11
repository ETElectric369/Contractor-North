import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ESTIMATE_FORMATS, type EstimateFormat } from "@/lib/doc-style";
import { dict } from "@/lib/i18n";
import { words as qt } from "@/lib/words/quotes";
import { titleCaseIn } from "../../../../tests/title-case-words";

/**
 * LABOR AND PARTS ON THE PAPER: ONE CONTROL, FOUR SEGMENTS (cn-v1158). Erik, 2026-11-10: "an option
 * to list out all the materials shown as it is now and an option to group the materials into one
 * materials line". The estimate's own answer is one of four — the company's (null), Every Part
 * ('detailed'), One Materials Line ('grouped'), Hidden ('tasks') — and this file holds each end of it:
 *
 *   · the four segments, by their words, in English and in Spanish, Title Case in both;
 *   · ONE NAME FOR EACH FORMAT, EVERYWHERE (re-pinned the same release, on the owner's law of fewer
 *     words per door): the segments were List Every Part / One Materials Line / Hide while the first
 *     segment said Every Part / One Line / Hidden after its dot and Document Studio had three more
 *     names. The three names are one table now (FORMAT_NAME), and the words after the dot are held
 *     to it here, letter for letter;
 *   · each segment stores its word and each stored word lights its segment (there and back), for
 *     every word the paper knows (lib/doc-style ESTIMATE_FORMATS), so a fourth word with no segment
 *     fails HERE and is never a quiet "Company Default";
 *   · the first segment says what the company's default is today, for all three;
 *   · a tap while a save is on the wire writes nothing; an id that is no segment writes nothing;
 *   · the four are a list at every width (the pill's stack="always"): one segment per row, the same
 *     shape in English and in Spanish; and its why line fits 140.
 *
 * The control is drawn for real (the markup below is the real pill's) while its props are caught on
 * the way through, because a render to markup cannot press a button: the catch is what lets a test
 * tap a segment by the words on it.
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
const { PaperFormatSwitch, COMPANY_DEFAULT, FORMAT_NAME, segmentFor, storedFor } = await import("./paper-format-switch");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
type Props = { value: EstimateFormat | null; companyDefault: EstimateFormat; onChange: (v: EstimateFormat | null) => void; disabled?: boolean };
/** Draw the switch in a language; hand back its markup and the pill's props as it was given them. */
function draw(lang: "en" | "es", p: Partial<Props> = {}) {
  seen.props = [];
  const onChange = vi.fn();
  const props: Props = { value: null, companyDefault: "tasks", onChange, ...p };
  const html = renderToStaticMarkup(createElement(LangProvider, { lang } as never, createElement(PaperFormatSwitch, props)));
  expect(seen.props).toHaveLength(1); // ONE control, never two switches side by side
  return { html, pill: seen.props[0] as Caught, onChange: (p.onChange ?? onChange) as ReturnType<typeof vi.fn> };
}
/** The white (lit) segment's words in the real markup. */
const lit = (html: string) => [...html.matchAll(/bg-white text-slate-900 shadow-sm">([^<]+)</g)].map((m) => m[1]);

/** THE ONE NAME OF EACH FORMAT (re-pinned: the segments said "List Every Part" and "Hide", in Spanish
 *  "Listar Cada Pieza" and "Ocultar", which were not the names the first segment used after its dot). */
const EN = { everyPart: "Every Part", oneLine: "One Materials Line", hidden: "Hidden" };
const ES = { everyPart: "Cada Pieza", oneLine: "Una Línea de Materiales", hidden: "Oculto" };
/** What the first segment says for each word Doc Studio can hold: "Company Default", a dot, the format's
 *  own name (re-pinned: 'grouped' said "· One Line" / "· Una Línea", a fourth name for the one state). */
const DEFAULT_WORDS: Record<EstimateFormat, { en: string; es: string }> = {
  detailed: { en: "Company Default · Every Part", es: "Predeterminado de la Empresa · Cada Pieza" },
  grouped: { en: "Company Default · One Materials Line", es: "Predeterminado de la Empresa · Una Línea de Materiales" },
  tasks: { en: "Company Default · Hidden", es: "Predeterminado de la Empresa · Oculto" },
};

beforeEach(() => {
  seen.props = [];
});

describe("four segments, in both languages", () => {
  it("English: the company's default first (named with what it is today), then Every Part, One Materials Line, Hidden", () => {
    const { html, pill } = draw("en", { companyDefault: "tasks" });
    expect(pill.items.map((i) => i.label)).toEqual(["Company Default · Hidden", EN.everyPart, EN.oneLine, EN.hidden]);
    const t = text(html);
    expect(t).toContain("Labor and Parts on the Paper"); // the control keeps its title
    expect(t).toContain("Company Default · Hidden Every Part One Materials Line Hidden");
    // The second set of names is gone from the screen: no segment is a verb any more.
    expect(t).not.toMatch(/List Every Part|\bHide\b/);
    expect(t).toContain("Changes what prints under each task, never its price or total. Company default: Document Studio.");
    // The three-segment switch's words are gone from the screen and from the catalog (a key nothing reads is a hole).
    expect(t).not.toMatch(/Company Default · (On|Off)|\bShow\b/);
  });

  it("Spanish: the same four, tú and the house words (pieza, Predeterminado), and no English door left", () => {
    const { html, pill } = draw("es", { companyDefault: "detailed" });
    expect(pill.items.map((i) => i.label)).toEqual(["Predeterminado de la Empresa · Cada Pieza", ES.everyPart, ES.oneLine, ES.hidden]);
    const t = text(html);
    expect(t).toContain("Mano de Obra y Piezas en el Papel");
    expect(t).toContain("Cambia lo que se imprime debajo de cada tarea, nunca su precio ni su total. Predeterminado de la empresa: Document Studio.");
    expect(t).not.toMatch(/Company Default|Every Part|One Materials Line|\bHidden\b|\bHide\b|Labor and Parts/);
    expect(t).not.toMatch(/Listar Cada Pieza|\bOcultar\b/);
  });

  it("the first segment follows the company's default, for all three words, in both languages", () => {
    for (const f of ESTIMATE_FORMATS) {
      expect(draw("en", { companyDefault: f }).pill.items[0], f).toEqual({ id: COMPANY_DEFAULT, label: DEFAULT_WORDS[f].en });
      expect(draw("es", { companyDefault: f }).pill.items[0], f).toEqual({ id: COMPANY_DEFAULT, label: DEFAULT_WORDS[f].es });
    }
    // The table above covers every word the paper knows: a fourth has no words here and fails this line.
    expect(Object.keys(DEFAULT_WORDS).sort()).toEqual([...ESTIMATE_FORMATS].sort());
  });

  it("every segment is Title Case in both languages, and the catalog holds the same words", () => {
    for (const lang of ["en", "es"] as const) {
      for (const f of ESTIMATE_FORMATS) {
        for (const item of draw(lang, { companyDefault: f }).pill.items) {
          expect(titleCaseIn(item.label, lang), `${lang}: "${item.label}"`).toBe(true);
          expect(item.label.trim().length, `${lang}: ${item.id}`).toBeGreaterThan(0);
        }
      }
    }
    expect(dict("en").qt_btn_oneMaterialsLine).toBe("One Materials Line");
    expect(dict("es").qt_btn_oneMaterialsLine).toBe("Una Línea de Materiales");
    expect(dict("en").qt_btn_everyPart).toBe("Every Part");
    expect(dict("es").qt_btn_everyPart).toBe("Cada Pieza");
    expect(dict("en").qt_btn_hidden).toBe("Hidden");
    expect(dict("es").qt_btn_hidden).toBe("Oculto");
    // Retired with the three-segment switch, in both languages; and, with the second set of names, the two
    // verbs the estimate's own segments wore (a key nothing reads is a hole).
    for (const gone of ["qt_btn_companyDefaultOn", "qt_btn_companyDefaultOff", "qt_btn_show", "qt_btn_listEveryPart", "qt_btn_hide"]) {
      expect(qt.en, gone).not.toHaveProperty(gone);
      expect(qt.es, gone).not.toHaveProperty(gone);
    }
  });

  it("ONE NAME FOR EACH FORMAT: the table holds a name for every word the paper knows, each segment wears it, and the words after the dot of a Company Default segment are that same name", () => {
    expect(Object.keys(FORMAT_NAME).sort()).toEqual([...ESTIMATE_FORMATS].sort());
    expect(FORMAT_NAME).toEqual({ detailed: "qt_btn_everyPart", grouped: "qt_btn_oneMaterialsLine", tasks: "qt_btn_hidden" });
    for (const lang of ["en", "es"] as const) {
      const words = dict(lang);
      for (const f of ESTIMATE_FORMATS) {
        const name = words[FORMAT_NAME[f]];
        expect(name, `${lang}: ${f}`).toBeTruthy();
        // The segment that stores this word wears its name…
        const { pill } = draw(lang, { companyDefault: f });
        expect(pill.items.find((i) => i.id === f)!.label, `${lang}: ${f}`).toBe(name);
        // …and the first segment says the company's default by the very same words, after its dot.
        const [head, tail, ...more] = pill.items[0].label.split(" · ");
        expect(more, `${lang}: ${f}`).toEqual([]);
        expect(tail, `${lang}: ${f}`).toBe(name);
        expect(head, `${lang}: ${f}`).toBe(lang === "en" ? "Company Default" : "Predeterminado de la Empresa");
      }
      // Three different names: no two formats can be mistaken for each other.
      expect(new Set(ESTIMATE_FORMATS.map((f) => words[FORMAT_NAME[f]])).size, lang).toBe(ESTIMATE_FORMATS.length);
    }
  });

  it("the why line says where the answer lands, in 140 characters or fewer, in both languages", () => {
    for (const lang of ["en", "es"] as const) {
      const line = dict(lang).qt_paperFormatHelp;
      expect(line.length, `${lang}: ${line.length}`).toBeLessThanOrEqual(140);
      expect(line).toMatch(/Document Studio\.$/);
    }
    expect(dict("en").qt_paperFormatHelp).toBe("Changes what prints under each task, never its price or total. Company default: Document Studio.");
  });
});

describe("each segment stores its word, and each stored word lights its segment", () => {
  /** The words on a segment → what tapping it must hand the page. */
  const STORES: [label: string, stored: EstimateFormat | null][] = [
    ["Company Default · Hidden", null],
    [EN.everyPart, "detailed"],
    [EN.oneLine, "grouped"],
    [EN.hidden, "tasks"],
  ];

  it("tapping a segment reports its stored word: null for the company's, a word for each of the other three", () => {
    for (const [label, stored] of STORES) {
      const { pill, onChange } = draw("en");
      const item = pill.items.find((i) => i.label === label);
      expect(item, label).toBeTruthy();
      pill.onSelect!(item!.id);
      expect(onChange.mock.calls, label).toEqual([[stored]]);
    }
  });

  it("One Materials Line stores 'grouped' in Spanish too: the word follows the segment, never the label's language", () => {
    const { pill, onChange } = draw("es");
    pill.onSelect!(pill.items.find((i) => i.label === ES.oneLine)!.id);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("grouped");
  });

  it("and back: a stored word lights the segment that stores it; null lights the company's", () => {
    for (const [label, stored] of STORES) {
      const { html, pill } = draw("en", { value: stored });
      expect(lit(html), String(stored)).toEqual([label]); // exactly one white segment, the right one
      expect(storedFor(pill.activeId!), String(stored)).toBe(stored);
    }
    // 'grouped' under a company that itself prints one line: the estimate's own segment is lit, not the default's.
    expect(lit(draw("en", { value: "grouped", companyDefault: "grouped" }).html)).toEqual([EN.oneLine]);
    expect(lit(draw("en", { value: null, companyDefault: "grouped" }).html)).toEqual(["Company Default · One Materials Line"]);
  });

  it("the round trip holds for every word the paper knows, and every one of them has a segment of its own", () => {
    const { pill } = draw("en");
    for (const f of ESTIMATE_FORMATS) {
      expect(storedFor(segmentFor(f)), f).toBe(f);
      expect(pill.items.filter((i) => storedFor(i.id) === f), f).toHaveLength(1);
    }
    expect(storedFor(segmentFor(null))).toBeNull();
    // Four segments exactly: the company's and one per word. No two store the same thing.
    expect(pill.items).toHaveLength(ESTIMATE_FORMATS.length + 1);
    expect(new Set(pill.items.map((i) => storedFor(i.id))).size).toBe(pill.items.length);
  });

  it("an id that is no segment writes nothing; a tap while a save is on the wire writes nothing", () => {
    const { pill, onChange } = draw("en");
    expect(storedFor("show")).toBeUndefined(); // the old switch's ids are not words
    expect(storedFor("")).toBeUndefined();
    pill.onSelect!("show");
    pill.onSelect!("itemized");
    expect(onChange).not.toHaveBeenCalled();
    const busy = draw("en", { disabled: true });
    for (const i of busy.pill.items) busy.pill.onSelect!(i.id);
    expect(busy.onChange).not.toHaveBeenCalled();
    expect(busy.html).toContain('class="pointer-events-none opacity-60" aria-disabled="true"');
  });
});

describe("four segments are a list, at every width", () => {
  // The first cut let the four wrap onto rows by their own widths: 1/2/1 on one phone, 1/1/2 on a
  // smaller one and in Spanish, 1/1/1/1 in Spanish on the smallest. This card is narrow on every
  // device (a phone's width, or the desktop page's sidebar), so the four are a list everywhere.
  it('asks the pill to stack "always" (and not to stretch): one segment per row, at least 44px tall, drawn as buttons, the same in both languages', () => {
    for (const lang of ["en", "es"] as const) {
      for (const companyDefault of ESTIMATE_FORMATS) {
        const { html, pill } = draw(lang, { companyDefault });
        const at = `${lang}, default ${companyDefault}`;
        expect(pill.stack, at).toBe("always");
        expect(pill.stretch, at).toBeUndefined();
        // A column: a row is one segment whatever its words are.
        expect(html, at).toContain('<div class="flex flex-col gap-0.5 rounded-lg bg-slate-100 p-0.5 text-sm">');
        expect(html.match(/<button type="button" class="flex min-h-11 items-center justify-center whitespace-normal text-center rounded-md px-3 py-1\.5 font-medium transition-colors /g), at).toHaveLength(4);
        // Nothing holds a label on one line, nothing shares a row, and nothing waits for a wider screen.
        expect(html, at).not.toMatch(/whitespace-nowrap|shrink-0|flex-wrap|flex-auto|(sm|md|lg|xl):/);
      }
    }
  });
});
