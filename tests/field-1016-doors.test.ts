/**
 * NORT TYPES INTO THE BOXES (field feedback 10-13, rung 2). Erik, 2026-10-14: "if Nort is flipping
 * screens for me he should be able to enter text into the box directly for me and record
 * measurements where they are supposed to be recorded, you know Jarvis style." A door is a named
 * box on the page; filling it runs the page's OWN setter, so the autosave is the save and the
 * person watches it land. Only what was said; a refusal and a missing box are both SAID.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ADD_FIELD_MAX, FILL_VALUE_MAX, SCREEN_CLOSE, SCREEN_OPEN, fillText, sanitizeScreen, screenBlocks } from "@/lib/assistant-protocol";
import { MAX_DOORS, _resetNortDoors, currentDoors, listNortDoors, nortDoor, registerNortDoors, type NortDoor } from "@/lib/nort/doors";
import { RING_CLASS, performScreen, typeInto } from "@/lib/nort/screen-driver";
import { doorContextLines, seenLines } from "@/lib/nort/door-context";
import { appendNote, inspectorDoors, matchOption, measureFromFields, needDoor, strictNumber, type InspectorDoorContext } from "@/lib/inspection/doors";
import { MAX_MEASURES, type CaptureMeasure } from "@/lib/inspection/capture";
import { screenPromptBlock } from "@/lib/nort/screens";
import type { TaskValue } from "@/lib/playbook/tasks";

const read = (p: string) => readFileSync(p, "utf8");

describe("the clamp: a fill is a door name and plain text; an add is a door name and a few short named fields", () => {
  it("keeps a fill's line breaks, strips every other control character, caps the length", () => {
    const s = sanitizeScreen({ fill: { door: "task-note-abc", value: " the wall is\r\nplaster\u0000 over lath\t " } });
    expect(s).toEqual({ fill: { door: "task-note-abc", value: "the wall is\nplaster over lath" } });
    expect(sanitizeScreen({ fill: { door: "task-note-abc", value: "x".repeat(FILL_VALUE_MAX + 50) } }).fill?.value).toHaveLength(FILL_VALUE_MAX);
  });
  it("a door is a NAME (the spot alphabet), never a selector; an empty value is no step", () => {
    for (const door of ["#task-note", "task note", "[data-tour=x]", "", "a".repeat(81)]) expect(sanitizeScreen({ fill: { door, value: "hi" } })).toEqual({});
    expect(sanitizeScreen({ fill: { door: "task-note-abc", value: "   " } })).toEqual({});
    expect(sanitizeScreen({ fill: { door: "task-note-abc", value: 12 } })).toEqual({});
    expect(sanitizeScreen({ fill: "task-note-abc" })).toEqual({});
  });
  it("an add keeps only [a-z_] keys with short plain values, at most eight; nothing else is 'fixed'", () => {
    const s = sanitizeScreen({ add: { door: "task-measure-abc", fields: { label: " wall ", value: "12.5", unit: "ft", "bad key": "x", BAD: "y", __proto__: "z" } } });
    expect(s.add).toEqual({ door: "task-measure-abc", fields: { label: "wall", value: "12.5", unit: "ft" } });
    expect(sanitizeScreen({ add: { door: "x", fields: { a: "1".repeat(ADD_FIELD_MAX + 9) } } }).add?.fields.a).toHaveLength(ADD_FIELD_MAX);
    expect(sanitizeScreen({ add: { door: "x", fields: {} } })).toEqual({});
    expect(sanitizeScreen({ add: { door: "x", fields: { label: "wall", unit: "null", value: "None" } } }).add?.fields).toEqual({ label: "wall" });
    expect(sanitizeScreen({ add: { door: "x", fields: ["a"] } })).toEqual({});
    const many: Record<string, string> = {};
    for (let i = 0; i < 12; i++) many["k".repeat(i + 1)] = "v";
    expect(Object.keys(sanitizeScreen({ add: { door: "x", fields: many } }).add?.fields ?? {})).toHaveLength(8);
    // Keys are words: a digit or a capital is not a field name.
    expect(sanitizeScreen({ add: { door: "x", fields: { k1: "v", Label: "v" } } })).toEqual({});
  });
  it("fillText: null for a non-string or an empty result; a fill rides a SCREEN block like a move", () => {
    expect(fillText(12, 10)).toBeNull();
    expect(fillText("\u0001\u0002", 10)).toBeNull();
    const full = `hi ${SCREEN_OPEN}${JSON.stringify({ fill: { door: "insp-notes", value: "gate code 4421" } })}${SCREEN_CLOSE} there`;
    expect(screenBlocks(full)).toEqual([{ fill: { door: "insp-notes", value: "gate code 4421" } }]);
  });
});

describe("the registry: providers, read fresh each time; a list the model can read; a cap", () => {
  beforeEach(() => _resetNortDoors());
  it("a provider's doors are read when asked, so a box added after registration is there; unregister forgets them", () => {
    const doors: Record<string, NortDoor> = { "insp-notes": { label: "Notes", fill: () => ({ ok: true, landed: "x" }) } };
    const off = registerNortDoors(() => doors);
    expect(Object.keys(currentDoors())).toEqual(["insp-notes"]);
    doors["task-note-1"] = { label: "Note on 'Panel'", fill: () => ({ ok: true, landed: "y" }) };
    expect(nortDoor("task-note-1")?.label).toBe("Note on 'Panel'");
    expect(nortDoor("#task-note-1")).toBeNull();
    expect(nortDoor("nope")).toBeNull();
    off();
    expect(currentDoors()).toEqual({});
  });
  it("the listing names what each door takes, never its handler; a door with neither fill nor add is not listed; bad names are skipped", () => {
    registerNortDoors(() => ({
      "task-measure-1": { label: "  Add A  Measurement ", fields: ["label", "value", "unit"], add: () => ({ ok: true, landed: "m" }) },
      "task-note-1": { label: "Note", fill: () => ({ ok: true, landed: "n" }) },
      dead: { label: "nothing" },
      "bad name": { label: "x", fill: () => ({ ok: true, landed: "" }) },
    }));
    expect(listNortDoors()).toEqual([
      { name: "task-measure-1", label: "Add A Measurement", can: ["add"], fields: ["label", "value", "unit"] },
      { name: "task-note-1", label: "Note", can: ["fill"] },
    ]);
    registerNortDoors(() => ({ "need-work": { label: "Work", options: ["Deck", "Remodel", "  x ".repeat(30)], now: "  Remodel  ", fill: () => ({ ok: true, landed: "" }) } }));
    const w = listNortDoors().find((d) => d.name === "need-work")!;
    expect(w.now).toBe("Remodel");
    expect(w.options?.[0]).toBe("Deck");
    expect(w.options?.[2]).toHaveLength(40);
    expect(nortDoor("constructor")).toBeNull();
    expect(nortDoor("toString")).toBeNull();
    expect(JSON.stringify(listNortDoors())).not.toContain("function");
  });
  it("a broken provider is skipped, a later provider wins a name, and the list stops at the cap", () => {
    registerNortDoors(() => {
      throw new Error("mid-unmount");
    });
    registerNortDoors(() => ({ a: { label: "first", fill: () => ({ ok: true, landed: "" }) } }));
    registerNortDoors(() => ({ a: { label: "second", fill: () => ({ ok: true, landed: "" }) } }));
    expect(nortDoor("a")?.label).toBe("second");
    const big: Record<string, NortDoor> = {};
    for (let i = 0; i < MAX_DOORS + 20; i++) big[`d${i}`] = { label: `d${i}`, fill: () => ({ ok: true, landed: "" }) };
    registerNortDoors(() => big);
    expect(listNortDoors()).toHaveLength(MAX_DOORS);
  });
});

describe("the route's context lines: the phone's list clamped, what landed clamped", () => {
  it("doors become one line each, names checked, labels plain, add-row fields named; junk dropped", () => {
    expect(
      doorContextLines([
        { name: "task-note-1", label: "Note on 'Panel'", can: ["fill"] },
        { name: "task-measure-1", label: "Add A Measurement", can: ["add"], fields: ["label", "value", "unit", "Bad!"] },
        { name: "need-work", label: "Work", can: ["fill"], options: ["Deck", "Remodel"], now: "Remodel" },
        { name: "bad name", label: "x", can: ["fill"] },
        { name: "no-can", label: "x", can: [] },
        { name: "ctrl", label: "a\u0000b\nc", can: ["fill"] },
        "junk",
        null,
      ]),
    ).toEqual(["[task-note-1] Note on 'Panel'", "[task-measure-1] Add A Measurement (add a row: label, value, unit)", '[need-work] Work — choices: Deck / Remodel — now: "Remodel"', "[ctrl] ab c"]);
    expect(doorContextLines("nope")).toEqual([]);
    expect(doorContextLines(Array.from({ length: 100 }, (_, i) => ({ name: `d${i}`, label: "x", can: ["fill"] })))).toHaveLength(80);
  });
  it("seen lines: plain, capped at 20, bulleted", () => {
    expect(seenLines(["task-note-1: landed — note: gate code", 5, "", "x\u0007y"])).toEqual(["- task-note-1: landed — note: gate code", "- xy"]);
    expect(seenLines(Array.from({ length: 30 }, () => "l"))).toHaveLength(20);
    expect(seenLines(null)).toEqual([]);
  });
});

describe("the Inspector's doors: every box as a pure door over the page's own setters", () => {
  const t1: TaskValue = { id: "t1", name: "Panel swap", hours: null, units: null, kit_id: "k1", materials: [], note: "200 A" };
  const t2: TaskValue = { id: "t2", name: "", hours: 2, units: null, kit_id: null, materials: [] };
  /** A context over a tiny live store, so two fills in one tick see each other (the H1 shape). */
  function ctx(over: Partial<InspectorDoorContext> = {}, store: { tasks?: TaskValue[]; answers?: Record<string, unknown>; notes?: string } = {}) {
    const calls: Record<string, unknown[]> = { patchTask: [], showTask: [], addMeasure: [], setAnswer: [], open1: [], setNotes: [] };
    const live = { tasks: store.tasks ?? [t1, t2], answers: store.answers ?? {}, notes: store.notes ?? "" };
    const c: InspectorDoorContext = {
      readOnly: false,
      tasks: live.tasks,
      openTaskId: null,
      taskOf: (id) => live.tasks.find((t) => t.id === id) ?? null,
      patchTask: (id, patch) => {
        live.tasks = live.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
        calls.patchTask.push([id, patch]);
      },
      showTask: (id) => calls.showTask.push(id),
      measures: [],
      addMeasure: (row) => calls.addMeasure.push(row),
      needs: [
        { key: "work", label: "Work", ask: "What kind of work is this?", slot: { type: "select", options: ["Deck", "Remodel"] } },
        { key: "tags", label: "Tags", ask: "Which apply?", slot: { type: "select", options: ["Wet", "Attic"], multi: true, other: true } },
        { key: "access", label: "Access", ask: "How are we getting materials and crew to it?", slot: { type: "select", options: ["Easy — drive right up", "Tight — a carry", "Difficult — steep or long carry"] } },
        { key: "amps", label: "Amps", ask: "How many amps?", slot: { type: "number", unit: "A" } },
        { key: "panel", label: "Panel", ask: "Which panel?", slot: { type: "text" } },
        { key: "bites", label: "Bites", ask: "Anything that'll bite us?" },
        { key: "scope", label: "Scope", ask: "What's the job?", slot: { type: "scope" } },
        { key: "picks", label: "Picks", ask: "Lines?", slot: { type: "scopes" } },
        { key: "plans", label: "Plans", ask: "Plans?", slot: { type: "file" } },
        { key: "tasks", label: "Tasks", ask: "Tasks?", slot: { type: "tasks" } },
      ],
      answerOf: (key) => live.answers[key],
      setAnswer: (k, v) => {
        live.answers[k] = v;
        calls.setAnswer.push([k, v]);
      },
      open1: (k) => calls.open1.push(k),
      readNotes: () => live.notes,
      setNotes: (t) => {
        live.notes = t;
        calls.setNotes.push(t);
      },
      ...over,
    };
    return { c, calls, live };
  }
  it("a plain tech's view has no doors at all", () => {
    expect(inspectorDoors(ctx({ readOnly: true }).c)).toEqual({});
  });
  it("names and ORDER: the visit's two doors first, then the open task, the other tasks, the questions — units only beside a kit; none for scopes, a file or the tasks list", () => {
    const { c } = ctx({ openTaskId: "t2" });
    expect(Object.keys(inspectorDoors(c))).toEqual([
      "insp-notes", "insp-measures",
      "task-name-t2", "task-hours-t2", "task-note-t2", "task-measure-t2",
      "task-name-t1", "task-hours-t1", "task-units-t1", "task-note-t1", "task-measure-t1",
      "need-work", "need-tags", "need-access", "need-amps", "need-panel", "need-bites", "need-scope",
    ]);
    const d = inspectorDoors(c);
    expect(d["task-note-t1"].label).toBe("Note on 'Panel swap' (adds a line)");
    expect(d["task-note-t1"].now).toBe("200 A");
    expect(d["task-hours-t2"].label).toBe("Hours on the unnamed task");
    expect(d["task-hours-t2"].now).toBe("2 h");
    expect(d["task-measure-t1"].fields).toEqual(["label", "value", "unit"]);
    expect(d["need-work"].label).toBe("What kind of work is this? (one of the choices)");
    expect(d["need-work"].options).toEqual(["Deck", "Remodel"]);
    expect(d["need-tags"].label).toBe("Which apply? (one of the choices, or their own words) — several add up");
    expect(d["need-amps"].label).toBe("How many amps? (A)");
    expect(d["need-panel"].label).toBe("Which panel? (adds a line)");
  });
  it("hours and units take ONE number above zero; a range, a fraction, a compound, a word, zero and 'null' are refused; a fill shows the task", () => {
    const { c, calls } = ctx();
    const d = inspectorDoors(c);
    expect(d["task-hours-t1"].fill!("2.5")).toEqual({ ok: true, landed: "2.5 h on 'Panel swap'" });
    expect(calls.patchTask).toEqual([["t1", { hours: 2.5 }]]);
    expect(calls.showTask).toEqual(["t1"]);
    expect(d["task-hours-t1"].fill!("3 h")).toEqual({ ok: true, landed: "3 h on 'Panel swap' (was: 2.5 h)" });
    for (const bad of ["a couple", "2 to 3", "12-14", "3/4", "15 ft 6 in", "0", "-2", "null", "none"]) {
      const r = d["task-hours-t1"].fill!(bad);
      expect(r.ok, bad).toBe(false);
    }
    expect(d["task-hours-t1"].fill!("2 to 3")).toEqual({ ok: false, why: '"2 to 3" isn\'t one number for hours — say the figure on its own.' });
    expect(d["task-hours-t1"].fill!("0")).toEqual({ ok: false, why: "hours has to be above zero." });
    expect(calls.patchTask).toHaveLength(2);
    expect(d["task-units-t1"].fill!("7")).toEqual({ ok: true, landed: "×7 on 'Panel swap'" });
    expect(calls.patchTask[2]).toEqual(["t1", { units: 7 }]);
    expect(d["task-units-t2"]).toBeUndefined();
    expect(strictNumber("1,250", "x")).toEqual({ n: 1250 });
  });
  it("a note APPENDS a line, never overwrites — and two fills in one tick both land (the second reads the first through the live store)", () => {
    const { c, calls, live } = ctx();
    const d = inspectorDoors(c);
    expect(d["task-note-t1"].fill!("plaster over lath").ok).toBe(true);
    expect(d["task-note-t1"].fill!("attic access is tight").ok).toBe(true);
    expect(calls.patchTask).toEqual([
      ["t1", { note: "200 A\nplaster over lath" }],
      ["t1", { note: "200 A\nplaster over lath\nattic access is tight" }],
    ]);
    expect(live.tasks[0].note).toBe("200 A\nplaster over lath\nattic access is tight");
    expect(appendNote("200 A\nplaster over lath", "Plaster over lath")).toBe("200 A\nplaster over lath");
    expect(appendNote("", "  ")).toBe("");
    expect(appendNote("x".repeat(1995), "a long line", 2000)).toBeNull();
    expect(d["task-note-t1"].fill!("y".repeat(2000)).ok).toBe(false);
    expect(d["task-name-t2"].fill!("  Hot   tub wires ")).toEqual({ ok: true, landed: "task named Hot tub wires" });
    expect(d["task-name-t2"].fill!("Hot tub circuit")).toEqual({ ok: true, landed: "task named Hot tub circuit (was: Hot tub wires)" });
    expect(d["task-note-t1"].fill!("null")).toEqual({ ok: false, why: "Nothing to put in." });
  });
  it("a measurement needs a NAME (the server drops a nameless row) and one number above zero; the model's empty words are nothing; on the task or the visit; the cap is said", () => {
    const { c, calls } = ctx();
    const d = inspectorDoors(c);
    expect(d["task-measure-t1"].add!({ label: "north wall", value: "12.5", unit: "ft" })).toEqual({ ok: true, landed: "north wall: 12.5 ft on 'Panel swap'" });
    expect(calls.addMeasure).toEqual([{ label: "north wall", value: 12.5, unit: "ft", task_id: "t1" }]);
    expect(calls.showTask).toEqual(["t1"]);
    expect(d["insp-measures"].add!({ label: "driveway", unit: "null" })).toEqual({ ok: true, landed: "driveway" });
    expect(calls.addMeasure[1]).toEqual({ label: "driveway", value: null, unit: "" });
    expect(calls.open1).toEqual(["measures"]);
    expect(d["task-measure-t1"].add!({ value: "12", unit: "ft" })).toEqual({ ok: false, why: "What was measured? A measurement needs a name (the north wall, the run to the panel)." });
    expect(d["task-measure-t1"].add!({ label: "n/a", value: "12" }).ok).toBe(false);
    expect(d["task-measure-t1"].add!({ label: "span", value: "twelve" })).toEqual({ ok: false, why: '"twelve" isn\'t one number for a measurement — say the figure on its own.' });
    expect(d["task-measure-t1"].add!({ label: "span", value: "0" })).toEqual({ ok: false, why: "a measurement has to be above zero." });
    expect(measureFromFields({ what: "span", value: "3" })).toEqual({ row: { label: "span", value: 3, unit: "" } });
    const full = ctx({ measures: Array.from({ length: MAX_MEASURES }, (_, i) => ({ id: `m${i}`, label: "", value: null, unit: "" }) as CaptureMeasure) });
    expect(inspectorDoors(full.c)["insp-measures"].add!({ label: "x" })).toEqual({ ok: false, why: `${MAX_MEASURES} measurements is the most a visit holds — take one off first.` });
    expect(full.calls.addMeasure).toEqual([]);
    const gone = ctx({ taskOf: () => null });
    expect(inspectorDoors(gone.c)["task-measure-t1"].add!({ label: "x" })).toEqual({ ok: false, why: "That task is no longer on the sheet." });
  });
  it("a single pick must be one of the choices (case-blind, or the one it starts, or its words before the dash); a multi ADDS; a number parses; text and an open need ADD a line; each opens its question", () => {
    const { c, calls, live } = ctx({}, { answers: { tags: ["Attic"], scope: "Panel swap and a sub" } });
    const d = inspectorDoors(c);
    expect(d["need-scope"].now).toBe("Panel swap and a sub");
    expect(d["need-work"].fill!("remodel")).toEqual({ ok: true, landed: "Work: Remodel" });
    expect(d["need-work"].fill!("Deck")).toEqual({ ok: true, landed: "Work: Deck (was: Remodel)" });
    expect(d["need-work"].fill!("Garage")).toEqual({ ok: false, why: '"Garage" isn\'t one of the choices for Work: Deck / Remodel.' });
    expect(d["need-access"].fill!("difficult")).toEqual({ ok: true, landed: "Access: Difficult — steep or long carry" });
    expect(d["need-access"].fill!("tight")).toEqual({ ok: true, landed: "Access: Tight — a carry (was: Difficult — steep or long carry)" });
    expect(matchOption("de", ["Deck", "Demo"])).toBeUndefined();
    expect(matchOption("zzz", ["Deck"])).toBeNull();
    expect(d["need-tags"].fill!("wet, crawlspace")).toEqual({ ok: true, landed: "Tags: Attic, Wet, crawlspace" });
    expect(live.answers.tags).toEqual(["Attic", "Wet", "crawlspace"]);
    expect(d["need-amps"].fill!("200")).toEqual({ ok: true, landed: "Amps: 200 A" });
    expect(d["need-amps"].fill!("100 A")).toEqual({ ok: true, landed: "Amps: 100 A (was: 200)" });
    expect(d["need-amps"].fill!("two hundred").ok).toBe(false);
    expect(d["need-panel"].fill!("Square D QO")).toEqual({ ok: true, landed: "Panel: Square D QO" });
    expect(d["need-bites"].fill!("knob and tube in the attic")).toEqual({ ok: true, landed: "Bites: knob and tube in the attic" });
    expect(d["need-scope"].fill!("also a hot tub circuit")).toEqual({ ok: true, landed: "Scope: also a hot tub circuit (added under what was there)" });
    expect(live.answers.scope).toBe("Panel swap and a sub\nalso a hot tub circuit");
    expect(d["need-panel"].fill!("x".repeat(600)).ok).toBe(false);
    expect(calls.open1).toEqual(["work", "work", "access", "access", "tags", "amps", "amps", "panel", "bites", "scope"]);
    expect(needDoor({ key: "picks", label: "Picks", ask: "Lines?", slot: { type: "scopes" } }, c)).toBeNull();
    // A chosen scope keeps its own-words door even without other:true.
    const sc = needDoor({ key: "scope2", label: "Scope", ask: "What's the job?", slot: { type: "scope", options: ["Deck", "Remodel"] } }, c);
    expect(sc?.fill!("fence")).toEqual({ ok: true, landed: "Scope: fence" });
  });
  it("the visit's notes append through the capture setter, reading the notes as they stand", () => {
    const { c, calls } = ctx({}, { notes: "gate code 4421" });
    const d = inspectorDoors(c);
    expect(d["insp-notes"].now).toBe("gate code 4421");
    expect(d["insp-notes"].fill!("dog in the yard")).toEqual({ ok: true, landed: "note: dog in the yard" });
    expect(d["insp-notes"].fill!("key under the mat")).toEqual({ ok: true, landed: "note: key under the mat" });
    expect(calls.setNotes).toEqual(["gate code 4421\ndog in the yard", "gate code 4421\ndog in the yard\nkey under the mat"]);
    expect(calls.open1).toEqual(["notes", "notes"]);
  });
});

