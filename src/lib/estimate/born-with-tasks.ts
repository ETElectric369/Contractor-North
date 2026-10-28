import type { SupabaseClient } from "@supabase/supabase-js";
import type { CaptureItem } from "@/lib/inspection/capture";
import type { Answers, Playbook } from "@/lib/playbook/types";
import { coerceTasks, type TaskValue } from "@/lib/playbook/tasks";
import { applicableNeeds, clearInapplicable } from "@/lib/playbook/resolve";
import { dbError } from "@/lib/db-error";
import { PLANNED_MINUTES_MAX, coerceTaskDetail, expandTaskKit, laborMinutes, lineQty, minutesPastBound, taskMinutesFor, type TaskKit } from "./task-lines";

/** The bound lives with the minutes rule (task-lines); callers that knew it here still find it. */
export { PLANNED_MINUTES_MAX } from "./task-lines";

/**
 * A JOB IS BORN WITH ITS TASKS (W3, cn-v1075).
 *
 * Erik (2026-10-09): "the foundation underlying the ability to estimate a project … is pretty much
 * always broken down into tasks … each task carries its own labor and materials." W1 put the task
 * on the Inspector, W2 made each one a line on the estimate with its breakdown riding the line
 * (quote_line_items.detail, 0386). This is the last step of the chain: when the estimate becomes a
 * job, every task line becomes a task ON THE JOB — the one list the crew checks off (0358) — in
 * estimate order, the job's planned length is the sum of HIS hours, and each task's parts land on
 * the job's materials list by code. A job started straight from a visit (no estimate) is born the
 * same way from the tasks typed on the inspection.
 *
 * ── THE RULES ─────────────────────────────────────────────────────────────────────────────────
 *
 *  - ONE RULE, THREE DOORS. The office's accept (createJobFromQuote), the customer's own Accept link
 *    (finishPublicAcceptance) and Start The Job on a visit (createJobFromAppointment) all call the
 *    same two functions here: a pure reader that says what is born, and bornTasks that writes it.
 *  - ONLY A TASK IS A TASK. A line whose detail coerces (coerceTaskDetail) is a task; a plain line
 *    (a legacy estimate, a hand-typed material) is not, and is born exactly as before.
 *  - HIS HOURS, SUMMED, NEVER FILLED. A task's labor is one or more rows (cn-v1131, TaskLabor); its
 *    minutes are Σ round(hours × 60) over the rows he gave hours to, written on the task itself
 *    (tasks.planned_minutes, 0395), and the job's planned_minutes is the same sum over every task.
 *    A row still asking ("hours?") adds nothing — the sum is his figures, not a guess
 *    ([[no-speculation]]). No hours at all → null, and the job's How Long box asks as it does today.
 *    A How Long the job already has WINS (the write lands only on a null); 0229's bound
 *    (0 < n ≤ 43200) is honoured by leaving an out-of-range sum null rather than clamping it.
 *  - THE QTY BOX IS "THIS MANY OF THE TASK" (cn-v1133). The breakdown is per unit and the paper
 *    multiplies it by the line's quantity, so the job does too: a task at qty 2 is born with twice
 *    the minutes and twice each counted part (taskMinutesFor, partQtyFor). A part he never counted
 *    stays null — "I haven't counted it" — at any quantity. Every door that reads lines for the
 *    birth selects `quantity` (LineRow): a reader that leaves it out is the bug class this closed.
 *  - IDEMPOTENT BY KEY. tasks.source_key ("line:<line id>", "task:<task id>") with
 *    tasks_job_source_key_uq means a door run twice births nothing twice. PostgREST's upsert cannot
 *    name a partial index's predicate, so the keys the job already has are read first and only the
 *    missing ones are inserted. SILENT-WRITE LAW: every write selects what it wrote and counts it.
 *  - A SERVICE CLIENT SAYS WHO. set_org_id stamps org_id from the JWT, and a service-role write has
 *    none — so org_id and created_by are always sent; on a user client they equal what the trigger
 *    would have stamped.
 */

export interface BornTask {
  /** "line:<quote_line_items.id>" or "task:<TaskValue.id>" — the job's idempotency key (0358). */
  source_key: string;
  title: string;
  sort_order: number;
  /** The Inspector task the line was built from (detail.task_id), when it was: how a visit-born task
   *  ("task:<id>") finds the line of the estimate drafted from the same visit (sync-job-tasks). */
  task_id?: string | null;
  /** THE TASK'S OWN MINUTES (tasks.planned_minutes, 0395): Σ its labor rows' hours × 60; null = he gave
   *  none (the task asks on the job as it did on the paper). The job's planned_minutes is the sum. */
  planned_minutes?: number | null;
}

