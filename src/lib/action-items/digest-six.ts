import { inRankPool, PUSH_SIX, rankSix, type SixRankTask } from "@/lib/six-rank";

/**
 * EACH PERSON'S OWN SIX, for the morning push (0358). The digest runs on the service client, which
 * reads every row in the company, so the privacy a Reminder has in the app (0358's tasks_read: only
 * its maker and the person it is for) has to be kept here by hand: each person is sent the six from
 * THEIR Reminders, never the company's. Pure, so it is tested without a database.
 */
export interface DigestTask extends SixRankTask {
  id: string;
  title: string;
  created_by?: string | null;
  assigned_to?: string | null;
}

/**
 * Whose six a row belongs in — the same cut My Day ranks with (planner/page.tsx mineCut): a Reminder
 * is in the six of the person it is for, or of its maker when it is for nobody else. A job's task is
 * nobody's six (it is the job's list). A Reminder with neither a maker nor a person is nobody's too:
 * it is never pushed to anyone's phone.
 */
export function sixOwner(t: Pick<DigestTask, "job_id" | "created_by" | "assigned_to">): string | null {
  if (t.job_id) return null;
  return t.assigned_to ?? t.created_by ?? null;
}

/**
 * One person's day from the company's pool: only rows that are theirs, ranked the way My Day ranks.
 *
 * BOUNDED AT PUSH_SIX, and that bound is the push's, not the card's. My Day has no cap any more
 * (Erik: "lets not limit it") but a notification is one sentence — it names two titles and "+N" — so
 * it reads the top of the same order rather than all of it. The ORDER is shared, which is what keeps
 * the phone and the app from disagreeing; the length is a property of a push.
 */
export function sixForPerson<T extends DigestTask>(pool: T[], personId: string, todayStr: string): T[] {
  return rankSix(
    // THE PUSH'S OWN POOL, asserted here as well as in its fetch (lib/six-rank inRankPool, scope
    // "push"): My Day shows a plain undated Reminder now, and a push must not — a pushed number may
    // not be the length of an undated set (the badge invariant). The fetch is the first guard; this is
    // the braces, so a caller handing over a wider pool can't put one on somebody's lock screen.
    pool.filter((t) => sixOwner(t) === personId && inRankPool(t, todayStr, "push")),
    { todayStr, slots: PUSH_SIX },
  );
}
