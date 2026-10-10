import { describe, it, expect } from "vitest";
import { coerceByPlaybook, answerText, factsForEstimator, retiredAnswers } from "./answers";
import { applyHeard, hearRequest, parseHeard } from "./hear";
import { parsePlaybook } from "./parse";
import { applyFills, countsIn, hoursIn, isAnswered, numbersIn } from "./resolve";
import { coerceTasks, mergeHeardTasks, saidIn, sameTask, screenHeardTask, taskAsking, taskLine, taskText } from "./tasks";
import type { Fill, Playbook, TaskValue } from "./types";

/**
 * A TASK IS THE UNIT. These tests hold the one law the slot exists for: an estimate carries only
 * what the visit recorded — his tasks, his hours, his parts — and a hole ASKS, it never guesses.
 * The model only structures; every name, part and number it hands back is screened against the
 * words it says they came from, and what fails the screen is SAID in the note, never kept.
 */

const PB: Playbook = {
  needs: [
    { key: "work_kind", label: "Service call or job", ask: "Is this a service call, or a job?", slot: { type: "select", options: ["Service call", "Contract job"] } },
    { key: "tasks", label: "Tasks", ask: "What are the tasks? Each with its hours and materials.", slot: { type: "tasks" }, hold: true, why: "Each task is a line on the estimate" },
    { key: "access", label: "Access", ask: "How am I getting to it?", slot: { type: "select", options: ["Open / easy", "Attic"] } },
    { key: "scope", label: "Scopes", ask: "Which scopes?", slot: { type: "scopes" } },
    { key: "panel", label: "Panel", ask: "What's the panel?", slot: { type: "text" } },
  ],
};

// His own lines from a real visit, stand-in street ("Bayberry").
const SAID =
  "Bayberry job. Generator plug needs a manual transfer switch, call it 3 hours. One vent fan in each of " +
  "2 bathrooms, 2 fans, say 4 hours for both. 50 amp 240 volt circuit to the range from the upstairs panel " +
  "with conduit on the outside of the wall, 60 feet of 6/3 and a 50 amp breaker. Clean up the hot tub wires. " +
  "Whole thing is 4 full days.";

const fills = (f: unknown[]) => f as Fill[];

describe("the slot parses and coerces like every other answer", () => {
  it("a tasks slot survives the parser (the parser is the gate)", () => {
    const pb = parsePlaybook({ needs: [{ key: "t", label: "Tasks", ask: "Tasks?", slot: { type: "tasks" } }] });
    expect(pb.needs[0].slot).toEqual({ type: "tasks" });
  });

  it("coerces shape only: name required, hours and qty positive or null, never 0", () => {
    const got = coerceTasks([
      { name: " Transfer switch ", hours: "3", materials: [{ words: "6/3", qty: "60" }, { code: "BRK50" }, { qty: 4 }] },
      { name: "", hours: 2 },
      { name: "Hot tub wires", hours: 0, units: "", materials: "nope" },
      { name: "Tiny", hours: 0.004, materials: [{ words: "a", qty: 0.002 }] },
    ]);
    expect(got).toHaveLength(3);
    expect(got![0]).toMatchObject({ name: "Transfer switch", hours: 3, units: null, kit_id: null });
    expect(got![0].materials).toEqual([
      { words: "6/3", code: null, qty: 60 },
      { code: "BRK50", words: null, qty: null },
    ]);
    expect(got![1]).toMatchObject({ name: "Hot tub wires", hours: null, materials: [] });
    // A figure that rounds to 0 is a hole, not a zero.
    expect(got![2]).toMatchObject({ hours: null, materials: [{ words: "a", qty: null }] });
    expect(got![0].id).toBeTruthy();
  });

  it("an empty list is null — null is visible, [] reads as answered-with-nothing", () => {
    expect(coerceTasks([])).toBeNull();
    expect(coerceTasks("three tasks")).toBeNull();
    expect(coerceByPlaybook(PB, { tasks: [{ hours: 3 }] }).tasks).toBeNull();
  });

  it("the same id twice keeps the first", () => {
    const got = coerceTasks([{ id: "a", name: "One" }, { id: "a", name: "Two" }]);
    expect(got!.map((t) => t.name)).toEqual(["One"]);
  });

  it("a task without hours is ASKING — unless a kit answers them (W4); a list with one task is answered", () => {
    const [a, b, c] = coerceTasks([{ name: "A", hours: 2 }, { name: "B" }, { name: "C", kit_id: "k1", units: 7 }])!;
    expect(taskAsking(a)).toBe(false);
    expect(taskAsking(b)).toBe(true);
    expect(taskAsking(c)).toBe(false);
    expect(taskLine(c)).toBe("C — hours from its kit × 7");
    expect(isAnswered(coerceTasks([{ name: "A" }]))).toBe(true);
    expect(isAnswered(coerceTasks([]))).toBe(false);
  });
});

