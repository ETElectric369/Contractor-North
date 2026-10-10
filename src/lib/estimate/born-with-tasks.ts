import type { SupabaseClient } from "@supabase/supabase-js";
import type { CaptureItem } from "@/lib/inspection/capture";
import type { Answers, Playbook } from "@/lib/playbook/types";
import { coerceTasks, type TaskValue } from "@/lib/playbook/tasks";
import { applicableNeeds, clearInapplicable } from "@/lib/playbook/resolve";
import { coerceTaskDetail } from "./task-lines";

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
 *  - HIS HOURS, SUMMED, NEVER FILLED. planned_minutes is Σ round(hours × 60) over the tasks he gave
 *    hours to; a task still asking ("hours?") adds nothing — the sum is his figures, not a guess
 *    ([[no-speculation]]). No hours at all → null, and the job's How Long box asks as it does today.
 *    A How Long the job already has WINS (the write lands only on a null); 0229's bound
 *    (0 < n ≤ 43200) is honoured by leaving an out-of-range sum null rather than clamping it.
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

/** jobs.planned_minutes' own check (0229): null, or 0 < n ≤ 43200 (thirty working days). */
export const PLANNED_MINUTES_MAX = 43_200;

/** Σ round(h × 60) over the hours he gave. None given → null; a sum the column would refuse → null. */
export function minutesOf(hours: ReadonlyArray<number | null>): number | null {
  const given = hours.filter((h): h is number => typeof h === "number" && Number.isFinite(h) && h > 0);
  if (!given.length) return null;
  const sum = given.reduce((t, h) => t + Math.round(h * 60), 0);
  return sum > 0 && sum <= PLANNED_MINUTES_MAX ? sum : null;
}

/** The columns a door reads off quote_line_items for the birth. */
export interface LineRow {
  id: string;
  description: string | null;
  sort_order: number | null;
  detail: unknown;
}

/** " ×7" after a per-unit task's name, exactly as taskLine (task-lines.ts) writes the line. */
const unitsSuffix = (units: number | null): string => (units !== null && units !== 1 ? ` ×${units}` : "");

/**
 * WHAT AN ACCEPTED ESTIMATE'S LINES GIVE BIRTH TO. Rows arrive in sort order; a row that is not a
 * task (no detail) is skipped and keeps its sort_order gap, so the tasks sit in estimate order.
 */
export function tasksFromLines(rows: ReadonlyArray<LineRow>): Birth {
  const tasks: BornTask[] = [];
  const parts: BornPart[] = [];
  const hours: Array<number | null> = [];
  rows.forEach((r, i) => {
    const d = coerceTaskDetail(r.detail);
    if (!d) return;
    const title = String(r.description ?? "").trim();
    if (!title) return;
    const source_key = `line:${r.id}`;
    tasks.push({ source_key, title, sort_order: typeof r.sort_order === "number" ? r.sort_order : i });
    hours.push(d.hours);
    for (const m of d.materials) {
      if (!m.name.trim()) continue;
      parts.push({ source_key, code: m.code, name: m.name.trim(), qty: m.qty, cost: m.cost });
    }
  });
  return { tasks, plannedMinutes: minutesOf(hours), parts };
}

/**
 * WHAT A VISIT'S TASKS GIVE BIRTH TO (no estimate in between: Start The Job on the inspection).
 * The Inspector's TaskValue: his name, his hours, his parts by words and/or code. A part's cost is
 * unknown here (nothing priced it), so the list asks for it.
 */
export function tasksFromVisit(tasks: ReadonlyArray<TaskValue>): Birth {
  const out: BornTask[] = [];
  const parts: BornPart[] = [];
  tasks.forEach((t, i) => {
    const name = t.name.trim();
    if (!name) return;
    const source_key = `task:${t.id}`;
    out.push({ source_key, title: `${name}${unitsSuffix(t.units)}`, sort_order: i });
    for (const m of t.materials) {
      const words = (m.words ?? "").trim() || (m.code ?? "").trim();
      if (!words) continue;
      parts.push({ source_key, code: m.code, name: words, qty: m.qty, cost: null });
    }
  });
  return { tasks: out, plannedMinutes: minutesOf(tasks.map((t) => (t.name.trim() ? t.hours : null))), parts };
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
 *  (addCaptureItemsToJobList): a part without a count rides as "I need this, I haven't counted it". */
export function partsAsCaptureItems(parts: ReadonlyArray<BornPart>): CaptureItem[] {
  return parts.map((p, i) => ({ id: `${p.source_key}:${i}`, description: p.name, quantity: p.qty, unit: "ea", code: p.code }));
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
  error?: string;
}

/**
 * WRITE THE BIRTH. Reads the job's existing keys, inserts the missing tasks, counts them, then
 * fills planned_minutes only where the job has none. Returns what it did; never throws for a
 * database answer (the job is already made — the door says what could not be listed).
 */
export async function bornTasks(sb: SupabaseClient, who: BornWho, birth: Birth): Promise<BornResult> {
  let inserted = 0;
  if (birth.tasks.length) {
    const { data: have, error: haveErr } = await sb
      .from("tasks")
      .select("source_key")
      .eq("job_id", who.jobId)
      .not("source_key", "is", null);
    if (haveErr) return { inserted: 0, plannedSet: false, error: haveErr.message };
    const seen = new Set(((have ?? []) as Array<{ source_key: string | null }>).map((r) => r.source_key));
    const rows = birth.tasks
      .filter((t) => !seen.has(t.source_key))
      .map((t) => ({
        ...(who.orgId ? { org_id: who.orgId } : {}),
        job_id: who.jobId,
        title: t.title,
        source_key: t.source_key,
        sort_order: t.sort_order,
        // Explicit null, as createTask sends: a job's task has no category (never the DB default).
        category: null,
        created_by: who.createdBy,
      }));
    if (rows.length) {
      const { data, error } = await sb.from("tasks").insert(rows).select("id");
      if (error) return { inserted: 0, plannedSet: false, error: error.message };
      inserted = data?.length ?? 0;
      if (inserted !== rows.length) {
        return { inserted, plannedSet: false, error: `${rows.length - inserted} of ${rows.length} tasks did not save.` };
      }
    }
  }
  let plannedSet = false;
  if (birth.plannedMinutes !== null) {
    let q = sb.from("jobs").update({ planned_minutes: birth.plannedMinutes }).eq("id", who.jobId).is("planned_minutes", null);
    if (who.orgId) q = q.eq("org_id", who.orgId);
    const { data, error } = await q.select("id");
    if (error) return { inserted, plannedSet: false, error: error.message };
    plannedSet = (data?.length ?? 0) > 0; // zero rows = the job already had a size: his box wins
  }
  return { inserted, plannedSet };
}

/** THE ESTIMATE DOORS' HALF: read the accepted estimate's lines, then bornTasks. */
export async function bornWithTasks(
  sb: SupabaseClient,
  who: BornWho & { quoteId: string },
): Promise<BornResult & { birth: Birth }> {
  let q = sb.from("quote_line_items").select("id, description, sort_order, detail").eq("quote_id", who.quoteId);
  if (who.orgId) q = q.eq("org_id", who.orgId);
  const { data, error } = await q.order("sort_order");
  if (error) return { inserted: 0, plannedSet: false, error: error.message, birth: EMPTY_BIRTH };
  const birth = tasksFromLines((data ?? []) as LineRow[]);
  const res = await bornTasks(sb, who, birth);
  return { ...res, birth };
}
