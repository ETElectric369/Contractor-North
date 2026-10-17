import type { NortDoor, DoorResult } from "@/lib/nort/doors";
import type { Need } from "@/lib/playbook/types";
import type { TaskValue } from "@/lib/playbook/tasks";
import { MAX_MEASURES, type CaptureMeasure } from "@/lib/inspection/capture";

/**
 * THE INSPECTOR'S DOORS — every box on the visit sheet Nort may type into, as pure functions over
 * the page's own setters (field feedback 10-13, rung 2: "enter text into the box directly for me
 * and record measurements where they are supposed to be recorded").
 *
 * Each door calls the SAME setter a keystroke calls (the tasks answer, setAnswer, the measures list,
 * the notes), so the page's autosave sees a typed value, the task sheet shows the task it filled,
 * and a hidden section is opened the way a tap opens it. NO SPECULATION rides in the words: a door
 * takes what was SAID — a number is one number (a range, a fraction, "15 ft 6 in" are refused in
 * words; hours and units are above zero), a pick is one of the options (or a unique start of one),
 * a measurement has a name — and fills nothing on its own; the model's empty-as-a-word ("null",
 * "none") is nothing. NORT NEVER OVERWRITES WHAT A HAND TYPED (capture.ts): a sentence box (a note,
 * an open question, a free scope, a text answer) APPENDS a line; a multi-select ADDS a pick; only a
 * one-value box (a number, a single pick, a task's name) replaces, and then `landed` says what stood.
 *
 * FRESH STATE, ALWAYS: two fills can land in one tick (one model message, two SCREEN blocks), so a
 * door never reads a render's copy — the context's readers (`taskOf`, `answerOf`, `readNotes`) and
 * setters are backed by refs the Inspector updates synchronously (skeptic #16, H1).
 *
 * Doors by name (the names are also element ids, so the driver rings the box it filled):
 *   insp-notes · insp-measures (add) · task-name/-hours/-units/-note-<id> · task-measure-<id> (add)
 *   need-<key> (text, open, scope, number, select)
 * No door for a scopes pick (the office prices those), a file, or the tasks list itself.
 */

export type DoorNeed = Pick<Need, "key" | "label" | "ask" | "slot">;

export type InspectorDoorContext = {
  /** A plain tech's view: no doors at all. */
  readOnly: boolean;
  tasks: TaskValue[];
  /** The task sheet that is open, if one is (its doors are listed first). */
  openTaskId: string | null;
  /** The task as it stands RIGHT NOW (a ref, not a render's copy). */
  taskOf: (taskId: string) => TaskValue | null;
  patchTask: (taskId: string, patch: Partial<TaskValue>) => void;
  /** Show the task's sheet without touching anything else (a no-op when it is already open). */
  showTask: (taskId: string) => void;
  measures: CaptureMeasure[];
  addMeasure: (row: Omit<CaptureMeasure, "id">) => void;
  /** The questions on the sheet that apply right now. */
  needs: DoorNeed[];
  /** The answer as it stands right now. */
  answerOf: (key: string) => unknown;
  setAnswer: (key: string, value: string | number | string[] | null) => void;
  /** Open a hidden question / section the way a tap would (AVAILABLE IS NOT VISIBLE). */
  open1: (key: string) => void;
  readNotes: () => string;
  setNotes: (text: string) => void;
};

/** The server's own caps (answers.ts, tasks.ts, capture.ts): a line past them would be cut on save. */
export const TASK_NOTE_MAX = 2000;
export const VISIT_NOTES_MAX = 8000;
export const TEXT_SHORT_MAX = 500;
export const TEXT_LONG_MAX = 8000;
/** What the model says when it means nothing (cn-v1112's lesson): never a value. */
export const EMPTY_WORDS = new Set(["", "null", "none", "undefined", "n/a", "nil", "nothing"]);

const ok = (landed: string): DoorResult => ({ ok: true, landed });
const no = (why: string): DoorResult => ({ ok: false, why });
const short = (s: string, n = 60) => s.replace(/\s+/g, " ").trim().slice(0, n);
const isEmptyWord = (s: string) => EMPTY_WORDS.has(s.trim().toLowerCase());

/** The words a box takes as its own unit, trailing the figure ("2 hrs" on the hours box). */
export const HOURS_WORDS = ["h", "hr", "hrs", "hour", "hours"];
export const UNITS_WORDS = ["x", "ea"];