describe("what the estimator, the retired block and the prompt read", () => {
  const tasks = coerceTasks([
    { name: "Transfer switch", hours: 3, materials: [{ words: "6/3", qty: 60 }, { code: "BRK50", qty: null }] },
    { name: "Hot tub wires" },
    { name: "Footings", hours: 1.5, units: 7 },
  ])!;

  it("one line per task: his hours or hours?, his parts", () => {
    expect(taskLine(tasks[0])).toBe("Transfer switch — 3 h: 6/3 ×60, BRK50");
    expect(taskLine(tasks[1])).toBe("Hot tub wires — hours?");
    expect(taskLine(tasks[2])).toBe("Footings — 1.5 h × 7");
    expect(taskText(tasks).split("\n")).toHaveLength(3);
  });

  it("factsForEstimator carries the list as given, asking said out loud, never a figure", () => {
    const facts = factsForEstimator(PB, { tasks, work_kind: "Contract job", access: null, scope: null, panel: null });
    expect(facts).toContain("- Tasks: Transfer switch — 3 h: 6/3 ×60, BRK50");
    expect(facts).toContain("Hot tub wires — hours?");
    expect(facts).not.toContain("[object Object]");
  });

  it("answerText flattens a task list to its LINES, so a retired tasks question keeps every hour and part", () => {
    expect(answerText(tasks as never)).toBe(taskText(tasks));
    const without: Playbook = { needs: PB.needs.filter((n) => n.key !== "tasks") };
    const kept = retiredAnswers(without, { tasks });
    expect(kept.tasks).toContain("Transfer switch — 3 h: 6/3 ×60, BRK50");
    expect(kept.tasks).toContain("Footings — 1.5 h × 7");
  });

  it("a scope-pick list still says its codes, never [object Object]", () => {
    expect(answerText([{ code: "R1", qty: 2, price: 10 }] as never)).toBe("R1");
  });
});