/** One part of one task, as the job's materials list wants it. `cost` is the book's buy at the time
 *  the line was built (detail.cost); null = the book did not price it, so the list asks. */
export interface BornPart {
  source_key: string;
  code: string | null;
  name: string;
  /** null = "how many?" — the list says so rather than inventing a count. */
  qty: number | null;
  cost: number | null;
}

export interface Birth {
  tasks: BornTask[];
  /** Σ his hours, in minutes; null when he gave none (or the sum is outside 0229's bound). */
  plannedMinutes: number | null;
  parts: BornPart[];
}

export const EMPTY_BIRTH: Birth = { tasks: [], plannedMinutes: null, parts: [] };

/** A PART'S KEY ON THE MATERIALS LIST (0390): its task's key plus the part — the book code when it has
 *  one, else a slug of its words — so the sync finds the row again and the builder's new line ids can
 *  be matched by the "#part" half. "line:<id>#R1", "line:<id>#bayberry-clips"; a SECOND part of the
 *  same code on one task is "#R1~2" (the ordinal), so two rows never share a key and the sync can
 *  count them. Every door that keys a part goes through keyParts, so the ordinals agree. */
export function materialKey(sourceKey: string, code: string | null, name: string, ordinal = 1): string {
  const c = String(code ?? "").trim().toUpperCase();
  const part = c || String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "part";
  return `${sourceKey}#${part}${ordinal > 1 ? `~${ordinal}` : ""}`;
}

/** The keys of ONE task's parts, in order, with ordinals for repeats of the same code or words. */
export function keyParts<T extends { code: string | null; name: string }>(sourceKey: string, parts: ReadonlyArray<T>): Array<T & { key: string }> {
  const seen = new Map<string, number>();
  return parts.map((p) => {
    const first = materialKey(sourceKey, p.code, p.name);
    const n = (seen.get(first) ?? 0) + 1;
    seen.set(first, n);
    return { ...p, key: materialKey(sourceKey, p.code, p.name, n) };
  });
}

/** A sum the job's column would take (0229): 0 < n ≤ PLANNED_MINUTES_MAX, else null — never clamped. */
const bounded = (sum: number): number | null => (sum > 0 && sum <= PLANNED_MINUTES_MAX ? sum : null);

/** Σ round(h × 60) over the hours he gave. None given → null; a sum the column would refuse → null. */
export function minutesOf(hours: ReadonlyArray<number | null>): number | null {
  const given = hours.filter((h): h is number => typeof h === "number" && Number.isFinite(h) && h > 0);
  if (!given.length) return null;
  return bounded(given.reduce((t, h) => t + Math.round(h * 60), 0));
}

/** THE JOB'S WHOLE from its tasks' own minutes: Σ over the tasks that have a figure. None → null; a sum
 *  the column would refuse → null (the same bound as minutesOf, over minutes already counted). A null
 *  here cannot tell "no hours" from "past the bound" — tasksFromLines reads that first (minutesPastBound)
 *  and leaves the whole null when any task with hours was. */
export function sumMinutes(minutes: ReadonlyArray<number | null | undefined>): number | null {
  const given = minutes.filter((m): m is number => typeof m === "number" && Number.isFinite(m) && m > 0);
  if (!given.length) return null;
  return bounded(given.reduce((t, m) => t + m, 0));
}

/** The columns a door reads off quote_line_items for the birth. `quantity` is the Qty box — "this
 *  many of the task" (cn-v1133) — and EVERY select that feeds a LineRow names it. */
export interface LineRow {
  id: string;
  description: string | null;
  sort_order: number | null;
  quantity: number | string | null;
  detail: unknown;
}

/** A PART'S COUNT FOR THIS MANY OF ITS TASK (cn-v1133): the part's count × the line's quantity, to the
 *  cent of a count (two decimals, as the breakdown stores counts). A part he never counted stays null
 *  — "I haven't counted it" — whatever the quantity; the list asks "how many?" as it did. */
export function partQtyFor(qty: number | null, lineQuantity: number): number | null {
  if (qty === null) return null;
  return Math.round(qty * lineQuantity * 100) / 100;
}

/** A wanted part with its row key (the materials sync's unit; keyed as the take-off keys rows). */
export interface KeyedPart {
  key: string;
  code: string | null;
  name: string;
  qty: number | null;
  cost: number | null;
  /** The Inspector task the line was built from (detail.task_id): how a visit's row finds its line. */
  taskId?: string | null;
}

