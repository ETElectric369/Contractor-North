import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE WHOLE CALENDAR, RENDERED (Wave 2 lane 1): the week and the day views of the real CalendarView,
 * with Everyone's Day's rows, a person who left, a past week's clocked time, a hollow day and a ghost.
 * Builders never run the app against the database (it talks to production), so this renders the page's
 * own component tree the way the server does, to prove the wiring end to end: the chips carry the day
 * rows, a past block shows its bars and its sentence (not the plan's chips), a booked day nobody worked
 * is hollow, work nobody booked is a dashed ghost the office can tap, the day drill carries the track
 * and the "Worked, Not Booked" row, and the To Schedule tray is gone.
 */
const nav = vi.hoisted(() => ({ params: new URLSearchParams("view=week") }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => "/schedule",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "" }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("../schedule/actions", () => ({}));
vi.mock("../appointments/actions", () => ({}));
vi.mock("../tasks/actions", () => ({}));
vi.mock("../leads/actions", () => ({}));
vi.mock("../jobs/actions", () => ({}));

import { CalendarView, type CalAppt, type CalJob } from "./calendar-view";
import { actualsFrom } from "@/lib/schedule/plan-vs-actual";
import { todayStrInTz, tzDateTimeUtc } from "@/lib/tz";
import { pillColorForPerson } from "@/lib/employee-color";
import { shortDay } from "@/lib/come-back-days";

const LA = "America/Los_Angeles";
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA) as string;
const TODAY = todayStrInTz(LA);
const dayOffset = (n: number) => {
  const t = new Date(`${TODAY}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
// A past weekday in this week's view or the one before is always drawn by the week stack (it starts two
// weeks back); the tests look at the markup, not at the day's name.
const PAST = dayOffset(-2);
const PAST2 = dayOffset(-3);
const PAST3 = dayOffset(-4);
const FUTURE = dayOffset(2);

const members = [
  { id: "p-erik", full_name: "Erik Taylor" },
  { id: "p-brian", full_name: "Brian Cole" },
];
const people = [...members, { id: "p-gone", full_name: "Dana Whitfield", active: false }];
const job = (over: Partial<CalJob>): CalJob => ({
  id: "j1",
  job_number: "J-001",
  name: "12 Elm St",
  status: "scheduled",
  scheduled_start: null,
  scheduled_end: null,
  planned_minutes: null,
  assigned_to: ["p-erik", "p-brian"],
  customers: { name: "Rita Moss" },
  address: "12 Elm St",
  city: "Truckee",
  ...over,
});
const jobs: CalJob[] = [
  // Worked past day: Erik 10 to 6 against a 9-to-5 block.
  job({ id: "j-worked", name: "12 Elm St", scheduled_start: at(PAST, "09:00"), scheduled_end: at(PAST, "17:00"), planned_minutes: 480 }),
  // Booked, and nobody went.
  job({ id: "j-hollow", name: "498 May Dell Lane", job_number: "J-002", scheduled_start: at(PAST2, "09:00"), scheduled_end: at(PAST2, "11:00"), planned_minutes: 120 }),
  // Upcoming, its crew moved by Everyone's Day; a person who left is on it.
  job({ id: "j-next", name: "22 Honeysuckle Way", job_number: "J-003", assigned_to: ["p-erik", "p-brian", "p-gone"], scheduled_start: at(FUTURE, "09:00"), scheduled_end: at(FUTURE, "11:00"), planned_minutes: 120 }),
];
const appointments: CalAppt[] = [];
const entryRows = [
  // Erik 10 to 6:30 with a 30 min lunch against a 9-to-5 block: the bar is 8.5 h of clock, the figure 8 h
  // worked — the ONE hours rule (lunch off), the number /timecards shows for the same shift (skeptic #55).
  {
    profile_id: "p-erik",
    job_id: "j-worked",
    clock_in: at(PAST, "10:00"),
    clock_out: at(PAST, "18:30"),
    lunch_minutes: 30,
    profiles: { full_name: "Erik Taylor" },
    job: { id: "j-worked", job_number: "J-001", name: "12 Elm St", customers: { name: "Rita Moss" } },
  },
  // Worked with nothing booked: a ghost.
  {
    profile_id: "p-brian",
    job_id: "j-ghost",
    clock_in: at(PAST3, "11:04"),
    clock_out: at(PAST3, "13:46"),
    profiles: { full_name: "Brian Cole" },
    job: { id: "j-ghost", job_number: "J-011", name: "5 Pine Rd", customers: { name: "Kim Hale" } },
  },
];
const { actuals } = actualsFrom(entryRows, LA, TODAY);
const dayRows = { [FUTURE]: [{ profile_id: "p-brian", work_date: FUTURE, kind: "off", job_id: null }] };

const render = (view: "week" | "day" | "month", date?: string, extra: Record<string, unknown> = {}) => {
  nav.params = new URLSearchParams(`view=${view}${date ? `&date=${date}` : ""}`);
  return renderToStaticMarkup(
    createElement(CalendarView, {
      jobs,
      segments: [],
      appointments,
      tasks: [],
      external: [],
      members,
      picker: { jobs: [], customers: [], staff: [] },
      now: new Date().toISOString(),
      tz: LA,
      workDayStart: "09:00",
      workDayEnd: "17:00",
      crewBoard: true,
      canEdit: true,
      perDayHours: true,
      addableJobs: [],
      dayRows,
      people,
      actuals,
      actualsCappedBefore: null,
      ...extra,
    }),
  );
};

describe("the week", () => {
  let html = "";
  beforeEach(() => {
    // The stack opens on the anchor's week and the next: anchored on the earliest past day, every day
    // here (four days back to two ahead) is drawn.
    html = render("week", PAST3);
  });

  it("an upcoming block carries its crew as that day leaves it: off struck through, someone who left named", () => {
    expect(html).toContain("Brian Cole · Off That Day");
    expect(html).toContain("Dana Whitfield · No Longer on the Team");
    expect(html).toContain(pillColorForPerson("p-erik").dot);
  });

  it("a past block shows what happened: its bars and its sentence, never the plan's chips", () => {
    expect(html).toContain('data-worked-bars="j-j-worked-' + PAST + '"');
    // Its title and label close with the sentence, and carry no crew as planned; since cn-v1151 the hours
    // WORKED that day follow the sentence (the box says more — lib/schedule/block-extras): the sentence is
    // the clock (10–6:30, 1.5h over), the figure the hours rule's 8 h with the lunch off.
    expect(html).toContain('title="12 Elm St · Rita Moss · Truckee · 9a–5p · Booked 9–5 · Erik 10–6:30 · 1h late · 1.5h over · 8 h worked"');
  });

  it("a booked day with no time clocked to it is hollow, and says only that", () => {
    // Not "Nobody clocked in": a punch with no job never reaches a block, so the block can't know.
    expect(html).toContain("Booked 9–11 · No time clocked to this job");
    expect(html).toContain("border-slate-300 bg-white/40 text-slate-500");
  });

  it("work nobody booked is a dashed ghost the office taps (one button, into the one sheet)", () => {
    expect(html).toMatch(/<button[^>]*aria-label="5 Pine Rd · worked, not booked · Brian 11:04 AM–1:46 PM"/);
    expect(html).toContain("border-2 border-dashed border-slate-400 bg-white/60 text-slate-700");
  });

  it("no To Schedule tray; the header's doors are 44px targets", () => {
    expect(html).not.toContain("To Schedule ·");
    const door = (html.match(/<a [^>]*href="\/schedule\?view=crew"[^>]*>/) ?? [""])[0];
    expect(door).toContain('aria-label="Everyone&#x27;s Day (crew board)"');
    expect(door).toMatch(/class="relative flex h-8 w-8[^"]*before:-inset-1\.5/);
  });

  it("the month draws the ghost as a dashed pill and the hollow day in its faint tone", () => {
    const month = render("month", PAST3);
    expect(month).toMatch(/border border-dashed border-slate-400 bg-white\/60 text-slate-700[^>]*>5 Pine Rd · Kim Hale</);
    expect(month).toMatch(/bg-white\/40 text-blue-400 ring-1 ring-inset ring-blue-200[^>]*>498 May Dell Lane · Rita Moss</);
  });
});

describe("the day drill", () => {
  it("a past day's card draws its track with the sentence", () => {
    const html = render("day", PAST);
    expect(html).toMatch(/role="img" aria-label="Booked 9–5 · Erik 10–6:30 · 1h late · 1.5h over"/);
  });

  it("a ghost's day carries the dashed Worked, Not Booked row with its two 44px doors", () => {
    const html = render("day", PAST3);
    expect(html).toContain("Worked, Not Booked");
    expect(html).toContain("5 Pine Rd · Kim Hale — Brian 11:04 AM–1:46 PM");
    expect(html).toMatch(/<a[^>]*href="\/jobs\/j-ghost"[^>]*>Open the Job<\/a>/);
    expect(html).toContain("Book This Day");
  });

  it("a failed clocked-time read says so in one quiet line, and no block is hollow", () => {
    const html = render("week", PAST3, { actuals: null });
    expect(html).toContain("Clocked time didn&#x27;t load, so today and past days show only what was booked.");
    expect(html).not.toContain("No time clocked to this job");
    expect(html).not.toContain("data-worked-bars");
  });

  it("a capped read: older weeks say how far back the clocked time loads, and are never hollow", () => {
    const html = render("week", PAST3, { actualsCappedBefore: TODAY });
    expect(html).toContain("Clocked time loads back to");
    expect(html).not.toContain("No time clocked to this job");
  });
});

/**
 * THE BOX SAYS MORE (cn-v1151; Erik: "on schedule im thinking we should also have totals of hours worked and
 * any job notes displayed in the space inside the box and closed and paid or if its open and needing attention
 * with the hold details etc"), rendered on the whole calendar: the hours line from the block's own bars and
 * the office's whole-job figure, the state line in its tone (on hold with the hold's details, done and paid or
 * a bill open — the office's line only), the note from the job's own words, a visit's state; and the week's
 * day header locks under the week line while the day view's does not. The rule itself is tabled in
 * lib/schedule/block-extras.test.ts; this proves the wiring through calendar-view.
 */
describe("the box says more (cn-v1151)", () => {
  const NEXT = dayOffset(1);
  const NEXT3 = dayOffset(3);
  const HOLD_BACK = dayOffset(5);
  const moreJobs: CalJob[] = [
    // Three hours (144px), so the hold's reason has a note line to draw in under the state (blockRows).
    job({ id: "j-hold", name: "7 Larkspur Ct", job_number: "J-004", status: "on_hold", hold_reason: "Waiting on the permit", hold_until: HOLD_BACK, customers: { name: "Sam Tillery" }, address: "7 Larkspur Ct", scheduled_start: at(NEXT, "09:00"), scheduled_end: at(NEXT, "12:00"), planned_minutes: 180 }),
    job({ id: "j-going", name: "3 Snowbell Rd", job_number: "J-005", status: "in_progress", notes: "Gate code 2580.\nDog in the yard.", customers: { name: "Dana Rook" }, address: "3 Snowbell Rd", scheduled_start: at(NEXT, "12:00"), scheduled_end: at(NEXT, "16:00"), planned_minutes: 240 }),
    job({ id: "j-paid", name: "9 Bayberry Ln", job_number: "J-006", status: "complete", invoices: [{ status: "paid" }, { status: "void" }], customers: { name: "Theo Vance" }, address: "9 Bayberry Ln", scheduled_start: at(NEXT3, "09:00"), scheduled_end: at(NEXT3, "11:00"), planned_minutes: 120 }),
    job({ id: "j-open", name: "11 Bayberry Ln", job_number: "J-007", status: "complete", invoices: [{ status: "paid" }, { status: "sent" }], description: "Service upgrade", customers: { name: "Theo Vance" }, address: "11 Bayberry Ln", scheduled_start: at(NEXT3, "12:00"), scheduled_end: at(NEXT3, "14:00"), planned_minutes: 120 }),
    // Today, booked 7 to 5: Brian clocked 7–8, and is back on the clock since 8:30.
    job({ id: "j-today", name: "5 Larkspur Ct", job_number: "J-008", status: "in_progress", assigned_to: ["p-brian"], customers: { name: "Sam Tillery" }, address: "5 Larkspur Ct", scheduled_start: at(TODAY, "07:00"), scheduled_end: at(TODAY, "17:00"), planned_minutes: 600 }),
  ];
  const visit = (over: Partial<CalAppt>): CalAppt => ({
    id: "v-done",
    type: "inspection",
    title: "Inspection: Sam Tillery",
    starts_at: at(PAST, "08:00"),
    ends_at: at(PAST, "10:00"),
    status: "completed",
    job_id: null,
    customer_id: null,
    location: "7 Larkspur Ct, Truckee, CA 96161",
    notes: "Bring the ladder.",
    assigned_to: "p-erik",
    ...over,
  });
  const moreVisits: CalAppt[] = [
    visit({}),
    visit({ id: "v-pick", type: "quote", title: "Quote: Dana Rook", status: "proposed", starts_at: at(NEXT3, "14:00"), ends_at: at(NEXT3, "16:00"), notes: null, location: "3 Snowbell Rd, Truckee, CA 96161" }),
  ];
  const { actuals: moreActuals } = actualsFrom(
    [
      ...entryRows,
      { profile_id: "p-brian", job_id: "j-today", clock_in: at(TODAY, "07:00"), clock_out: at(TODAY, "08:00"), profiles: { full_name: "Brian Cole" }, job: { id: "j-today", job_number: "J-008", name: "5 Larkspur Ct", customers: { name: "Sam Tillery" } } },
      { profile_id: "p-brian", job_id: "j-today", clock_in: at(TODAY, "08:30"), clock_out: null, profiles: { full_name: "Brian Cole" }, job: { id: "j-today", job_number: "J-008", name: "5 Larkspur Ct", customers: { name: "Sam Tillery" } } },
    ],
    LA,
    TODAY,
  );
  const more = (extra: Record<string, unknown> = {}, view: "week" | "day" = "week", date = PAST3) =>
    render(view, date, { jobs: [...jobs, ...moreJobs], appointments: moreVisits, actuals: moreActuals, hoursByJob: { "j-worked": 22 }, ...extra });

  it("a job on hold draws On Hold · the day it comes back in amber, SHORT, and its reason as the first line of the note (skeptic #55)", () => {
    const html = more();
    // The state line is one `truncate` line in a week column: the reason never rides on it to be cut short.
    expect(html).toContain(`<div class="truncate font-semibold text-amber-700">On Hold · Back ${shortDay(HOLD_BACK)}</div>`);
    expect(html).not.toContain("On Hold · Waiting on the permit");
    // The reason draws as the note, in whole lines (a three-hour block has room for it under the state).
    expect(html).toMatch(/style="-webkit-line-clamp:\d+">Waiting on the permit<\/div>/);
    // And the title carries it all: the state, then the reason.
    expect(html).toContain(`· On Hold · Back ${shortDay(HOLD_BACK)} · Waiting on the permit"`);
  });

  it("a done job for the office: Done · Paid when every live bill is paid, Done · Bill Open when one is out; a tech's says Done alone", () => {
    const office = more();
    expect(office).toContain('<div class="truncate font-semibold text-emerald-700">Done · Paid</div>');
    expect(office).toContain('<div class="truncate font-semibold text-emerald-700">Done · Bill Open</div>');
    const tech = more({ canEdit: false });
    expect(tech).toContain('<div class="truncate font-semibold text-emerald-700">Done</div>');
    expect(tech).not.toContain("Paid");
    expect(tech).not.toContain("Bill Open");
  });

  it("a job in progress says so, plain, and its Notes are the note, drawn in whole lines; a job with no Notes carries its Description in its title", () => {
    const html = more();
    expect(html).toContain('<div class="truncate font-semibold opacity-80">In Progress</div>');
    expect(html).toMatch(/style="-webkit-line-clamp:\d+">Gate code 2580\.\nDog in the yard\.<\/div>/);
    expect(html).toContain("· Done · Bill Open · Service upgrade");
  });

  it("the hours line: the day's hours WORKED (the hours rule, lunch off), then the office's whole-job figure, one basis; a punch still running says on the clock", () => {
    const html = more();
    // 10 to 6:30 on the clock (the sentence and the bars), 8 h worked with the 30 min lunch off (the figure):
    // the same 8 h /timecards shows, on one basis with the 22 h on the job beside it.
    expect(html).toContain("· Erik 10–6:30 · 1h late · 1.5h over · 8 h worked · 22 h on the job");
    expect(html).toContain('<div class="truncate tabular-nums">8 h worked · 22 h on the job</div>');
    expect(html).not.toContain("8.5 h");
    expect(html).not.toContain("h clocked");
    expect(html).toContain("1 h worked · on the clock");
    // No figure handed in (a tech, or a read that was cut): the day's hours alone, never a short number.
    expect(more({ hoursByJob: {} })).toContain("· 1.5h over · 8 h worked");
    expect(more({ hoursByJob: {} })).not.toContain("on the job");
  });

  it("the office's whole-job figure dropped (its read cut or failed) is SAID on each week line; nothing when it was not (skeptic #55)", () => {
    const line = '<span class="block text-[11px] font-normal text-slate-500">Hours on the job are not shown this time: more shifts than this page counts.</span>';
    const dropped = more({ hoursByJob: {}, jobHoursDropped: true });
    expect(dropped).toContain(line);
    // Once per week line, inside the stuck line (the same place the clocked-time cap is said).
    expect(dropped.split(line).length - 1).toBeGreaterThanOrEqual(2);
    expect(dropped).not.toContain("on the job</div>");
    expect(more()).not.toContain("Hours on the job are not shown");
    expect(more({ hoursByJob: {} })).not.toContain("Hours on the job are not shown");
  });

  it("a visit: Done when completed, Pending Pick while the customer picks, its notes as the note", () => {
    const html = more();
    expect(html).toContain('<div class="truncate font-semibold text-emerald-700">Done</div>');
    expect(html).toContain('<div class="truncate font-semibold text-amber-700">Pending Pick</div>');
    expect(html).toContain("Inspection: Sam Tillery · 7 Larkspur Ct · Truckee · 8a–10a · Crew: Erik Taylor · Done · Bring the ladder.");
  });

  it("the week's day header locks under the week line (stickyHeader, at the measured top); the day view's does not", () => {
    const week = more();
    expect(week).toContain('class="overflow-x-hidden bg-white sticky z-[15]" style="top:var(--grid-stick-top, 0px)"');
    // The week line is still the stuck line above it, inside the host div the hook measures against.
    expect(week).toMatch(/<div class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-clip"><div><div class="sticky top-0 z-20 border-b/);
    const day = more({}, "day", NEXT);
    expect(day).toContain(`On Hold · Back ${shortDay(HOLD_BACK)}`);
    expect(day).toContain("Waiting on the permit");
    expect(day).not.toContain("sticky z-[15]");
    expect(day).not.toContain("--grid-stick-top");
  });
});
