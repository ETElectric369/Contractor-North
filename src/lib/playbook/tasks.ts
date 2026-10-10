import { captureId, looseNumber } from "@/lib/inspection/capture";
import type { TaskMaterial, TaskValue } from "./types";

export type { TaskMaterial, TaskValue } from "./types";

/**
 * A TASK IS THE UNIT — on the inspection, on the estimate, on the job.
 *
 * Erik (2026-10-09): "the foundation underlying the ability to estimate a project no matter what
 * it is is pretty much always broken down into tasks like we already have setup on the jobs …
 * each task carries its own labor and materials and is really how we ultimately have to separate
 * it to estimate it properly anyway."
 *
 * His own why lines already said it. "What materials are needed?" → "Line items listed
 * individually on estimate priced from price book". "How long will it take?" → "Labor line
 * item(s)". What was missing was the SHAPE: one scope box, one hours box and one materials box
 * for the whole job, so nothing tied an hour or a part to the piece of work it belonged to. The
 * Oct 7 visit arrived as a six-line scope, "4 full days" for everything, and no materials; zero
 * estimate lines came out of it, and the only door that could make lines guessed them.
 *
 * ── THE LAW THIS FILE CARRIES: NO SPECULATION ([[no-speculation]]) ─────────────────────────
 *
 * `hours` is HIS number, said or typed on site. null means he has not given it yet, and a task
 * without hours is drawn ASKING and prices nothing — never a typical figure, never an average.
 * A material's `qty` is the same: null is "I know I need it, I haven't counted it", and it is
 * never a silent 0 (looseNumber's law). Nort may split his paragraph into tasks and put HIS
 * numbers in the boxes, traceable to his words (resolve.applyFills); it may not invent one.
 *
 * ── WHY A SLOT TYPE, NOT A NEW TABLE ───────────────────────────────────────────────────────
 *
 * `scopes` proved the shape: a typed answer in the playbook rides the why line, the hold, the
 * position he gave it, the hear path, the crew-lead rules and the estimate seed with no second
 * mechanism. A task list is the same kind of thing with hours and parts beneath each row, so it
 * is the next slot type, and the value lives in `inspection_answers` under his key like every
 * other answer. One coercer, one renderer, one door onto the estimate ([[two-doors-one-thing]]).
 */

export const MAX_TASKS = 60;
export const MAX_TASK_MATERIALS = 60;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A positive number or null. 0 is not an hours figure and not a count — it is a hole. */
const positive = (v: unknown, max: number): number | null => {
  const n = looseNumber(v);
  if (n === null || n <= 0) return null;
  const r = Math.min(Math.round(n * 100) / 100, max);
  return r > 0 ? r : null;
};

/** One part under a task. Dropped when it names nothing (no code and no words). */
export function coerceTaskMaterial(raw: unknown): TaskMaterial | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const code = str(o.code, 64) || null;
  const words = str(o.words, 300) || null;
  if (!code && !words) return null;
  return { code, words, qty: positive(o.qty, 1000000) };
}

/** One task. Shape only: whether a CODE is in this org's book or a kit is this org's is checked
 *  where the book is known (the estimate seed), the same split as the scopes slot. */
export function coerceTask(raw: unknown): TaskValue | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = str(o.name, 500);
  if (!name) return null;
  const materials = Array.isArray(o.materials)
    ? (o.materials as unknown[]).map(coerceTaskMaterial).filter((m): m is TaskMaterial => !!m).slice(0, MAX_TASK_MATERIALS)
    : [];
  return {
    id: str(o.id, 80) || captureId(name),
    name,
    hours: positive(o.hours, 100000),
    units: positive(o.units, 100000),
    kit_id: str(o.kit_id, 64) || null,
    materials,
  };
}

/** The whole answer. Not an array → null; an array with no real task → null (null is visible). */
export function coerceTasks(v: unknown): TaskValue[] | null {
  if (!Array.isArray(v)) return null;
  const out: TaskValue[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const t = coerceTask(raw);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= MAX_TASKS) break;
  }
  return out.length ? out : null;
}