/** The parts of a quote's TASK lines, keyed as the take-off keys them (ordinals for repeats), each
 *  count × the line's quantity. The take-off's own predicate: a line with a breakdown, whatever its
 *  title — a nameless task line's parts are still rows on the sheet. ONE reader for the materials
 *  sync and for the figure a door reads before its write (estimateLines' partCounts). */
export function partsFromLines(rows: ReadonlyArray<LineRow>): KeyedPart[] {
  const out: KeyedPart[] = [];
  for (const r of rows) {
    const d = coerceTaskDetail(r.detail);
    if (!d) continue;
    const qty = lineQty(r);
    const named = d.materials.filter((m) => m.name.trim());
    for (const m of keyParts(`line:${r.id}`, named)) out.push({ key: m.key, code: m.code, name: m.name.trim(), qty: partQtyFor(m.qty, qty), cost: m.cost, taskId: d.task_id || null });
  }
  return out;
}

/** " ×7" after a per-unit task's name, exactly as taskLine (task-lines.ts) writes the line. */
const unitsSuffix = (units: number | null): string => (units !== null && units !== 1 ? ` ×${units}` : "");

/**
 * WHAT AN ACCEPTED ESTIMATE'S LINES GIVE BIRTH TO. Rows arrive in sort order; a row that is not a
 * task (no detail) is skipped and keeps its sort_order gap, so the tasks sit in estimate order. Each
 * task's minutes and parts are for the line's quantity (cn-v1133); the job's whole is their sum.
 */
export function tasksFromLines(rows: ReadonlyArray<LineRow>): Birth {
  const tasks: BornTask[] = [];
  const parts: BornPart[] = [];
  // THE WHOLE IS NULL WHEN A TASK WITH HOURS COULD NOT BE COUNTED (skeptic #39, N1): a task past the
  // column's bound (its hours × its count) reads null, and summing the rest would hand the job a length
  // that is the OTHER tasks' — a job with one giant task showed as two hours. The How Long box asks.
  let pastBound = false;
  rows.forEach((r, i) => {
    const d = coerceTaskDetail(r.detail);
    if (!d) return;
    const title = String(r.description ?? "").trim();
    if (!title) return;
    const source_key = `line:${r.id}`;
    const qty = lineQty(r);
    if (minutesPastBound(d.labor, qty)) pastBound = true;
    tasks.push({ source_key, title, sort_order: typeof r.sort_order === "number" ? r.sort_order : i, task_id: d.task_id || null, planned_minutes: taskMinutesFor(d.labor, qty) });
    for (const m of d.materials) {
      if (!m.name.trim()) continue;
      parts.push({ source_key, code: m.code, name: m.name.trim(), qty: partQtyFor(m.qty, qty), cost: m.cost });
    }
  });
  return { tasks, plannedMinutes: pastBound ? null : sumMinutes(tasks.map((t) => t.planned_minutes)), parts };
}

/**
 * WHAT A VISIT'S TASKS GIVE BIRTH TO (no estimate in between: Start The Job on the inspection).
 * The Inspector's TaskValue: his name, his hours, his parts by words and/or code. A part's cost is
 * unknown here (nothing priced it), so the list asks for it.
 */
export function tasksFromVisit(tasks: ReadonlyArray<TaskValue>, kits?: ReadonlyMap<string, TaskKit>): Birth {
  const out: BornTask[] = [];
  const parts: BornPart[] = [];
  const hours: (number | null)[] = [];
  tasks.forEach((t, i) => {
    const name = t.name.trim();
    if (!name) return;
    const source_key = `task:${t.id}`;
    // A TASK KIT (0386, W4): his minutes per unit × the units and the kit's parts × the units,
    // through THE one expandTaskKit the estimate seeds from. His own hours win over the kit's.
    const kit = t.kit_id && kits ? kits.get(t.kit_id) ?? null : null;
    const fromKit = kit ? expandTaskKit(t, kit, { orgDefaultPct: 0 }) : null;
    const h = t.hours ?? fromKit?.hours ?? null;
    out.push({ source_key, title: `${name}${unitsSuffix(t.units)}`, sort_order: i, planned_minutes: laborMinutes([{ hours: h }]) });
    hours.push(h);
    for (const m of fromKit?.materials ?? []) parts.push({ source_key, code: m.code, name: m.name, qty: m.qty, cost: m.cost });
    for (const m of t.materials) {
      const words = (m.words ?? "").trim() || (m.code ?? "").trim();
      if (!words) continue;
      parts.push({ source_key, code: m.code, name: words, qty: m.qty, cost: null });
    }
  });
  return { tasks: out, plannedMinutes: minutesOf(hours), parts };
}