/** A document with a few named elements, enough for the finder and the ring (the screen test's own fake). */
type FakeEl = { id?: string; classList: Set<string>; offsetWidth: number; getBoundingClientRect: () => { width: number; height: number; top: number; bottom: number }; scrollIntoView: () => void; has: (c: string) => boolean };
function el(id: string): FakeEl {
  const set = new Set<string>();
  const e = {
    id,
    offsetWidth: 100,
    getBoundingClientRect: () => ({ width: 100, height: 40, top: 10, bottom: 50 }),
    scrollIntoView: () => {},
    has: (c: string) => set.has(c),
    classList: { add: (c: string) => set.add(c), remove: (c: string) => set.delete(c), has: (c: string) => set.has(c) },
  };
  return e as unknown as FakeEl;
}
function fakeWindow(els: FakeEl[]) {
  const timers: { fn: () => void }[] = [];
  const win = {
    document: { querySelectorAll: () => [], getElementById: (id: string) => els.find((e) => e.id === id) ?? null },
    innerHeight: 800,
    dispatchEvent: () => true,
    setTimeout: (fn: () => void) => {
      timers.push({ fn });
      return timers.length;
    },
    clearTimeout: () => {},
  };
  // Run what is due, moving the clock a poll each time (the driver reads Date.now for its deadline).
  const tick = (times = 1) => {
    for (let i = 0; i < times; i++) {
      vi.advanceTimersByTime(130);
      timers.splice(0).forEach((t) => t.fn());
    }
  };
  return { win: win as unknown as Window, tick };
}

