import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import { bornTasks, partsFromLines, tasksFromLines, type BornTask, type LineRow } from "./born-with-tasks";

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
 *  - cn-v1084, the deferred items: a KEPT orphan keeps its line under a TOMBSTONE key ("gone:line:<id>")
 *    — it is his now, "kept" is said once, and if the line ever comes back (an estimate moved away and
 *    back) the task is the line's again instead of a second copy. A dismissal remembers the task's
 *    TITLE ("line:<id>#<title>", the delete door since cn-v1084), so a task he deleted stays gone
 *    through a rebuild that gives its line a new id: the same title on a line nobody has is LEFT OFF
 *    (said), and the dismissal MOVES to the new key — one entry per deletion, never a pile. A VISIT's
 *    task ("task:<TaskValue id>", born by Start The Job) finds the line of the estimate drafted from
 *    that visit — by the task id the line's breakdown remembers (detail.task_id), else by exact title
 *    — and becomes the line's instead of doubling; so does an OPEN task he made by hand under the
 *    same exact title. Live tasks claim BEFORE a title dismissal bars, so a dismissal never costs a
 *    task that is there.
 *
 *  - cn-v1131 (0395): A TASK'S OWN MINUTES follow its line under THE SIZE'S OWN RULE. tasks.planned_minutes
 *    is the line's labor rows' hours summed; it moves to the line's figure now while the figure on the
 *    task is still the line's — empty (born before 0395, or the line had no hours) or equal to what
 *    the line said BEFORE the change (`tasksBefore`, read by the door before the status flipped, the
 *    twin of `sizeBefore`) — compare-and-set on the value just read. Anything else is his (a figure
 *    typed on the job) and STAYS, said by name. Without `tasksBefore` only an empty figure follows.
 *
 *  Declining an accepted estimate does NOT run this (deliberate: a walk-back to edit would churn the
 *  list and lose photos on open tasks); accepting again does. The materials list follows the same
 *  doors through sync-job-materials (0390 gave its rows their line). Every write selects what it
 *  wrote and counts it (the silent-write law); every read is org-scoped when the caller says who.
 */

export const LINE_KEY = "line:";
/** A task Start The Job put on the job from the visit's Inspector (born-with-tasks tasksFromVisit). */
export const VISIT_KEY = "task:";
/** A kept orphan's key: "gone:" + the line key it had. His now; the line's again if that line returns. */
export const GONE_KEY = "gone:";

/** A task on the job that an estimate line put there, as the sync reads it. */
export interface LineTask {
  id: string;
  /** The LINE key ("line:<id>") — for a tombstoned task, the key under the "gone:" prefix. */
  source_key: string;
  title: string;
  status: string;
  notes: string | null;
  photo_path: string | null;
  /** True when steps sit under it (tasks.parent_id, 0055) — deleting it would delete them. */
  has_steps?: boolean;
  /** True when the stored key is "gone:<source_key>": an orphan kept earlier, said then. */
  gone?: boolean;
  /** The task's own minutes (0395), as stored; null or absent = none. */
  planned_minutes?: number | null;
}

/** Any other task on the job: a visit's ("task:<id>") or one made by hand (no key). Never removed here. */
export interface OtherTask {
  id: string;
  source_key: string | null;
  title: string;
  status: string;
  planned_minutes?: number | null;
}

/** Something a person added to the task: it is his now, and leaves only by his hand. */
export const isHisTask = (t: Pick<LineTask, "notes" | "photo_path" | "has_steps">): boolean =>
  !!(t.notes && t.notes.trim()) || !!t.photo_path || !!t.has_steps;

/**
 * A DISMISSAL, as the delete door writes it since cn-v1084: "<key>#<title>". The key bars that line;
 * the title bars the same task on a REBUILT line (the builder's autosave re-ids every line, so a key
 * alone forgot the task the moment the estimate was touched). Entries from before carry the key alone.
 */
export const dismissalEntry = (key: string, title: string): string => `${key}#${title.trim()}`;
const dismissalKey = (e: string): string => (e.includes("#") ? e.slice(0, e.indexOf("#")) : e);
const dismissalTitle = (e: string): string | null => (e.includes("#") ? e.slice(e.indexOf("#") + 1).trim() || null : null);