/**
 * THE TASKS A VISIT ANSWERED — the same read the new-estimate page does (quotes/new/page.tsx):
 * the answers cleared to a fixed point, then only the questions that still apply, then every
 * `tasks` slot. A tasks question a later answer turned off births nothing, exactly as it seeds
 * nothing on the estimate.
 */
export function tasksAnswered(pb: Playbook, answers: Record<string, unknown>): TaskValue[] {
  const live = clearInapplicable(pb, answers as Answers);
  const out: TaskValue[] = [];
  for (const n of applicableNeeds(pb, live)) {
    if (n.slot?.type !== "tasks") continue;
    const tasks = coerceTasks((live as Record<string, unknown>)[n.key]);
    if (tasks?.length) out.push(...tasks);
  }
  return out;
}

/** A visit task's parts as rows for the job's list, through the same door the typed take-off uses
 *  (addCaptureItemsToJobList): a part without a count rides as quantity null — "I need this, I
 *  haven't counted it" — and that door writes it as one that SAYS "how many?". Nothing has priced a
 *  visit's part yet, so it lands by its code and words, unit "ea", no vendor, no cost. */
export function partsAsCaptureItems(parts: ReadonlyArray<BornPart>): CaptureItem[] {
  // Keys per task, with ordinals for repeats (keyParts), the same way the take-off keys a line's parts.
  const byTask = new Map<string, BornPart[]>();
  for (const p of parts) byTask.set(p.source_key, [...(byTask.get(p.source_key) ?? []), p]);
  const keys = new Map<BornPart, string>();
  for (const [sk, ps] of byTask) keyParts(sk, ps).forEach((k, i) => keys.set(ps[i], k.key));
  return parts.map((p, i) => ({
    id: `${p.source_key}:${i}`,
    description: p.name,
    quantity: p.qty,
    unit: "ea",
    code: p.code,
    // The row remembers its task and part (0390), so the list can follow the visit's tasks later.
    source_key: keys.get(p) ?? materialKey(p.source_key, p.code, p.name),
  }));
}

export interface BornWho {
  jobId: string;
  /** The company. Sent on every write (a service client has no JWT for set_org_id to read). */
  orgId: string | null;
  /** Who the tasks say made them: the staff member at the door, or the estimate's author. */
  createdBy: string | null;
}

export interface BornResult {
  /** Tasks inserted by THIS call (an already-born key counts zero). */
  inserted: number;
  /** True when this call set the job's planned_minutes (it had none and the tasks had hours). */
  plannedSet: boolean;
  /** Tasks NOT born because he deleted that key from this job before (jobs.dismissed_task_keys). */
  leftOff: number;
  error?: string;
}

/**
 * A DISMISSAL, as the delete door writes it since cn-v1084: "<key>#<title>". The key bars that line;
 * the title bars the same task on a REBUILT line (the builder's autosave re-ids every line, so a key
 * alone forgot the task the moment the estimate was touched). Entries from before carry the key alone.
 * Here, below the sync (sync-job-tasks reads them through these), so the birth honors the same list.
 */
export const dismissalEntry = (key: string, title: string): string => `${key}#${title.trim()}`;
export const dismissalKey = (e: string): string => (e.includes("#") ? e.slice(0, e.indexOf("#")) : e);
export const dismissalTitle = (e: string): string | null => (e.includes("#") ? e.slice(e.indexOf("#") + 1).trim() || null : null);

/**
 * WRITE THE BIRTH. Reads the job's existing keys, inserts the missing tasks, counts them, then
 * fills planned_minutes only where the job has none. Returns what it did; never throws for a
 * database answer (the job is already made — the door says what could not be listed).
 */
/** The keys the job already has (its born tasks), and the keys he DELETED from it by hand
 *  (jobs.dismissed_task_keys, read as the sync reads them: the key half of each entry) — a dismissed
 *  key is never born again, the sync's own rule (planLineSync), followed here by every door that births. */
