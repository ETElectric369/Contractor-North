import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderers, text } from "./editor-test-mocks";

/**
 * THE TASK IS THE LINE, ON THE ONE EDITOR (0386; cn-v1132 moved it from the builder to
 * quotes/task-breakdown.tsx, which both estimate pages render). A line that carries a breakdown
 * shows its labor and parts under the description and ASKS where a number is missing; a line
 * without one renders exactly as before. The rate the hours price at comes through THE one rule
 * (laborRateFor) from the org default the page hands in — pinned at the source, because an editor
 * that forgets the prop still compiles and prices every task's hours at $0 while saying "no company
 * labor rate set".
 *
 * LABOR IS ONE ROW PER RATE (cn-v1131). Erik: "im curious how to add time at a different pay rate
 * and i noticed the 145 on there and i thought i had updated that in the backend to 135". Each row
 * names who (Labor · a person · his own word), asks its hours, and says beside the figure where it
 * came from — "company default", "<name>'s rate", "typed", "from the scope".
 */

const { EstimateEditor } = await import("./estimate-editor");
const { splitLineNote, joinLineNote } = await import("./task-breakdown");
const { unsaved, saved } = renderers(EstimateEditor);

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
// The company default is $145/h on every render here, so a rule row's chip can name its source.
const builder = (p: Record<string, unknown> = {}) => {
  const { seededLines, ...cat } = p as { seededLines?: unknown[] } & Record<string, unknown>;
  return unsaved({ items: seededLines ?? [] }, cat);
};

const rule = { label: null, person_id: null, hours: null, rate: 145, rate_from: "rule" as const };
const taskLine = {
  description: "Install transfer switch",
  quantity: 1,
  unit: "ea",
  unit_price: 480,
  flag: "hours? · price? a 50 amp breaker",
  detail: {
    task_id: "t1",
    labor: [rule],
    units: null,
    kit_id: null,
    materials: [
      { code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 480 },
      { code: null, name: "a 50 amp breaker", qty: null, cost: null, sell: null },
    ],
  },
};
const people = [
  { id: "p1", name: "Snowbell", billRate: 135 },
  { id: "p2", name: "Larkspur", billRate: null },
];