/**
 * THE SHIELD (audit v1085, carried [17]): the task lines of the job's LINKED estimates that are not
 * accepted right now — walked back to Draft to edit, or still Sent after Create Job on a sent one. Their
 * tasks are on the job and their line is on no ACCEPTED estimate, so the plan read them as orphans:
 * another estimate's accept, pin or line delete stripped them (open ones removed, done ones
 * tombstoned), and re-accepting bore the done ones twice. An orphan whose key OR exact title one of
 * those lines holds is left exactly as it is — not removed, not tombstoned — and SAID ("left alone"),
 * until its own estimate is accepted again and the title claim re-keys it. By title as well as key
 * because the builder's autosave re-ids every line, so after an edit the old ids exist nowhere; the
 * title half is a trade-off (a stale draft can hold a same-titled task the accepted estimate dropped),
 * which is why it is said every time. Claims run before the shield: an orphan the accepted set wants
 * again by title is the line's, never a second copy.
 */
export interface Shield {
  keys: ReadonlySet<string>;
  titles: ReadonlySet<string>;
}
export const NO_SHIELD: Shield = { keys: new Set(), titles: new Set() };

export interface LineSyncPlan {
  /** Wanted tasks nobody has (by key or by exact title): inserted. */
  insert: BornTask[];
  /** Orphans, a visit's tasks, open hand tasks and returning tombstones: re-keyed to the line that is theirs. */
  rekey: Array<{ id: string; source_key: string }>;
  /** Open, bare orphans: removed. */
  remove: string[];
  /** Orphans that stay — done, or his (notes / a photo / steps). Said. */
  kept: LineTask[];
  /** The kept orphans, re-keyed under the tombstone so "kept" is said once and the line can find them again. */
  tombstone: Array<{ id: string; source_key: string }>;
  /** Wanted tasks a title dismissal barred (he deleted that task before): not inserted, said by name. */
  leftOff: string[];
  /** The dismissal entries that did the barring: replaced by `redismiss` (one entry per deletion). */
  consumed: string[];
  /** The same deletions under the rebuilt lines' keys. */
  redismiss: string[];
  /** Orphans a linked-but-unaccepted estimate's line still holds (the shield): untouched, said by name. */
  leftAlone: string[];
}

/**
 * THE PLAN, pure: what the job's line tasks must become given what its accepted estimates say.
 * `dismissed` = what he deleted by hand (jobs.dismissed_task_keys): never inserted, never re-keyed into.
 * `others` = the job's tasks no line put there (a visit's, hand-made): candidates, never removed.
 */
