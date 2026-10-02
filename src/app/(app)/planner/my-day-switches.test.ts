import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * MY DAY AND THE SWITCH BOARD (0352), and MY DAY'S ONE ADD LINE (0358). There is no Open Leads card
 * for anyone (a lead is a Needs You row, and the Sales tile's badge counts the new ones); the Daily
 * Reports card goes with Daily Reports once nothing is left to review (until then it stays, Off line
 * on top). The 6-field task box is gone: Tasks & Reminders leads with one line ("Add A Reminder Or
 * Task") and an optional job chip, and asks no priority whatever To-Do Extras says (the switch is the
 * Reminders page's now). Everything on = My Day as it was otherwise.
 *
 * RENAMED AND UNCAPPED for Erik's report of 2026-09-30 (/planner): the card is "Tasks & Reminders"
 * ("instead of todayy's 6 lets not limit it and call it something more clear like Tasks & Reminders"),
 * the Add line no longer stamps a pin, and a pin carries past midnight instead of disappearing ("the
 * tasks keep disappearing even the pinned ones").
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

import { YourList, AddReminderLine, LATER_CHOICE, PROGRESS_MARKS, addDaysStr, laterRow, movedWords, type SixSlot } from "./your-list";
import { NewReminderBox } from "../tasks/tasks-view";
import { NowCard } from "./now-card";
import { codeOnly } from "@/lib/migration-body.test-util";
import { LUNCH_LABEL } from "@/lib/lunch-rule";
import { carriedDay, rankSix } from "@/lib/six-rank";

/** Every shipped source file in a tree — the app's own code, never a test or a fixture. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(p) && !/\.(test|db-suite|db-fixture)\.tsx?$/.test(p) && !/\.d\.ts$/.test(p) ? [p] : [];
  });
}

const JOBS = [{ id: "j1", label: "J-055 Smith Panel", number: "J-055" }];
const line = (jobs = JOBS) => renderToStaticMarkup(createElement(AddReminderLine, { jobs, todayStr: "2026-09-26" }));
const TODAY = "2026-09-26";
/** A row as the server hands it over: focus_date as-is, no pre-chewed "pinned" flag. */
const row = (over: Partial<SixSlot> = {}): SixSlot => ({
  id: "r1",
  title: "Call PUD",
  category: "office",
  priority: 0,
  due_date: null,
  job_id: null,
  focus_date: null,
  ...over,
});

describe("Tasks & Reminders: the one Add line up top (Erik, 2026-09-26)", () => {
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

  it("the card is always there, even with nothing on it, so a first Reminder has a place to go", () => {
    const html = renderToStaticMarkup(
      createElement(YourList, { rows: [], subtasks: [], todayStr: TODAY, doneToday: 0, restCount: 0, jobs: JOBS }),
    );
    expect(html).toContain("Tasks &amp; Reminders");
    expect(html).toContain("Add A Reminder Or Task");
    expect(html).toContain("Nothing urgent today.");
    expect(html).not.toContain("Grab One");
  });

  it("HIS NAME FOR IT: no \"Today's 6\" and no number left in the heading (Erik, 2026-09-30)", () => {
    const html = renderToStaticMarkup(
      createElement(YourList, { rows: [row({ due_date: TODAY })], subtasks: [], todayStr: TODAY, doneToday: 0, restCount: 0, jobs: JOBS }),
    );
    expect(html).toContain("Tasks &amp; Reminders");
    expect(html).not.toContain("Today’s 6");
    expect(html).not.toContain("Today's 6");
    expect(html).not.toMatch(/of 6 done today/);
  });

  it("the Add line never claims a pin it didn't write, and doesn't write one", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/planner/your-list.tsx"), "utf8");
    // Part B: a typed reminder is created WITHOUT focus_date — it is visible because the card now
    // shows plain undated Reminders, not because something stamped a pin on it that then expired.
    expect(src).toContain("createTask(job ? { title, job_id: job.id } : { title, today: todayStr })");
    expect(src).not.toContain("{ title, focus_date: todayStr }");
    expect(src).toContain('toast("Added To Tasks & Reminders", "success")');
    expect(src).not.toMatch(/Reminder added and pinned/);
  });

  it("Reminders the card isn't showing: All Reminders says how many and goes to /tasks", () => {
    const html = renderToStaticMarkup(
      createElement(YourList, { rows: [row({ due_date: TODAY })], subtasks: [], todayStr: TODAY, doneToday: 0, restCount: 4, jobs: JOBS }),
    );
    // "For You": the count is the Reminders for this person; /tasks also lists the ones they made for others.
    expect(html).toContain("All Reminders · 4 More For You");
    expect(html).toContain('href="/tasks"');
  });
});

describe("Tasks & Reminders: a carried pin says so on the row (Erik, 2026-09-30)", () => {
  const draw = (focus_date: string | null) =>
    renderToStaticMarkup(
      createElement(YourList, {
        rows: [row({ title: "Order the meter base", category: "field", focus_date })],
        subtasks: [],
        todayStr: TODAY,
        doneToday: 0,
        restCount: 0,
        jobs: JOBS,
      }),
    );

  it("a pin from an earlier day wears Carried From <Day>, in Title Case, and keeps the pin glyph", () => {
    const html = draw("2026-09-25");
    expect(html).toContain("Carried From Yesterday");
    expect(html).toMatch(/lucide-pin/);
  });

  it("today's pin wears the glyph and NO carried chip", () => {
    const html = draw(TODAY);
    expect(html).not.toContain("Carried From");
    expect(html).toMatch(/lucide-pin/);
  });

  it("no pin at all: neither", () => {
    const html = draw(null);
    expect(html).not.toContain("Carried From");
    expect(html).not.toMatch(/lucide-pin/);
  });

  it("the chip and the glyph are gated the SAME way the flag and the due chip are (one gate, one function)", () => {
    // The gate itself is lib/six-rank's carriedPin, proven behaviourally in pin-carries.test.ts and
    // through a real render in tasks/tasks-view.test.ts. On THIS card the done-ness is the optimistic
    // local state of a checked row, which a static render can't reach (no DOM in the unit project), so
    // what is pinned here is that the card asks the one function and gates the glyph with it.
    const src = readFileSync(join(process.cwd(), "src/app/(app)/planner/your-list.tsx"), "utf8");
    expect(src).toContain("const carried = carriedPin(t, todayStr, done);");
    expect(src).toContain("const pinned = isPinned(t.focus_date, todayStr) && !done;");
    expect(src).not.toContain("const carried = pinCarriedFrom(t.focus_date, todayStr);");
  });

  it("the words stay true as the carry gets older: Yesterday, then the weekday, then the date", () => {
    expect(carriedDay("2026-09-25", TODAY)).toBe("Yesterday");
    expect(carriedDay("2026-09-21", TODAY)).toBe("Monday");
    // Past six days back a bare weekday would be a lie (three Mondays ago also reads "Monday").
    expect(carriedDay("2026-09-12", TODAY)).toBe("Sep 12, 2026");
  });
});

describe("Tasks & Reminders: the polish (progress marks, 44px steps, one ⋯ per row)", () => {
  const rows = [
    row({ id: "r1", due_date: TODAY }),
    row({ id: "r2", title: "Order the meter base", category: "field", priority: 1, focus_date: TODAY }),
  ];
  const subtasks = [{ id: "s1", title: "Find the account number", status: "open", parent_id: "r1" }];
  const render = (doneToday: number) =>
    renderToStaticMarkup(createElement(YourList, { rows, subtasks, todayStr: TODAY, doneToday, restCount: 0, jobs: JOBS }));

  it("one mark per thing on the day, filled for each done: the total is the DAY's, never a hard 6", () => {
    const html = render(2);
    const header = html.slice(0, html.indexOf("Add A Reminder Or Task"));
    expect(header).toContain("Tasks &amp; Reminders");
    // 2 done + 2 open on the card = 4 marks, 2 filled. It used to be six marks whatever the day held.
    expect(header).toContain('aria-label="2 of 4 done today"');
    expect(header.match(/data-mark="done"/g)).toHaveLength(2);
    expect(header.match(/data-mark="open"/g)).toHaveLength(2);
    expect(html).not.toMatch(/\d\/\d/);
    expect(header).not.toContain("rounded-full");
  });

  it("a long day abbreviates the marks but the label still carries the TRUE total", () => {
    const html = renderToStaticMarkup(
      createElement(YourList, {
        rows: Array.from({ length: 20 }, (_, i) => row({ id: `x${i}`, title: `Thing ${i}`, due_date: TODAY })),
        subtasks: [],
        todayStr: TODAY,
        doneToday: 5,
        restCount: 0,
        jobs: JOBS,
      }),
    );
    const header = html.slice(0, html.indexOf("Add A Reminder Or Task"));
    expect(header).toContain('aria-label="5 of 25 done today"');
    expect((header.match(/data-mark=/g) ?? []).length).toBe(PROGRESS_MARKS);
    // All twenty rows are DRAWN — only the marks abbreviate (Erik: "lets not limit it").
    expect(html).toContain("Thing 19");
  });

  it("nothing done and nothing open: no marks at all (zero means no badge)", () => {
    const html = renderToStaticMarkup(
      createElement(YourList, { rows: [], subtasks: [], todayStr: TODAY, doneToday: 0, restCount: 0, jobs: JOBS }),
    );
    expect(html).not.toContain("data-mark=");
  });

  it("a step's check row is 44px, like every other target", () => {
    const html = render(0);
    expect(html).toMatch(/<button type="button" class="flex min-h-\[44px\] w-full[^"]*"[^>]*aria-label="Mark Find the account number done"/);
    expect(html).not.toContain("min-h-[36px]");
  });

  it("the pin row says what the pin does: it carries until you unpin it", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/planner/your-list.tsx"), "utf8");
    expect(src).toContain('{pinned ? "Unpin" : "Pin To Top (Carries Until You Unpin It)"}');
    expect(src).not.toContain("Unpin From Today");
  });

  /**
   * AND NOWHERE ELSE IN src EITHER. This used to grep your-list.tsx alone, and the retired words
   * survived in five other files — a type's doc comment still promising the midnight expiry, three
   * comments still calling the card Today's 6, and the page comment that still put the quote under
   * the Now card after it was moved above the clock. A comment that lies is how the next person
   * rebuilds the bug.
   */
  it("NO FILE IN src STILL DESCRIBES THE OLD BEHAVIOUR: no midnight expiry, no Today's 6", () => {
    const files = sourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThan(500); // it really is the whole app
    const expiry: string[] = [];
    const oldName: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!/self-expir|Today'?s[- ]?6\b|today'?s six/i.test(src)) continue;
      src.split("\n").forEach((ln, i) => {
        const at = `${relative(process.cwd(), f)}:${i + 1}`;
        if (/self-expir/i.test(ln)) expiry.push(at);
        // The retired NAME survives in exactly one place: inside Erik's own quoted words, which are
        // the history of why the card is called what it is called now.
        if (/Today'?s[- ]?6\b|today'?s six/i.test(ln) && !/Erik/.test(ln)) oldName.push(at);
      });
    }
    expect(expiry, "a pin does not expire at midnight any more").toEqual([]);
    expect(oldName, 'the card is "Tasks & Reminders" — the old name only inside his own quote').toEqual([]);
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

  it("a Reminder that leaves the card says where it went; a pin, or a day of today or earlier, needs no word", () => {
    const today = "2026-09-26";
    const plain = { focus_date: null, priority: 0, category: "general" };
    expect(movedWords(plain, "2026-09-27", today)).toBe("Due tomorrow. It waits on your Reminders list till then.");
    expect(movedWords(plain, "2026-10-03", today)).toBe("Due Oct 3, 2026. It waits on your Reminders list till then.");
    // A PIN keeps it on the card whatever the date — including a pin from an earlier day, which is
    // the whole point of the carry (it used to be dropped silently at midnight).
    expect(movedWords({ ...plain, focus_date: today }, "2026-10-03", today)).toBeNull();
    expect(movedWords({ ...plain, focus_date: "2026-09-20" }, "2026-10-03", today)).toBeNull();
    expect(movedWords(plain, today, today)).toBeNull();
    // Clearing the date no longer SILENCES an ordinary Reminder: the last rank shows it, so claiming
    // "it waits under Someday" would be a lie, and this says nothing instead.
    expect(movedWords(plain, null, today)).toBeNull();
    // A flagged Reminder with a future day never ranks, so it does leave the card and says so.
    expect(movedWords({ ...plain, priority: 1 }, "2026-10-03", today)).toBe("Due Oct 3, 2026. It waits on your Reminders list till then.");
  });

  it("the only Reminder a cleared date still sends quiet is an OFFICE one, and it says so", () => {
    const today = "2026-09-26";
    const due = laterRow("someday", today).due;
    expect(due).toBeNull();
    const someday = "No due date now. It waits on your Reminders list under Someday.";
    expect(movedWords({ focus_date: null, priority: 1, category: "office" }, due, today)).toBe(someday);
    expect(movedWords({ focus_date: null, priority: 0, category: "office" }, due, today)).toBe(someday);
    // The rank agrees — these words ASK it (ranksToday), so they can't drift from it.
    const base = { id: "r1", status: "open", due_date: null, focus_date: null, priority: 1, category: "general", job_id: null, parent_id: null };
    expect(rankSix([base], { todayStr: today }).map((r) => r.id)).toEqual(["r1"]);
    expect(rankSix([{ ...base, priority: 0 }], { todayStr: today }).map((r) => r.id)).toEqual(["r1"]);
    expect(rankSix([{ ...base, category: "office" }], { todayStr: today })).toEqual([]);
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
    // ONE call for both lists (the shell's badge shares its fan-out).
    expect(pageCode).toContain('getActionItems({ todayStr, isStaff, userId: user?.id ?? "", tz, off: offFeatureKey(features) })');
    expect(pageCode.match(/getActionItems\(/g)).toHaveLength(1);
  });

  it("Needs You is whole (no five-row cut, no Show All), with the Waiting fold under it (Wave 1, NY-list)", () => {
    expect(pageCode).toMatch(
      /<ActionList\s+items=\{needsYou\.now\}\s+people=\{people\}\s+todayStr=\{todayStr\}\s+tz=\{tz\}\s+leadsOn=\{leadsOn\}\s+isStaff=\{isStaff\}\s+textReady=\{textReady\}/,
    );
    expect(pageCode).toContain("<WaitingFold items={needsYou.waiting} />");
    for (const gone of ["slice(0, 5)", "actions=all", "Show All", "visibleActions", "showAllActions"]) expect(pageCode, gone).not.toContain(gone);
    // The card is drawn when either list has something; its pill is the open count, and none at zero.
    expect(pageCode).toContain("{(needsYou.now.length > 0 || needsYou.waiting.length > 0) && (");
    expect(pageCode).toMatch(/\{needsYou\.now\.length > 0 && \(\s*<span className="rounded-full bg-amber-100[^"]*">\{needsYou\.now\.length\}<\/span>/);
    // The Send sheet's Text It hears the company's texting, read once on the page.
    expect(pageCode).toContain("const textReady = smsReadiness(");
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

  it("the quote sits ABOVE the clock (Erik, 2026-09-30), then the Now card, the office's Daily Reports, the Today card", () => {
    // "move the quote of the day up over time clock". It used to sit UNDER the Now card, so the first
    // thing he read on opening the app was a running timer.
    const quoteAt = pageCode.indexOf("{dailyQuote}");
    const nowOpensAt = pageCode.indexOf("<NowCard");
    const nowAt = pageCode.indexOf("</NowCard>");
    const reportsAt = pageCode.indexOf("Daily reports");
    const todayAt = pageCode.indexOf('<CalendarCheck className="h-4 w-4 text-brand" /> Today');
    expect(quoteAt).toBeGreaterThan(0);
    expect(nowOpensAt).toBeGreaterThan(quoteAt);
    expect(nowAt).toBeGreaterThan(nowOpensAt);
    expect(reportsAt).toBeGreaterThan(nowAt);
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
  const punch = (over: Record<string, unknown> = {}) => ({ id: "p1", clock_in: at(2), notes: null, job_id: "j55", ...over });
  const job = { name: "J-055 Smith Panel", sub: "Nora Smith · 41 Larkspur", href: "/jobs/j55" };
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(NowCard, { userId: "u1", ...props } as any, createElement("div", null, "THE-DOORS")));

  it("on the clock with a job: Now and the timer, the name as the one link, customer · address, the doors, then the footer", () => {
    const html = render({ open: punch(), job });
    expect(html).toContain(">Now<");
    expect(html).toMatch(/tabular-nums[^>]*>\d+:\d{2}:\d{2}</);
    expect(html).toMatch(/<a[^>]*href="\/jobs\/j55"[^>]*>J-055 Smith Panel<\/a>/);
    expect(html.match(/href="\/jobs\/j55"/g)).toHaveLength(1);
    expect(html).toContain("Nora Smith · 41 Larkspur");
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
    const html = render({ open: punch({ job_id: null }), job: null });
    expect(html).toContain("Which job are you on?");
    expect(html.match(/Pick The Job/g)).toHaveLength(1);
    expect(html).not.toContain("THE-DOORS");
    expect(html).toContain("Clock Out");
    expect(html).toContain(LUNCH_LABEL);
  });

  it("a punch on a job the page couldn't read says so instead of asking which job", () => {
    const html = render({ open: punch({ job_id: "j55" }), job: null });
    expect(html).not.toContain("Pick The Job");
    expect(html).toContain("Your punch is on a job this page couldn’t load just now. Timeclock shows it.");
  });

  /**
   * THE PUNCH CARRIES ITS JOB'S ID, NOT A BOOLEAN (Erik, 2026-10-01). NowPunch said only `onJob:
   * true`, so the card could not ask clock-told's staleness rule whether the remembered "the app
   * picked that" sentence is still true of the punch on screen — and it did not ask: it drew the
   * line raw. After the office re-pointed the punch from Timecards, the banner updated to the new job
   * while the sentence under it named the old one, with a Change door that then refused as stale.
   */
  it("the card is handed the job the punch is ON, so the app-picked sentence can be checked against it", () => {
    const card = codeOnly(readFileSync(join(process.cwd(), "src/app/(app)/planner/now-card.tsx"), "utf8"));
    expect(card, "NowPunch carries the job id the staleness rule needs").toMatch(/job_id\??: string \| null/);
    expect(card, "no boolean stand-in for the job on the punch").not.toContain("onJob");
    // And the card asks the rule instead of drawing what it remembered.
    expect(card, "the card checks the sentence against the punch on screen").toMatch(/noticeOnScreen\(\s*chose/);
    expect(card, "and hands the punch to the notice, which checks it again").toMatch(/punch=\{open\}/);
    // And it reaches the card: the planner page hands over the open entry's job_id.
    const page = readFileSync(join(process.cwd(), "src/app/(app)/planner/page.tsx"), "utf8");
    expect(page).toContain("job_id: openEntry.job_id ?? null");
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