async function keysOnJob(sb: SupabaseClient, jobId: string, orgId: string | null = null): Promise<{ keys: Set<string | null>; dismissed: Set<string>; error?: string }> {
  const none = { keys: new Set<string | null>(), dismissed: new Set<string>() };
  let q = sb.from("tasks").select("source_key").eq("job_id", jobId).not("source_key", "is", null);
  if (orgId) q = q.eq("org_id", orgId); // the service client: the company's rows only (audit v1085, carried)
  const { data, error } = await q;
  if (error) return { ...none, error: dbError(error) };
  let jq = sb.from("jobs").select("dismissed_task_keys").eq("id", jobId);
  if (orgId) jq = jq.eq("org_id", orgId);
  const { data: job, error: jErr } = await jq.maybeSingle();
  if (jErr) return { ...none, error: dbError(jErr) };
  const entries = (Array.isArray((job as { dismissed_task_keys?: unknown } | null)?.dismissed_task_keys) ? (job as { dismissed_task_keys: unknown[] }).dismissed_task_keys : []).filter(
    (k): k is string => typeof k === "string",
  );
  return {
    keys: new Set(((data ?? []) as Array<{ source_key: string | null }>).map((r) => r.source_key)),
    dismissed: new Set(entries.map(dismissalKey)),
  };
}

export async function bornTasks(sb: SupabaseClient, who: BornWho, birth: Birth): Promise<BornResult> {
  let inserted = 0;
  let leftOff = 0;
  if (birth.tasks.length) {
    const have = await keysOnJob(sb, who.jobId, who.orgId);
    if (have.error) return { inserted: 0, plannedSet: false, leftOff: 0, error: have.error };
    const seen = have.keys;
    // A key he deleted from this job stays gone (the sync's rule, cn-v1134 here): not born, counted.
    leftOff = birth.tasks.filter((t) => !seen.has(t.source_key) && have.dismissed.has(t.source_key)).length;
    const rows = birth.tasks
      .filter((t) => !seen.has(t.source_key) && !have.dismissed.has(t.source_key))
      .map((t) => ({
        ...(who.orgId ? { org_id: who.orgId } : {}),
        job_id: who.jobId,
        title: t.title,
        source_key: t.source_key,
        sort_order: t.sort_order,
        // Explicit null, as createTask sends: a job's task has no category (never the DB default).
        category: null,
        // The task's own minutes (0395): his rows' hours, or null — never a figure nobody gave.
        planned_minutes: t.planned_minutes ?? null,
        created_by: who.createdBy,
      }));
    if (rows.length) {
      const { data, error } = await sb.from("tasks").insert(rows).select("id");
      if (error) {
        // TWO DOORS IN THE SAME SECOND (the customer's Accept and the office's): the loser's insert
        // hits tasks_job_source_key_uq (23505). The winner's rows ARE the birth, so re-read and, when
        // every key is now on the job, this call did its work by doing nothing. Any other refusal is said.
        const raced = (error as { code?: string }).code === "23505" && (await keysOnJob(sb, who.jobId, who.orgId));
        if (!raced || raced.error || !birth.tasks.every((t) => raced.keys.has(t.source_key) || raced.dismissed.has(t.source_key))) {
          return { inserted: 0, plannedSet: false, leftOff, error: dbError(error) };
        }
      } else {
        inserted = data?.length ?? 0;
        if (inserted !== rows.length) {
          return { inserted, plannedSet: false, leftOff, error: `${rows.length - inserted} of ${rows.length} tasks did not save.` };
        }
      }
    }
  }
  let plannedSet = false;
  if (birth.plannedMinutes !== null) {
    let q = sb.from("jobs").update({ planned_minutes: birth.plannedMinutes }).eq("id", who.jobId).is("planned_minutes", null);
    if (who.orgId) q = q.eq("org_id", who.orgId);
    const { data, error } = await q.select("id");
    if (error) return { inserted, plannedSet: false, leftOff, error: dbError(error) };
    plannedSet = (data?.length ?? 0) > 0; // zero rows = the job already had a size: his box wins
  }
  return { inserted, plannedSet, leftOff };
}

/** THE ESTIMATE DOORS' HALF: read the accepted estimate's lines, then bornTasks. */
export async function bornWithTasks(
  sb: SupabaseClient,
  who: BornWho & { quoteId: string },
): Promise<BornResult & { birth: Birth }> {
  // `quantity` rides with the breakdown (cn-v1133): "this many of the task" multiplies its minutes and parts.
  let q = sb.from("quote_line_items").select("id, description, sort_order, quantity, detail").eq("quote_id", who.quoteId);
  if (who.orgId) q = q.eq("org_id", who.orgId);
  const { data, error } = await q.order("sort_order");
  if (error) return { inserted: 0, plannedSet: false, leftOff: 0, error: dbError(error), birth: EMPTY_BIRTH };
  const birth = tasksFromLines((data ?? []) as LineRow[]);
  const res = await bornTasks(sb, who, birth);
  return { ...res, birth };
}