/** Is this answer a task list? (The one shape test every reader of AnswerValue can ask.) */
export function isTaskList(v: unknown): v is TaskValue[] {
  return Array.isArray(v) && v.length > 0 && v.every((t) => t && typeof t === "object" && typeof (t as TaskValue).name === "string");
}

/** A task that is still ASKING: no hours from him yet. It prices nothing until he answers. */
export const taskAsking = (t: TaskValue): boolean => t.hours === null;

/** The words that carry meaning in a phrase: lowercased, plurals folded, the glue dropped. */
const GLUE = new Set(["the", "a", "an", "of", "in", "on", "to", "for", "and", "with", "at", "by", "from", "up", "is", "it", "its", "or", "into", "onto", "off", "out", "per", "all", "that", "this", "new"]);
export function contentWords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9/]+/)
    .filter((w) => w.length > 1 && !GLUE.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}
const norm = (s: string) => contentWords(s).join(" ");
/** The same task said twice: the same words, give or take punctuation, case and a plural. */
export const sameTask = (a: string, b: string): boolean => !!norm(a) && norm(a) === norm(b);

/**
 * DID HE SAY THIS? `words` is a name the model wrote; `heard` is the fragment of his words it
 * says the task came from. Every meaningful word of a PART must be in the fragment (a part is
 * copied, not composed); a TASK NAME may be shortened or reordered by the model, so two in three
 * of its words must be there. Below that, the task or the part was invented and it is dropped.
 */
export function saidIn(words: string, heard: string, share = 1): boolean {
  const want = contentWords(words);
  if (!want.length) return false;
  const have = new Set(contentWords(heard));
  const hit = want.filter((w) => have.has(w)).length;
  return hit >= Math.ceil(want.length * share);
}

/**
 * "A 50 amp breaker", "an outlet", "one transfer switch": ONE of a part is said by the article in
 * front of it (up to three words may sit between, "a manual transfer switch"). Without the article
 * — "install receptacles in the kitchen" — no count was said, and the part asks "how many?".
 */
