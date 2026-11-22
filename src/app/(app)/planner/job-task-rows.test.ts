import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dict, fillText } from "@/lib/i18n";
import { LangProvider } from "@/components/lang-provider";

/**
 * A JOB'S TASKS ON MY DAY, ONE ROW PER JOB (cn-v1175). Erik, 2026-11-21: "a job's full list of tasks
 * shouldnt be all counted in the top badge but subdivided with a drop down in the list and stated as
 * that job's tasks with its own mini badge". Under the Reminders in Tasks & Reminders: one row per job
 * with open tasks (the one open rule), its own badge, a drop-down shut by default; today's and carried
 * jobs first; a tech only his crew's jobs; the clocked-in job left to the Now card; no top number reads
 * any of it; a check-off never remounts the drop-down.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/planner",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../tasks/actions", () => ({ createTask: vi.fn(), toggleTask: vi.fn(), deleteTask: vi.fn(), updateTask: vi.fn() }));

import { groupJobTasks, JobTaskRows, JOB_ROW_CAP, type JobTaskReadRow } from "./job-task-rows";
import { YourList } from "./your-list";
import { NowTasks } from "./now-tasks";

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

type J = { status?: string; name?: string | null; job_number?: string | null; assigned_to?: string[] };
const job = (id: string, over: J = {}) => ({ id, status: "in_progress", name: `${id} name`, job_number: null, assigned_to: [] as string[], ...over });
let seq = 0;
const task = (jobId: string, j: ReturnType<typeof job>, over: Partial<JobTaskReadRow> = {}): JobTaskReadRow => ({
  id: `t${++seq}`,
  title: `Task ${seq}`,
  status: "open",
  job_id: jobId,
  sort_order: 0,
  created_at: `2026-11-0${(seq % 9) + 1}T10:00:00Z`,
  jobs: { status: j.status, name: j.name, job_number: j.job_number, assigned_to: j.assigned_to },
  ...over,
});
const base = { firstIds: [] as string[], currentJobId: null as string | null, techId: null as string | null };

describe("groupJobTasks: the grouping and the order", () => {
  const thistle = job("j-thistle", { name: "Thistlewood Panel Swap" });
  const bay = job("j-bay", { name: "Bayberry Subpanel" });
  const cat = job("j-cat", { name: "Catbird Rewire" });
  const snow = job("j-snow", { name: "Snowbell Service Call" });

  const table: { name: string; rows: JobTaskReadRow[]; p: Partial<typeof base> & { truncated?: boolean }; want: [string, number][] }[] = [
    {
      name: "the rest by label when nothing is on today",
      rows: [task("j-thistle", thistle), task("j-bay", bay), task("j-bay", bay), task("j-cat", cat)],
      p: {},
      want: [["Bayberry Subpanel", 2], ["Catbird Rewire", 1], ["Thistlewood Panel Swap", 1]],
    },
    {
      name: "today's and carried-over jobs lead, in the order given, then the rest by label",
      rows: [task("j-thistle", thistle), task("j-bay", bay), task("j-cat", cat), task("j-snow", snow)],
      p: { firstIds: ["j-snow", "j-thistle"] },
      want: [["Snowbell Service Call", 1], ["Thistlewood Panel Swap", 1], ["Bayberry Subpanel", 1], ["Catbird Rewire", 1]],
    },
    {
      name: "a job that is over has no open task (the one rule); on hold keeps its tasks",
      rows: [
        task("j-done", job("j-done", { status: "complete", name: "Larkspur Done" })),
        task("j-off", job("j-off", { status: "cancelled", name: "Larkspur Off" })),
        task("j-hold", job("j-hold", { status: "on_hold", name: "Larkspur Held" })),
      ],
      p: {},
      want: [["Larkspur Held", 1]],
    },
    {
      name: "a task not open draws nothing, and a job with none open draws no row",
      rows: [task("j-bay", bay, { status: "done" }), task("j-cat", cat), task("j-cat", cat, { status: "done" })],
      p: {},
      want: [["Catbird Rewire", 1]],
    },
    {
      name: "the job's name, never a bare number; the number only when it has no name",
      rows: [task("j-num", job("j-num", { name: null, job_number: "J-900" }))],
      p: {},
      want: [["J-900", 1]],
    },
  ];
  for (const c of table) {
    it(c.name, () => {
      const got = groupJobTasks(c.rows, { ...base, ...c.p });
      expect(got.map((g) => [g.label, g.tasks.length])).toEqual(c.want);
    });
  }

  it("each job's tasks are in its list's order: sort_order, then the order they were added", () => {
    const rows = [
      task("j-bay", bay, { title: "Third", sort_order: 2, created_at: "2026-11-01T00:00:00Z" }),
      task("j-bay", bay, { title: "Second", sort_order: 1, created_at: "2026-11-05T00:00:00Z" }),
      task("j-bay", bay, { title: "First", sort_order: 1, created_at: "2026-11-02T00:00:00Z" }),
    ];
    expect(groupJobTasks(rows, base)[0].tasks.map((t) => t.title)).toEqual(["First", "Second", "Third"]);
  });

  it("a read the bound cut makes only the last job read a floor", () => {
    const rows = [task("j-bay", bay), task("j-cat", cat), task("j-cat", cat)];
    const got = groupJobTasks(rows, { ...base, truncated: true });
    expect(got.map((g) => [g.jobId, g.floor])).toEqual([["j-bay", false], ["j-cat", true]]);
    expect(groupJobTasks(rows, base).every((g) => !g.floor)).toBe(true);
  });

  it("an embed read back as a one-element array is the same job", () => {
    const r = task("j-bay", bay);
    const arr = { ...r, jobs: [r.jobs as any] };
    expect(groupJobTasks([arr], base).map((g) => g.label)).toEqual(["Bayberry Subpanel"]);
  });
});

describe("the tech cut and the clocked-in job", () => {
  const mine = job("j-mine", { name: "Larkspur Kitchen", assigned_to: ["u-sam", "u-dana"] });
  const theirs = job("j-theirs", { name: "Bayberry Garage", assigned_to: ["u-dana"] });
  const nobody = job("j-nobody", { name: "Catbird Attic", assigned_to: [] });
  const rows = [task("j-mine", mine), task("j-theirs", theirs), task("j-nobody", nobody)];

  it("a tech sees only the jobs whose crew names him", () => {
    expect(groupJobTasks(rows, { ...base, techId: "u-sam" }).map((g) => g.jobId)).toEqual(["j-mine"]);
  });
  it("the office sees every job with an open task", () => {
    expect(groupJobTasks(rows, base).map((g) => g.jobId).sort()).toEqual(["j-mine", "j-nobody", "j-theirs"]);
  });
  it("the job on the reader's open punch is left out (its tasks are on the Now card)", () => {
    expect(groupJobTasks(rows, { ...base, currentJobId: "j-theirs" }).map((g) => g.jobId)).not.toContain("j-theirs");
    expect(groupJobTasks(rows, { ...base, techId: "u-sam", currentJobId: "j-mine" })).toEqual([]);
  });
});

describe("the section, rendered in both languages", () => {
  const kitchen = job("j1", { name: "Larkspur Kitchen" });
  const rows = [task("j1", kitchen, { title: "Hang the fixtures" }), task("j1", kitchen, { title: "Label the panel" })];
  const input = { read: { rows, truncated: false }, firstIds: [], currentJobId: null, techId: null };
  const en = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
  const es = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: el }));

  it("English: the heading, the job's name, its badge, a shut drop-down with check-off and All Tasks", () => {
    const html = en(createElement(JobTaskRows, { input }));
    expect(html).toContain("Job Tasks");
    expect(html).toContain("Larkspur Kitchen");
    expect(html).toMatch(/data-job-badge[^>]*>2<\/span>/);
    expect(html).toContain('aria-label="Larkspur Kitchen: 2 open tasks"');
    expect(html).toMatch(/<details class="group">/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain('href="/jobs/j1?tab=tasks"');
    expect(html).toContain("All Tasks");
    expect(html).toContain("Hang the fixtures");
    // Each task is a check-off button (the Now card's own row).
    expect(html).toContain(`aria-label="${fillText(dict("en").md_checkOffTask, { title: "Label the panel" })}"`);
  });

  it("Spanish: the same section in the reader's words", () => {
    const html = es(createElement(JobTaskRows, { input }));
    expect(html).toContain("Tareas de Trabajos");
    expect(html).toContain('aria-label="Larkspur Kitchen: 2 tareas abiertas"');
    expect(html).toContain("Todas las Tareas");
    expect(html).not.toContain("Job Tasks");
  });

  it("a failed read is said, in both languages, never drawn as no tasks", () => {
    const failed = { ...input, read: null };
    const text = (html: string) => html.replace(/&#x27;/g, "'");
    expect(text(en(createElement(JobTaskRows, { input: failed })))).toContain(dict("en").md_jobTasksFailed);
    expect(text(es(createElement(JobTaskRows, { input: failed })))).toContain(dict("es").md_jobTasksFailed);
  });

  it("no job with an open task: nothing at all", () => {
    expect(en(createElement(JobTaskRows, { input: { ...input, read: { rows: [], truncated: false } } }))).toBe("");
  });

  it("a floor says N+", () => {
    const html = en(createElement(JobTaskRows, { input: { ...input, read: { rows, truncated: true } } }));
    expect(html).toMatch(/data-job-badge[^>]*>2\+<\/span>/);
  });

  it("a read the bound cut says so in ONE plain grey line under the rows, Jobs linked, in both languages (skeptic #78)", () => {
    const cut = { ...input, read: { rows, truncated: true } };
    const text = (html: string) => html.replace(/<[^>]+>/g, "");
    const enHtml = en(createElement(JobTaskRows, { input: cut }));
    expect(text(enHtml)).toContain("More jobs have open tasks. Open Jobs to see them all.");
    expect(enHtml).toMatch(/<p data-job-tasks-more="true" class="[^"]*text-slate-500[^"]*">More jobs have open tasks\. Open <a [^>]*href="\/jobs"[^>]*>Jobs<\/a> to see them all\.<\/p>/);
    expect(enHtml).not.toMatch(/amber/);
    // Under the job rows, never above them.
    expect(enHtml.indexOf("data-job-tasks-more")).toBeGreaterThan(enHtml.indexOf("Larkspur Kitchen"));
    const esHtml = es(createElement(JobTaskRows, { input: cut }));
    expect(text(esHtml)).toContain("Hay más trabajos con tareas abiertas. Abre Trabajos para verlas todas.");
    expect(esHtml).toContain('href="/jobs"');
    expect(dict("en").md_jobTasksMore).toBe("More jobs have open tasks. Open {jobs} to see them all.");
    expect(dict("es").md_jobTasksMore).toBe("Hay más trabajos con tareas abiertas. Abre {jobs} para verlas todas.");
    // A read that was not cut says nothing of the kind.
    expect(en(createElement(JobTaskRows, { input }))).not.toContain("data-job-tasks-more");
  });

  it("the section sits at the foot of Tasks & Reminders, under the Reminders, and DoneMarks does not count it", () => {
    const reminder = { id: "r1", title: "Call the supplier", category: "operations", priority: 0, due_date: null, job_id: null, focus_date: null };
    const html = en(createElement(YourList, { rows: [reminder], subtasks: [], todayStr: "2026-11-21", doneToday: 0, restCount: 0, jobTasks: input }));
    expect(html.indexOf("Call the supplier")).toBeLessThan(html.indexOf("Job Tasks"));
    // One Reminder on the card: one mark, whatever the jobs hold.
    expect([...html.matchAll(/data-mark=/g)].length).toBe(1);
    // Without the prop the card is what it was.
    expect(en(createElement(YourList, { rows: [reminder], subtasks: [], todayStr: "2026-11-21", doneToday: 0, restCount: 0 }))).not.toContain("Job Tasks");
  });

  it("the words are in both catalogs, the heading Title Case", () => {
    expect(dict("en").md_jobTasks).toBe("Job Tasks");
    expect(dict("es").md_jobTasks).toBe("Tareas de Trabajos");
    expect(dict("en").md_jobTasksOpen).toBe("{job}: {n} open tasks");
    expect(dict("es").md_jobTasksOpen).toBe("{job}: {n} tareas abiertas");
  });
});

describe("NowTasks' cap: the Now card is unchanged, a job row draws more", () => {
  const next = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, title: `Step ${i + 1}` }));
  const count = (html: string) => [...html.matchAll(/>Step \d+</g)].length;
  it("no cap: three, or two under Buy Materials", () => {
    expect(count(renderToStaticMarkup(createElement(NowTasks, { jobId: "j1", left: 12, next })))).toBe(3);
    expect(count(renderToStaticMarkup(createElement(NowTasks, { jobId: "j1", left: 13, next, materials: { open: 2, href: "/materials/l1" } })))).toBe(2);
  });
  it("a job row's cap", () => {
    expect(count(renderToStaticMarkup(createElement(NowTasks, { jobId: "j1", left: 12, next, cap: JOB_ROW_CAP })))).toBe(JOB_ROW_CAP);
  });
});

describe("source pins: one read, no top number reads a job's task, nothing remounts", () => {
  const page = src("src/app/(app)/planner/page.tsx");
  const list = src("src/app/(app)/planner/your-list.tsx");
  const rowsSrc = src("src/app/(app)/planner/job-task-rows.tsx");

  it("ONE read of job tasks for the section, through the one open rule, with no money column", () => {
    const at = page.indexOf("A JOB'S OPEN TASKS for Tasks & Reminders' job rows");
    expect(at).toBeGreaterThan(0);
    const read = page.slice(at, page.indexOf("]);", at));
    expect([...read.matchAll(/from\("tasks"\)/g)].length).toBe(1);
    expect(read).toContain("whereJobTaskOpen(");
    expect(read).toContain("OPEN_TASK_JOB.replace(");
    expect(read).toContain('.select(`id, title, status, job_id, sort_order, created_at, ${OPEN_TASK_JOB.replace(/\\)$/, ", job_number, name, assigned_to)")}`');
    expect(read).toContain('(q as any).contains("jobs.assigned_to", [uid])');
    expect(read).not.toMatch(/total|amount|price|rate|cost/i);
    // Not one read per job: the page has exactly two open-rule task reads (the Now card's and this).
    expect([...page.matchAll(/whereJobTaskOpen\(/g)].length).toBe(2);
    // The section's read feeds the section only.
    expect([...page.matchAll(/jobTasksRead/g)].length).toBe(2);
  });

  it("the head counts, the rank and DoneMarks stay Reminders", () => {
    expect(page).toContain("const six = rankSix(sixPool, { todayStr });");
    expect(page).toContain("const restCount = Math.max(0, ((((restCountR as any)?.count as number | null) ?? 0) - six.length));");
    expect(page).toContain("const doneToday = (((doneTodayR as any)?.count as number | null) ?? 0);");
    expect(page).toContain('(q as any).is("job_id", null).or(');
    expect(list).toContain("const doneCount = doneToday + rows.filter((row) => slotDone(row)).length;");
    expect(list).toContain("<DoneMarks done={doneCount} total={doneToday + rows.length} />");
    expect(list.slice(0, list.indexOf("{jobTasks && <JobTaskRows"))).not.toMatch(/jobTasks\.|JobTaskRows input/);
    expect(src("src/lib/six-rank.ts")).not.toContain("job-task-rows");
  });

  it("the dock's dot and Needs You never read them", () => {
    for (const f of ["src/app/(app)/layout.tsx", "src/lib/action-items/query.ts"]) {
      const s = src(f);
      expect(s, f).not.toContain("job-task-rows");
      expect(s, f).not.toContain("groupJobTasks");
    }
  });

  it("a check-off never remounts the drop-down: one key, the job's id, and nothing keyed around it", () => {
    expect([...rowsSrc.matchAll(/\bkey=/g)].map((m) => rowsSrc.slice(m.index!, m.index! + 20))).toEqual(["key={g.jobId} group="]);
    expect(rowsSrc).toMatch(/<details className="group">/);
    expect(rowsSrc).not.toMatch(/<details[^>]*\bopen\b/);
    expect(rowsSrc).toContain("<NowTasks jobId={group.jobId} left={live} next={group.tasks} cap={JOB_ROW_CAP} onCheckedChange={setChecked} />");
    // The badge goes down with the tap: it is the list less what was checked.
    expect(rowsSrc).toContain("const live = group.tasks.filter((task) => !checked.has(task.id)).length;");
  });
});
