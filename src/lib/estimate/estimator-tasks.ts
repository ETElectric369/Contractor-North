import { countsIn, hoursIn } from "@/lib/playbook/resolve";
import { coerceTask, contentWords, screenHeardTask, type TaskValue } from "@/lib/playbook/tasks";

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
 * named in it, and a count must be said in it (or be one by its article). Ids, kit ids and codes
 * the model writes are wiped. What was heard and not kept is SAID (`dropped`) so the builder can
 * show it — nothing is lost silently.
 *
 * THE FRAGMENT IS ONE LINE, AND IT IS ONE TASK'S (the skeptic's probe, 2026-10-09): a `heard` that
 * spanned the whole scope let any figure in it attach to any task, and two tasks sharing one
 * fragment both took its "3 hours total for both". So a fragment spanning lines is refused, and
 * tasks that share a fragment lose their hours and say why — one time for two pieces of work is
 * neither piece's time.
 *
 * ONLY HIS WORDS ARE EVIDENCE. The scope the builder sends can carry blocks the page labelled as
 * NOT his — a stranger's web-form answers, a machine's reading of a plan ("NOT CONFIRMED ON SITE",
 * "WHAT THE CUSTOMER TOLD YOU", "IN THEIR OWN WORDS"). The model may read them for context; a task
 * must trace to the rest.
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

/** The headers quotes/new/page.tsx puts on the blocks that are NOT the contractor's own words. */
const NOT_HIS_WORDS = ["NOT CONFIRMED ON SITE", "WHAT THE CUSTOMER TOLD YOU", "IN THEIR OWN WORDS", "ATTACHED TO THIS INSPECTION"];

/** The scope with every block that is not his words removed (paragraphs are separated by a blank line). */
export function stripUnverified(scope: string): string {
  return scope
    .split(/\n\s*\n/)
    .filter((para) => !NOT_HIS_WORDS.some((h) => para.trimStart().toUpperCase().startsWith(h)))
    .join("\n\n");
}

/** The containment test folds whitespace and case: his words, not his typing. */
const fold = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

export function screenEstimatorTasks(scope: string, raw: unknown): { tasks: TaskValue[]; dropped: string[] } {
  const dropped: string[] = [];
  const kept: { task: TaskValue; heard: string }[] = [];
  const text = fold(stripUnverified(scope));
  for (const r of Array.isArray(raw) ? raw : []) {
    const o = (r && typeof r === "object" ? r : {}) as EstimatorTaskRaw;
    // Shape only here (name, hours, parts); provenance is screened below. A nameless entry is nothing.
    const t = coerceTask({ name: o.name, hours: o.hours, materials: o.materials });
    if (!t) continue;
    const heard = typeof o.heard === "string" ? o.heard.trim() : "";
    if (/\n/.test(heard)) {
      dropped.push(`its words span more than one line: ${t.name}`);
      continue;
    }
    if (!heard || !text.includes(fold(heard))) {
      dropped.push(`not in the scope: ${t.name}`);
      continue;
    }
    const screened = screenHeardTask(t, heard, { hours: hoursIn(heard), counts: countsIn(heard) });
    dropped.push(...screened.dropped);
    if (screened.task) kept.push({ task: screened.task, heard: fold(heard) });
  }

  // THE SAME TASK SAID TWICE collapses only when it is the same words from the same place. Two
  // "Replace outlet" tasks from two lines (the kitchen's and the bath's) are two tasks — the
  // inspector's name merge (mergeHeardTasks) is for filling HIS list, not for this.
  const tasks: TaskValue[] = [];
  const distinct: { task: TaskValue; heard: string }[] = [];
  const seen = new Map<string, TaskValue>();
  for (const k of kept) {
    // The name's content words (plurals folded, the glue dropped — the inspector's sameTask) plus
    // the fragment: "Install transfer switch" and "Install the transfer switch" from one line are one.
    const key = `${contentWords(k.task.name).join(" ")}|${k.heard}`;
    const twin = seen.get(key);
    if (!twin) {
      seen.set(key, k.task);
      tasks.push(k.task);
      distinct.push(k);
      continue;
    }
    if (twin.hours === null && k.task.hours !== null) twin.hours = k.task.hours;
    else if (twin.hours !== null && k.task.hours !== null && twin.hours !== k.task.hours) dropped.push(`${twin.name}: said with two different hours`);
    for (const m of k.task.materials) {
      if (!twin.materials.some((x) => x.words === m.words)) twin.materials.push(m);
    }
  }
  // ONE FRAGMENT, ONE TASK'S HOURS. Tasks that share a fragment keep their names and parts and lose
  // their hours: "pull the permit and set the panel, 3 hours total" is not 3 h twice.
  const byHeard = new Map<string, { task: TaskValue; heard: string }[]>();
  for (const k of distinct) byHeard.set(k.heard, [...(byHeard.get(k.heard) ?? []), k]);
  for (const group of byHeard.values()) {
    if (group.length < 2 || !group.some((k) => k.task.hours !== null)) continue;
    dropped.push(`one time was said for ${group.map((k) => k.task.name).join(" and ")} together — each asks for its own`);
    for (const k of group) k.task.hours = null;
  }

  return { tasks, dropped };
}
