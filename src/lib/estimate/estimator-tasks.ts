import { hoursIn, numbersIn } from "@/lib/playbook/resolve";
import { coerceTask, mergeHeardTasks, screenHeardTask, type TaskValue } from "@/lib/playbook/tasks";

/**
 * DRAFT WITH ESTIMATOR, IN TASK MODE: the model SPLITS his scope into tasks; it never prices one.
 *
 * Erik (2026-10-09): Draft With Estimator "is the speculation" — it read his punch list and
 * returned crew-hours it had decided on and parts it had chosen. His answer: the draft becomes a
 * TASK LIST. Each task is his words, with his hours when he wrote them and his parts when he named
 * them; a task he gave no time for ASKS ("hours?"), and the line prices from the task
 * (task-lines.ts), never from the model.
 *
 * THE SAME GATE THE INSPECTOR USES (screenHeardTask): every task must trace to his words. The model
 * returns, per task, the fragment of the scope it came from (`heard`); the fragment must be IN the
 * scope, the task's name must be (mostly) the fragment's words, the hours must be a figure said AS
 * hours in that fragment ("4 full days" is not 4 hours; a day is never converted), each part must be
 * named in it, and a count must appear in it (or be one of a named part). Ids, kit ids and codes
 * the model writes are wiped. What was heard and not kept is SAID (`dropped`) so the builder can
 * show it — nothing is lost silently.
 *
 * Pure, so it is tested without the API. The server action parses the model's JSON, calls this with
 * the scope text it sent, then prices the survivors with taskLines.
 */

export interface EstimatorTaskRaw {
  name?: unknown;
  hours?: unknown;
  heard?: unknown;
  materials?: unknown;
}

/** The containment test folds whitespace and case: his words, not his typing. */
const fold = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

export function screenEstimatorTasks(scope: string, raw: unknown): { tasks: TaskValue[]; dropped: string[] } {
  const dropped: string[] = [];
  const kept: TaskValue[] = [];
  const text = fold(scope);
  for (const r of Array.isArray(raw) ? raw : []) {
    const o = (r && typeof r === "object" ? r : {}) as EstimatorTaskRaw;
    // Shape only here (name, hours, parts); provenance is screened below. A nameless entry is nothing.
    const t = coerceTask({ name: o.name, hours: o.hours, materials: o.materials });
    if (!t) continue;
    const heard = typeof o.heard === "string" ? o.heard.trim() : "";
    if (!heard || !text.includes(fold(heard))) {
      dropped.push(`not in the scope: ${t.name}`);
      continue;
    }
    const screened = screenHeardTask(t, heard, { hours: hoursIn(heard), counts: numbersIn(heard) });
    dropped.push(...screened.dropped);
    if (screened.task) kept.push(screened.task);
  }
  // The same task said twice collapses to one (his hours stand; a disagreement is said).
  const merged = mergeHeardTasks([], kept);
  for (const name of merged.skipped) dropped.push(`${name}: said with two different hours`);
  return { tasks: merged.tasks, dropped };
}
