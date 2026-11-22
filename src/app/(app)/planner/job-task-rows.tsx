"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { fillText, localeOf, translator, type Lang } from "@/lib/i18n";
import { isOpenTask } from "@/lib/open-counts";
import { jobLabel } from "@/lib/schedule-options";
import { NowTasks } from "./now-tasks";

/**
 * A JOB'S TASKS ON MY DAY, ONE ROW PER JOB (cn-v1175). Erik, 2026-11-21: "My Day tasks im thinking that
 * a job's full list of tasks shouldnt be all counted in the top badge but subdivided with a drop down in
 * the list and stated as that job's tasks with its own mini badge so we can keep the flowe easier on the
 * eye (check the math on this so we can have these badges actually work pls :)".
 *
 * So, under the Reminders in Tasks & Reminders: one row per job that has open tasks, named the way the
 * app names a job for a person (lib/schedule-options jobLabel: the job's name, never a bare number), a
 * small badge that counts THAT job's open tasks and nothing else, and a drop-down, shut by default, that
 * lists them with check-off (the Now card's own block, NowTasks, with a larger cap) and All Tasks to the
 * job's Tasks tab. A job with none open draws no row.
 *
 * THE MATH. Open is the ONE rule (lib/job-tasks whereJobTaskOpen does the cut in the read; isOpenTask,
 * its twin, is asked again here on the same rows), so a badge is the length of the list under it. Steps
 * count as tasks, as on the Now card. The job's materials are NOT read here (one read for the whole
 * section): the job page's Tasks badge adds one for Buy Materials, this one does not. No top number
 * reads any of it: the card's head counts, DoneMarks, rankSix and the dock stay Reminders and Needs You.
 *
 * NEVER REMOUNT AN OPEN THING: each row is keyed by its job alone, and nothing around the <details> or
 * NowTasks is keyed, so a check-off (and the refresh after it) keeps the drop-down open. The badge goes
 * down with the tap (NowTasks tells the row what it checked) and the refreshed read agrees with it.
 */

/** A task row as the page's one read returns it: the task, and its job through the open rule's inner
 *  embed (status for the rule, name and number for the label, the crew for a tech's cut). No money. */
export type JobTaskReadRow = {
  id: string;
  title: string;
  status?: string | null;
  job_id: string | null;
  sort_order?: number | null;
  created_at?: string | null;
  jobs:
    | { status?: string | null; job_number?: string | null; name?: string | null; assigned_to?: string[] | null }
    | { status?: string | null; job_number?: string | null; name?: string | null; assigned_to?: string[] | null }[]
    | null;
};

/** The section's input: the read (null = it failed, which the card says), and who is reading. */
export type JobTasksInput = {
  read: { rows: JobTaskReadRow[]; truncated: boolean } | null;
  /** Today's jobs, then the carried-over ones, in the Today card's order: these lead. */
  firstIds: string[];
  /** The job on the reader's open punch: its tasks are on the Now card, so it has no row here. */
  currentJobId: string | null;
  /** A tech's own id (he sees only jobs he is on the crew of); null for the office (every job). */
  techId: string | null;
};

export type JobTasksGroup = {
  jobId: string;
  label: string;
  tasks: { id: string; title: string }[];
  /** true when the read's bound cut this job's list: its badge is a floor ("N+"). */
  floor: boolean;
};

/** How many of a job's open tasks its drop-down draws; All Tasks opens the whole list. */
export const JOB_ROW_CAP = 10;

const jobOf = (r: JobTaskReadRow) => (Array.isArray(r.jobs) ? (r.jobs[0] ?? null) : r.jobs);

/**
 * THE GROUPING AND THE ORDER, pure. One group per job with open tasks, each job's tasks in its list's
 * order (sort_order, then the order they were added). Left out: a task that is not open by the one rule,
 * the clocked-in job, and for a tech every job whose crew does not name him. Today's and carried-over
 * jobs first, in the order given; then the rest by label in the reader's language.
 */