describe("hoursIn: a figure counts as hours only when he said it as hours", () => {
  it("reads the ways he says a time", () => {
    expect(hoursIn("call it 3 hours")).toEqual([3]);
    expect(hoursIn("say 4 hours for both")).toEqual([4]);
    expect(hoursIn("about 2 hrs, maybe 2.5h")).toEqual([2, 2.5]);
    expect(hoursIn("an hour")).toEqual([1]);
    expect(hoursIn("half an hour on that")).toEqual([0.5]);
    expect(hoursIn("a half hour")).toEqual([0.5]);
    expect(hoursIn("an hour and a half")).toEqual([1.5]);
    expect(hoursIn("two and a half hours")).toEqual([2.5]);
    expect(hoursIn("twenty four hours")).toEqual([24]);
  });

  it("a bare number, a count and a time in days are NOT hours", () => {
    expect(hoursIn("install 4 receptacles in the kitchen")).toEqual([]);
    expect(hoursIn("Whole thing is 4 full days")).toEqual([]);
    expect(hoursIn("60 feet of 6/3")).toEqual([]);
    expect(numbersIn("Whole thing is 4 full days")).toEqual([4]);
  });

  it("the sentence's full stop is not part of the word, and minutes are hours too", () => {
    expect(hoursIn("Install the breaker, 3 hours.")).toEqual([3]);
    expect(hoursIn("3 hrs.")).toEqual([3]);
    expect(hoursIn("1.5 hours.")).toEqual([1.5]);
    expect(hoursIn("an hour.")).toEqual([1]);
    expect(hoursIn("30 mins on that")).toEqual([0.5]);
    expect(hoursIn("45 minutes")).toEqual([0.75]);
  });

  it("a rate, a pace, a rating and a fraction are NOT a task's hours", () => {
    expect(hoursIn("$85/hr")).toEqual([]);
    expect(hoursIn("200 per hour")).toEqual([]);
    expect(hoursIn("4 days at 8 hours a day")).toEqual([]);
    expect(hoursIn("a 2 hour rated wall")).toEqual([]);
    expect(hoursIn("3/4 hour")).toEqual([]);
    expect(hoursIn("2 hours per unit")).toEqual([]);
  });
});

describe("countsIn: a count is a number he did not say as hours or money", () => {
  it("keeps the counts and drops the hours figure", () => {
    expect(countsIn("2 fans, 2 hours")).toEqual([2]);
    expect(countsIn("Replace the outlet in the hall, 3 hours total")).toEqual([]);
    expect(countsIn("60 feet of 6/3 and a 50 amp breaker")).toEqual([60, 6, 3, 50]);
    expect(countsIn("two and a half hours for four fans")).toEqual([4]);
    expect(countsIn("call it 3 hours. $85/hr")).toEqual([]);
  });
});

