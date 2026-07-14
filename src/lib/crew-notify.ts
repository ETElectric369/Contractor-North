import "server-only";
import { createNotifications } from "@/lib/notifications";
import { sendPushToProfiles } from "@/lib/push";

/**
 * Bell + push for members newly ADDED to a job's crew — the one diff+notify used by
 * every assigned_to writer (setJobCrew / setJobAssignee in schedule/actions, updateJob
 * in jobs/actions), so "you're on this job" can't depend on which surface assigned you.
 * Diffs old→new and notifies ONLY the additions; removals are silent, and the caller
 * never notifies themselves (the appointments/actions self-suppress precedent).
 * Fire-and-forget: a notify failure must never break the assignment itself.
 */
export async function notifyJobCrewAdded(
  job: { id: string; org_id: string | null; job_number?: string | null; name?: string | null },
  oldIds: (string | null | undefined)[] | null | undefined,
  newIds: string[],
  callerId: string,
): Promise<void> {
  try {
    const before = new Set((oldIds ?? []).filter((x): x is string => !!x));
    const added = newIds.filter((x) => !!x && !before.has(x) && x !== callerId);
    if (!added.length) return;
    const label = [job.job_number, job.name].filter(Boolean).join(" · ") || "a job";
    const payload = {
      title: "New job assigned",
      body: `You're on ${label}.`,
      url: `/jobs/${job.id}`,
    };
    await createNotifications(job.org_id, added, { type: "assigned", ...payload }); // the bell — always works
    await sendPushToProfiles(added, "assigned", payload); // + push (kind "assigned" defaults ON)
  } catch {
    /* best-effort — notifications must never break the caller */
  }
}
