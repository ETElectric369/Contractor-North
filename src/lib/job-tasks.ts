import { todayStrInTz } from "@/lib/tz";
import { buyMaterialsCounts, type BuyMaterials } from "@/lib/materials-checklist";

/**
 * A JOB'S TASKS: ONE LIST, THE JOB'S (0358).
 *
 * Erik, 2026-09-26: "tasks embed with the job so if multiple people are on the job a crew leader can
 * assign them verbally". A task with a job belongs to the JOB: no assignee, no due date, no priority
 * on the list. Whoever is on the job checks things off, and the check-off records who and when (the
 * server stamps them, 0358's stamp_task_who). A task with no job is a Reminder, private to the person
 * who made it and the person it is for.
 *
 * This file is the list's shared shape and words, used by the job's Overview card and Tasks tab, and
 * by My Day's Now card. The reader is safe on a database without 0358: it asks for the new columns
 * and, when the database doesn't have them yet, reads the old ones (stamps: false) so the list still
 * works and only photos and who-checked-it-off wait for the migration.
 */

export interface JobTaskRow {
  id: string;
  title: string;
  status: string;
  created_by: string | null;
  created_at: string;
  /** The done-at. Server-stamped since 0358 (cleared on reopen); older rows keep what they had. */
  completed_at: string | null;
  /** Who checked it off (0358). Null on old done rows, open rows, and before 0358. */
  done_by: string | null;
  /** done_by's name, from the profile. */
  done_by_name: string | null;
  /** The photo the task was made from (a documents-bucket path), if any. */
  photo_path: string | null;
  /** An optional photo of the finished work. */
  done_photo_path: string | null;
  sort_order: number;
  /** The task's note (the Task sheet shows it). Crew materials requests made before 2026-09-27 kept
   *  who asked and the whole text here; a request is a line on the materials list now. */
  notes: string | null;
}

/** After 0358: the stamps, the photos and the doer's name ride along. */
export const JOB_TASK_COLUMNS =
  "id, title, status, notes, created_by, created_at, completed_at, sort_order, photo_path, done_photo_path, done_by, doer:done_by(full_name)";
/** Before 0358: the columns every database has (notes is older than 0358). */
export const JOB_TASK_COLUMNS_BEFORE_0358 = "id, title, status, notes, created_by, created_at, completed_at";

export type JobTasksRead = {
  rows: JobTaskRow[];
  /** true when the database has 0358's columns (photos on tasks, who checked it off). */
  stamps: boolean;
  /** true when the list couldn't be read at all: the card says so instead of "no tasks". */
  failed: boolean;
};

/** The database doesn't have a column (or the embed it names) yet: Postgres' undefined_column, or
 *  PostgREST's "not in the schema cache". Anything else is a real failure, never a fallback. */
export function isMissingColumn(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = String(e?.code ?? "");
  if (code === "42703" || code === "PGRST204" || code === "PGRST200") return true;
  return /column .* does not exist|could not find .* in the schema cache/i.test(String(e?.message ?? ""));
}

/** Shape one row, whichever columns it came with. */
export function toJobTaskRow(r: Record<string, any>): JobTaskRow {
  const doer = Array.isArray(r.doer) ? r.doer[0] : r.doer;
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    status: String(r.status ?? "open"),
    created_by: (r.created_by ?? null) as string | null,
    created_at: String(r.created_at ?? ""),
    completed_at: (r.completed_at ?? null) as string | null,
    done_by: (r.done_by ?? null) as string | null,
    done_by_name: (doer?.full_name ?? null) as string | null,
    photo_path: (r.photo_path ?? null) as string | null,
    done_photo_path: (r.done_photo_path ?? null) as string | null,
    sort_order: Number(r.sort_order ?? 0) || 0,
    notes: (r.notes ?? null) as string | null,
  };
}

/**
 * The job's whole list, in one read (a job's list is short; 500 is a ceiling, not a page). A
 * database without 0358 answers the new columns with "does not exist": read the old ones and say
 * stamps:false. Any other error: failed, so the card says it couldn't read the list.
 */
