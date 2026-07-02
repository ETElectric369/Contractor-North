// THE SIX-SLOT RANK — the one pure function that picks "Today's 6" from the open
// task pool. Shared by the My Day six-slot card (planner/page.tsx) and the morning
// push digest (action-items/digest.ts), and pinned by tests/badge-economy.test.ts,
// so the selection can never drift between surfaces. Pure and DB-free on purpose:
// callers fetch their pool (top-level open tasks under the usual ownership cut)
// and pass the org-local day + today's scheduled-job set.
//
// Slot order (the amended six-slot spec):
//   1. PINNED — focus_date = today (an explicit user/debrief choice), priority desc.
//      A pin is a DATE so it self-expires at midnight; yesterday's undone pin falls
//      back into the ranked pool instead of squatting a slot forever.
//   2. FRESH OVERDUE — due < today; priority desc, then due DESC (the freshest
//      missed deadline first — a yesterday-miss beats a June-8 zombie). Capped at
//      3 auto-fill slots so a stale backlog can't monopolize the whole day and
//      starve ranks 3-4. (Pinned overdue rows ride rank 1, not this cap; an
//      over-cap overdue task tied to today's site can still re-enter via rank 4.)
//   3. DUE TODAY — priority desc.
//   4. ON SITE TODAY — task.job_id ∈ today's scheduled-job set, priority desc:
//      the six lean toward the places the truck is already going.
//   5. FLAGGED UNDATED — priority ≥ 1 with no due date. category='office' is
//      excluded from THIS rank only: office work is batch-by-nature and lives
//      behind the Office door, but a DATED office task (payroll day, a license
//      renewal) enters ranks 2-3 like everything else — a stated date beats the
//      category.
//
// PLAIN UNDATED TASKS NEVER AUTO-PROMOTE — undated is not "due now"; it lives
// behind the Everything-else door until someone dates, flags, or pins it. And
// SUBTASKS (parent_id set) are never slots — they render nested under their
// parent and are never counted anywhere as top-level work.

export const SIX_SLOTS = 6;

/** Rank-2's auto-fill cap: at most this many overdue tasks fill unpinned slots. */
export const OVERDUE_AUTO_CAP = 3;

export interface SixRankTask {
  id: string;
  /** Only "open" rows rank; anything else is dropped defensively. */
  status?: string | null;
  /** 0 normal · 1 high · 2 urgent (tasks.priority). */
  priority?: number | null;
  /** yyyy-mm-dd due date, if any. */
  due_date?: string | null;
  /** yyyy-mm-dd — equal to today means PINNED into today's six. */
  focus_date?: string | null;
  /** tasks.category — 'office' is excluded from rank 5 (flagged-undated) only. */
  category?: string | null;
  job_id?: string | null;
  /** Subtasks (parent_id set) never rank — they nest under their parent. */
  parent_id?: string | null;
}

export interface SixRankContext {
  /** The org-local day, yyyy-mm-dd. */
  todayStr: string;
  /** Jobs the crew stands on today (scheduled today + segments covering today). */
  scheduledJobIds?: ReadonlySet<string>;
  /** Slot count — defaults to SIX_SLOTS; exists for tests, not for tuning. */
  slots?: number;
}

/**
 * Pick today's six from an open-task pool. Returns at most `slots` tasks in slot
 * order (rank 1 → 5; ties resolved priority-first, then input order — feed rows
 * pre-sorted by due date so date ties stay nearest-first). Never mutates input.
 */
export function rankSix<T extends SixRankTask>(tasks: T[], ctx: SixRankContext): T[] {
  const { todayStr } = ctx;
  const slots = ctx.slots ?? SIX_SLOTS;
  const onSite = ctx.scheduledJobIds ?? new Set<string>();
  const prio = (t: SixRankTask) => Number(t.priority) || 0;
  // Sort helpers copy via filter() first, so sort() never touches the caller's array.
  const byPriority = (a: T, b: T) => prio(b) - prio(a); // stable sort keeps input order on ties

  // Top-level OPEN tasks only — subtasks and done/cancelled rows never rank.
  const pool = tasks.filter((t) => t.parent_id == null && (t.status == null || t.status === "open"));

  const picked: T[] = [];
  const taken = new Set<string>();
  const take = (rows: T[], cap: number) => {
    for (const t of rows) {
      if (picked.length >= slots || cap <= 0) return;
      if (taken.has(t.id)) continue;
      picked.push(t);
      taken.add(t.id);
      cap--;
    }
  };

  // 1. Pinned into today.
  take(pool.filter((t) => t.focus_date === todayStr).sort(byPriority), slots);
  // 2. Fresh overdue — priority desc, then due DESC; hard-capped auto-fill.
  take(
    pool
      .filter((t) => !!t.due_date && (t.due_date as string) < todayStr)
      .sort((a, b) => byPriority(a, b) || (b.due_date as string).localeCompare(a.due_date as string)),
    OVERDUE_AUTO_CAP,
  );
  // 3. Due today.
  take(pool.filter((t) => t.due_date === todayStr).sort(byPriority), slots);
  // 4. On a job the crew stands on today (any due state — the truck is going there).
  take(pool.filter((t) => !!t.job_id && onSite.has(t.job_id as string)).sort(byPriority), slots);
  // 5. Flagged undated — office excluded from this rank ONLY.
  take(
    pool.filter((t) => t.due_date == null && prio(t) >= 1 && t.category !== "office").sort(byPriority),
    slots,
  );

  return picked;
}
