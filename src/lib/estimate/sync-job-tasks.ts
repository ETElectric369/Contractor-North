import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import { bornTasks, tasksFromLines, type BornTask, type LineRow } from "./born-with-tasks";

/**
 * A JOB FOLLOWS ITS ESTIMATE (the first of the four deferred items, 2026-10-10).
 *
 * W3 gave a job its tasks the moment the estimate was accepted (born-with-tasks). But an accepted
 * estimate with a job stays editable — "a scope change after acceptance is a legitimate business
 * event" (quotes/actions requireEditableQuote) — and nothing told the job. A deleted task line left
 * its task on the job's list; a renamed line left the task under the old name; the job's planned
 * length kept the deleted task's hours. An estimate already linked to a job and accepted again (after
 * a walk-back to edit it, a second estimate born from the job page, one pinned with Attach) gave the
 * job nothing at all, and the builder's autosave rewrites every line with a NEW id (save_quote_draft
 * deletes and re-inserts), which orphaned every task a rebuilt estimate had born.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────────────────
 *  The job's line tasks ARE the task lines of its ACCEPTED estimates. What he added to a task is his.
 *  The size follows the estimate only while it is still the estimate's figure.
 *
 *  - A task whose line is still on an accepted estimate stays as it is (never retitled here; the
 *    rename door below renames only a task that still reads exactly as the line put it).
 *  - An ORPHAN (its line is on no accepted estimate of the job) is first matched BY EXACT TITLE to a
 *    wanted task nobody has yet — the builder's new ids — and re-keyed; open orphans claim a name
 *    before done ones, and a match is SAID ("matched by name") because a done task matched to a new
 *    line of the same name hides new work. Otherwise it is removed when it is open and bare, and KEPT
 *    when it is done, carries his notes or a photo, or has steps under it (0055 cascades a parent's
 *    delete to its steps). Kept is said by name, never silent.
 *  - A task HE deleted by hand stays gone: the delete door writes its key to jobs.dismissed_task_keys
 *    (0358 made the column for exactly this; nothing read it until now) and the sync never re-inserts
 *    a dismissed key.
 *  - The rest of the wanted tasks are inserted through the birth's own insert (bornTasks), so the
 *    row shape, the dedupe by key and the silent-write counts are one piece of code.
 *  - THE SIZE: jobs.planned_minutes has no "came from the estimate" mark (0229), so the door reads
 *    the estimate's figure BEFORE its change and hands it in. The box follows to the new figure only
 *    when it still equals the old one (both null counts: a job never sized takes the estimate's
 *    figure, as at birth), and the write is compare-and-set on the value just read, so a figure he
 *    types between the read and the write wins. When the box differs the size STAYS, and that is
 *    said with both figures — a walk-back and re-accept lands here (the old figure left the accepted
 *    set), as does any figure he typed.
 *
 *  Declining an accepted estimate does NOT run this (deliberate: a walk-back to edit would churn the
 *  list and lose photos on open tasks); accepting again does. The materials list follows the same
 *  doors through sync-job-materials (0390 gave its rows their line). Every write selects what it
 *  wrote and counts it (the silent-write law); every read is org-scoped when the caller says who.
 */

export const LINE_KEY = "line:";

/** A task on the job that an estimate line put there, as the sync reads it. */
export interface LineTask {
  id: string;
  source_key: string;
  title: string;
  status: string;
  notes: string | null;
  photo_path: string | null;
  /** True when steps sit under it (tasks.parent_id, 0055) — deleting it would delete them. */
  has_steps?: boolean;
}

/** Something a person added to the task: it is his now, and leaves only by his hand. */
export const isHisTask = (t: Pick<LineTask, "notes" | "photo_path" | "has_steps">): boolean =>
  !!(t.notes && t.notes.trim()) || !!t.photo_path || !!t.has_steps;

export interface LineSyncPlan {
  /** Wanted tasks nobody has (by key or by exact title): inserted. */
  insert: BornTask[];
  /** Orphans re-keyed to the line that now carries their exact title. */
  rekey: Array<{ id: string; source_key: string }>;
  /** Open, bare orphans: removed. */
  remove: string[];
  /** Orphans that stay — done, or his (notes / a photo / steps). Said. */
  kept: LineTask[];
}

