import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { NORT_EXAMPLES_RULE, engineeringLine, tradeRuleWords, voiceEstimateRule } from "@/lib/nort/trade-prompt";
import { REGISTRY } from "@/lib/actions/registry";
import { DATA_TOOLS } from "@/lib/assistant-tools";

/**
 * NO BAKED-IN EXAMPLES FROM ONE COMPANY OR ONE TRADE (Nort-guide Wave A).
 *
 * Erik: "Nort cant be giving examples that dont make sense like in the tour." Every company's Nort
 * was taught with ET's crew and jobs ("have Brian install the ground rod", "2 4S boxes at Acacia",
 * "30 feet of 10/3 romex"), every company's inspection showed "roughly 200' of 12-2", and every
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
  /\b(brian|acacia|romex|subpanels?|home ?runs?|homeruns?|board count|joists?|AC-10427|truckee|honeysuckle|finch|clover|cardell|wexley)\b|\b1[24][-/]2\b|\b10[-/]3\b/gi;
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
/**
 * An allowance: which words, in which file, and (when the file also holds strings every trade gets)
 * only inside the one string that carries `within`. A file-wide allowance in quotes/actions.ts let
 * "(wire e.g. 12/2 NM-B)" into the estimator prompt every trade gets, and the guard still passed.
 */
type Allowance = { words: RegExp; within?: string };
const ALLOWED: Record<string, Allowance> = {
  "src/lib/playbook/starters/et-electric.ts": { words: /./ },
  "src/lib/electrical-calc.ts": { words: /^romex$/i },
  "src/app/(app)/tools/tools-view.tsx": { words: /^romex$/i },
  "src/app/(app)/jobs/[id]/circuit-edit-sheet.tsx": { words: /^12\/2$/ },
  "src/app/(app)/quotes/[id]/circuit-schedule-card.tsx": { words: /^12\/2$/ },
  // The circuit schedule's model instructions (Panel Map): its wire column's own format, in that
  // prompt only. The same file builds the estimator prompt every trade gets.
  "src/app/(app)/quotes/actions.ts": { words: /^(12\/2|14\/2|10\/3)$/, within: "ckt = circuit position" },
  "src/app/(app)/price-list/vendor-import-math.ts": { words: /^brian$/i },
  // A CARD PROCESSOR'S OWN BRAND NAME, in the one table the app matches a bank line's printed words
  // against (bank-money-in.ts's CHANNEL_WORDS). "Clover" here is the processor and has nothing to do
  // with the invented customer of the same name: nobody reads this string, a bank wrote it, and it has
  // to stay because PROCESSOR_RE is built from this list - a brand dropped out of it starts reading as
  // "a transfer between the company's own accounts" on every statement that names it. It was invisible
  // to this guard while it lived inside a regular expression literal, which is the only reason this
  // allowance is new rather than old.
  "src/lib/bank-money-in.ts": { words: /^clover$/i },
};

function allows(a: Allowance | undefined, word: string, s: string): boolean {
  return !!a && a.words.test(word) && (!a.within || s.includes(a.within));
}

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
    hits.push(...strayIn(file, text));
  }
  return hits;
}

/** The hits in one file's strings that its allowance doesn't cover. */
function strayIn(file: string, text: string): string[] {
  const allowed = ALLOWED[file];
  const hits: string[] = [];
  for (const s of strings(file, text)) {
    for (const m of s.matchAll(EXAMPLE_WORDS)) {
      if (allows(allowed, m[0], s)) continue;
      hits.push(`${file}: "${m[0]}" in "${s.replace(/\s+/g, " ").slice(0, 120)}"`);
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
    for (const [file, a] of Object.entries(ALLOWED)) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const used = strings(file, text).some((s) => [...s.matchAll(EXAMPLE_WORDS)].some((m) => allows(a, m[0], s)));
      expect(used, `${file} no longer needs its allowance`).toBe(true);
    }
  });

  it("an allowance scoped to one string covers only that string, not the rest of its file", () => {
    const file = "src/app/(app)/quotes/actions.ts";
    const schedule = `const a = 'ckt = circuit position ("1","2"…). wire = e.g. "12/2","14/2","10/3".';`;
    const estimator = `const b = "You are an estimator. Price the wire (e.g. 12/2 NM-B) by the foot.";`;
    expect(strayIn(file, schedule)).toEqual([]);
    expect(strayIn(file, `${schedule}\n${estimator}`)).toEqual([
      `${file}: "12/2" in "You are an estimator. Price the wire (e.g. 12/2 NM-B) by the foot."`,
    ]);
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

  it("an electrical company keeps its field-tested words word for word (cn-v339: 'Propane or natural gas?')", () => {
    // The voice rule as it shipped from the cn-v339 field test, before Wave A.
    expect(voiceEstimateRule("electrical")).toBe(
      "3. BUILDING AN ESTIMATE OUT LOUD: do NOT narrate each line as you add it — the screen fills in the lines. Jump to the KEY POINTS and the running/final TOTAL. And CONFIRM the make-or-break assumptions FIRST, before you price a big list on them — the ones that change everything: fuel type (propane / natural gas), panel or service size, overhead vs underground, permitted or not. Ask 'Propane or natural gas?' up front so they never have to sit through a whole list and then correct it. When it's built, say the total and one-line summary and ask if it's good — never recite it line by line.\n",
    );
    expect(tradeRuleWords("electrical")).toEqual({
      clarifying: "residential vs commercial, panel size, etc.",
      webSpecs: "pull real specs like wire/breaker sizes",
      cardFacts: "gate/lockbox code, balance due, hours today, amp size, next appointment",
    });
  });

  it("every other trade gets the same rules in its own terms", () => {
    for (const k of ["deck", "general", "plumbing", "hvac", "painting", ""] as const) {
      const rule = voiceEstimateRule(k);
      expect(rule, k).toContain("in THIS trade");
      expect(rule, k).toMatch(/^3\. BUILDING AN ESTIMATE OUT LOUD: .* never recite it line by line\.\n$/);
      expect(rule, k).not.toMatch(/propane|natural gas|panel|overhead vs underground/i);
      expect(JSON.stringify(tradeRuleWords(k)), k).not.toMatch(ELECTRICIAN_WORDS);
      expect(JSON.stringify(tradeRuleWords(k)), k).not.toMatch(/\bwire\b/i);
    }
  });

  it("the chat route uses them all", () => {
    const route = readFileSync(join(ROOT, "src/app/api/chat/route.ts"), "utf8");
    expect(route).toContain("${NORT_EXAMPLES_RULE}");
    expect(route).toContain("${engineeringLine(trade.key)}");
    expect(route).toContain("tradeRuleWords(trade.key)");
    for (const w of ["ruleWords.webSpecs", "ruleWords.clarifying", "ruleWords.cardFacts", "voiceEstimateRule(trade.key)"])
      expect(route, w).toContain(w);
    // ...and no copy of either version is left hard-wired into it.
    expect(route).not.toContain("Propane or natural gas?");
    expect(route).not.toContain("the size of what's there, permitted or not");
  });
});
