import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { taskBookFromRows, taskModeDraft, taskModePrompt } from "./task-mode";

/**
 * DRAFT WITH ESTIMATOR IN TASK MODE: the model splits, code checks, taskLines prices from HIS
 * numbers, and every refusal is said. The prompt's promises are pinned here because the model
 * cannot be run in a unit test, and a prompt that quietly starts asking for prices again is the
 * speculation coming back one word at a time.
 */
const SCOPE = [
  "Install the transfer switch by the panel, about 3 hours, one 50 amp breaker.",
  "Run hot tub wires out to the pad, 2 runs of 6/3.",
  "Clean up speaker and phone wires. Whole thing is 4 full days.",
].join("\n");

const BOOK = taskBookFromRows([
  { code: "R1", description: "Transfer switch, 200A", unit: "ea", buy_price: 400, markup_pct: 0 },
  { code: "", description: "no code — not in the book" },
  null,
]);
const ctx = { book: BOOK, rate: 145, pricing: { levelPct: null, orgDefaultPct: 20 } };

describe("taskModePrompt", () => {
  const prompt = taskModePrompt({ trade: "electrical contractor", playbook: " Always quote the permit. " });

  it("names the trade, asks for the task shape with the fragment, and forbids every invention", () => {
    expect(prompt).toContain("helping an electrical contractor");
    expect(prompt).toContain('"tasks": [ ... ]');
    expect(prompt).toContain('{"name": string, "hours": number|null, "heard": string, "materials": [{"words": string, "qty": number|null}]}');
    expect(prompt).toContain("copied VERBATIM");
    expect(prompt).toContain("A time he gave for the whole job is nobody's task's hours: null");
    expect(prompt).toContain("Days are never converted to hours: null");
    expect(prompt).toContain('("a", "an" or "one" in front of it is 1); no count said: null');
    expect(prompt).toContain("A fragment is ONE line of his scope, never several");
    expect(prompt).toContain("NEVER: a price, a catalog code, a labor rate, a part he did not name, a task he did not describe");
  });

  it("carries the description and questions rules of the priced-lines prompt, and the company notes last", () => {
    expect(prompt).toContain('"description" = HIS OWN SCOPE, rewritten as 2-5 sentences');
    expect(prompt).toContain('"questions" = AT MOST TWO, and usually ZERO');
    expect(prompt.trimEnd().endsWith("Company notes (apply on top; his words still govern):\nAlways quote the permit.")).toBe(true);
    expect(taskModePrompt({ trade: "contractor" })).not.toContain("Company notes");
  });

  it("sends NO price book and no rate: the model does not price", () => {
    expect(prompt).not.toContain("PRICE BOOK");
    expect(prompt).not.toMatch(/\$\d/);
    expect(prompt).not.toContain("home_depot");
    expect(prompt).not.toContain("unit_cost");
  });
});

describe("taskBookFromRows", () => {
  it("keys the rows by code as stored and skips the codeless and the junk", () => {
    expect([...BOOK.keys()]).toEqual(["R1"]);
    expect(BOOK.get("R1")?.description).toBe("Transfer switch, 200A");
  });
});