describe("screenHeardTask: the model only structures", () => {
  const said = (heard: string) => ({ hours: hoursIn(heard), counts: countsIn(heard) });

  it("one of a part is said by its article; a part named without a count asks, and the hours figure is never a count", () => {
    const article = "Install a transfer switch and an outlet below the panel, 3 hours";
    const [t] = coerceTasks([{ name: "Install transfer switch and outlet", hours: 3, materials: [{ words: "transfer switch", qty: 1 }, { words: "outlet", qty: 1 }] }])!;
    expect(screenHeardTask(t, article, said(article)).task!.materials.map((m) => m.qty)).toEqual([1, 1]);
    const bare = "Install receptacles in the kitchen, 2 hours";
    const [u] = coerceTasks([{ name: "Install receptacles in the kitchen", hours: 2, materials: [{ words: "receptacles", qty: 1 }] }])!;
    const r = screenHeardTask(u, bare, said(bare));
    expect(r.task!.materials).toEqual([{ code: null, words: "receptacles", qty: null }]);
    expect(r.dropped).toEqual(["Install receptacles in the kitchen: receptacles ×1 — the count was not said"]);
    const hoursAsCount = "Replace the outlet in the hall, 3 hours total";
    const [v] = coerceTasks([{ name: "Replace the outlet in the hall", hours: 3, materials: [{ words: "outlet", qty: 3 }] }])!;
    const q = screenHeardTask(v, hoursAsCount, said(hoursAsCount));
    expect(q.task!.hours).toBe(3);
    expect(q.task!.materials[0].qty).toBeNull();
  });

  it("keeps a task he named, with the hours he said AS hours, and strips what is not his", () => {
    const heard = "Generator plug needs a manual transfer switch, call it 3 hours";
    const [t] = coerceTasks([{ id: "model-id", name: "Generator plug manual transfer switch", hours: 3, units: 2, kit_id: "K1", materials: [{ code: "ZZ9", words: "transfer switch", qty: 1 }] }])!;
    const r = screenHeardTask(t, heard, said(heard));
    expect(r.task).toMatchObject({ name: t.name, hours: 3, units: null, kit_id: null, materials: [{ code: null, words: "transfer switch", qty: 1 }] });
    expect(r.task!.id).not.toBe("model-id");
    expect(r.dropped).toEqual(["Generator plug manual transfer switch: × 2"]);
  });

  it("a task he did not name is refused whole", () => {
    const heard = "Clean up the hot tub wires";
    const [t] = coerceTasks([{ name: "Replace GFCI breaker and rewire spa disconnect", materials: [{ words: "60 amp GFCI spa breaker", qty: 1 }] }])!;
    const r = screenHeardTask(t, heard, said(heard));
    expect(r.task).toBeNull();
    expect(r.dropped[0]).toContain("a task he did not name");
  });

  it("a part he did not name is dropped; a named part may be one; a count must be said", () => {
    const heard = "50 amp 240 volt circuit to the range, 60 feet of 6/3 and a 50 amp breaker";
    const [t] = coerceTasks([{ name: "50 amp circuit to the range", materials: [{ words: "6/3", qty: 60 }, { words: "50 amp breaker", qty: 1 }, { words: "junction box", qty: 1 }, { words: "conduit", qty: 20 }] }])!;
    const r = screenHeardTask(t, heard, said(heard));
    expect(r.task!.materials).toEqual([
      { code: null, words: "6/3", qty: 60 },
      { code: null, words: "50 amp breaker", qty: 1 },
    ]);
    expect(r.dropped).toEqual(["50 amp circuit to the range: a part he did not name: junction box", "50 amp circuit to the range: a part he did not name: conduit"]);
  });

  it("a number that was not said as hours leaves the task ASKING: '4 full days' and '4 receptacles' are not 4 h", () => {
    const whole = "Clean up the hot tub wires. Whole thing is 4 full days";
    const [t] = coerceTasks([{ name: "Clean up the hot tub wires", hours: 4 }])!;
    const r = screenHeardTask(t, whole, said(whole));
    expect(r.task!.hours).toBeNull();
    expect(r.dropped).toEqual(["Clean up the hot tub wires: 4 h was not said as hours"]);
    const count = "install 4 receptacles in the kitchen";
    const [u] = coerceTasks([{ name: "Install 4 receptacles in the kitchen", hours: 4 }])!;
    expect(screenHeardTask(u, count, said(count)).task!.hours).toBeNull();
  });

  it("saidIn: all of a part's words, two in three of a task's", () => {
    expect(saidIn("vent fan", "One vent fan in each of 2 bathrooms")).toBe(true);
    expect(saidIn("vent fans", "One vent fan in each of 2 bathrooms")).toBe(true);
    expect(saidIn("junction box", "Clean up the hot tub wires")).toBe(false);
    expect(saidIn("Install the generator transfer switch", "Generator plug needs a manual transfer switch", 2 / 3)).toBe(true);
    expect(saidIn("", "anything")).toBe(false);
  });
});

