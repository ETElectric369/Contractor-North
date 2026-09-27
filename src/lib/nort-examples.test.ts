import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { NORT_EXAMPLES_RULE, engineeringLine } from "@/lib/nort/trade-prompt";
import { REGISTRY } from "@/lib/actions/registry";
import { DATA_TOOLS } from "@/lib/assistant-tools";

/**
 * NO BAKED-IN EXAMPLES FROM ONE COMPANY OR ONE TRADE (Nort-guide Wave A).
 *
 * Erik: "Nort cant be giving examples that dont make sense like in the tour." Every company's Nort
 * was taught with ET's crew and jobs ("have Brian install the ground rod", "2 4S boxes at Apache",
 * "30 feet of 10/3 romex"), every company's walk-through showed "roughly 200' of 12-2", and every
 * why box offered a deck builder's board count or an electrician's subpanel fork. An example comes
 * from THIS company's own data and trade; with none, it shows the shape (<job>, <item>) or asks.
 *
 * THIS GUARD reads every string the app can show or say (string literals, templates and JSX text,
 * parsed by the compiler, so comments naming who asked for what are fine) and fails if an
 * ET-specific or electrician-only example word comes back outside the places it belongs.
 */
const ROOT = process.cwd();

/** ET's people, jobs, places and account; and the electrician-only examples that leaked everywhere. */
const EXAMPLE_WORDS =
  /\b(brian|apache|romex|subpanels?|home ?runs?|homeruns?|board count|joists?|TR-34426|truckee|herringbone|burks|chmura|chamorro|waldow)\b|\b1[24][-/]2\b|\b10[-/]3\b/gi;
/** The same words, for a yes/no test (no /g, so no lastIndex carried between calls). */
const ANY_EXAMPLE_WORD = new RegExp(EXAMPLE_WORDS.source, "i");

/**
 * WHERE THESE WORDS BELONG, and only these words there:
 *  - fixtures and replays of ET's real papers (they ARE the fixture, never the rule);
 *  - ET's own electrical playbook starter (the electrical starter itself);
 *  - the electrical calculators and the Panel Map, whose subject IS wire (a switch hides them for
 *    trades that don't use them);
 *  - a first-name dictionary that happens to contain "brian".
 */
const FIXTURE = [/\/__fixtures__\//, /-fixture\.ts$/, /^src\/test\//];
const ALLOWED: Record<string, RegExp> = {
  "src/lib/playbook/starters/et-electric.ts": /./,
  "src/lib/electrical-calc.ts": /^romex$/i,
  "src/app/(app)/tools/tools-view.tsx": /^romex$/i,
  "src/app/(app)/jobs/[id]/circuit-edit-sheet.tsx": /^12\/2$/,
  "src/app/(app)/quotes/[id]/circuit-schedule-card.tsx": /^12\/2$/,
  // The circuit schedule's model instructions (Panel Map): its wire column's own format.
  "src/app/(app)/quotes/actions.ts": /^(12\/2|14\/2|10\/3)$/,
  "src/app/(app)/price-list/vendor-import-math.ts": /^brian$/i,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(p) && !/\.(test|db-suite)\.tsx?$/.test(p) ? [p] : [];
  });
}

/** Every string a person could read or Nort could be told, as the compiler reads the file. */
function strings(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    else if (ts.isJsxText(n)) out.push(n.text);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** Every hit that isn't where it belongs, as "file: word — the string". */
function strayExamples(): string[] {
  const hits: string[] = [];
  for (const abs of sourceFiles(join(ROOT, "src"))) {
    const file = relative(ROOT, abs);
    if (FIXTURE.some((r) => r.test(file))) continue;
    const text = readFileSync(abs, "utf8");
    if (!ANY_EXAMPLE_WORD.test(text)) continue; // cheap pre-check before parsing
    const allowed = ALLOWED[file];
    for (const s of strings(file, text)) {
      for (const m of s.matchAll(EXAMPLE_WORDS)) {
        if (allowed?.test(m[0])) continue;
        hits.push(`${file}: "${m[0]}" in "${s.replace(/\s+/g, " ").slice(0, 120)}"`);
      }
    }
  }
  return hits;
}

/** Reading and parsing every source file takes ~3 s alone and far longer beside the whole suite. */
const SCAN_TIMEOUT = 60_000;

describe("no screen and no Nort instruction carries another company's or another trade's example", () => {
  it("finds none outside the places they belong", () => {
    expect(strayExamples()).toEqual([]);
  }, SCAN_TIMEOUT);

  it("the guard really reads strings, and only strings", () => {
    // A self-check, so an empty result can't mean a scanner that reads nothing.
    const planted = `// Brian asked for this in a comment\nconst x = "have Brian install it"; const y = <p>12-2 romex</p>;`;
    const found = strings("planted.tsx", planted).flatMap((s) => [...s.matchAll(EXAMPLE_WORDS)].map((m) => m[0].toLowerCase()));
    expect(found).toEqual(["brian", "12-2", "romex"]);
  });

  it("every allowance still has something to allow (a stale one is a hole)", () => {
    for (const [file, rx] of Object.entries(ALLOWED)) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const used = strings(file, text).some((s) => [...s.matchAll(EXAMPLE_WORDS)].some((m) => rx.test(m[0])));
      expect(used, `${file} no longer needs its allowance`).toBe(true);
    }
  });
});

