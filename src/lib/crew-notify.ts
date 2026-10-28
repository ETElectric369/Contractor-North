import "server-only";
import { notifyPeople } from "@/lib/notifications";
import { fillText, translator } from "@/lib/i18n";

/**
 * Bell + push for members newly ADDED to a job's crew — the one diff+notify used by
 * every assigned_to writer (setJobCrew / setJobAssignee in schedule/actions, updateJob
 * in jobs/actions), so "you're on this job" can't depend on which surface assigned you.
 * Diffs old→new and notifies ONLY the additions; removals are silent, and the caller
 * never notifies themselves (the appointments/actions self-suppress precedent).
 * Fire-and-forget: a notify failure must never break the assignment itself.
 *
 * IN EACH PERSON'S LANGUAGE (cn-v1138): the words are a function of the language, and notifyPeople
 * reads the recipients' profiles.language once, groups them, and writes each group its own bell line
 * (type "assigned", as before) before its own push (kind "assigned", defaults ON). This file read no
 * profile before; that one read is notifyPeople's.
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
    const named = [job.job_number, job.name].filter(Boolean).join(" · ");
    await notifyPeople(job.org_id, added, "assigned", (lang) => {
      const t = translator(lang);
      return {
        title: t("nb_jobAssignedTitle"),
        body: fillText(t("nb_jobAssignedBody"), { label: named || t("nb_aJob") }),
        url: `/jobs/${job.id}`,
      };
    });
  } catch {
    /* best-effort — notifications must never break the caller */
  }
}