export function saidOne(words: string, heard: string): boolean {
  const first = contentWords(words)[0];
  if (!first) return false;
  const re = new RegExp(`\\b(a|an|one|1)\\s+(?:[a-z0-9/]+\\s+){0,3}${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  return re.test(heard.toLowerCase().replace(/[^a-z0-9/\s]/g, " "));
}

/** One material as a person reads it: "14/2 romex ×100", "R142 ×2", "a box". */
export function materialText(m: TaskMaterial): string {
  const name = m.words || m.code || "";
  return m.qty === null ? name : `${name} ×${m.qty}`;
}

/** One task as one line. The estimator, the hear prompt and the retired-answers block all read
 *  this; "hours?" is the asking state said out loud, never a number. */
export function taskLine(t: TaskValue): string {
  const hours = t.hours === null ? "hours?" : `${t.hours} h${t.units !== null && t.units !== 1 ? ` × ${t.units}` : ""}`;
  const parts = t.materials.length ? `: ${t.materials.map(materialText).join(", ")}` : "";
  return `${t.name} — ${hours}${parts}`;
}

/** The list, one task per line. His line breaks are his structure (answers.factsForEstimator). */
export const taskText = (tasks: TaskValue[]): string => tasks.map(taskLine).join("\n");

/**
 * NORT HEARD SOME TASKS. Merge them into what is already on the sheet: FILL HOLES, NEVER
 * OVERWRITE A HAND.
 *
 *   · a task he has not named yet is ADDED (with whatever numbers survived the trace);
 *   · a task he already has keeps HIS hours; only a null gets filled; a disagreement is SAID;
 *   · materials he already listed under it stay; new ones are appended.
 *
 * Pure. The caller (resolve.applyFills) has already traced every number to his words.
 */
export function mergeHeardTasks(
  existing: TaskValue[],
  heard: TaskValue[],
): { tasks: TaskValue[]; added: string[]; skipped: string[] } {
  const tasks = existing.map((t) => ({ ...t, materials: [...t.materials] }));
  const added: string[] = [];
  const skipped: string[] = [];
  for (const h of heard) {
    const at = tasks.findIndex((t) => sameTask(t.name, h.name));
    if (at < 0) {
      if (tasks.length >= MAX_TASKS) break;
      tasks.push(h);
      added.push(h.name);
      continue;
    }
    const t = tasks[at];
    let touched = false;
    if (t.hours === null && h.hours !== null) {
      t.hours = h.hours;
      touched = true;
    } else if (t.hours !== null && h.hours !== null && t.hours !== h.hours) skipped.push(t.name);
    for (const m of h.materials) {
      const have = t.materials.some((x) => (m.code && x.code === m.code) || (m.words && x.words && sameTask(x.words, m.words)));
      if (have || t.materials.length >= MAX_TASK_MATERIALS) continue;
      t.materials.push(m);
      touched = true;
    }
    if (touched) added.push(t.name);
  }
  return { tasks, added, skipped };
}

/** What the resolver knows about the fragment a fill came from (resolve.hoursIn / numbersIn). */
export interface HeardNumbers {
  /** The figures he said AS HOURS — "3 hours", "an hour and a half". "4 days" is not among them. */
  hours: readonly number[];
  /** The numbers said as COUNTS (resolve.countsIn): not the hours figure, not money. */
  counts: readonly number[];
}

/**
 * A TASK THE MODEL HEARD, SCREENED AGAINST HIS WORDS. The model only structures; this is where
 * that law is enforced in code rather than asked for in a prompt.
 *
 *   · the task's NAME must be (mostly) his words — else the whole task is refused (null);
 *   · each PART must be named in the fragment — else that part is dropped;
 *   · `hours` must be a figure he said AS HOURS. "Whole thing is 4 full days" and "4 receptacles"
 *     both contain a 4 and neither is 4 hours; a day is not converted (that is arithmetic, and
 *     somebody else's). Otherwise null: the task stays and ASKS;
 *   · a part's `qty` must be a COUNT in the fragment (countsIn: not the hours figure, not money),
 *     or 1 when the article says so ("a 50 amp breaker", "one switch") — "install receptacles" names
 *     a part and no count, so it asks "how many?";
 *   · `units`, `kit_id`, a material `code` and the `id` are never the model's: wiped. The kit and
 *     the book are his to pick; an id the model invents could shadow a task he typed.
 *
 * `dropped` says, for the note, what was heard and not kept — nothing is lost silently.
 */
export function screenHeardTask(t: TaskValue, heard: string, said: HeardNumbers): { task: TaskValue | null; dropped: string[] } {
  const dropped: string[] = [];
  if (!saidIn(t.name, heard, 2 / 3)) return { task: null, dropped: [`a task he did not name: ${t.name}`] };
  const hours = t.hours === null || said.hours.includes(t.hours) ? t.hours : (dropped.push(`${t.name}: ${t.hours} h was not said as hours`), null);
  if (t.units !== null) dropped.push(`${t.name}: × ${t.units}`);
  const materials: TaskMaterial[] = [];
  for (const m of t.materials) {
    const name = m.words ?? m.code ?? "";
    if (!saidIn(name, heard)) {
      dropped.push(`${t.name}: a part he did not name: ${name}`);
      continue;
    }
    const counted = m.qty === null || said.counts.includes(m.qty) || (m.qty === 1 && saidOne(name, heard));
    const qty = counted ? m.qty : (dropped.push(`${t.name}: ${materialText(m)} — the count was not said`), null);
    materials.push({ code: null, words: name, qty });
  }
  return { task: { id: captureId(), name: t.name, hours, units: null, kit_id: null, materials }, dropped };
}