describe("taskModeDraft", () => {
  it("one task → one line priced from HIS hours at the rate; his part is named and asks for a price", () => {
    const out = taskModeDraft(
      SCOPE,
      {
        description: "  Install a transfer   switch and run the hot tub wires. ",
        tasks: [
          {
            name: "Install transfer switch",
            hours: 3,
            heard: "Install the transfer switch by the panel, about 3 hours, one 50 amp breaker.",
            materials: [{ words: "50 amp breaker", qty: 1 }],
          },
        ],
        questions: ["  Is the hot tub pad already poured?  ", ""],
      },
      ctx,
    );
    expect(out.description).toBe("Install a transfer switch and run the hot tub wires.");
    expect(out.items).toHaveLength(1);
    const [line] = out.items;
    expect(line.description).toBe("Install transfer switch");
    expect(line.quantity).toBe(1);
    expect(line.unit_price).toBe(435); // 3 h × $145; the breaker has no price yet
    expect(line.flag).toBe("price? 50 amp breaker");
    expect(line.detail).toMatchObject({ hours: 3, rate: 145, units: null, kit_id: null });
    expect(line.detail?.materials).toEqual([{ code: null, name: "50 amp breaker", qty: 1, cost: null, sell: null }]);
    expect(out.questions).toEqual(["Is the hot tub pad already poured?"]);
  });

  it("a task without hours asks; what the gate refused is SAID after his questions as Not taken", () => {
    const out = taskModeDraft(
      SCOPE,
      {
        tasks: [
          { name: "Clean up speaker and phone wires", hours: 4, heard: "Clean up speaker and phone wires. Whole thing is 4 full days." },
          { name: "Patch drywall", hours: 2, heard: "patch the drywall where the wires ran" },
          { name: "Run hot tub wires", hours: null, heard: "Run hot tub wires out to the pad, 2 runs of 6/3.", materials: [{ words: "GFCI spa panel", qty: 1 }] },
        ],
        questions: ["Which pad?"],
      },
      ctx,
    );
    expect(out.items.map((l) => l.description)).toEqual(["Clean up speaker and phone wires", "Run hot tub wires"]);
    expect(out.items[0].unit_price).toBe(0);
    expect(out.items[0].flag).toBe("hours?");
    expect(out.items[1].detail?.materials).toEqual([]);
    expect(out.questions).toEqual([
      "Which pad?",
      "Not taken: Clean up speaker and phone wires: 4 h was not said as hours",
      "Not taken: not in the scope: Patch drywall",
      "Not taken: Run hot tub wires: a part he did not name: GFCI spa panel",
    ]);
  });

  it("the rate it is handed is the rate: a stated $/hr prices the hours, and no rate says so", () => {
    const task = { name: "Install transfer switch", hours: 3, heard: "Install the transfer switch by the panel, about 3 hours" };
    expect(taskModeDraft(SCOPE, { tasks: [task] }, { ...ctx, rate: 200 }).items[0].unit_price).toBe(600);
    const none = taskModeDraft(SCOPE, { tasks: [task] }, { ...ctx, rate: 0 }).items[0];
    expect(none.unit_price).toBe(0);
    expect(none.flag).toBe("no company labor rate set");
  });

  it("junk in is an empty draft out, never a throw", () => {
    expect(taskModeDraft(SCOPE, null, ctx)).toEqual({ items: [], questions: [], description: "" });
    expect(taskModeDraft(SCOPE, { tasks: "x", questions: 7, description: 3 }, ctx)).toEqual({ items: [], questions: [], description: "3" });
  });
});

describe("the server action takes task mode on the free-text path only", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/actions.ts"), "utf8");
  const helperAt = src.indexOf("async function runEstimatorTasks(");
  const coreAt = src.indexOf("async function runEstimator(");
  const helper = src.slice(helperAt, coreAt);
  const core = src.slice(coreAt, src.indexOf("function estimatorError(", coreAt));

  it("branches before the priced-lines prompt, for a string scope on a non-catalog org, with his stated rate winning", () => {
    expect(helperAt).toBeGreaterThan(-1);
    expect(helperAt).toBeLessThan(coreAt);
    const branch = core.indexOf('if (typeof content === "string" && !catalogMode)');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(core.indexOf("const system: Anthropic.MessageCreateParams"));
    expect(core).toContain("return runEstimatorTasks({");
    expect(core).toContain("rate: stated ?? rate,");
    expect(core).toContain("levelPct: markupPct ?? null,");
  });

  it("the helper sends the task prompt only, meters usage, refuses a truncated answer, and prices through taskModeDraft", () => {
    expect(helper).toContain("taskModePrompt({ trade, playbook })");
    expect(helper).toContain("recordAiUsage({");
    expect(helper).toContain('if (msg.stop_reason === "max_tokens")');
    expect(helper).toContain("taskModeDraft(scope, parsed, {");
    expect(helper).toContain("book: taskBookFromRows(rows),");
    // No calculators, no catalog block, no per-line pricing of the model's numbers.
    expect(helper).not.toContain("CALC_TOOLS");
    expect(helper).not.toContain("PRICE BOOK (code");
    expect(helper).not.toContain("mapEstimatorLine(");
  });
});
