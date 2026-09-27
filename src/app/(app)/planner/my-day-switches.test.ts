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
// The Now card punches through the clock's actions and opens the clock's Which Job sheet; rendered only.
vi.mock("../timeclock/actions", () => ({ clockIn: vi.fn(), clockOut: vi.fn() }));
vi.mock("../timeclock/which-job-actions", () => ({ whichJobChoices: vi.fn(), putPunchOnJob: vi.fn() }));

import { YourList, AddReminderLine, LATER_CHOICE, addDaysStr, laterRow, movedWords } from "./your-list";
import { NewReminderBox } from "../tasks/tasks-view";
import { NowCard } from "./now-card";
import { LUNCH_LABEL } from "@/lib/lunch-rule";

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

describe("Today's 6: the polish (six marks, 44px steps, one ⋯ per row)", () => {
  const six = [
    { id: "r1", title: "Call PUD", category: "office", priority: 0, due_date: "2026-09-26", job_id: null, pinned: false },
    { id: "r2", title: "Order the meter base", category: "field", priority: 1, due_date: null, job_id: null, pinned: true },
  ];
  const subtasks = [{ id: "s1", title: "Find the account number", status: "open", parent_id: "r1" }];
  const render = (doneToday: number) =>
    renderToStaticMarkup(createElement(YourList, { six, subtasks, todayStr: "2026-09-26", doneToday, restCount: 0, jobs: JOBS }));

  it("six small marks beside the title, one filled for each done today: a progress mark, not a count", () => {
    const html = render(2);
    const header = html.slice(0, html.indexOf("Add A Reminder Or Task"));
    expect(header).toContain("Today’s 6");
    expect(header).toContain('aria-label="2 of 6 done today"');
    expect(header.match(/data-mark="done"/g)).toHaveLength(2);
    expect(header.match(/data-mark="open"/g)).toHaveLength(4);
    expect(html).not.toMatch(/\d\/6/);
    // Never more than six, never a badge pill.
    expect(render(9).match(/data-mark="done"/g)).toHaveLength(6);
    expect(header).not.toContain("rounded-full");
  });

  it("a step's check row is 44px, like every other target", () => {
    const html = render(0);
    expect(html).toMatch(/<button type="button" class="flex min-h-\[44px\] w-full[^"]*"[^>]*aria-label="Mark Find the account number done"/);
    expect(html).not.toContain("min-h-[36px]");
  });

  it("each Reminder's ⋯ is the app's one row sheet: 44px, named for its row", () => {
    const html = render(0);
    expect(html).toMatch(/<button type="button" aria-label="More For Call PUD"[^>]*class="[^"]*h-11 w-11/);
    expect(html).toMatch(/aria-label="More For Order the meter base"/);
    const src = readFileSync(join(process.cwd(), "src/app/(app)/planner/your-list.tsx"), "utf8");
    expect(src).toContain('import { RowMoreSheet, SheetLink, SHEET_ROW } from "@/components/row-more-sheet";');
    expect(src).not.toMatch(/const SHEET_ROW\s*=/);
    // Open goes to the Reminders page without closing the sheet first (SheetLink).
    expect(src).toContain("<SheetLink href={taskHref(t)}>Open</SheetLink>");
    expect(src).not.toContain("onClick={close}");
  });
});

