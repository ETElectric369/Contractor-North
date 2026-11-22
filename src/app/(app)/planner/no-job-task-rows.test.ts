import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dict } from "@/lib/i18n";

/**
 * MY DAY CARRIES NO JOB'S TASK LIST (cn-v1179). cn-v1175 put every job's open tasks under the Reminders,
 * one row per job; the owner took them off again, for everyone (2026-11-22: "i dont think i need or want
 * all of the scheduled jobs' tasks lists on my day its way too much [...] the bulk of the list isnt
 * needed until i get to the job"). A job's list lives on the job's Tasks tab, a FLAGGED job task is a
 * Needs You row, and the job on the clock keeps its tasks on the Now card.
 *
 * Read from the source: My Day is a server page with a dozen reads, and what this pins is that a read
 * and a section are GONE, so every pin is a statement about the files themselves.
 */
const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const PAGE = "src/app/(app)/planner/page.tsx";
const LIST = "src/app/(app)/planner/your-list.tsx";
const NOW = "src/app/(app)/planner/now-tasks.tsx";

/** Every `.from("tasks")` read on the page, with the 400 characters after it (its cut). */
const taskReads = (s: string) => [...s.matchAll(/\.from\("tasks"\)/g)].map((m) => s.slice(m.index!, m.index! + 400));

describe("My Day draws no per-job task rows", () => {
  it("the rows' component and its read are gone", () => {
    expect(existsSync(join(ROOT, "src/app/(app)/planner/job-task-rows.tsx"))).toBe(false);
    const page = src(PAGE);
    expect(page).not.toContain("MY_DAY_JOB_TASKS_LIMIT");
    expect(page).not.toContain("jobTasksR");
    expect(page).not.toMatch(/jobTasks=\{/);
    const list = src(LIST);
    expect(list).not.toContain("job-task-rows");
    expect(list).not.toContain("JobTaskRows");
    expect(list).not.toMatch(/\bjobTasks\b/);
  });

  it("every tasks read on the page is a Reminder's (job_id null), a Reminder's steps, or the clocked-in job's", () => {
    const page = src(PAGE);
    const reads = taskReads(page);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const r of reads) {
      const reminders = r.includes("RANK_POOL_SELECT"); // inside mineCut(...): job_id null
      const steps = r.includes('.in("parent_id", six.map');
      const nowCard = r.includes('.eq("job_id", currentJob.id)');
      const head = r.startsWith('.from("tasks").select("id", { count: "exact", head: true })'); // headCount: used only through mineCut
      expect(reminders || steps || nowCard || head, r).toBe(true);
    }
    // headCount is only ever called inside mineCut (job_id null).
    expect([...page.matchAll(/headCount\(\)/g)].length).toBe(2);
    expect(page).toMatch(/mineCut\(headCount\(\)/);
    expect(page).toMatch(/mineCut\(\s*headCount\(\)/);
    // The Now card's is the only job-task read, bound to the job on the clock.
    expect([...page.matchAll(/whereJobTaskOpen\(/g)].length).toBe(1);
  });

  it("the Now card's task block lost the props only the rows passed", () => {
    const now = src(NOW);
    expect(now).not.toMatch(/\bcap\b/);
    expect(now).not.toContain("onCheckedChange");
  });

  it("the rows' four words left both languages", () => {
    for (const lang of ["en", "es"] as const) {
      const d = dict(lang) as Record<string, string>;
      for (const k of ["md_jobTasks", "md_jobTasksOpen", "md_jobTasksFailed", "md_jobTasksMore"]) expect(d[k], `${lang}:${k}`).toBeUndefined();
    }
  });

  it("the Needs You comment says the one task that comes there is a flagged job task, in the owner's words", () => {
    const page = src(PAGE);
    expect(page).toContain("the ONE task that comes here is a job task the office FLAGGED");
    expect(page).toContain("so maybe these tasks should go in the needs you under operations");
    expect(page).not.toContain("Tasks\n          live in Tasks & Reminders + the doors above, never here.");
  });
});