export function planLineSync(
  wanted: ReadonlyArray<BornTask>,
  have: ReadonlyArray<LineTask>,
  dismissed: ReadonlySet<string> = new Set(),
  others: ReadonlyArray<OtherTask> = [],
  shield: Shield = NO_SHIELD,
): LineSyncPlan {
  const wantedKeys = new Set(wanted.map((t) => t.source_key));
  const haveKeys = new Set(have.map((t) => t.source_key)); // live and tombstoned alike: neither is inserted again
  const dismissedKeys = new Set([...dismissed].map(dismissalKey));
  // Wanted tasks nobody has yet and he did not dismiss, in estimate order — the pool a task may re-key into.
  const unmatched = wanted.filter((t) => !haveKeys.has(t.source_key) && !dismissedKeys.has(t.source_key));

  const rekey: LineSyncPlan["rekey"] = [];
  const claimed = new Set<string>();
  const claim = (t: { id: string }, pick: (w: BornTask) => boolean): void => {
    if (claimed.has(t.id)) return;
    const i = unmatched.findIndex(pick);
    if (i === -1) return;
    rekey.push({ id: t.id, source_key: unmatched[i].source_key });
    unmatched.splice(i, 1);
    claimed.add(t.id);
  };
  const open = (t: { status: string }) => t.status === "open";

  // A TOMBSTONE whose line is back (an estimate moved away and back) is the line's again — not a second copy.
  for (const t of have) if (t.gone && wantedKeys.has(t.source_key)) rekey.push({ id: t.id, source_key: t.source_key });

  // A VISIT'S TASK finds the line built from it, by the task id the line's breakdown remembers — exact,
  // done or open: it is the same task — before any guess by name below.
  const visit = others.filter((t) => typeof t.source_key === "string" && t.source_key.startsWith(VISIT_KEY));
  for (const t of visit) claim(t, (w) => !!w.task_id && `${VISIT_KEY}${w.task_id}` === t.source_key);

  // Orphans (their line is on no accepted estimate) claim a name: open ones first — a done task matched
  // to a new line of the same name would hide new work. Then a visit's task by exact title, the same
  // way; then an OPEN task he made by hand (a done one does not: the estimate asking again is new work).
  const orphans = have.filter((t) => !t.gone && !wantedKeys.has(t.source_key));
  for (const pass of [orphans.filter(open), orphans.filter((t) => !open(t))]) for (const t of pass) claim(t, (w) => w.title === t.title);
  for (const pass of [visit.filter(open), visit.filter((t) => !open(t))]) for (const t of pass) claim(t, (w) => w.title === t.title);
  for (const t of others.filter((o) => !o.source_key && open(o))) claim(t, (w) => w.title === t.title);

  // A dismissal under a line that is gone bars the same task on a line nobody has (one task per
  // dismissal) — AFTER the claims, so a task that is there always wins — and MOVES to the new key.
  const leftOff: string[] = [];
  const consumed: string[] = [];
  const redismiss: string[] = [];
  // A VISIT task's dismissal ("task:<id>#…", the delete door after Start The Job) bars the line built
  // from that task by the id the line's breakdown remembers — whatever the builder's units box did to
  // the title (audit v1085, carried [18]) — and MOVES to the line's key like any other.
  const orphanEntries = [...dismissed].filter((e) => !wantedKeys.has(dismissalKey(e)) && (dismissalTitle(e) !== null || dismissalKey(e).startsWith(VISIT_KEY)));
  const insert = unmatched.filter((t) => {
    const byTask = t.task_id ? orphanEntries.findIndex((e) => dismissalKey(e) === `${VISIT_KEY}${t.task_id}`) : -1;
    const i = byTask !== -1 ? byTask : orphanEntries.findIndex((e) => dismissalTitle(e) === t.title.trim());
    if (i === -1) return true;
    consumed.push(orphanEntries[i]);
    orphanEntries.splice(i, 1);
    redismiss.push(dismissalEntry(t.source_key, t.title));
    leftOff.push(t.title);
    return false;
  });

  // A task a linked-but-unaccepted estimate's line still holds (by key or exact title) is that estimate's
  // (the shield): left exactly as it is — not removed, not tombstoned — and SAID, until its estimate is
  // accepted again. The claim above ran first: an orphan whose title the accepted set wants again is the
  // line's, shield or no shield, never a second copy.
  const shielded = (t: LineTask): boolean => shield.keys.has(t.source_key) || shield.titles.has(t.title.trim());
  const remove: string[] = [];
  const kept: LineTask[] = [];
  const leftAlone: string[] = [];
  for (const t of orphans) {
    if (claimed.has(t.id)) continue;
    if (shielded(t)) leftAlone.push(t.title);
    else if (t.status === "open" && !isHisTask(t)) remove.push(t.id);
    else kept.push(t);
  }
  return {
    insert,
    rekey,
    remove,
    kept,
    tombstone: kept.map((t) => ({ id: t.id, source_key: `${GONE_KEY}${t.source_key}` })),
    leftOff,
    consumed,
    redismiss,
    leftAlone,
  };
}

export interface EstimateLines {
  /** The task-bearing lines of the job's accepted estimates, oldest estimate first, each in its own order. */
  lines: LineRow[];
  /** Σ his hours over those lines, in minutes (born-with-tasks minutesOf); null when none. */
  minutes: number | null;
  /** Each task line's own minutes by its key ("line:<id>" → Σ its rows' hours × 60, null = none): the
   *  per-task twin of `minutes`, handed back to the sync as `tasksBefore` by a door that read it first. */
  taskMinutes: ReadonlyMap<string, number | null>;
  /** Each counted part's count by its row key ("line:<id>#R1" → the count the line said, × its quantity;
   *  an uncounted part is left out): the materials twin of `taskMinutes`, handed back to the materials
   *  sync as `partsBefore` (cn-v1133) so a row still holding the line's count follows the line. */
  partCounts: ReadonlyMap<string, number>;
  error?: string;
}