export async function readJobTasks(supabase: { from: (t: string) => any }, jobId: string): Promise<JobTasksRead> {
  const read = (cols: string): PromiseLike<{ data: Record<string, any>[] | null; error: unknown }> =>
    supabase.from("tasks").select(cols).eq("job_id", jobId).order("created_at", { ascending: true }).limit(500);
  try {
    const first = await read(JOB_TASK_COLUMNS);
    if (!first.error) return { rows: (first.data ?? []).map(toJobTaskRow), stamps: true, failed: false };
    if (!isMissingColumn(first.error)) return { rows: [], stamps: false, failed: true };
    const old = await read(JOB_TASK_COLUMNS_BEFORE_0358);
    if (old.error) return { rows: [], stamps: false, failed: true };
    return { rows: (old.data ?? []).map(toJobTaskRow), stamps: false, failed: false };
  } catch {
    return { rows: [], stamps: false, failed: true };
  }
}

/** Open tasks in the list's order (sort_order, then the order they were added); done tasks newest
 *  first, the ones with no done time last. Never mutates the input. */
export function splitJobTasks(rows: JobTaskRow[]): { open: JobTaskRow[]; done: JobTaskRow[] } {
  const open = rows
    .filter((t) => t.status !== "done")
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
  const done = rows
    .filter((t) => t.status === "done")
    .sort((a, b) => {
      if (!a.completed_at && !b.completed_at) return b.created_at.localeCompare(a.created_at);
      if (!a.completed_at) return 1;
      if (!b.completed_at) return -1;
      return b.completed_at.localeCompare(a.completed_at);
    });
  return { open, done };
}

/** "Tasks: 7 of 12 done" — the card's one-line answer. */
export function tasksHeader(total: number, done: number): string {
  return `Tasks: ${done} of ${total} done`;
}

/**
 * THE JOB'S TASK COUNT, WITH THE LIVE BUY MATERIALS ROW IN IT (lib/materials-checklist). One rule
 * for every reader (the Overview card's "Tasks: X of Y done", the Tasks chip's badge, My Day's
 * "Tasks: N left"): the row is ONE task, open while anything on the materials list is left to buy
 * and done once it's all bought; no row, no task. `open` is the Tasks badge (0 = no badge).
 */
export function jobTaskTally(rows: readonly { status: string }[], buy: BuyMaterials): { total: number; done: number; open: number } {
  const m = buyMaterialsCounts(buy);
  const done = rows.filter((t) => t.status === "done").length;
  return { total: rows.length + m.total, done: done + m.done, open: rows.length - done + m.open };
}

const fmt = (tz: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o });

/** 9/17 (and 9/17/25 in another year), in the company's time zone. */
function monthDay(d: Date, tz: string, now: Date): string {
  const md = fmt(tz, { month: "numeric", day: "numeric" }).format(d);
  const y = fmt(tz, { year: "numeric" }).format(d);
  return y === fmt(tz, { year: "numeric" }).format(now) ? md : `${md}/${y.slice(-2)}`;
}

/**
 * WHEN IT WAS DONE, in the company's time zone (never the phone's or the server's): "Today 2:14 PM"
 * the same day, "Tue 2:14 PM" within the last six days, "9/17" before that. A time a clock put a
 * little in the future reads as today.
 */
export function doneWhenWords(iso: string, tz: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round(
    (Date.parse(`${todayStrInTz(tz, now)}T00:00:00Z`) - Date.parse(`${todayStrInTz(tz, d)}T00:00:00Z`)) / 86_400_000,
  );
  // A plain space before AM/PM: newer ICU puts a narrow no-break space there, and the server's ICU
  // and the phone's may not agree, which would make the server's words and the phone's differ.
  const time = fmt(tz, { hour: "numeric", minute: "2-digit" }).format(d).replace(/[  ]/g, " ");
  if (days <= 0) return `Today ${time}`;
  if (days <= 6) return `${fmt(tz, { weekday: "short" }).format(d)} ${time}`;
  return monthDay(d, tz, now);
}

/**
 * THE DONE LINE under a checked-off task: "Brian · Tue 2:14 PM". A task checked off before 0358
 * recorded no one, so it reads "Done 6/17" and never a guessed name.
 */