export function groupJobTasks(
  rows: readonly JobTaskReadRow[],
  p: { firstIds: readonly string[]; currentJobId: string | null; techId: string | null; truncated?: boolean; lang?: Lang },
): JobTasksGroup[] {
  const lang = p.lang ?? "en";
  const byJob = new Map<string, { job: NonNullable<ReturnType<typeof jobOf>>; rows: JobTaskReadRow[] }>();
  for (const r of rows) {
    const job = jobOf(r);
    if (!r.job_id || !job) continue;
    if (!isOpenTask(r, job)) continue;
    if (r.job_id === p.currentJobId) continue;
    if (p.techId && !(job.assigned_to ?? []).includes(p.techId)) continue;
    const g = byJob.get(r.job_id) ?? { job, rows: [] };
    g.rows.push(r);
    byJob.set(r.job_id, g);
  }
  // The read is ordered by job: when its bound cut it, only the last job read can be short.
  const cutJob = p.truncated && rows.length ? rows[rows.length - 1].job_id : null;
  const first = new Map(p.firstIds.map((id, i) => [id, i] as const));
  const locale = localeOf(lang);
  return [...byJob.entries()]
    .map(([jobId, g]) => ({
      jobId,
      label: jobLabel(g.job, lang),
      tasks: [...g.rows]
        .sort((a, b) => (Number(a.sort_order ?? 0) || 0) - (Number(b.sort_order ?? 0) || 0) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
        .map((r) => ({ id: r.id, title: r.title })),
      floor: jobId === cutJob,
    }))
    .sort((a, b) => {
      const fa = first.get(a.jobId);
      const fb = first.get(b.jobId);
      if (fa !== undefined || fb !== undefined) {
        if (fa === undefined) return 1;
        if (fb === undefined) return -1;
        return fa - fb;
      }
      return a.label.localeCompare(b.label, locale) || a.jobId.localeCompare(b.jobId);
    });
}

/** One job's row: its name, its own badge, and the drop-down. The row's checked ids live here so the
 *  badge goes down with the tap; nothing here is keyed, so the drop-down stays open through it. */
function JobTaskRow({ group }: { group: JobTasksGroup }) {
  const t = translator(useLang());
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const live = group.tasks.filter((task) => !checked.has(task.id)).length;
  const n = `${live}${group.floor ? "+" : ""}`;
  return (
    <li>
      <details className="group">
        <summary
          className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-5 py-1.5 hover:bg-slate-50 [&::-webkit-details-marker]:hidden"
          aria-label={fillText(t("md_jobTasksOpen"), { job: group.label, n })}
        >
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{group.label}</span>
          {live > 0 && (
            <span data-job-badge className="inline-flex min-w-[1.25rem] shrink-0 justify-center rounded-full bg-slate-100 px-1.5 py-px text-xs font-semibold text-slate-700">
              {n}
            </span>
          )}
        </summary>
        <div className="px-3 pb-3">
          <NowTasks jobId={group.jobId} left={live} next={group.tasks} cap={JOB_ROW_CAP} onCheckedChange={setChecked} />
        </div>
      </details>
    </li>
  );
}

/** The section at the foot of Tasks & Reminders. Nothing at all when no job has an open task; a failed
 *  read is said, never drawn as "no tasks". When the read's bound cut it, jobs after the cut have no row,
 *  so ONE plain grey line under the rows says so and links Jobs (skeptic #78: nothing vanishes unsaid).
 *  Grey, never amber: it is inventory, not a clock. */
export function JobTaskRows({ input }: { input: JobTasksInput }) {
  const lang = useLang();
  const t = translator(lang);
  const groups = useMemo(
    () =>
      input.read
        ? groupJobTasks(input.read.rows, { firstIds: input.firstIds, currentJobId: input.currentJobId, techId: input.techId, truncated: input.read.truncated, lang })
        : [],
    [input, lang],
  );
  if (!input.read) {
    return <p className="border-t border-slate-100 px-5 py-3 text-sm text-slate-500">{t("md_jobTasksFailed")}</p>;
  }
  const cut = input.read.truncated;
  if (!groups.length && !cut) return null;
  const [before, after = ""] = t("md_jobTasksMore").split("{jobs}");
  return (
    <div className="border-t border-slate-100">
      <h3 className="px-5 pb-1 pt-3 text-xs font-semibold text-slate-500">{t("md_jobTasks")}</h3>
      <ul className="divide-y divide-slate-100">
        {groups.map((g) => (
          <JobTaskRow key={g.jobId} group={g} />
        ))}
      </ul>
      {cut && (
        <p data-job-tasks-more className="px-5 pb-3 pt-1 text-xs text-slate-500">
          {before}
          <Link href="/jobs" className="underline underline-offset-2 hover:text-slate-700">
            {t("jb_jobsTitle")}
          </Link>
          {after}
        </p>
      )}
    </div>
  );
}