const NO_TASK_MINUTES: ReadonlyMap<string, number | null> = new Map();
const NO_PART_COUNTS: ReadonlyMap<string, number> = new Map();

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
  if (qErr) return { lines: [], minutes: null, taskMinutes: NO_TASK_MINUTES, partCounts: NO_PART_COUNTS, error: dbError(qErr) };
  const when = (q: { created_at: string | null; accepted_at?: string | null }) => String(q.accepted_at ?? q.created_at ?? "");
  const ordered = ((quotes ?? []) as Array<{ id: string; created_at: string | null; accepted_at?: string | null }>)
    .filter((q) => !who.except || q.id !== who.except)
    .sort((a, b) => when(a).localeCompare(when(b)) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  if (!ordered.length) return { lines: [], minutes: null, taskMinutes: NO_TASK_MINUTES, partCounts: NO_PART_COUNTS };
  const rank = new Map(ordered.map((q, i) => [q.id, i]));
  // `quantity` rides with the breakdown (cn-v1133): "this many of the task" multiplies its minutes and parts.
  let lq = sb.from("quote_line_items").select("id, description, sort_order, quantity, detail, quote_id").in("quote_id", ordered.map((q) => q.id));
  if (who.orgId) lq = lq.eq("org_id", who.orgId);
  const { data, error } = await lq.order("sort_order");
  if (error) return { lines: [], minutes: null, taskMinutes: NO_TASK_MINUTES, partCounts: NO_PART_COUNTS, error: dbError(error) };
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
    lines.push({ id: r.id, description: r.description, sort_order: own + offset, quantity: r.quantity, detail: r.detail });
  }
  const birth = tasksFromLines(lines);
  // The parts' counts by key, through THE one reader the materials sync uses (partsFromLines), so the
  // figure a door reads before its write is exactly the figure the sync compares a row to.
  const partCounts = new Map<string, number>();
  for (const p of partsFromLines(lines)) if (p.qty !== null) partCounts.set(p.key, p.qty);
  return { lines, minutes: birth.plannedMinutes, taskMinutes: new Map(birth.tasks.map((t) => [t.source_key, t.planned_minutes ?? null])), partCounts };
}

/**
 * THE SHIELD READ: the task lines of the job's linked estimates that are DRAFT or SENT right now (never
 * declined, expired or superseded — those are over). A failed read is an error, and the sync refuses
 * rather than strip what it could not see.
 */
export async function pendingShield(sb: SupabaseClient, who: { jobId: string; orgId: string | null }): Promise<Shield & { error?: string }> {
  let qq = sb.from("quotes").select("id").eq("job_id", who.jobId).in("status", ["draft", "sent"]);
  if (who.orgId) qq = qq.eq("org_id", who.orgId);
  const { data: quotes, error: qErr } = await qq;
  if (qErr) return { ...NO_SHIELD, error: dbError(qErr) };
  const ids = ((quotes ?? []) as Array<{ id: string }>).map((q) => q.id);
  if (!ids.length) return NO_SHIELD;
  let lq = sb.from("quote_line_items").select("id, description, sort_order, quantity, detail").in("quote_id", ids);
  if (who.orgId) lq = lq.eq("org_id", who.orgId);
  const { data, error } = await lq;
  if (error) return { ...NO_SHIELD, error: dbError(error) };
  const tasks = tasksFromLines((data ?? []) as LineRow[]).tasks;
  return { keys: new Set(tasks.map((t) => t.source_key)), titles: new Set(tasks.map((t) => t.title.trim())) };
}

export interface SyncWho {
  jobId: string;
  orgId: string | null;
  createdBy: string | null;
  /** The estimate's figure (estimateLines().minutes) as read BEFORE the change. undefined = leave the size alone. */
  sizeBefore?: number | null;
  /** Each task line's figure (estimateLines().taskMinutes) as read BEFORE the change, by line key: a task
   *  whose stored minutes still equal it follows its line. undefined = only an empty figure follows. */
  tasksBefore?: ReadonlyMap<string, number | null>;
}

export interface SyncResult {
  inserted: number;
  rekeyed: number;
  removed: number;
  kept: number;
  /** Tasks whose own minutes moved to their line's figure (0395). */
  timed: number;
  /** Tasks whose minutes differ from their line's and STAYED — his figure, typed on the job — by name. */
  hoursStay?: string[];
  /** The kept orphans' names, for the sentence. */
  keptNames: string[];
  /** Wanted tasks a title dismissal barred (he deleted that task before), by name. */
  leftOff: string[];
  /** A visit's or hand task that would have taken a line another door just filled: on the list twice, by name. */
  twice: string[];
  /** Orphans a linked-but-unaccepted estimate still holds (the shield): untouched, by name. */
  leftAlone?: string[];
  /** True when this call moved jobs.planned_minutes to the estimate's new figure (sizeNow). */
  sizeSet: boolean;
  sizeNow?: number | null;
  /** The estimate's figure moved but the box did not follow (his figure, or an old estimate figure): both, said. */
  sizeStays?: { box: number | null; estimate: number | null };
  error?: string;
}