describe("the driver: a fill waits for the door the way a point waits for a spot, runs it, rings the box, says a refusal", () => {
  beforeEach(() => {
    _resetNortDoors();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("a fill lands through the door, the box is rung, and the outcome names what landed", () => {
    const box = el("task-note-t1");
    const { win } = fakeWindow([box]);
    const fill = vi.fn(() => ({ ok: true as const, landed: "note on 'Panel': plaster" }));
    registerNortDoors(() => ({ "task-note-t1": { label: "Note", fill } }));
    const done = vi.fn();
    typeInto({ door: "task-note-t1", value: "plaster" }, 1500, win, { onDone: done });
    expect(fill).toHaveBeenCalledWith("plaster");
    expect(done).toHaveBeenCalledWith({ door: "task-note-t1", result: { ok: true, landed: "note on 'Panel': plaster" } });
    expect(box.has(RING_CLASS)).toBe(true);
  });
  it("a door that registers AFTER a push is waited for until the page ARRIVES; one that never comes is a said miss", () => {
    const { win, tick } = fakeWindow([]);
    const done = vi.fn();
    let here = "/planner";
    typeInto({ door: "task-hours-t1", value: "2" }, 3000, win, { ready: () => here === "/appointments/x", onDone: done });
    tick(4);
    expect(done).not.toHaveBeenCalled();
    here = "/appointments/x";
    const fill = vi.fn(() => ({ ok: true as const, landed: "2 h" }));
    registerNortDoors(() => ({ "task-hours-t1": { label: "Hours", fill } }));
    tick(2);
    expect(fill).toHaveBeenCalledWith("2");
    expect(done).toHaveBeenCalledTimes(1);
    const miss = vi.fn();
    typeInto({ door: "need-amps", value: "200" }, 1000, win, { onDone: miss });
    tick(10);
    expect(miss).toHaveBeenCalledWith({ door: "need-amps", result: { ok: false, why: "no box by that name on this screen", missing: true } });
  });
  it("a refusal is the door's own words; an add on a fill-only door and a fill on an add-only door are refused; a throwing door is not a broken turn", () => {
    const { win } = fakeWindow([]);
    registerNortDoors(() => ({
      "task-hours-t1": { label: "Hours", fill: () => ({ ok: false, why: '"two" isn\'t a number for hours.' }) },
      "task-measure-t1": { label: "Measure", add: () => ({ ok: true, landed: "x" }) },
      boom: {
        label: "Boom",
        fill: () => {
          throw new Error("x");
        },
      },
    }));
    const done = vi.fn();
    typeInto({ door: "task-hours-t1", value: "two" }, 100, win, { onDone: done });
    expect(done).toHaveBeenLastCalledWith({ door: "task-hours-t1", result: { ok: false, why: '"two" isn\'t a number for hours.' } });
    typeInto({ door: "task-hours-t1", fields: { value: "2" } }, 100, win, { onDone: done });
    expect(done).toHaveBeenLastCalledWith({ door: "task-hours-t1", result: { ok: false, why: "That box takes words, not a row." } });
    typeInto({ door: "task-measure-t1", value: "2" }, 100, win, { onDone: done });
    expect(done).toHaveBeenLastCalledWith({ door: "task-measure-t1", result: { ok: false, why: "That door adds rows; it has no box to type into." } });
    typeInto({ door: "boom", value: "2" }, 100, win, { onDone: done });
    expect(done).toHaveBeenLastCalledWith({ door: "boom", result: { ok: false, why: "The box didn't take it." } });
  });
  it("performScreen: a block with a fill is a typing move (its box is the point, the anchor waits); the same path is not pushed", () => {
    const { win } = fakeWindow([el("insp-notes")]);
    const fill = vi.fn(() => ({ ok: true as const, landed: "ok" }));
    registerNortDoors(() => ({ "insp-notes": { label: "Notes", fill } }));
    const push = vi.fn();
    const onDoor = vi.fn();
    const here = "/appointments/0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
    const r = performScreen({ path: here, fill: { door: "insp-notes", value: "dog" }, anchor: "insp-notes" }, { here: () => here, push }, win, { onDoor });
    expect(push).not.toHaveBeenCalled();
    expect(r).toEqual({ moved: false, pointed: false });
    expect(fill).toHaveBeenCalledWith("dog");
    expect(onDoor).toHaveBeenCalledWith({ door: "insp-notes", result: { ok: true, landed: "ok" } });
  });
});

describe("the wiring, pinned", () => {
  const route = read("src/app/api/chat/route.ts");
  const chat = read("src/app/(app)/assistant/assistant-chat.tsx");
  const insp = read("src/app/(app)/appointments/[id]/inspector.tsx");

  it("the route offers fill_screen to every caller, emits the clamped step mid-stream and keeps going, says back what was not used", () => {
    expect(route).toContain('name: "fill_screen"');
    expect(route).toContain("SHOW_SCREEN_TOOL, FILL_SCREEN_TOOL,");
    const h = route.slice(route.indexOf('if (tu.name === "fill_screen")'), route.indexOf('if (tu.name === "open_maps")'));
    expect(h).toContain("sanitizeScreen(wanted, { isStaff: isStaffCaller, voice: !!body.voice })");
    expect(h).toContain("emit(envelope(SCREEN_OPEN, typed, SCREEN_CLOSE))");
    expect(h).toContain("continue;");
    expect(h).not.toContain("break;");
    expect(h).toContain("not_used: Object.keys(asked)");
    expect(route).toContain('fill_screen: "Typing it in…"');
  });
  it("the boxes on the screen and what landed ride the message TAIL (volatile), never the cached system block", () => {
    expect(route).toContain("const doorLines = doorContextLines(body.doors);");
    expect(route).toContain("tailContext.push(`BOXES ON THE SCREEN RIGHT NOW (fill_screen doors; [name] what it is):\\n${doorLines.join(\"\\n\")}`)");
    expect(route).toContain("const seen = seenLines(body.seen);");
    expect(route).toContain("WHAT LANDED ON THE SCREEN since your last turn");
    expect(route).not.toContain("systemPrompt += `${doorLines");
    expect(route).toContain("doors?: unknown; seen?: unknown");
    // A Next route may export only its handlers: the helpers live in lib.
    expect(route).not.toContain("export function doorContextLines");
  });
  it("the cached prompt block teaches TYPING FOR THEM once, for office and tech alike, with the money line", () => {
    for (const staff of [true, false]) {
      const p = screenPromptBlock(staff);
      expect(p).toContain("TYPING FOR THEM (fill_screen)");
      expect(p).toContain("BOXES ON THE SCREEN RIGHT NOW");
      expect(p).toContain("AS THEY SAID IT");
      expect(p).toContain("Never fill_screen on money");
    }
  });
  it("the phone sends its doors and what landed with every turn, clears the landed lines on send, and says a refusal under the chat", () => {
    expect(chat).toContain('import { listNortDoors } from "@/lib/nort/doors";');
    expect(chat).toContain("version: APP_VERSION, doors: listNortDoors(), seen: seenNow })");
    expect(chat).toContain("const seenNow = seenRef.current.slice();\n    turnPathRef.current = window.location.pathname;");
    expect(chat).toContain("if (res.ok) seenRef.current = seenRef.current.slice(seenNow.length);");
    // A fill lands only on the screen its boxes were listed from; a refusal is spoken by voice.
    expect(chat).toContain("if (typing && !step.path && window.location.pathname !== turnPathRef.current) {");
    expect(chat).toContain('noteUnder("The screen changed — say that again.");');
    expect(chat).toContain('if (viaVoice) say("missing" in o.result ? "That box isn\'t on this screen." : `That didn\'t go in. ${o.result.why}`);');
    const loop = chat.slice(chat.indexOf("onDoor: (o) => {"), chat.indexOf("} catch {\n            /* a point not made is not a broken turn */"));
    expect(loop).toContain("if (o.result.ok) seenRef.current.push(`${o.door}: landed — ${o.result.landed}`);");
    expect(loop).toContain("seenRef.current.push(`${o.door}: NOT filled — ${o.result.why}`);");
    expect(loop).toContain('const words = "missing" in o.result ? `No box called ${o.door} on this screen.` : `Couldn\'t put that in: ${o.result.why}`;');
  });
  it("the Inspector registers ONE provider that reads a per-render ref, and its boxes carry the door names as ids", () => {
    expect(insp).toContain("useEffect(() => registerNortDoors(() => doorsRef.current), []);");
    expect(insp).toContain("doorsRef.current = inspectorDoors({");
    for (const id of ["task-name-${t.id}", "task-hours-${t.id}", "task-units-${t.id}", "task-note-${t.id}", "task-measure-${t.id}"]) expect(insp).toContain(`id={\`${id}\`}`);
    expect(insp).toContain('<div id="insp-measures" className="scroll-mt-16 space-y-2">');
    expect(insp).toContain('<div id="insp-notes" className="scroll-mt-16">');
    // The provider's setters are the page's own: the tasks need's answer, the measures list, the capture's notes.
    const prov = insp.slice(insp.indexOf("doorsRef.current = inspectorDoors({"), insp.indexOf("useEffect(() => registerNortDoors"));
    // Fresh state for every door: the refs are written synchronously, so two fills in one tick both land.
    expect(prov).toContain("answersRef.current = nextAnswers;");
    expect(prov).toContain("setAnswers(nextAnswers);\n      queueAnswers();");
    expect(prov).toContain("const next = [...measuresRef.current, { id: captureId(), ...row }];\n      measuresRef.current = next;");
    expect(prov).toContain("queueCapture({ measures: next });");
    expect(prov).toContain("notesRef.current = text;\n      setNotes(text);\n      queueCapture({ notes: text });");
    expect(prov).toContain("answerOf: (key) => answersRef.current[key],");
    expect(prov).toContain("readNotes: () => notesRef.current,");
    expect(prov).toContain("if (openTaskIdRef.current === id) return;");
    expect(prov).toContain("readOnly,");
  });
});