describe("NORT SPLITS THE PARAGRAPH INTO TASKS, HIS NUMBERS ONLY", () => {
  it("the prompt offers the tasks question even when it is answered, with what it holds", () => {
    const req = hearRequest(PB, { tasks: coerceTasks([{ name: "Transfer switch", hours: 3 }]) }, SAID);
    expect(req).toContain("key: tasks");
    expect(req).toContain("A TASK LIST");
    expect(req).toContain("already on the list:\n    Transfer switch — 3 h");
    expect(req).not.toContain("ALREADY KNOWN (do not fill these again):\n- Tasks");
  });

  it("parseHeard keeps an object fill (one task) as a one-task list, and a list of objects as is", () => {
    const h = parseHeard(
      JSON.stringify({
        fills: [
          { key: "tasks", value: { name: "Transfer switch", hours: 3 }, heard: "manual transfer switch, call it 3 hours" },
          { key: "tasks", value: [{ name: "Range circuit" }], heard: "circuit to the range" },
          { key: "access", value: "Attic", heard: "attic" },
        ],
        leftover: "",
      }),
    );
    expect(h.fills[0].value).toEqual([{ name: "Transfer switch", hours: 3 }]);
    expect(h.fills[1].value).toEqual([{ name: "Range circuit" }]);
    expect(h.fills[2].value).toBe("Attic");
  });

  const GOOD = {
    fills: fills([
      { key: "tasks", value: [{ name: "Generator plug manual transfer switch", hours: 3 }], heard: "Generator plug needs a manual transfer switch, call it 3 hours" },
      { key: "tasks", value: [{ name: "Vent fan in each of 2 bathrooms", hours: 4, materials: [{ words: "vent fan", qty: 2 }] }], heard: "One vent fan in each of 2 bathrooms, 2 fans, say 4 hours for both" },
      {
        key: "tasks",
        value: [{ name: "50 amp 240 volt circuit to the range", hours: null, materials: [{ words: "6/3", qty: 60 }, { words: "50 amp breaker", qty: 1 }] }],
        heard: "50 amp 240 volt circuit to the range from the upstairs panel with conduit on the outside of the wall, 60 feet of 6/3 and a 50 amp breaker",
      },
      { key: "tasks", value: [{ name: "Clean up the hot tub wires", hours: null }], heard: "Clean up the hot tub wires" },
    ]),
    leftover: "Whole thing is 4 full days.",
  };
  const EMPTY = { tasks: null, work_kind: null, access: null, scope: null, panel: null };

  it("four fills become four tasks; the ones with no time ask; the total stays in the note", () => {
    const got = applyHeard(PB, EMPTY, SAID, GOOD);
    const tasks = got.answers.tasks as TaskValue[];
    expect(tasks.map((t) => t.name)).toEqual([
      "Generator plug manual transfer switch",
      "Vent fan in each of 2 bathrooms",
      "50 amp 240 volt circuit to the range",
      "Clean up the hot tub wires",
    ]);
    expect(tasks.map((t) => t.hours)).toEqual([3, 4, null, null]);
    expect(tasks[2].materials).toEqual([
      { words: "6/3", code: null, qty: 60 },
      { words: "50 amp breaker", code: null, qty: 1 },
    ]);
    expect(got.filled).toEqual(["Tasks"]);
    expect(got.note).toBe("Whole thing is 4 full days.");
  });

  it("a number the words do not carry is dropped, the task stays and ASKS, and HIS WORDS reach the note", () => {
    const got = applyHeard(PB, EMPTY, SAID, {
      fills: fills([{ key: "tasks", value: [{ name: "Clean up the hot tub wires", hours: 4, materials: [{ words: "staples", qty: 40 }] }], heard: "Clean up the hot tub wires. Whole thing is 4 full days" }]),
      leftover: "",
    });
    const [t] = got.answers.tasks as TaskValue[];
    expect(t.hours).toBeNull();
    expect(t.materials).toEqual([]);
    expect(got.filled).toEqual(["Tasks"]);
    expect(got.note).toBe("Clean up the hot tub wires. Whole thing is 4 full days");
  });

  it("a `heard` that is not in his words is refused whole, and noted", () => {
    const got = applyHeard(PB, EMPTY, SAID, { fills: fills([{ key: "tasks", value: [{ name: "Panel swap", hours: 8 }], heard: "swap the panel, 8 hours" }]), leftover: "" });
    expect(got.answers.tasks).toBeNull();
    expect(got.note).toBe("swap the panel, 8 hours");
  });

  it("FILL HOLES, NEVER OVERWRITE A HAND: his hours stand and the disagreement is SAID; his hole fills; a new task joins", () => {
    const hand = coerceTasks([{ id: "h1", name: "Generator plug manual transfer switch", hours: 2.5 }, { id: "h2", name: "Clean up the hot tub wires" }])!;
    const got = applyHeard(PB, { ...EMPTY, tasks: hand }, SAID, {
      fills: fills([
        { key: "tasks", value: [{ name: "generator plug manual transfer switch", hours: 3 }], heard: "Generator plug needs a manual transfer switch, call it 3 hours" },
        { key: "tasks", value: [{ name: "Clean up the hot tub wires", hours: 4 }], heard: "say 4 hours for both. 50 amp 240 volt circuit to the range from the upstairs panel with conduit on the outside of the wall, 60 feet of 6/3 and a 50 amp breaker. Clean up the hot tub wires" },
        { key: "tasks", value: [{ name: "Vent fan in each of 2 bathrooms", hours: 4 }], heard: "One vent fan in each of 2 bathrooms, 2 fans, say 4 hours for both" },
      ]),
      leftover: "",
    });
    const tasks = got.answers.tasks as TaskValue[];
    expect(tasks.map((t) => [t.id, t.hours])).toEqual([["h1", 2.5], ["h2", 4], [tasks[2].id, 4]]);
    // The first fill disagreed with his 2.5: his number stands and the words are in the note.
    expect(got.note).toBe("Generator plug needs a manual transfer switch, call it 3 hours");
    expect(got.filled).toEqual(["Tasks"]);
  });

  it("a fill that brings nothing new is refused silently: his answer stands", () => {
    const hand = coerceTasks([{ id: "h1", name: "Generator plug manual transfer switch", hours: 3 }])!;
    const got = applyHeard(PB, { ...EMPTY, tasks: hand }, SAID, {
      fills: fills([{ key: "tasks", value: [{ name: "Generator plug manual transfer switch", hours: 3 }], heard: "Generator plug needs a manual transfer switch, call it 3 hours" }]),
      leftover: "",
    });
    expect(got.answers.tasks).toEqual(hand);
    expect(got.filled).toEqual([]);
    expect(got.note).toBe("");
  });

  it("AN OBJECT IS ONLY EVER A TASK: a scopes pick with a price, or an object in a text box, is refused", () => {
    const { answers, rejected } = applyFills(
      PB,
      EMPTY,
      fills([
        { key: "scope", value: [{ code: "R1", qty: 1, price: 4200 }], heard: "the remodel scope" },
        { key: "panel", value: [{ name: "x" }], heard: "the panel" },
        { key: "access", value: "Attic", heard: "Bayberry" },
      ]),
      SAID,
    );
    expect(answers.scope).toBeNull();
    expect(answers.panel).toBeNull();
    expect(answers.access).toBe("Attic");
    expect(rejected).toHaveLength(2);
    expect(coerceByPlaybook(PB, answers).scope).toBeNull();
  });
});

describe("the pure merge", () => {
  it("sameTask ignores case, punctuation and a plural", () => {
    expect(sameTask("Clean up hot-tub wires", "clean up the hot tub wire.")).toBe(true);
    expect(sameTask("", "")).toBe(false);
  });

  it("mergeHeardTasks appends new materials under a known task and says a disagreement", () => {
    const have = coerceTasks([{ name: "Range circuit", hours: 5, materials: [{ words: "6/3", qty: 60 }] }])!;
    const heard = coerceTasks([{ name: "range circuit", hours: 6, materials: [{ words: "6/3", qty: 60 }, { words: "breaker", qty: 1 }] }])!;
    const r = mergeHeardTasks(have, heard);
    expect(r.tasks[0].hours).toBe(5);
    expect(r.tasks[0].materials.map((m) => m.words)).toEqual(["6/3", "breaker"]);
    expect(r.skipped).toEqual(["Range circuit"]);
    expect(r.added).toEqual(["Range circuit"]);
    // Pure: the input is untouched.
    expect(have[0].materials).toHaveLength(1);
  });
});