export function doneWords(
  t: { completed_at: string | null; done_by_name: string | null },
  tz: string,
  now: Date = new Date(),
): string {
  const first = t.done_by_name?.trim().split(/\s+/)[0] ?? "";
  if (first && t.completed_at) return `${first} · ${doneWhenWords(t.completed_at, tz, now)}`;
  if (t.completed_at) {
    const d = new Date(t.completed_at);
    return Number.isNaN(d.getTime()) ? "Done" : `Done ${monthDay(d, tz, now)}`;
  }
  return "Done";
}

const steps = (n: number) => (n === 1 ? "step" : `${n} steps`);

/** The check-off toast on the job's card and My Day's Now card: "Checked off: Rough-in", and when
 *  the check-off closed the task's open steps with it (the cascade), "…and its 2 open steps", so
 *  the Undo beside it plainly takes those back too. */
export function checkedOffWords(title: string, closedSteps: number): string {
  if (closedSteps <= 0) return `Checked off: ${title}`;
  return `Checked off: ${title} and its ${closedSteps === 1 ? "open step" : `${closedSteps} open steps`}`;
}

/** What a reopen answered, as far as an Undo reads it (tasks/actions ToggleTaskResult). */
export type UndoAnswer = { ok: boolean; error?: string; reopenedSteps?: number; stepsStillDone?: number };
export type UndoSay = { text: string; tone: "info" | "error" } | null;

/**
 * What an Undo says once it ran, for a check-off that closed `asked` steps. A plain check-off's Undo
 * is quiet: the task back on the list is the answer. With steps, it says they came back, or which
 * didn't (never "undone" over a step still checked off).
 */
export function undoneWords(title: string, asked: number, res: UndoAnswer): UndoSay {
  if (!res.ok) return { text: res.error ?? "Couldn't reopen the task. Try again.", tone: "error" };
  if (asked <= 0) return null;
  const back = res.reopenedSteps ?? 0;
  const stuck = res.stepsStillDone ?? 0;
  if (stuck > 0) {
    const which = asked === 1 ? "Its step is" : `${stuck} of its ${asked} steps ${stuck === 1 ? "is" : "are"}`;
    return { text: `Reopened: ${title}. ${which} still checked off: reopen ${stuck === 1 ? "it" : "them"} on the job's Tasks tab.`, tone: "error" };
  }
  return { text: back > 0 ? `Reopened: ${title} and its ${steps(back)}.` : `Reopened: ${title}.`, tone: "info" };
}

/**
 * UNDO OF A CHECK-OFF (the 10-second toast on the job's card and the Now card). Reopens the task and,
 * when its check-off cascaded, exactly the steps that check-off closed (its closedSteps), never a
 * step that was already done before it. `reopen` is tasks/actions toggleTask.
 */
export async function undoCheckOff(
  reopen: (id: string, done: false, opts: { jobId: string; reopenSteps?: string[] }) => Promise<UndoAnswer>,
  task: { id: string; title: string },
  closedSteps: readonly string[],
  jobId: string,
): Promise<{ ok: boolean; say: UndoSay }> {
  let res: UndoAnswer;
  try {
    res = await reopen(task.id, false, closedSteps.length ? { jobId, reopenSteps: [...closedSteps] } : { jobId });
  } catch {
    res = { ok: false };
  }
  return { ok: res.ok, say: undoneWords(task.title, closedSteps.length, res) };
}

/** 0358's delete rule, said before the tap: the office, or whoever added the task. A tech checks an
 *  office task off; its trash never renders for him (a door the server would refuse). */
export function canDeleteTask(t: { created_by: string | null }, viewerId: string | null, viewerIsStaff: boolean): boolean {
  return viewerIsStaff || (!!viewerId && t.created_by === viewerId);
}

export type TaskPhoto = { url: string } | "removed" | "unavailable" | null;

/**
 * What a task's photo row shows. A path with a signed URL is the photo. A path that is still one of
 * the job's documents but couldn't be signed just now is "unavailable" (say so, don't claim it's
 * gone). A path the job no longer has — the photo was deleted from the Photos tab — is "removed".
 */
export function taskPhoto(path: string | null, signed: ReadonlyMap<string, string>, jobFiles: ReadonlySet<string>): TaskPhoto {
  if (!path) return null;
  const url = signed.get(path);
  if (url) return { url };
  return jobFiles.has(path) ? "unavailable" : "removed";
}