describe("nothing goes quiet without a day: In A Week, not Someday (Erik's open question, the plan's pick)", () => {
  it("the sheet's later row is In A Week, due seven days out on the company's day", () => {
    expect(LATER_CHOICE).toBe("in_a_week");
    expect(laterRow(LATER_CHOICE, "2026-09-26")).toEqual({ label: "In A Week", due: "2026-10-03" });
    expect(addDaysStr("2026-12-29", 7)).toBe("2027-01-05");
    // One line flips it back.
    expect(laterRow("someday", "2026-09-26")).toEqual({ label: "Someday (Clear Date)", due: null });
    const src = readFileSync(join(process.cwd(), "src/app/(app)/planner/your-list.tsx"), "utf8");
    expect(src).toContain("{later.label}");
    expect(src).toContain("updateTask(t.id, { due_date: later.due }, opts)");
  });

  it("a Reminder that leaves the six says where it went; a pin, or a day of today or earlier, needs no word", () => {
    const today = "2026-09-26";
    expect(movedWords({ pinned: false }, "2026-09-27", today)).toBe("Due tomorrow. It waits on your Reminders list till then.");
    expect(movedWords({ pinned: false }, "2026-10-03", today)).toBe("Due Oct 3, 2026. It waits on your Reminders list till then.");
    expect(movedWords({ pinned: true }, "2026-10-03", today)).toBeNull();
    expect(movedWords({ pinned: false }, today, today)).toBeNull();
    expect(movedWords({ pinned: false }, null, today)).toBe("No due date now. It waits on your Reminders list under Someday.");
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

  it("the decision inbox is called Needs You (Nort's words and the morning push say it too, same release)", () => {
    expect(pageCode).toContain('<h2 className="text-sm font-semibold text-slate-900">Needs You</h2>');
    expect(pageCode).not.toMatch(/Needs action/i);
    // Its list is untouched here: ActionList's props and the one getActionItems call stay as they are.
    expect(pageCode).toContain("<ActionList items={visibleActions} people={people} todayStr={todayStr} tz={tz} leadsOn={leadsOn} />");
    expect(pageCode).toContain('getActionItems({ todayStr, isStaff, userId: user?.id ?? "", tz, off: offFeatureKey(features) })');
    expect(pageCode.match(/getActionItems\(/g)).toHaveLength(1);
    // Show All is a 44px door too.
    expect(pageCode).toMatch(/className="flex min-h-11 items-center justify-center border-t[^"]*"\s*>\s*Show All/);
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

  it("the Now card carries the clocked-in job's tasks, and only on the clock", () => {
    expect(page).toContain("{nowTasks && nowTasks.left > 0 && (");
    expect(page).toMatch(/currentJob\s*\?\s*supabase\s*\.from\("tasks"\)\s*\.select\("id, title", \{ count: "exact" \}\)\s*\.eq\("job_id", currentJob\.id\)/);
  });

  it("ONE Now card at the top, for every role: no separate clock card, Now block or Which Job block", () => {
    expect(pageCode.match(/<NowCard\b/g)).toHaveLength(1);
    expect(pageCode).not.toContain("MyDayClock");
    expect(pageCode).not.toContain("<WhichJob entryId=");
    // The job's name is the one link to the job: the separate Open door is cut. (A week-view day
    // with nothing on it still reads "Open", as a line, not a door.)
    expect(pageCode).not.toMatch(/<Link[^>]*>\s*Open\s*<\/Link>/);
    expect(pageCode.match(/>\s*Open\s*</g) ?? []).toEqual(['>Open<']);
    expect(pageCode).toContain('<p className="px-5 py-2 text-xs text-slate-300">Open</p>');
  });

  it("the job's doors render on the server inside the card; Add Cost only inside isStaff &&", () => {
    const card = pageCode.slice(pageCode.indexOf("<NowCard"), pageCode.indexOf("</NowCard>"));
    expect(card).toContain("<NavLink");
    expect(card).toContain("href={currentMaterialsHref}");
    expect(card).toMatch(/\{isStaff && \(\s*<QuickCostButton[^>]*snapFirst/);
    expect(pageCode.match(/<QuickCostButton/g)).toHaveLength(1);
    expect(card).toContain("<NowTasks");
    // Two columns for a tech, three for the office (two below ~360px).
    expect(card).toContain('isStaff ? "grid-cols-2 min-[360px]:grid-cols-3" : "grid-cols-2"');
    // Nothing priced crosses into the client card: its job prop is a name, a line and an href.
    expect(pageCode).toMatch(/job=\{\s*currentJob\s*\?\s*\{\s*name: jobLabel\(currentJob\),\s*sub: [^\n]+\n\s*href: `\/jobs\/\$\{currentJob\.id\}`,\s*\}/);
  });

  it("the Today card's header: no doors for the office, the tech's own Week link at 44px", () => {
    const header = pageCode.slice(pageCode.indexOf('<CalendarCheck className="h-4 w-4 text-brand" /> Today'), pageCode.indexOf("Nothing else on the schedule today."));
    expect(header).not.toMatch(/isStaff && <AppointmentButton/);
    expect(header).not.toContain("<AppointmentButton");
    expect(pageCode).not.toContain('"/schedule?view=week" : "/planner?view=week"');
    // The Week link is the tech's, and only the tech's.
    expect(header).toMatch(/\{!isStaff && \(\s*<Link\s+href="\/planner\?view=week"\s+className="[^"]*min-h-11[^"]*px-2[^"]*"/);
    expect(pageCode.match(/Week →/g)).toHaveLength(1);
    // The office still reaches both: THE week redirect stays, New Appointment stays on the + menu
    // (lane 3's file) and the Schedule tile stays on the dock (lane 1b's file).
    expect(page).toContain('if (view === "week" && isStaff) redirect("/schedule?view=week");');
    expect(readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8")).toContain('"New Appointment"');
    const dock = readFileSync(join(process.cwd(), "src/lib/dock.ts"), "utf8");
    expect(dock).toContain('key: "schedule"');
    expect(dock).toContain('label: "Schedule"');
  });

  it("the tech's week pages at 44px too", () => {
    for (const label of ["Previous week", "Next week"]) {
      expect(pageCode).toMatch(new RegExp(`aria-label="${label}"\\s*className="flex h-11 w-11 `));
    }
    expect(pageCode).toMatch(/<Link href="\/planner\?view=week" className="inline-flex min-h-11 [^"]*">\s*This Week/);
  });

  it("the quote sits below the Now card, then the office's Daily Reports, then the Today card", () => {
    const nowAt = pageCode.indexOf("</NowCard>");
    const quoteAt = pageCode.indexOf("{dailyQuote}");
    const reportsAt = pageCode.indexOf("Daily reports");
    const todayAt = pageCode.indexOf('<CalendarCheck className="h-4 w-4 text-brand" /> Today');
    expect(nowAt).toBeGreaterThan(0);
    expect(quoteAt).toBeGreaterThan(nowAt);
    expect(reportsAt).toBeGreaterThan(quoteAt);
    expect(todayAt).toBeGreaterThan(reportsAt);
    // The Today card keeps its honest empty line when the only job today is the one you're on.
    expect(page).toContain('empty(currentJob ? "Nothing else on the schedule today." : "Nothing left on the schedule today.")');
  });

  it("the Reminders page hears To-Do Extras", () => {
    const tasksPage = readFileSync(join(process.cwd(), "src/app/(app)/tasks/page.tsx"), "utf8");
    expect(tasksPage).toContain('extras={featureOn(sw.features, "todo_extras")}');
  });
});

describe("the Now card (rendered)", () => {
  const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const punch = (over: Record<string, unknown> = {}) => ({ id: "p1", clock_in: at(2), notes: null, onJob: true, ...over });
  const job = { name: "J-055 Smith Panel", sub: "Nora Smith · 85 Whitney", href: "/jobs/j55" };
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(NowCard, { userId: "u1", ...props } as any, createElement("div", null, "THE-DOORS")));

  it("on the clock with a job: Now and the timer, the name as the one link, customer · address, the doors, then the footer", () => {
    const html = render({ open: punch(), job });
    expect(html).toContain(">Now<");
    expect(html).toMatch(/tabular-nums[^>]*>\d+:\d{2}:\d{2}</);
    expect(html).toMatch(/<a[^>]*href="\/jobs\/j55"[^>]*>J-055 Smith Panel<\/a>/);
    expect(html.match(/href="\/jobs\/j55"/g)).toHaveLength(1);
    expect(html).toContain("Nora Smith · 85 Whitney");
    expect(html).not.toMatch(/>\s*Open\s*</);
    // Top to bottom: the name, the doors, the lunch box, Timeclock, Clock Out.
    const order = ["J-055 Smith Panel", "THE-DOORS", LUNCH_LABEL, ">Timeclock<", "Clock Out"].map((w) => html.indexOf(w));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Every door on the card is 44px, the Timeclock link included.
    expect(html).toMatch(/<a[^>]*class="[^"]*min-h-11[^"]*"[^>]*href="\/timeclock"|<a[^>]*href="\/timeclock"[^>]*class="[^"]*min-h-11/);
    expect(html).toMatch(/<label[^>]*class="[^"]*min-h-11[^"]*"[^>]*>/);
    // The old one-liner is cut.
    expect(html).not.toContain("On the clock ·");
    // The job's name is 44px to the thumb too (py-2 on a 28px line, the margins given back).
    expect(html).toMatch(/<a class="[^"]*\bpy-2\b[^"]*" href="\/jobs\/j55">/);
  });

  it("the footer wraps rather than covers: a wide button takes its own line, never over Timeclock", () => {
    const card = readFileSync(join(process.cwd(), "src/app/(app)/planner/now-card.tsx"), "utf8");
    expect(card).toContain('className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-brand/20 px-5 py-2"');
    expect(card).toContain('className="flex min-w-[8.5rem] flex-1 flex-wrap items-center gap-x-4"');
    expect(card.match(/className="ml-auto /g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(card).toMatch(/className="ml-auto shrink-0">\s*\{pending/);
  });

  it("a forgotten clock: Set When You Stopped REPLACES Clock Out, and goes to Timeclock", () => {
    const html = render({ open: punch({ clock_in: at(13) }), job });
    expect(html).toContain("Set When You Stopped");
    expect(html).not.toContain("Clock Out");
    expect(html).toMatch(/<a[^>]*href="\/timeclock"[^>]*>(?:(?!<\/a>)[\s\S])*Set When You Stopped/);
    // After a Switch Job the twelve hours count from the SHIFT's start, not the running part's.
    expect(render({ open: punch({ clock_in: at(1), shift_start: at(13) }), job })).toContain("Set When You Stopped");
  });

  it("on the clock with no job: the timer, the question and ONE Pick The Job; no job doors", () => {
    const html = render({ open: punch({ onJob: false }), job: null });
    expect(html).toContain("Which job are you on?");
    expect(html.match(/Pick The Job/g)).toHaveLength(1);
    expect(html).not.toContain("THE-DOORS");
    expect(html).toContain("Clock Out");
    expect(html).toContain(LUNCH_LABEL);
  });

  it("a punch on a job the page couldn't read says so instead of asking which job", () => {
    const html = render({ open: punch({ onJob: true }), job: null });
    expect(html).not.toContain("Pick The Job");
    expect(html).toContain("Your punch is on a job this page couldn’t load just now. Timeclock shows it.");
  });

  it("off the clock: Not Clocked In, a big Clock In and the Timeclock link", () => {
    const html = render({ open: null, job: null });
    expect(html).toContain("Not Clocked In");
    expect(html).toMatch(/<button[^>]*class="[^"]*h-12[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*Clock In<\/button>/);
    expect(html).toContain('href="/timeclock"');
    expect(html).not.toContain("THE-DOORS");
  });

  it("the held line and the offline line keep their exact words (the shell's offline drain keeps the promise)", () => {
    const card = readFileSync(join(process.cwd(), "src/app/(app)/planner/now-card.tsx"), "utf8");
    expect(card).toContain("Clocked in — saved on your phone at the right time, and it&rsquo;ll file itself when you have signal.");
    expect(card).toContain('const OFFLINE_MSG = "No connection — try again when you have bars.";');
    // Queue first, then the live punch; each punch's warning is toasted and kept until it is read.
    expect(card.indexOf('await enqueue("time.clockIn"')).toBeLessThan(card.indexOf("await clockIn("));
    expect(card.match(/if \(res\.warning\) toast\(res\.warning, "info", undefined, \{ sticky: true \}\);/g)).toHaveLength(2);
  });
});