const NONE: SyncResult = { inserted: 0, rekeyed: 0, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: false };

/** THE SYNC: read what the accepted estimates say and what the job has, plan, write, count. */
export async function syncJobTasks(sb: SupabaseClient, who: SyncWho): Promise<SyncResult> {
  const est = await estimateLines(sb, who);
  if (est.error) return { ...NONE, error: est.error };
  const wanted = tasksFromLines(est.lines).tasks;

  let tq = sb.from("tasks").select("id, source_key, title, status, notes, photo_path, parent_id, planned_minutes").eq("job_id", who.jobId);
  if (who.orgId) tq = tq.eq("org_id", who.orgId);
  const { data: rows, error: tErr } = await tq.order("sort_order").order("created_at");
  if (tErr) return { ...NONE, error: dbError(tErr) };
  type Row = Omit<LineTask, "source_key"> & { source_key: string | null; parent_id?: string | null };
  const all = (rows ?? []) as Row[];
  // What each task held AS READ — the key and the minutes — before any write below moves either.
  const asRead = new Map(all.map((t) => [t.id, { key: t.source_key, minutes: (t.planned_minutes ?? null) as number | null, title: t.title }]));
  // The tasks a LINE put there are the estimate's to keep in step — live ("line:") and tombstoned
  // ("gone:line:", kept earlier). A visit's ("task:") and hand-made tasks (no key) are candidates only —
  // a line may be theirs — and are never removed here. Steps under a task (parent_id) are the task's.
  const isLine = (k: string | null): k is string => typeof k === "string" && (k.startsWith(LINE_KEY) || k.startsWith(`${GONE_KEY}${LINE_KEY}`));
  const have: LineTask[] = all
    .filter((t) => isLine(t.source_key))
    .map((t) => {
      const k = t.source_key as string;
      return k.startsWith(GONE_KEY) ? { ...t, source_key: k.slice(GONE_KEY.length), gone: true } : { ...t, source_key: k };
    });
  const others: OtherTask[] = all.filter((t) => !isLine(t.source_key) && !t.parent_id).map((t) => ({ id: t.id, source_key: t.source_key, title: t.title, status: t.status }));
  const otherTitle = new Map(others.map((t) => [t.id, t.title]));

  // The job itself: the keys he dismissed by hand, and the length box as it stands right now.
  let jq = sb.from("jobs").select("planned_minutes, dismissed_task_keys").eq("id", who.jobId);
  if (who.orgId) jq = jq.eq("org_id", who.orgId);
  const { data: job, error: jErr } = await jq.maybeSingle();
  if (jErr) return { ...NONE, error: dbError(jErr) };
  if (!job) return { ...NONE, error: "That job could not be read." };
  const dismissedList = (Array.isArray((job as { dismissed_task_keys?: unknown }).dismissed_task_keys) ? (job as { dismissed_task_keys: unknown[] }).dismissed_task_keys : []).filter(
    (k): k is string => typeof k === "string",
  );
  const dismissed = new Set<string>(dismissedList);
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

  const shield = await pendingShield(sb, who);
  if (shield.error) return { ...NONE, error: shield.error };
  const plan = planLineSync(wanted, have, dismissed, others, shield);

  let rekeyed = 0;
  const twice: string[] = [];
  const rekeyedOk: Array<{ id: string; source_key: string }> = [];
  for (const r of plan.rekey) {
    let rq = sb.from("tasks").update({ source_key: r.source_key }).eq("id", r.id).eq("job_id", who.jobId);
    if (who.orgId) rq = rq.eq("org_id", who.orgId); // the service client: the company's rows only
    const { data, error } = await rq.select("id");
    // 23505: another door (the customer's Accept) put a task on that line between this read and this
    // write. Theirs is the task. A line orphan is cleaned up by the next pass; a visit's or hand task
    // is never removed here, so it is now on the list twice — SAID, by name. Any other refusal is said.
    if (error && (error as { code?: string }).code === "23505") {
      const title = otherTitle.get(r.id);
      if (title) twice.push(title);
      continue;
    }
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    if (!data?.length) return { ...NONE, rekeyed, error: "A task could not be matched to its line." };
    rekeyed++;
    rekeyedOk.push(r);
  }

  for (const t of plan.tombstone) {
    // A KEPT ORPHAN IS HIS NOW: its key goes under the tombstone ("gone:line:<id>") — "kept" is said this
    // once, not on every sync after, and the line can still find it if it ever comes back.
    let kq = sb.from("tasks").update({ source_key: t.source_key }).eq("id", t.id).eq("job_id", who.jobId);
    if (who.orgId) kq = kq.eq("org_id", who.orgId);
    const { data, error } = await kq.select("id");
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    if (!data?.length) return { ...NONE, rekeyed, error: "A kept task could not be marked." };
  }

  let removed = 0;
  let kept = plan.kept.length;
  const keptNames = plan.kept.map((t) => t.title);
  if (plan.remove.length) {
    // Conditional on what was read: a task checked off or photographed in the meantime is not removed — it is kept.
    let dq = sb.from("tasks").delete().in("id", plan.remove).eq("job_id", who.jobId).eq("status", "open").is("photo_path", null);
    if (who.orgId) dq = dq.eq("org_id", who.orgId);
    const { data, error } = await dq.select("id");
    if (error) return { ...NONE, rekeyed, error: dbError(error) };
    removed = data?.length ?? 0;
    kept += plan.remove.length - removed;
  }

  if (plan.redismiss.length) {
    // The same deletions, MOVED to the rebuilt lines' keys: the entries that barred are replaced, never
    // piled up (two stale entries would bar two live lines). Read again right before the write, so a
    // delete made meanwhile (the delete door's dismiss_task_key, 0393) is kept, not overwritten — the
    // window is one round trip; the service client (the customer's Accept) cannot use an org-bound door.
    let fq = sb.from("jobs").select("dismissed_task_keys").eq("id", who.jobId);
    if (who.orgId) fq = fq.eq("org_id", who.orgId);
    const { data: fresh, error: fErr } = await fq.maybeSingle();
    if (fErr) return { ...NONE, rekeyed, removed, kept, keptNames, error: dbError(fErr) };
    const now = (Array.isArray((fresh as { dismissed_task_keys?: unknown } | null)?.dismissed_task_keys) ? (fresh as { dismissed_task_keys: unknown[] }).dismissed_task_keys : dismissedList).filter(
      (k): k is string => typeof k === "string",
    );
    const consumed = new Set(plan.consumed);
    const next = [...now.filter((e) => !consumed.has(e)), ...plan.redismiss.filter((e) => !now.includes(e))];
    let dq = sb.from("jobs").update({ dismissed_task_keys: next }).eq("id", who.jobId);
    if (who.orgId) dq = dq.eq("org_id", who.orgId);
    const { data, error } = await dq.select("id");
    if (error) return { ...NONE, rekeyed, removed, kept, keptNames, error: dbError(error) };
    if (!data?.length) return { ...NONE, rekeyed, removed, kept, keptNames, error: "The job's deleted tasks could not be kept up." };
  }

  // A TASK'S OWN MINUTES FOLLOW ITS LINE (0395), the size's rule per task: the task that holds each
  // wanted line now (by key as read, or re-keyed just above) moves to the line's figure while its
  // stored figure is still the line's — empty, or equal to what the line said before (`tasksBefore`)
  // — compare-and-set on the value just read, so a figure typed meanwhile wins. Anything else is his
  // and stays, said by name. A task the insert below births carries its minutes already.
  const holder = new Map<string, string>(); // line key → the id of the task that holds it now
  for (const t of have) if (!t.gone) holder.set(t.source_key, t.id);
  for (const r of rekeyedOk) holder.set(r.source_key, r.id);
  let timed = 0;
  const hoursStay: string[] = [];
  for (const w of wanted) {
    const id = holder.get(w.source_key);
    const read = id ? asRead.get(id) : undefined;
    if (!id || !read) continue;
    const want = w.planned_minutes ?? null;
    if (read.minutes === want) continue;
    const before = read.key ? who.tasksBefore?.get(read.key) : undefined;
    if (!(read.minutes === null || (before !== undefined && read.minutes === before))) {
      hoursStay.push(read.title);
      continue;
    }
    let mq = sb.from("tasks").update({ planned_minutes: want }).eq("id", id).eq("job_id", who.jobId);
    mq = read.minutes === null ? mq.is("planned_minutes", null) : mq.eq("planned_minutes", read.minutes);
    if (who.orgId) mq = mq.eq("org_id", who.orgId);
    const { data, error } = await mq.select("id");
    if (error) return { ...NONE, rekeyed, removed, kept, keptNames, timed, error: dbError(error) };
    if (data?.length) timed++; // zero rows: a figure typed between the read and the write wins
  }

  // The birth's own insert: same row shape, dedupe by key, silent-write counts. Size left to the rule below.
  const born = await bornTasks(sb, { jobId: who.jobId, orgId: who.orgId, createdBy: who.createdBy }, { tasks: plan.insert, plannedMinutes: null, parts: [] });
  if (born.error) return { ...NONE, rekeyed, removed, kept, keptNames, timed, error: born.error };

  const done: SyncResult = {
    inserted: born.inserted,
    rekeyed,
    removed,
    kept,
    timed,
    keptNames,
    leftOff: plan.leftOff,
    twice,
    sizeSet: false,
    ...(hoursStay.length ? { hoursStay } : {}),
    ...(plan.leftAlone.length ? { leftAlone: plan.leftAlone } : {}),
  };
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
    // "stays at X (now says X)" is no news (audit v1085, carried): only a figure that differs is said.
    return boxNow === est.minutes ? done : { ...done, sizeStays: { box: boxNow, estimate: est.minutes } };
  }
  return done;
}