/**
 * NORT'S TOOLS ARE DESCRIBED FOR ANY TRADE. Every tool description goes to every company's Nort, and
 * an example in one is an example Nort learns from: "bump the panel line to $1,800", "received 20 of
 * the 50 breakers", "a hot tub circuit" taught a deck builder's Nort an electrician's job with made-up
 * prices. The examples are shapes (<item>, <job>, $<amount>). The Panel tools are the one place
 * whose subject IS circuits (a switch hides them from trades that don't use them).
 */
const ELECTRICIAN_WORDS = /\b(circuits?|breakers?|panels?|amps?|amperage|gauge|hot tub|romex|conduit|outlets?|receptacles?)\b/i;
/** A dollar figure written into a description: every amount in an example is $<amount>. */
const MADE_UP_AMOUNT = /\$\d/;
const PANEL_TOOLS = new Set(["get_job_panel"]);

function tradeHits(name: string, text: string): string[] {
  return [ELECTRICIAN_WORDS, MADE_UP_AMOUNT].flatMap((rx) => {
    const m = text.match(rx);
    return m ? [`${name}: ${m[0]}`] : [];
  });
}

describe("Nort's tools are described for any trade", () => {
  it("no action outside the Panel tools carries an electrician's example or a made-up amount", () => {
    const hits = Object.values(REGISTRY)
      .filter((a) => a.group !== "panel")
      .flatMap((a) => tradeHits(a.name, `${a.label} ${a.description}`));
    expect(hits).toEqual([]);
  });

  it("no read tool outside the Panel tools does either (its inputs' descriptions included)", () => {
    const hits = DATA_TOOLS.filter((t) => !PANEL_TOOLS.has(t.name)).flatMap((t) =>
      tradeHits(t.name, JSON.stringify({ d: t.description, i: t.input_schema })),
    );
    expect(hits).toEqual([]);
  });

  it("the check can see one (so an empty result can't mean it reads nothing)", () => {
    expect(tradeHits("x", "bump the panel line to $1,800")).toEqual(["x: panel", "x: $1"]);
    expect(tradeHits("x", "bump the <item> line to $<amount>")).toEqual([]);
    expect(Object.values(REGISTRY).some((a) => a.group === "panel" && ELECTRICIAN_WORDS.test(a.description))).toBe(true);
    expect(DATA_TOOLS.some((t) => PANEL_TOOLS.has(t.name))).toBe(true);
  });

  it("the windshield card's tiles don't suggest amps", () => {
    const route = readFileSync(join(ROOT, "src/app/api/chat/route.ts"), "utf8");
    expect(route).toContain("(gate code, balance, hours)");
    expect(route).not.toMatch(/hours, amps\)/);
  });
});

/**
 * A PLACEHOLDER IS AN EXAMPLE. "Circuit Map" sat in the title box of the Papers card every company
 * sees. Every placeholder outside the Panel screens (whose subject is circuits) names no
 * electrician's thing.
 */
const PANEL_SCREENS = /(panel|breaker|circuit)[^/]*\.tsx$/i;

function placeholderHits(): string[] {
  const hits: string[] = [];
  for (const abs of sourceFiles(join(ROOT, "src"))) {
    const file = relative(ROOT, abs);
    if (!file.endsWith(".tsx") || PANEL_SCREENS.test(file) || FIXTURE.some((r) => r.test(file))) continue;
    const text = readFileSync(abs, "utf8");
    if (!text.includes("placeholder")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const walk = (n: ts.Node) => {
      if (ts.isJsxAttribute(n) && n.name.getText(sf) === "placeholder" && n.initializer) {
        const said = n.initializer.getText(sf);
        const m = said.match(ELECTRICIAN_WORDS);
        if (m) hits.push(`${file}: "${m[0]}" in ${said.slice(0, 100)}`);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return hits;
}

describe("no placeholder outside the Panel screens is an electrician's example", () => {
  it("finds none", () => {
    expect(placeholderHits()).toEqual([]);
  }, SCAN_TIMEOUT);

  it("the Panel screens are the ones allowed, and only by name", () => {
    expect(PANEL_SCREENS.test("src/app/(app)/jobs/[id]/job-panel.tsx")).toBe(true);
    expect(PANEL_SCREENS.test("src/app/(app)/jobs/[id]/place-breaker-sheet.tsx")).toBe(true);
    expect(PANEL_SCREENS.test("src/app/(app)/jobs/[id]/job-portal-papers.tsx")).toBe(false);
  });
});

describe("Nort is told the same thing the guard enforces", () => {
  it("examples are the company's own, or shapes", () => {
    expect(NORT_EXAMPLES_RULE).toContain("THIS company");
    expect(NORT_EXAMPLES_RULE).toMatch(/never make a number up/i);
    expect(NORT_EXAMPLES_RULE).not.toMatch(ANY_EXAMPLE_WORD);
  });

  it("only electrical work is sized by the NEC and its calculators", () => {
    expect(engineeringLine("electrical")).toContain("per NEC");
    for (const k of ["deck", "general", "plumbing", "painting", ""] as const) {
      expect(engineeringLine(k), k).not.toContain("per NEC");
      expect(engineeringLine(k), k).toContain("electrical work only");
    }
  });

  it("the chat route uses both", () => {
    const route = readFileSync(join(ROOT, "src/app/api/chat/route.ts"), "utf8");
    expect(route).toContain("${NORT_EXAMPLES_RULE}");
    expect(route).toContain("${engineeringLine(trade.key)}");
  });
});