/**
 * THE PLAN, pure: what the job's line tasks must become given what its accepted estimates say.
 * `dismissed` = keys he deleted by hand (jobs.dismissed_task_keys): never inserted, never re-keyed into.
 */
export function planLineSync(
  wanted: ReadonlyArray<BornTask>,
  have: ReadonlyArray<LineTask>,
  dismissed: ReadonlySet<string> = new Set(),
): LineSyncPlan {
  const wantedKeys = new Set(wanted.map((t) => t.source_key));
  const haveKeys = new Set(have.map((t) => t.source_key));
  // Wanted tasks nobody has yet and he did not dismiss, in estimate order — the pool an orphan may re-key into.
  const unmatched = wanted.filter((t) => !haveKeys.has(t.source_key) && !dismissed.has(t.source_key));
  const rekey: LineSyncPlan["rekey"] = [];
  const remove: string[] = [];
  const kept: LineTask[] = [];
  const orphans = have.filter((t) => !wantedKeys.has(t.source_key)); // its line is on no accepted estimate
  // Open orphans claim a name first: a done task matched to a new line of the same name would hide new work.
  const claimed = new Set<string>();
  for (const pass of [orphans.filter((t) => t.status === "open"), orphans.filter((t) => t.status !== "open")]) {
    for (const t of pass) {
      const i = unmatched.findIndex((w) => w.title === t.title);
      if (i === -1) continue;
      rekey.push({ id: t.id, source_key: unmatched[i].source_key });
      unmatched.splice(i, 1);
      claimed.add(t.id);
    }
  }
  for (const t of orphans) {
    if (claimed.has(t.id)) continue;
    if (t.status === "open" && !isHisTask(t)) remove.push(t.id);
    else kept.push(t);
  }
  return { insert: unmatched, rekey, remove, kept };
}

export interface EstimateLines {
  /** The task-bearing lines of the job's accepted estimates, oldest estimate first, each in its own order. */
  lines: LineRow[];
  /** Σ his hours over those lines, in minutes (born-with-tasks minutesOf); null when none. */
  minutes: number | null;
  error?: string;
}

/**
 * THE JOB'S ACCEPTED ESTIMATES' LINES. A later-ACCEPTED estimate's lines sit AFTER the earlier one's
 * on the job's list: its sort_orders are offset past the earlier estimate's highest, so two estimates
 * that both count from 0 do not interleave. The first estimate's lines keep their own numbers (what
 * the birth used), so nothing already on the list moves. `except` leaves one estimate out — "the
 * figure before THIS acceptance" for a door that runs after the status has already flipped.
 */
