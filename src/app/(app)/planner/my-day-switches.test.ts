import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * MY DAY AND THE SWITCH BOARD (0352), and MY DAY'S ONE ADD LINE (0358). There is no Open Leads card
 * for anyone (a lead is a Needs You row, and the Sales tile's badge counts the new ones); the Daily
 * Reports card goes with Daily Reports once nothing is left to review (until then it stays, Off line
 * on top). The 6-field task box is gone: Today's 6 leads with one line ("Add A Reminder Or Task") and
 * an optional job chip, and asks no priority whatever To-Do Extras says (the switch is the Reminders
 * page's now). Everything on = My Day as it was otherwise.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/planner",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../tasks/actions", () => ({ createTask: vi.fn(), toggleTask: vi.fn(), deleteTask: vi.fn(), updateTask: vi.fn() }));

import { YourList, AddReminderLine } from "./your-list";
import { NewReminderBox } from "../tasks/tasks-view";

const JOBS = [{ id: "j1", label: "J-055 Smith Panel", number: "J-055" }];
const line = (jobs = JOBS) => renderToStaticMarkup(createElement(AddReminderLine, { jobs, todayStr: "2026-09-26", pinsFull: false, bumps: null }));

describe("Today's 6: the one Add line up top (Erik, 2026-09-26)", () => {
  it("one line, Title Case, 44px: type the words, an optional job chip, Add", () => {
    const html = line();
    expect(html).toContain('placeholder="Add A Reminder Or Task…"');
    expect(html).toContain('aria-label="Job (optional)"');
    expect(html).toContain("No Job: A Reminder For Me");
    expect(html).toContain("On J-055 Smith Panel");
    // 44px, all three: the input, the chip and the Add button.
    expect(html).toMatch(/<input[^>]*class="[^"]*h-11[^"]*"/);
    expect(html).toMatch(/<select[^>]*class="[^"]*h-11[^"]*"/);
    expect(html).toMatch(/<button[^>]*class="[^"]*h-11[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*Add<\/button>/);
  });

  it("no priority, no due date, no person: the 6 fields are gone", () => {
    const html = line();
    for (const gone of ['aria-label="Priority"', 'aria-label="Due date"', 'aria-label="Assigned to"', "Category"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("no jobs to offer: the line adds Reminders only (no empty chip)", () => {
    expect(line([])).not.toContain("Job (optional)");
  });

  it("the card is always there, even with nothing in the six, so a first Reminder has a place to go", () => {
    const html = renderToStaticMarkup(
      createElement(YourList, { six: [], subtasks: [], todayStr: "2026-09-26", doneToday: 0, restCount: 0, jobs: JOBS }),
    );
    expect(html).toContain("Today’s 6");
    expect(html).toContain("Add A Reminder Or Task");
    expect(html).toContain("Nothing urgent today.");
    expect(html).not.toContain("Grab One");
  });

  it("more Reminders than the six: All Reminders says how many and goes to /tasks", () => {
    const six = [{ id: "r1", title: "Call PUD", category: "office", priority: 0, due_date: "2026-09-26", job_id: null, pinned: false }];
    const html = renderToStaticMarkup(
      createElement(YourList, { six, subtasks: [], todayStr: "2026-09-26", doneToday: 0, restCount: 4, jobs: JOBS }),
    );
    // "For You": the count is the Reminders for this person; /tasks also lists the ones they made for others.
    expect(html).toContain("All Reminders · 4 More For You");
    expect(html).toContain('href="/tasks"');
  });
});

describe("the Reminders page's one-line add", () => {
  it("one line and Add, Title Case; no category, job, person, due date or priority", () => {
    const html = renderToStaticMarkup(createElement(NewReminderBox));
    expect(html).toContain('placeholder="Add A Reminder…"');
    expect(html).toContain("Add");
    for (const gone of ['aria-label="Priority"', 'aria-label="Due date"', 'aria-label="Job"', 'aria-label="Assigned to"', 'aria-label="Category"']) {
      expect(html).not.toContain(gone);
    }
  });
});

/** A source file with its comments taken out, so a pin reads what renders, not what a comment says. */
const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("My Day's cards (structural: the page is a server component over the database)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/planner/page.tsx"), "utf8");
  const pageCode = codeOf(page);

  it("no Open Leads card and no leads read, for any role or switch: leads are Needs You rows and the Sales badge", () => {
    expect(page).not.toContain('.from("inquiries")');
    expect(pageCode).not.toMatch(/Open leads/i);
    expect(pageCode).not.toContain('href="/leads"');
    expect(page).not.toContain("{isStaff && leadsOn ? (");
    // The switch is still read, because Needs You's rows hear it.
    expect(page).toContain('const leadsOn = featureOn(features, "leads");');
    expect(page).toContain("leadsOn={leadsOn}");
  });

  it("the Daily Reports card stays while a report waits for review, with the Off line on top", () => {
    expect(page).toContain("(reportsOn || reportsToReview > 0)");
    expect(page).toContain('<FeatureOffLine feature="daily_reports"');
  });

  it("the 6-field task box is gone from My Day, and Needs You hears every switch", () => {
    expect(page).not.toContain("NewTaskBox");
    expect(page).not.toContain('extras={featureOn(features, "todo_extras")}');
    expect(page).toContain("off: offFeatureKey(features)");
  });

  it("the Now block carries the clocked-in job's tasks, and only on the clock", () => {
    expect(page).toContain("{nowTasks && nowTasks.left > 0 && (");
    expect(page).toMatch(/currentJob\s*\?\s*supabase\s*\.from\("tasks"\)\s*\.select\("id, title", \{ count: "exact" \}\)\s*\.eq\("job_id", currentJob\.id\)/);
  });

  it("the Reminders page hears To-Do Extras", () => {
    const tasksPage = readFileSync(join(process.cwd(), "src/app/(app)/tasks/page.tsx"), "utf8");
    expect(tasksPage).toContain('extras={featureOn(sw.features, "todo_extras")}');
  });
});
