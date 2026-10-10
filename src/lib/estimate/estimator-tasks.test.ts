import { describe, it, expect } from "vitest";
import { screenEstimatorTasks, stripUnverified } from "./estimator-tasks";

/**
 * Draft With Estimator in task mode: the model splits HIS scope into tasks and may not add a
 * number, a part or a task he did not write. The screen is the inspector's (screenHeardTask), with
 * the scope text as the transcript. What is refused is SAID.
 */
const SCOPE = [
  "Install the transfer switch by the panel, about 3 hours, one 50 amp breaker.",
  "Run hot tub wires out to the pad, 2 runs of 6/3.",
  "Clean up speaker and phone wires. Whole thing is 4 full days.",
].join("\n");

describe("screenEstimatorTasks", () => {
  it("keeps a task in his words with his hours and the part he named", () => {
    const { tasks, dropped } = screenEstimatorTasks(SCOPE, [
      {
        name: "Install transfer switch",
        hours: 3,
        heard: "Install the transfer switch by the panel, about 3 hours, one 50 amp breaker.",
        materials: [{ words: "50 amp breaker", qty: 1 }],
      },
    ]);
    expect(dropped).toEqual([]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ name: "Install transfer switch", hours: 3, units: null, kit_id: null });
    expect(tasks[0].materials).toEqual([{ code: null, words: "50 amp breaker", qty: 1 }]);
  });

  it("a whole-job time is not a task's hours; the task stays and asks, and the refusal is said", () => {
    const { tasks, dropped } = screenEstimatorTasks(SCOPE, [
      { name: "Clean up speaker and phone wires", hours: 4, heard: "Clean up speaker and phone wires. Whole thing is 4 full days." },
    ]);
    expect(tasks[0].hours).toBeNull();
    expect(dropped).toEqual(["Clean up speaker and phone wires: 4 h was not said as hours"]);
  });

  it("refuses a task whose fragment is not in the scope, and one the fragment does not name", () => {
    const { tasks, dropped } = screenEstimatorTasks(SCOPE, [
      { name: "Patch drywall", hours: 2, heard: "patch the drywall where the wires ran" },
      { name: "Trench to the pad", hours: null, heard: "Run hot tub wires out to the pad, 2 runs of 6/3." },
    ]);
    expect(tasks).toEqual([]);
    expect(dropped).toEqual(["not in the scope: Patch drywall", "a task he did not name: Trench to the pad"]);
  });

  it("a count must be in the fragment; a part must be named in it; model ids and codes are wiped", () => {
    const { tasks, dropped } = screenEstimatorTasks(SCOPE, [
      {
        name: "Run hot tub wires",
        hours: null,
        heard: "Run hot tub wires out to the pad, 2 runs of 6/3.",
        materials: [
          { words: "6/3", qty: 2 },
          { words: "6/3", qty: 75 },
          { words: "GFCI spa panel", qty: 1 },
        ],
        id: "model-made",
        kit_id: "k-model",
      },
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).not.toBe("model-made");
    expect(tasks[0].kit_id).toBeNull();
    expect(tasks[0].materials).toEqual([
      { code: null, words: "6/3", qty: 2 },
      { code: null, words: "6/3", qty: null },
    ]);
    expect(dropped).toEqual(["Run hot tub wires: 6/3 ×75 — the count was not said", "Run hot tub wires: a part he did not name: GFCI spa panel"]);
  });

  it("the same task twice collapses to one; two different hours for it are said", () => {
    const heard = "Install the transfer switch by the panel, about 3 hours, one 50 amp breaker.";
    const { tasks, dropped } = screenEstimatorTasks(SCOPE, [
      { name: "Install transfer switch", hours: 3, heard },
      { name: "Install the transfer switch", hours: null, heard },
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].hours).toBe(3);
    expect(dropped).toEqual([]);
  });

  it("junk is nothing: not an array, nameless entries, non-objects", () => {
    expect(screenEstimatorTasks(SCOPE, null)).toEqual({ tasks: [], dropped: [] });
    expect(screenEstimatorTasks(SCOPE, [{ hours: 3, heard: "x" }, 4, "task"])).toEqual({ tasks: [], dropped: [] });
  });

  it("case and spacing do not break the trace; different words do", () => {
    const { tasks } = screenEstimatorTasks(SCOPE, [{ name: "Run hot tub wires", hours: null, heard: "run HOT TUB wires   out to the pad" }]);
    expect(tasks).toHaveLength(1);
    const { dropped } = screenEstimatorTasks(SCOPE, [{ name: "Run hot tub wires", hours: null, heard: "run hot tub wires to the garage" }]);
    expect(dropped).toEqual(["not in the scope: Run hot tub wires"]);
  });

  it("a fragment spanning lines is refused: any figure in the scope could attach to any task", () => {
    const scope = "Replace the kitchen outlets.\nInstall a 50 amp breaker, 3 hours";
    const { tasks, dropped } = screenEstimatorTasks(scope, [{ name: "Replace kitchen outlets", hours: 3, heard: scope }]);
    expect(tasks).toEqual([]);
    expect(dropped).toEqual(["its words span more than one line: Replace kitchen outlets"]);
  });

  it("two tasks sharing one fragment lose its hours: one time for two pieces of work is neither's", () => {
    const scope = "Pull the permit and set the panel, 3 hours total for both";
    const { tasks, dropped } = screenEstimatorTasks(scope, [
      { name: "Pull the permit", hours: 3, heard: scope },
      { name: "Set the panel", hours: 3, heard: scope },
    ]);
    expect(tasks.map((t) => [t.name, t.hours])).toEqual([["Pull the permit", null], ["Set the panel", null]]);
    expect(dropped).toEqual(["one time was said for Pull the permit and Set the panel together — each asks for its own"]);
  });

  it("the same name from two different lines is two tasks, not one", () => {
    const scope = "Replace outlet in the kitchen, 1 hour\nReplace outlet in the bath, 1 hour";
    const { tasks, dropped } = screenEstimatorTasks(scope, [
      { name: "Replace outlet", hours: 1, heard: "Replace outlet in the kitchen, 1 hour" },
      { name: "Replace outlet", hours: 1, heard: "Replace outlet in the bath, 1 hour" },
    ]);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.hours === 1)).toBe(true);
    expect(dropped).toEqual([]);
  });

  it("a stranger's words are not evidence: the unverified blocks are stripped before the trace", () => {
    const scope = [
      "From the inspection — Bayberry",
      "FROM THE INSPECTION (his words — take them as given):\nReplace the panel, 6 hours",
      "NOT CONFIRMED ON SITE (unverified — the customer typed these into your web form):\n6 outlets, 2 hours",
      "WHAT THE CUSTOMER TOLD YOU (they typed these):\nRewire the garage, 4 hours",
    ].join("\n\n");
    expect(stripUnverified(scope)).not.toContain("6 outlets");
    expect(stripUnverified(scope)).not.toContain("Rewire the garage");
    expect(stripUnverified(scope)).toContain("Replace the panel, 6 hours");
    const { tasks, dropped } = screenEstimatorTasks(scope, [
      { name: "Replace the panel", hours: 6, heard: "Replace the panel, 6 hours" },
      { name: "6 outlets", hours: 2, heard: "6 outlets, 2 hours" },
    ]);
    expect(tasks.map((t) => [t.name, t.hours])).toEqual([["Replace the panel", 6]]);
    expect(dropped).toEqual(["not in the scope: 6 outlets"]);
  });

  it("a part named without a count asks; the hours figure never becomes a count", () => {
    const scope = "Install receptacles in the kitchen, 2 hours";
    const { tasks, dropped } = screenEstimatorTasks(scope, [{ name: "Install receptacles", hours: 2, heard: scope, materials: [{ words: "receptacles", qty: 1 }, { words: "receptacles", qty: 2 }] }]);
    expect(tasks[0].materials.map((m) => m.qty)).toEqual([null, null]);
    expect(dropped).toEqual(["Install receptacles: receptacles ×1 — the count was not said", "Install receptacles: receptacles ×2 — the count was not said"]);
  });
});