export async function estimateLines(
  sb: SupabaseClient,
  who: { jobId: string; orgId: string | null; except?: string | null },
): Promise<EstimateLines> {
  let qq = sb.from("quotes").select("id, created_at, accepted_at").eq("job_id", who.jobId).eq("status", "accepted");
  if (who.orgId) qq = qq.eq("org_id", who.orgId);
  const { data: quotes, error: qErr } = await qq.order("accepted_at");
  if (qErr) return { lines: [], minutes: null, error: dbError(qErr) };
  const when = (q: { created_at: string | null; accepted_at?: string | null }) => String(q.accepted_at ?? q.created_at ?? "");
  const ordered = ((quotes ?? []) as Array<{ id: string; created_at: string | null; accepted_at?: string | null }>)
    .filter((q) => !who.except || q.id !== who.except)
    .sort((a, b) => when(a).localeCompare(when(b)) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  if (!ordered.length) return { lines: [], minutes: null };
  const rank = new Map(ordered.map((q, i) => [q.id, i]));
  let lq = sb.from("quote_line_items").select("id, description, sort_order, detail, quote_id").in("quote_id", ordered.map((q) => q.id));
  if (who.orgId) lq = lq.eq("org_id", who.orgId);
  const { data, error } = await lq.order("sort_order");
  if (error) return { lines: [], minutes: null, error: dbError(error) };
  const rows = ((data ?? []) as Array<LineRow & { quote_id: string }>)
    .slice()
    .sort((a, b) => (rank.get(a.quote_id) ?? 0) - (rank.get(b.quote_id) ?? 0) || (a.sort_order ?? 0) - (b.sort_order ?? 0));
  // Offset each later estimate past the one before it.
  const lines: LineRow[] = [];
  let offset = 0;
  let current: string | null = null;
  let highest = -1;
  for (const r of rows) {
    if (r.quote_id !== current) {
      if (current !== null) offset += highest + 1;
      current = r.quote_id;
      highest = -1;
    }
    const own = typeof r.sort_order === "number" ? r.sort_order : 0;
    highest = Math.max(highest, own);
    lines.push({ id: r.id, description: r.description, sort_order: own + offset, detail: r.detail });
  }
  return { lines, minutes: tasksFromLines(lines).plannedMinutes };
}

export interface SyncWho {
  jobId: string;
  orgId: string | null;
  createdBy: string | null;
  /** The estimate's figure (estimateLines().minutes) as read BEFORE the change. undefined = leave the size alone. */
  sizeBefore?: number | null;
}

export interface SyncResult {
  inserted: number;
  rekeyed: number;
  removed: number;
  kept: number;
  /** The kept orphans' names, for the sentence. */
  keptNames: string[];
  /** True when this call moved jobs.planned_minutes to the estimate's new figure (sizeNow). */
  sizeSet: boolean;
  sizeNow?: number | null;
  /** The estimate's figure moved but the box did not follow (his figure, or an old estimate figure): both, said. */
  sizeStays?: { box: number | null; estimate: number | null };
  error?: string;
}

const NONE: SyncResult = { inserted: 0, rekeyed: 0, removed: 0, kept: 0, keptNames: [], sizeSet: false };

/** THE SYNC: read what the accepted estimates say and what the job has, plan, write, count. */
export async function syncJobTasks(sb: SupabaseClient, who: SyncWho): Promise<SyncResult> {
  const est = await estimateLines(sb, who);
  if (est.error) return { ...NONE, error: est.error };
  const wanted = tasksFromLines(est.lines).tasks;

  let tq = sb.from("tasks").select("id, source_key, title, status, notes, photo_path").eq("job_id", who.jobId).not("source_key", "is", null);
  if (who.orgId) tq = tq.eq("org_id", who.orgId);
  const { data: rows, error: tErr } = await tq.order("sort_order").order("created_at");
  if (tErr) return { ...NONE, error: dbError(tErr) };
  // Only the tasks a LINE put there: a visit's ("task:") and hand-made tasks (no key) are not the estimate's to touch.
  const have = ((rows ?? []) as LineTask[]).filter((t) => typeof t.source_key === "string" && t.source_key.startsWith(LINE_KEY));

  // The job itself: the keys he dismissed by hand, and the length box as it stands right now.
  let jq = sb.from("jobs").select("planned_minutes, dismissed_task_keys").eq("id", who.jobId);
  if (who.orgId) jq = jq.eq("org_id", who.orgId);
  const { data: job, error: jErr } = await jq.maybeSingle();
  if (jErr) return { ...NONE, error: dbError(jErr) };
  if (!job) return { ...NONE, error: "That job could not be read." };
  const dismissed = new Set<string>(
    (Array.isArray((job as { dismissed_task_keys?: unknown }).dismissed_task_keys) ? (job as { dismissed_task_keys: unknown[] }).dismissed_task_keys : []).filter(
      (k): k is string => typeof k === "string",
    ),
  );
  const boxNow = ((job as { planned_minutes?: number | null }).planned_minutes ?? null) as number | null;

  // Steps under a line task (0055: a parent's delete cascades to them) make it his.
  if (have.length) {
    let cq = sb.from("tasks").select("parent_id").in("parent_id", have.map((t) => t.id));
    if (who.orgId) cq = cq.eq("org_id", who.orgId);
    const { data: kids, error: cErr } = await cq;
    if (cErr) return { ...NONE, error: dbError(cErr) };
    const parents = new Set(((kids ?? []) as Array<{ parent_id: string | null }>).map((k) => k.parent_id));
    for (const t of have) if (parents.has(t.id)) t.has_steps = true;
  }

  const plan = planLineSync(wanted, have, dismissed);

  let rekeyed = 0;
  for (const r of plan.rekey) {
    const { data, error } = await sb.from("tasks").update({ source_key: r.source_key }).eq("id", r.id).eq("job_id", who.jobId).select("id");
    // 23505: another door (the customer's Accept) put a task on that line between this read and this
    // write. Theirs is the task; this orphan is cleaned up by the next pass. Any other refusal is said.
    if (error && (error as { code?: string }).code === "23505") continue;
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    if (!data?.length) return { ...NONE, rekeyed, error: "A task could not be matched to its line." };
    rekeyed++;
  }

  let removed = 0;
  let kept = plan.kept.length;
  const keptNames = plan.kept.map((t) => t.title);
  if (plan.remove.length) {
    // Conditional on what was read: a task checked off or photographed in the meantime is not removed — it is kept.
    const { data, error } = await sb
      .from("tasks")
      .delete()
      .in("id", plan.remove)
      .eq("job_id", who.jobId)
      .eq("status", "open")
      .is("photo_path", null)
      .select("id");
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    removed = data?.length ?? 0;
    kept += plan.remove.length - removed;
  }

  // The birth's own insert: same row shape, dedupe by key, silent-write counts. Size left to the rule below.
  const born = await bornTasks(sb, { jobId: who.jobId, orgId: who.orgId, createdBy: who.createdBy }, { tasks: plan.insert, plannedMinutes: null, parts: [] });
  if (born.error) return { ...NONE, rekeyed, removed, kept, keptNames, error: born.error };

  const done: SyncResult = { inserted: born.inserted, rekeyed, removed, kept, keptNames, sizeSet: false };
  if (who.sizeBefore !== undefined && est.minutes !== who.sizeBefore) {
    // The box still holds the estimate's figure (or nothing yet): it follows — compare-and-set on the value
    // just read, so a figure he types between the read and the write wins. Anything else is his: it stays, said.
    if (boxNow === who.sizeBefore) {
      let uq = sb.from("jobs").update({ planned_minutes: est.minutes }).eq("id", who.jobId);
      uq = boxNow === null ? uq.is("planned_minutes", null) : uq.eq("planned_minutes", boxNow);
      if (who.orgId) uq = uq.eq("org_id", who.orgId);
      const { data: upd, error: uErr } = await uq.select("id");
      if (uErr) return { ...done, error: dbError(uErr) };
      if (upd?.length) return { ...done, sizeSet: true, sizeNow: est.minutes };
    }
    return { ...done, sizeStays: { box: boxNow, estimate: est.minutes } };
  }
  return done;
}

/**
 * RENAME THE TASK A LINE PUT THERE — only while it still reads exactly as the line did. A task he
 * renamed by hand on the job is his and stands (zero rows is that answer, not a failure).
 */
export async function retitleLineTask(
  sb: SupabaseClient,
  who: { jobId: string; orgId: string | null; lineId: string; from: string; to: string },
): Promise<{ renamed: boolean; error?: string }> {
  const to = who.to.trim();
  const from = who.from.trim();
  if (!to || to === from) return { renamed: false };
  let q = sb.from("tasks").update({ title: to }).eq("job_id", who.jobId).eq("source_key", `${LINE_KEY}${who.lineId}`).eq("title", from);
  if (who.orgId) q = q.eq("org_id", who.orgId);
  const { data, error } = await q.select("id");
  if (error) return { renamed: false, error: dbError(error) };
  return { renamed: (data?.length ?? 0) > 0 };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Minutes as the schedule says them: "none", "2 h", "1.5 h". */
export const hoursWords = (minutes: number | null): string => (minutes === null ? "none" : `${Math.round((minutes / 60) * 10) / 10} h`);

/** What the job's list did, in a sentence — or null when nothing changed. */
export function syncWords(r: SyncResult): string | null {
  const bits: string[] = [];
  if (r.inserted) bits.push(`${plural(r.inserted, "task", "tasks")} added`);
  if (r.rekeyed) bits.push(`${r.rekeyed} matched by name`);
  if (r.removed) bits.push(`${r.removed} removed`);
  if (r.kept) {
    const names = r.keptNames.slice(0, 3).join(", ");
    bits.push(`${r.kept} kept${names ? ` (${names}${r.keptNames.length > 3 ? ", …" : ""})` : ""} — done, or with notes, a photo or steps`);
  }
  if (r.sizeSet) bits.push(`the job's length is now ${hoursWords(r.sizeNow ?? null)}`);
  if (r.sizeStays) bits.push(`the job's length stays at ${hoursWords(r.sizeStays.box)} (the estimate now says ${hoursWords(r.sizeStays.estimate)})`);
  return bits.length ? `The job's list follows the estimate: ${bits.join(" · ")}.` : null;
}
