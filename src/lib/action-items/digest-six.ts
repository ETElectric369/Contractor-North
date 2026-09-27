import { rankSix, type SixRankTask } from "@/lib/six-rank";

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

/** One person's six from the company's pool: only rows that are theirs, ranked the way My Day ranks. */
export function sixForPerson<T extends DigestTask>(pool: T[], personId: string, todayStr: string): T[] {
  return rankSix(
    pool.filter((t) => sixOwner(t) === personId),
    { todayStr },
  );
}