/** ONE number, as said: "2.5", "12", "-3", "2 hrs" when `units` lists the box's own unit words.
 *  A range ("2 to 3", "12-14"), a fraction ("3/4"), a compound ("15 ft 6 in") or a word is
 *  refused — never the first figure out of it. A trailing word that is NOT the box's unit is
 *  refused too, naming the unit: "30 min" said to the hours box used to land as 30 hours (audit
 *  v1120, class 5) — a hole asks, it never converts. `positive` refuses zero and below. */
export function strictNumber(value: string, what: string, opts: { positive?: boolean; units?: string[] } = {}): { n: number } | { why: string } {
  const t = value.trim().replace(/,/g, "");
  const m = /^(-?\d+(?:\.\d+)?)\s*([a-z%"']{0,12})?$/i.exec(t);
  if (!m) return { why: `"${short(value, 40)}" isn't one number for ${what} — say the figure on its own.` };
  const word = (m[2] ?? "").toLowerCase();
  const units = (opts.units ?? []).map((u) => u.toLowerCase());
  if (word && !units.includes(word)) {
    const named = units.filter((u) => u.length > 2); // "hours", a slot's own unit; not the one-letter x
    return { why: `${what} takes a number${named.length ? ` in ${named[named.length - 1]}` : ""} — "${short(value, 40)}" isn't one.` };
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return { why: `"${short(value, 40)}" isn't a number for ${what}.` };
  if (opts.positive && n <= 0) return { why: `${what} has to be above zero.` };
  return { n };
}

/** A line onto a sentence box; the same line twice is one line; null when the box would overflow
 *  the server's cap (the tail would be cut on save while the screen showed it). */
export function appendNote(existing: string, value: string, max = VISIT_NOTES_MAX): string | null {
  const cur = existing.trim();
  const add = value.trim();
  if (!add) return cur;
  if (!cur) return add.length <= max ? add : null;
  if (cur.split("\n").some((l) => l.trim().toLowerCase() === add.toLowerCase())) return cur;
  const next = `${cur}\n${add}`;
  return next.length <= max ? next : null;
}

/** A measurement row from said fields: a NAME (the server drops a nameless row), a number above
 *  zero when one was said, the unit as said; the model's empty words are nothing. */
export function measureFromFields(fields: Record<string, string>): { row: Omit<CaptureMeasure, "id" | "task_id"> } | { why: string } {
  const pick = (k: string) => {
    const v = (fields[k] ?? "").trim();
    return isEmptyWord(v) ? "" : v;
  };
  const label = short(pick("label") || pick("what"), 80);
  const unit = short(pick("unit"), 16);
  const valueText = pick("value");
  if (!label) return { why: "What was measured? A measurement needs a name (the north wall, the run to the panel)." };
  let value: number | null = null;
  if (valueText) {
    const r = strictNumber(valueText, "a measurement", { positive: true, units: unit ? [unit] : [] }); // its unit is its own field
    if ("why" in r) return { why: r.why };
    value = r.n;
  }
  return { row: { label, value, unit } };
}

const sayMeasure = (m: { label: string; value: number | null; unit: string }) =>
  [m.label, m.value !== null ? `${m.value}${m.unit ? ` ${m.unit}` : ""}` : null].filter(Boolean).join(": ");

/** The option that was said: exact (case-blind), else the one option it starts, else the one whose
 *  words before " — " / " (" match. Null = none; undefined = more than one could be meant. */
export function matchOption(said: string, options: string[]): string | null | undefined {
  const s = said.trim().toLowerCase();
  if (!s) return null;
  const exact = options.find((o) => o.toLowerCase() === s);
  if (exact) return exact;
  const head = (o: string) => o.toLowerCase().split(/\s+[—(-]\s*|\s*\(/)[0].trim();
  const heads = options.filter((o) => head(o) === s);
  if (heads.length === 1) return heads[0];
  const starts = options.filter((o) => o.toLowerCase().startsWith(s));
  if (starts.length === 1) return starts[0];
  return starts.length > 1 || heads.length > 1 ? undefined : null;
}

const was = (prev: string) => (prev ? ` (was: ${short(prev, 40)})` : "");
const nowText = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : "");

/** The door for one question, by its slot. Null = not a box Nort types into. */
export function needDoor(n: DoorNeed, ctx: InspectorDoorContext): NortDoor | null {
  const slot = n.slot;
  const label = n.ask || n.label;
  const land = (words: string): DoorResult => {
    ctx.open1(n.key);
    return ok(words);
  };
  const current = nowText(ctx.answerOf(n.key));
  // A SENTENCE BOX — an open need, a text answer, a free-typed scope: his line goes under what stands.
  if (!slot || slot.type === "text" || (slot.type === "scope" && !slot.options?.length)) {
    const max = !slot || slot.type === "scope" ? TEXT_LONG_MAX : slot.long ? TEXT_LONG_MAX : TEXT_SHORT_MAX;
    return {
      label: `${label} (adds a line)`,
      now: current || undefined,
      fill: (value) => {
        if (isEmptyWord(value)) return no("Nothing to put in.");
        const cur = nowText(ctx.answerOf(n.key));
        const next = appendNote(cur, value, max);
        if (next === null) return no(`${n.label} is full — ${max} characters is the most it holds.`);
        ctx.setAnswer(n.key, next || null);
        return land(`${n.label}: ${short(value)}${cur ? " (added under what was there)" : ""}`);
      },
    };
  }
  if (slot.type === "number") {
    return {
      label: `${label}${slot.unit ? ` (${slot.unit})` : ""}`,
      now: current || undefined,
      fill: (value) => {
        if (isEmptyWord(value)) return no("Nothing to put in.");
        const r = strictNumber(value, n.label, { units: slot.unit ? [slot.unit] : [] });
        if ("why" in r) return no(r.why);
        const cur = nowText(ctx.answerOf(n.key));
        ctx.setAnswer(n.key, r.n);
        return land(`${n.label}: ${r.n}${slot.unit ? ` ${slot.unit}` : ""}${was(cur)}`);
      },
    };
  }
  if (slot.type === "select" || (slot.type === "scope" && slot.options?.length)) {
    const options = slot.type === "select" ? slot.options : (slot.options ?? []);
    const multi = slot.type === "select" ? !!slot.multi : false;
    const other = slot.type === "select" ? !!slot.other : true; // a chosen scope always keeps its Something Else box
    return {
      label: `${label}${other ? " (one of the choices, or their own words)" : " (one of the choices)"}${multi ? " — several add up" : ""}`,
      options,
      now: current || undefined,
      fill: (value) => {
        if (isEmptyWord(value)) return no("Nothing to put in.");
        const said = (multi ? value.split(/\s*,\s*|\s*;\s*|\n/) : [value]).map((x) => x.trim()).filter(Boolean);
        if (!said.length) return no("Nothing to put in.");
        const picks: string[] = [];
        for (const s of said) {
          const hit = matchOption(s, options);
          if (hit) picks.push(hit);
          else if (hit === undefined) return no(`"${short(s, 40)}" could mean more than one of the choices for ${n.label}: ${options.join(" / ")}.`);
          else if (other) picks.push(s);
          else return no(`"${short(s, 40)}" isn't one of the choices for ${n.label}: ${options.join(" / ")}.`);
        }
        const curV = ctx.answerOf(n.key);
        if (multi) {
          const cur = Array.isArray(curV) ? curV.filter((x): x is string => typeof x === "string") : typeof curV === "string" && curV ? [curV] : [];
          const next = [...cur];
          for (const p of picks) if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
          ctx.setAnswer(n.key, next);
          return land(`${n.label}: ${next.join(", ")}`);
        }
        ctx.setAnswer(n.key, picks[0]);
        return land(`${n.label}: ${picks[0]}${was(nowText(curV))}`);
      },
    };
  }
  return null; // scopes (priced by the office), a file, the tasks list
}

const taskWord = (t: TaskValue) => (t.name.trim() ? `'${short(t.name, 40)}'` : "the unnamed task");

/** Every door on the sheet as it stands right now — the provider the Inspector registers reads this.
 *  Order matters (the listing caps at 80): the visit's own two doors, the OPEN task, the other
 *  tasks, then the questions. */
export function inspectorDoors(ctx: InspectorDoorContext): Record<string, NortDoor> {
  const doors: Record<string, NortDoor> = {};
  if (ctx.readOnly) return doors;
  const addRow = (taskId: string | null) => (fields: Record<string, string>): DoorResult => {
    if (ctx.measures.length >= MAX_MEASURES) return no(`${MAX_MEASURES} measurements is the most a visit holds — take one off first.`);
    const r = measureFromFields(fields);
    if ("why" in r) return no(r.why);
    const task = taskId ? ctx.taskOf(taskId) : null;
    if (taskId && !task) return no("That task is no longer on the sheet.");
    ctx.addMeasure(task ? { ...r.row, task_id: task.id } : r.row);
    if (task) ctx.showTask(task.id);
    else ctx.open1("measures");
    return ok(`${sayMeasure(r.row)}${task ? ` on ${taskWord(task)}` : ""}`);
  };
  doors["insp-notes"] = {
    label: "The visit's Notes (adds a line)",
    now: ctx.readNotes() || undefined,
    fill: (value) => {
      if (isEmptyWord(value)) return no("Nothing to put in.");
      const next = appendNote(ctx.readNotes(), value, VISIT_NOTES_MAX);
      if (next === null) return no(`The notes are full — ${VISIT_NOTES_MAX} characters is the most they hold.`);
      ctx.setNotes(next);
      ctx.open1("notes");
      return ok(`note: ${short(value)}`);
    },
  };
  doors["insp-measures"] = {
    label: "Add A Measurement to the visit (not on a task)",
    fields: ["label", "value", "unit"],
    add: addRow(null),
  };
  const ordered = [...ctx.tasks].sort((a, b) => (a.id === ctx.openTaskId ? -1 : b.id === ctx.openTaskId ? 1 : 0));
  for (const t0 of ordered) {
    if (!t0.id) continue;
    const id = t0.id;
    const fresh = () => ctx.taskOf(id);
    const open = (words: string): DoorResult => {
      ctx.showTask(id);
      return ok(words);
    };
    doors[`task-name-${id}`] = {
      label: `The name of ${taskWord(t0)}`,
      now: t0.name.trim() || undefined,
      fill: (value) => {
        if (isEmptyWord(value)) return no("Nothing to put in.");
        const t = fresh();
        if (!t) return no("That task is no longer on the sheet.");
        const name = short(value, 120);
        ctx.patchTask(id, { name });
        return open(`task named ${short(name, 40)}${was(t.name)}`);
      },
    };
    doors[`task-hours-${id}`] = {
      label: `Hours on ${taskWord(t0)}`,
      now: t0.hours !== null ? `${t0.hours} h` : undefined,
      fill: (value) => {
        if (isEmptyWord(value)) return no("Nothing to put in.");
        const r = strictNumber(value, "hours", { positive: true, units: HOURS_WORDS });
        if ("why" in r) return no(r.why);
        const t = fresh();
        if (!t) return no("That task is no longer on the sheet.");
        ctx.patchTask(id, { hours: r.n });
        return open(`${r.n} h on ${taskWord(t)}${was(t.hours !== null ? `${t.hours} h` : "")}`);
      },
    };
    // The units box exists only beside a kit (or where a count already stands): no box, no door.
    if (t0.kit_id || t0.units !== null) {
      doors[`task-units-${id}`] = {
        label: `Units (how many of the kit) on ${taskWord(t0)}`,
        now: t0.units !== null ? `×${t0.units}` : undefined,
        fill: (value) => {
          if (isEmptyWord(value)) return no("Nothing to put in.");
          const r = strictNumber(value, "units", { positive: true, units: UNITS_WORDS });
          if ("why" in r) return no(r.why);
          const t = fresh();
          if (!t) return no("That task is no longer on the sheet.");
          ctx.patchTask(id, { units: r.n });
          return open(`×${r.n} on ${taskWord(t)}${was(t.units !== null ? `×${t.units}` : "")}`);
        },
      };
    }
    doors[`task-note-${id}`] = {
      label: `Note on ${taskWord(t0)} (adds a line)`,
      now: t0.note?.trim() || undefined,
      fill: (value) => {
        if (isEmptyWord(value)) return no("Nothing to put in.");
        const t = fresh();
        if (!t) return no("That task is no longer on the sheet.");
        const next = appendNote(t.note ?? "", value, TASK_NOTE_MAX);
        if (next === null) return no(`That task's note is full — ${TASK_NOTE_MAX} characters is the most it holds.`);
        ctx.patchTask(id, { note: next || null });
        return open(`note on ${taskWord(t)}: ${short(value)}`);
      },
    };
    doors[`task-measure-${id}`] = {
      label: `Add A Measurement to ${taskWord(t0)}`,
      fields: ["label", "value", "unit"],
      add: addRow(id),
    };
  }
  for (const n of ctx.needs) {
    if (n.slot?.type === "tasks") continue;
    const d = needDoor(n, ctx);
    if (d) doors[`need-${n.key}`] = d;
  }
  return doors;
}
