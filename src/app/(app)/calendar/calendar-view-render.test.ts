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
  job({ id: "j-hollow", name: "498 Mil Drae Lane", job_number: "J-002", scheduled_start: at(PAST2, "09:00"), scheduled_end: at(PAST2, "11:00"), planned_minutes: 120 }),
  // Upcoming, its crew moved by Everyone's Day; a person who left is on it.
  job({ id: "j-next", name: "22 Herringbone Way", job_number: "J-003", assigned_to: ["p-erik", "p-brian", "p-gone"], scheduled_start: at(FUTURE, "09:00"), scheduled_end: at(FUTURE, "11:00"), planned_minutes: 120 }),
];
const appointments: CalAppt[] = [];
const entryRows = [
  {
    profile_id: "p-erik",
    job_id: "j-worked",
    clock_in: at(PAST, "10:00"),
    clock_out: at(PAST, "18:00"),
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
    expect(html).toContain("Dana Whitfield · No Longer On The Team");
    expect(html).toContain(pillColorForPerson("p-erik").dot);
  });

  it("a past block shows what happened: its bars and its sentence, never the plan's chips", () => {
    expect(html).toContain('data-worked-bars="j-j-worked-' + PAST + '"');
    // Its title and label close with the sentence, and carry no crew as planned.
    expect(html).toContain('title="12 Elm St · Rita Moss · Truckee · 9a–5p · Booked 9–5 · Erik 10–6 · 1h late · 1h over"');
  });

  it("a booked day nobody worked is hollow", () => {
    expect(html).toContain("Booked 9–11 · Nobody clocked in");
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
    expect(month).toMatch(/bg-white\/40 text-blue-400 ring-1 ring-inset ring-blue-200[^>]*>498 Mil Drae Lane · Rita Moss</);
  });
});

describe("the day drill", () => {
  it("a past day's card draws its track with the sentence", () => {
    const html = render("day", PAST);
    expect(html).toMatch(/role="img" aria-label="Booked 9–5 · Erik 10–6 · 1h late · 1h over"/);
  });

  it("a ghost's day carries the dashed Worked, Not Booked row with its two 44px doors", () => {
    const html = render("day", PAST3);
    expect(html).toContain("Worked, Not Booked");
    expect(html).toContain("5 Pine Rd · Kim Hale — Brian 11:04 AM–1:46 PM");
    expect(html).toMatch(/<a[^>]*href="\/jobs\/j-ghost"[^>]*>Open The Job<\/a>/);
    expect(html).toContain("Book This Day");
  });

  it("a failed clocked-time read says so in one quiet line, and no block is hollow", () => {
    const html = render("week", PAST3, { actuals: null });
    expect(html).toContain("Clocked time didn&#x27;t load, so past days show only what was booked.");
    expect(html).not.toContain("Nobody clocked in");
    expect(html).not.toContain("data-worked-bars");
  });

  it("a capped read: older weeks say how far back the clocked time loads, and are never hollow", () => {
    const html = render("week", PAST3, { actualsCappedBefore: TODAY });
    expect(html).toContain("Clocked time loads back to");
    expect(html).not.toContain("Nobody clocked in");
  });
});