/**
 * A RENAMED LINE'S DISMISSAL FOLLOWS (audit v1085, carried [18]): a task he deleted left "line:<id>#<old
 * title>" on the job; a rename in the builder and a rebuild then brought the same task back under the new
 * title, because the title half no longer matched. Moved to the new title in ONE statement
 * (retitle_task_dismissal, 0393: array_replace, so a dismissal another door appends meanwhile is never
 * written over by a stale read). False is the common answer (the task is there, or never dismissed).
 */
export async function retitleDismissal(
  sb: SupabaseClient,
  who: { jobId: string; lineId: string; from: string; to: string },
): Promise<{ moved: boolean; error?: string }> {
  const to = who.to.trim();
  const from = who.from.trim();
  if (!to || to === from) return { moved: false };
  const { data, error } = await sb.rpc("retitle_task_dismissal", { p_job_id: who.jobId, p_key: `${LINE_KEY}${who.lineId}`, p_from: from, p_to: to });
  if (error) return { moved: false, error: dbError(error) };
  return { moved: data === true };
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

const few = (names: string[]): string => (names.length ? ` (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""})` : "");

/** What the job's list did, in a sentence — or null when nothing changed. `lead` names whose list, when
 *  it is not the obvious one (the job an estimate was moved away from). */
export function syncWords(r: SyncResult, lead = "The job's list follows the estimate"): string | null {
  const bits: string[] = [];
  if (r.inserted) bits.push(`${plural(r.inserted, "task", "tasks")} added`);
  if (r.rekeyed) bits.push(`${r.rekeyed} matched`);
  if (r.removed) bits.push(`${r.removed} removed`);
  if (r.kept) bits.push(`${r.kept} kept${few(r.keptNames)} — done, or with notes, a photo or steps`);
  if (r.leftOff?.length) bits.push(`${r.leftOff.length} left off${few(r.leftOff)} — deleted from the job before`);
  if (r.twice?.length) bits.push(`${r.twice.length} on the list twice${few(r.twice)} — remove one`);
  if (r.leftAlone?.length) bits.push(`${r.leftAlone.length} left alone${few(r.leftAlone)} — an estimate not yet accepted still has them`);
  if (r.timed) bits.push(`${r.timed} ${r.timed === 1 ? "task's" : "tasks'"} hours updated`);
  if (r.hoursStay?.length) bits.push(`${r.hoursStay.length} kept ${r.hoursStay.length === 1 ? "its" : "their"} hours${few(r.hoursStay)} — set on the job`);
  if (r.sizeSet) bits.push(`the job's length is now ${hoursWords(r.sizeNow ?? null)}`);
  if (r.sizeStays) bits.push(`the job's length stays at ${hoursWords(r.sizeStays.box)} (the estimate now says ${hoursWords(r.sizeStays.estimate)})`);
  return bits.length ? `${lead}: ${bits.join(" · ")}.` : null;
}