describe("a task line on the editor", () => {
  it("shows the breakdown: one labor row asks its hours at the rule's rate, each part has a count and a price box, and the sums read", () => {
    const html = builder({ seededLines: [taskLine] });
    expect(html).toContain('aria-label="Who"');
    expect(html).toContain('placeholder="hours?"');
    expect(text(html)).toContain("× $145.00/h · company default");
    expect(html).toContain('placeholder="Part"');
    expect(html).toContain('value="Transfer switch, 200A"');
    expect(html).toContain('value="a 50 amp breaker"');
    expect((html.match(/placeholder="how many"/g) ?? []).length).toBe(2);
    expect((html.match(/placeholder="price\?"/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="Remove This Part"');
    expect(html).toContain("Add A Part");
    expect(text(html)).toContain("Add Labor At Another Rate");
    // The first row is the task's labor: it never offers to leave.
    expect(html).not.toContain('aria-label="Remove This Labor"');
    expect(text(html)).toContain("Parts $480.00");
    // The flag is REBUILT from the breakdown by the one coercer (coerceDraftLine → taskFlags): the
    // seed said "hours? · price?", the part with no count also asks how many. A breakdown that adds
    // up prints no hand-price note.
    expect(text(html)).toContain("hours? · how many? a 50 amp breaker · price? a 50 amp breaker");
    expect(text(html)).not.toContain("Price set by hand");
  });

  it("THIS MANY OF THE TASK (cn-v1133): at qty 2 the breakdown's sum says what the paper will charge — $480.00 × 2 = $960.00; at qty 1 no such row", () => {
    const t = text(builder({ seededLines: [{ ...taskLine, quantity: 2 }] }));
    expect(t).toContain("$480.00 × 2 = $960.00");
    expect(t).not.toContain("Price set by hand"); // the breakdown explains the UNIT price; the count rides the line
    expect(text(builder({ seededLines: [taskLine] }))).not.toContain(" × 1 = ");
  });

  it("THE SAME BREAKDOWN ON THE SAVED PAGE (Erik's morning): a stored task line reads with its rows, never as a plain row", () => {
    const row = { id: "li-1", description: taskLine.description, quantity: 1, unit: "ea", unit_price: 480, category: "Tasks", detail: taskLine.detail, sort_order: 0 };
    const html = saved({}, [row]);
    expect(html).toContain('aria-label="Who"');
    expect(html).toContain('placeholder="hours?"');
    expect(text(html)).toContain("× $145.00/h · company default");
    expect(html).toContain('value="Transfer switch, 200A"');
    // The group came back as the line's category.
    expect(text(html)).toContain("Tasks · 1 item");
    // The flag is build-time only and is rebuilt from the stored breakdown (the row carries none).
    expect(text(html)).toContain("hours? · how many? a 50 amp breaker · price? a 50 amp breaker");
  });

  it("two rows at two rates render two chips with their source words; a person row says <name>'s rate", () => {
    const line = {
      ...taskLine,
      unit_price: 905, // 2 h × $145 + 1 h × $135 + $480 of parts
      flag: "price? a 50 amp breaker",
      detail: {
        ...taskLine.detail,
        labor: [
          { ...rule, hours: 2 },
          { label: null, person_id: "p1", hours: 1, rate: 135, rate_from: "rule" as const },
        ],
      },
    };
    const html = builder({ seededLines: [line], people });
    const t = text(html);
    expect(t).toContain("× $145.00/h · company default");
    expect(t).toContain("× $135.00/h · Snowbell's rate");
    expect(t).toContain("$290.00");
    expect(t).toContain("$135.00");
    expect(t).toContain("Labor $425.00");
    expect((html.match(/aria-label="Remove This Labor"/g) ?? []).length).toBe(1);
    expect(html).toContain(">Labor</option>");
    expect(html).toContain('value="person:p1"');
    expect(html).toContain(">Snowbell</option>");
    expect(html).toContain(">Larkspur</option>");
    expect(html).toContain('value="other"');
    expect(t).not.toContain("Price set by hand");
  });

  it("a typed rate says typed, a dictated one says from the scope, an old one-figure row says only what it was quoted at", () => {
    const line = {
      ...taskLine,
      unit_price: 1175,
      detail: {
        ...taskLine.detail,
        labor: [
          { label: null, person_id: null, hours: 2, rate: 200, rate_from: "hand" as const },
          { label: "2-man crew", person_id: null, hours: 1, rate: 150, rate_from: "stated" as const },
          { label: null, person_id: null, hours: 1, rate: 145, rate_from: "legacy" as const },
        ],
      },
    };
    const html = builder({ seededLines: [line], people });
    const t = text(html);
    expect(t).toContain("× $200.00/h · typed");
    expect(t).toContain("× $150.00/h · from the scope");
    expect(t).toContain("quoted at $145.00/h");
    expect(html).toContain('value="2-man crew"');
    expect(t).not.toContain("Price set by hand");
  });

  it("a row priced for somebody who has left the team keeps a row to sit on (Title Case, an option), and its chip says the rule has moved on", () => {
    const line = { ...taskLine, unit_price: 615, detail: { ...taskLine.detail, labor: [{ label: null, person_id: "gone", hours: 1, rate: 135, rate_from: "rule" as const }] } };
    const html = builder({ seededLines: [line], people });
    expect(html).toContain('value="person:gone"');
    expect(text(html)).toContain("Someone No Longer On The Team");
    expect(text(html)).toContain("quoted at $135.00/h · the rule says $145.00/h now");
  });

  it("A RULE ROW THE RULE HAS LEFT BEHIND: a row stored at $145 after the default moved to $135 says what it was quoted at and what the rule says now — never 'company default' beside a figure that is not", () => {
    const t = text(builder({ seededLines: [{ ...taskLine, detail: { ...taskLine.detail, labor: [{ ...rule, hours: 2 }] }, unit_price: 770 }], defaultLaborRate: 135 }));
    expect(t).toContain("quoted at $145.00/h · the rule says $135.00/h now");
    expect(t).not.toContain("× $145.00/h · company default");
    expect(text(builder({ seededLines: [taskLine] }))).toContain("× $145.00/h · company default");
    expect(text(builder({ seededLines: [taskLine], defaultLaborRate: 0 }))).toContain("quoted at $145.00/h · the rule says no rate now");
    // The way back is offered to such a row too (beside the box when the chip is open), by the rule's
    // name — and it is a DECISION, so it is written at once (commit), not merely typed.
    const src = read("src/app/(app)/quotes/task-breakdown.tsx");
    expect(src).toContain("const back = cents(live.rate) !== row.rate ? backWords(live) : null;");
    expect(src).toContain('commit(laborWith(i, { rate: cents(live.rate), rate_from: "rule" }));');
  });

  it("A STORED LINE FROM AN OLDER BUILD: the one-figure {hours, rate} shape reads as ONE legacy row and the breakdown renders instead of throwing", () => {
    const oldShape = {
      id: "li-old",
      description: "Install transfer switch",
      quantity: 1,
      unit: "ea",
      unit_price: 3380,
      category: null,
      sort_order: 0,
      detail: { task_id: "t-old", hours: 20, rate: 145, hours_from_kit: false, units: null, kit_id: null, materials: [{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 480 }] },
    };
    const html = saved({ title: "Larkspur panel" }, [oldShape], {}, { companyEstimateFormat: "tasks" });
    expect(html).toContain('value="Larkspur panel"');
    expect(html).toContain('value="Install transfer switch"');
    expect(html).toContain('aria-label="Who"');
    expect(html).toContain('aria-label="Hours"');
    expect(html).toContain('value="20"');
    expect(text(html)).toContain("quoted at $145.00/h"); // the legacy row, with no source words to claim
    expect(html).toContain('value="Transfer switch, 200A"');
    // His price stands: 20 × 145 + 480 = 3380 explains the line, so no hand-price note.
    expect(text(html)).not.toContain("Price set by hand");
    // Both pages read a stored line through the one coercer (lineFromRow → coerceDraftLine).
    const src = read("src/app/(app)/quotes/estimate-editor.tsx");
    expect(src).toContain("export function lineFromRow(r: SavedLineRow): DraftLineItem & { id: string } {");
    expect(src).toContain("...coerceDraftLine({");
  });

  it("a Unit $ typed over the sum says the breakdown stays off the paper", () => {
    const html = builder({ seededLines: [{ ...taskLine, unit_price: 450 }] });
    expect(text(html)).toContain("Price set by hand — the breakdown stays off the paper");
  });

  it("a line without a breakdown renders exactly as before, with the one door to become a task", () => {
    const plain = builder({ seededLines: [{ description: "Permit", quantity: 1, unit: "ea", unit_price: 250 }] });
    expect(plain).not.toContain('placeholder="hours?"');
    expect(plain).not.toContain("Add A Part");
    expect(text(plain)).toContain("Make This A Task");
    expect(builder({ seededLines: [{ description: "Permit", quantity: 1, unit: "ea", unit_price: 250, detail: null }] })).toBe(plain);
    // A task line already is one.
    expect(text(builder({ seededLines: [taskLine] }))).not.toContain("Make This A Task");
  });
});

describe("Add A Task and Make This A Task", () => {
  const src = read("src/app/(app)/quotes/estimate-editor.tsx");
  it("both buttons are on the screen, Title Case, beside Add A Line — on both pages", () => {
    for (const html of [builder(), saved()]) {
      const t = text(html);
      expect(t).toContain("Add A Task");
      expect(t).toContain("Add A Line");
      expect(t).not.toMatch(/\bAdd\s*<\/button>/);
    }
  });
  it("Add A Task starts from emptyTaskDetail at the rule's rate under Tasks and focuses the name; Make This A Task goes through taskFromLine and is written at once", () => {
    // The render cannot press the buttons (no DOM), so the two doors are pinned at the source; the
    // writes they reach (addLine, commitLine) are driven in use-quote-writes.test.ts.
    expect(src).toContain("const detail = emptyTaskDetail(rule);");
    expect(src).toContain('setFocusKey(session.addLine({ description: "", quantity: 1, unit: "ea", unit_price: 0, group: "Tasks", detail, flag: taskFlags(detail) }));');
    expect(src).toContain("autoFocus={focusKey === it.key}");
    expect(src).toContain("void session.commitLine(l.key, taskFromLine(l, rule));");
  });
});

describe("the rate reaches the editor through the one rule", () => {
  it("both pages hand in the org default and the team, and the editor resolves the rule with laborRateFor's object form", () => {
    for (const p of ["src/app/(app)/quotes/new/page.tsx", "src/app/(app)/quotes/[id]/page.tsx"]) {
      const page = read(p);
      const tag = page.slice(page.indexOf("<EstimateEditor"), page.indexOf("/>", page.indexOf("<EstimateEditor")));
      expect(tag, p).toContain("people,");
      expect(tag, p).toMatch(/defaultLaborRate: (settings|orgS)\.default_labor_rate,/);
      expect(tag, p).toMatch(/companyEstimateFormat(,|: companyPaperFormat,)/);
      // The team off the same view the job's labor billing reads its rates from — never their pay rate.
      expect(page, p).toContain('supabase.from("profile_pay").select("id, full_name, bill_rate").eq("active", true).order("full_name")');
    }
    expect(read("src/app/(app)/quotes/new/page.tsx")).toContain("laborRateFor({ levelRate: seedCustomer?.pricing_levels?.labor_rate, orgDefault: settings.default_labor_rate }).rate");
    // The saved page reads the level's labor rate with the row (projection law) and hands it as the level.
    expect(read("src/app/(app)/quotes/[id]/page.tsx")).toContain("customers(*, pricing_levels(markup_pct, labor_rate))");
    expect(read("src/app/(app)/quotes/[id]/page.tsx")).toContain("level: { markup: q.customers?.pricing_levels?.markup_pct ?? null, rate: q.customers?.pricing_levels?.labor_rate ?? null },");
    const editor = read("src/app/(app)/quotes/estimate-editor.tsx");
    const breakdown = read("src/app/(app)/quotes/task-breakdown.tsx");
    expect(breakdown).toContain('import { laborRateFor, laborRateFromWords, type LaborRateFrom } from "@/lib/pricing/labor-rate";');
    expect(editor).toContain("const rule = laborRateFor({ levelRate, orgDefault: defaultLaborRate });");
    // A row's own rule: the person's Team rate on top of the estimate's two rungs.
    expect(breakdown).toContain("laborRateFor({ personRate: person?.billRate, levelRate, orgDefault: defaultLaborRate })");
    // Every edit of the breakdown re-prices through lineFromDetail: typing moves the line on screen,
    // leaving a box or a tap that decides commits it (the one save model).
    expect(breakdown).toContain("const type = (next: TaskDetail) => onChange(lineFromDetail(line, next));");
    expect(breakdown).toContain("const commit = (next: TaskDetail) => onCommit(lineFromDetail(line, next));");
    // Typing a rate makes it his; typing hours makes them his (the kit's mark comes off that row).
    expect(breakdown).toContain('setLabor(i, { rate: n > 0 ? n : 0, rate_from: "hand" })');
    expect(breakdown).toContain("const { from_kit: _k, ...rest } = r;");
    // A Who pick goes through rowForWho and is a decision: committed.
    expect(breakdown).toContain("commit(laborWith(i, rowForWho(row, who, ruleInputs)));");
  });
});

describe("the paper switch (Labor And Parts On The Paper)", () => {
  it("sits by the totals on both pages, seeded from the row, and goes through the one header write", () => {
    const t = text(builder({ companyEstimateFormat: "tasks" }));
    expect(t).toContain("Labor And Parts On The Paper");
    expect(t).toContain("Company Default · Off");
    expect(text(builder({ companyEstimateFormat: "detailed" }))).toContain("Company Default · On");
    const stored = saved({ estimate_format: "detailed" }, [], {}, { companyEstimateFormat: "tasks" });
    expect(stored).toMatch(/bg-white text-slate-900 shadow-sm">Show</);
    expect(stored).not.toMatch(/bg-white text-slate-900 shadow-sm">Hide</);
    const src = read("src/app/(app)/quotes/estimate-editor.tsx");
    expect(src).toContain('import { PaperFormatSwitch } from "./paper-format-switch";');
    expect(src).toContain('estimateFormat: q.estimate_format === "tasks" || q.estimate_format === "detailed" ? q.estimate_format : null,');
    expect(src).toContain('commitField("estimateFormat");');
    // Only while the estimate is still editable — the lock's own words say why a sent one is not.
    expect(text(saved({}, [], { lock: { reason: "A signed contract." } }))).not.toContain("Labor And Parts On The Paper");
    // The new page no longer adopts a draft into the browser: a lead's draft is OPENED where it lives.
    const page = read("src/app/(app)/quotes/new/page.tsx");
    expect(page).toContain("if (existing?.id) redirect(`/quotes/${existing.id}`);");
    expect(page).toContain("const companyEstimateFormat = normalizeDocStyle(settings.doc_style).estimate_format;");
  });
});

describe("Remember As A Kit (W4)", () => {
  it("a task line offers the door; a line built from a kit names the kit and its units instead", () => {
    const html = builder({ seededLines: [taskLine] });
    expect(text(html)).toContain("Remember As A Kit");
    const kitLabor = [{ ...rule, hours: 14 }];
    const fromKit = builder({
      seededLines: [{ ...taskLine, description: "Footings ×7", unit_price: 2510, detail: { ...taskLine.detail, labor: kitLabor, units: 7, kit_id: "k1" } }],
      taskKits: [{ id: "k1", name: "Footing", labor_minutes: 120, unit: "footing", items: [] }],
    });
    expect(text(fromKit)).toContain("From the kit Footing · Units");
    expect(fromKit).toContain('aria-label="Units"');
    expect(fromKit).toContain('value="7"');
    expect(text(fromKit)).toContain("footing");
    expect(text(fromKit)).toContain("your hours stand; the kit’s parts follow the units");
    expect(text(fromKit)).not.toContain("Remember As A Kit");
    const gone = builder({
      seededLines: [{ ...taskLine, description: "Footings ×7", unit_price: 2510, detail: { ...taskLine.detail, labor: kitLabor, units: 7, kit_id: "k1" } }],
      taskKits: [],
    });
    expect(text(gone)).toContain("From the kit it was built from (no longer in your kits) · ×7");
    expect(gone).not.toContain('aria-label="Units"');
  });

  it("a plain line has no door, and the company's Kits switch off hides it", () => {
    expect(text(builder({ seededLines: [{ description: "Permit", quantity: 1, unit: "ea", unit_price: 250 }] }))).not.toContain("Remember As A Kit");
    expect(text(builder({ seededLines: [taskLine], kitsOn: false }))).not.toContain("Remember As A Kit");
  });
});

describe("A NOTE UNDER A LINE (cn-v1137): the description's lines after the head, behind Add A Note / Edit Note", () => {
  const src = read("src/app/(app)/quotes/task-breakdown.tsx");

  it("the box holds the head only, the note's lines read under it, and the door says Edit Note", () => {
    const html = builder({ seededLines: [{ description: "Panel upgrade, 200A\nIncludes the permit\nTwo-day job", quantity: 1, unit: "ea", unit_price: 2400 }] });
    expect(html).toContain('value="Panel upgrade, 200A"');
    expect(html).not.toContain('value="Panel upgrade, 200A\n');
    expect(html).toContain("<li>Includes the permit</li><li>Two-day job</li>");
    expect(text(html)).toContain("Edit Note");
    expect(text(html)).not.toContain("Add A Note");
  });

  it("a line with no note offers Add A Note, once per line and never on a task's parts", () => {
    const plain = builder({ seededLines: [{ description: "Permit", quantity: 1, unit: "ea", unit_price: 250 }] });
    expect(text(plain)).toContain("Add A Note");
    expect(text(plain)).not.toContain("Edit Note");
    expect((plain.match(/Add A Note/g) ?? []).length).toBe(1);
    // A task line has two part boxes (the same LineDescInput): still one door, the line's.
    const task = builder({ seededLines: [taskLine] });
    expect((task.match(/Add A Note|Edit Note/g) ?? []).length).toBe(1);
    expect(src).toContain('placeholder="Part"\n              className={box}\n              value={m.name}\n              noteDoor={false}');
  });

  it("join and split live in lib/estimate/line-note (skeptic #43, S6), so the task, part and kit readers share the one rule; the breakdown re-exports them", () => {
    const breakdown = read("src/app/(app)/quotes/task-breakdown.tsx");
    expect(breakdown).toContain('import { joinLineNote, splitLineNote } from "@/lib/estimate/line-note";');
    expect(breakdown).toContain("export { joinLineNote, splitLineNote };");
    expect(breakdown).not.toContain("export function splitLineNote(");
    for (const rel of ["src/lib/estimate/task-lines.ts", "src/lib/estimate/born-with-tasks.ts"]) expect(read(rel), rel).toMatch(/import \{ (joinLineNote, )?splitLineNote \} from "\.\/line-note";/);
    expect(read("src/lib/estimate/born-with-tasks.ts")).toContain('const title = splitLineNote(String(r.description ?? "")).head.trim();');
  });

  it("join and split: the head stays the first line, an empty or blank note puts the description back on one line", () => {
    expect(joinLineNote("Head", "")).toBe("Head");
    expect(joinLineNote("Head", "   \n ")).toBe("Head");
    expect(joinLineNote("Head", "Note line")).toBe("Head\nNote line");
    expect(joinLineNote("Head", "A\nB")).toBe("Head\nA\nB");
    expect(splitLineNote("Head\nA\nB")).toEqual({ head: "Head", note: "A\nB" });
    expect(splitLineNote("Head")).toEqual({ head: "Head", note: "" });
    expect(splitLineNote("")).toEqual({ head: "", note: "" });
    // A newline cannot be typed into the head: it would make a second note line out of the name.
    expect(joinLineNote("Head\nsneaky", "Note")).toBe("Head sneaky\nNote");
    // Round trip, with a trailing newline he is mid-typing kept (the box would lose it otherwise).
    for (const d of ["Head\nNote", "Head\nA\nB\n", "Head"]) {
      const { head, note } = splitLineNote(d);
      expect(joinLineNote(head, note)).toBe(d);
    }
  });

  it("every keystroke in either box goes out as the one joined description; the autocomplete matches the head alone; leaving the note commits and closes it", () => {
    expect(src).toContain("onText(joinLineNote(e.target.value, note));");
    expect(src).toContain("onChange={(e) => onText(joinLineNote(head, e.target.value))}");
    expect(src).toContain("const q = head.trim().toLowerCase();");
    expect(src).toContain("onBlur={() => {\n                setNoteOpen(false);\n                onBlur?.();\n              }}");
    expect(src).toContain('{hasNote ? "Edit Note" : "Add A Note"}');
  });
});
