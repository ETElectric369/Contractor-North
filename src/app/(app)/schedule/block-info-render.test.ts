import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE BLOCK SAYS WHERE AND WHO, rendered on the real components (Erik, 2026-09-28: "we definitly need
 * the address showing up on the job block with info too"): the schedule's grid block by its height,
 * the day drill's card, the rail's card, and My Day's rows read the same words; a small block drops
 * lines whole and in order, never cut; the crew is initials or a dashed Nobody; no money anywhere.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("./actions", () => ({
  setJobContact: vi.fn(),
  setJobHold: vi.fn(),
  sizeAppointment: vi.fn(),
  sizeJob: vi.fn(),
  placeAppointmentOnDay: vi.fn(),
  placeJobOnDay: vi.fn(),
  planDayTimes: vi.fn(),
}));
vi.mock("../leads/actions", () => ({ setLeadContact: vi.fn(), sizeLead: vi.fn(), scheduleLeadsOnDay: vi.fn() }));
vi.mock("../jobs/actions", () => ({ setJobStatus: vi.fn() }));

import { TimeGrid, type TimeGridEvent } from "@/components/time-grid";
import { JobScheduleCard } from "./job-schedule-card";
import { PlaceRail } from "./place-rail";
import { tzDateTimeUtc } from "@/lib/tz";

const LA = "America/Los_Angeles";
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const block = (minutes: number, crew: TimeGridEvent["info"] extends infer I ? (I extends { crew?: infer C } ? C : never) : never = [{ id: "p-erik", initials: "ET", name: "Erik Taylor" }]) =>
  ({
    id: `j-${minutes}`,
    dayStr: "2026-09-28",
    startMin: 600,
    endMin: 600 + minutes,
    label: "Seiler · 3-way switches",
    info: { place: "123 Main St", town: "Truckee", time: "10a–12p", crew },
    color: "border-slate-300 bg-slate-200/80 text-slate-800",
    href: "/jobs/j058",
  }) as TimeGridEvent;
const grid = (e: TimeGridEvent, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(TimeGrid, {
      days: [{ dayStr: "2026-09-28", label: "Mon 28" }],
      events: [e],
      workStartMin: 540,
      workEndMin: 1020,
      tz: LA,
      ...extra,
    }),
  );

describe("a grid block, by its height", () => {
  it("two hours: the name, the street, the crew, the time and the town", () => {
    const t = text(grid(block(120)));
    for (const w of ["Seiler · 3-way switches", "123 Main St", "ET", "10a–12p", "Truckee"]) expect(t).toContain(w);
  });

  it("an hour: the name, the street and the crew; a half hour: the name alone (but its title says it all)", () => {
    const hour = grid(block(60));
    expect(text(hour)).toContain("123 Main St");
    expect(text(hour)).toContain("ET");
    expect(text(hour)).not.toContain("10a–12p");
    const half = grid(block(30));
    expect(text(half)).not.toContain("123 Main St");
    expect(half).toContain('title="Seiler · 3-way switches · 123 Main St · Truckee · 10a–12p · Crew: Erik Taylor"');
  });

  it("nobody on it is a dashed Nobody; the block never grows past its time (overflow is clipped, lines are whole)", () => {
    const html = grid(block(120, []));
    expect(html).toMatch(/<span[^>]*border-dashed[^>]*>Nobody<\/span>/);
    const pill = html.match(/<a [^>]*href="\/jobs\/j058"[^>]*>/)?.[0] ?? "";
    expect(pill).toContain("height:96px");
    expect(pill).toContain('class="absolute overflow-hidden rounded-md');
  });

  it("with the office's tap, the block opens its sheet and says what it holds", () => {
    const html = grid({ ...block(120), tapId: "job:j058" }, { onEventTap: () => {} });
    expect(html).toMatch(/<button[^>]*aria-label="Seiler · 3-way switches · 123 Main St · Truckee · 10a–12p · Crew: Erik Taylor: day, time and crew"/);
  });
});

describe("the day drill's card", () => {
  const card = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(JobScheduleCard, {
        job: {
          id: "j058",
          name: "Seiler · 3-way switches",
          job_number: "J-058",
          status: "scheduled",
          scheduled_start: at("2026-09-28", "10:00"),
          scheduled_end: at("2026-09-28", "12:00"),
          planned_minutes: null,
          assigned_to: ["p-erik"],
          customers: { name: "Rich Seiler" },
          address: "123 Main St",
          city: "Truckee",
          ...over,
        },
        members: [{ id: "p-erik", full_name: "Erik Taylor" }],
        tz: LA,
        workDay: { start: "09:00", end: "17:00" },
        day: "2026-09-28",
        onOpen: () => {},
      }),
    );

  it("the street and the town small, the time, the crew's initials", () => {
    const t = text(card());
    expect(t).toContain("123 Main St");
    expect(t).toContain("· Truckee");
    expect(t).toContain("10:00 AM – 12:00 PM · 2 hours — change it");
    expect(card()).toMatch(/title="Erik Taylor"[^>]*>ET</);
  });

  it("a job named for its street reads who instead of the street twice", () => {
    const t = text(card({ name: "123 Main St", customers: { name: "Rich Seiler" } }));
    expect(t).toContain("Rich Seiler");
    expect(t.match(/123 Main St/g)?.length).toBe(1);
  });

  it("a job whose name already says who (and has no street) reads no J-number in its place: only its town", () => {
    const named = { name: "Jackie Burks · Panel Upgrade", customers: { name: "Jackie Burks" }, address: null };
    const t = text(card(named));
    expect(t).not.toContain("J-058");
    expect(t).toContain("Truckee");
    expect(t).not.toContain("· Truckee");
    expect(t.match(/Jackie Burks/g)?.length).toBe(1);
    const bare = text(card({ ...named, city: null }));
    expect(bare).not.toContain("J-058");
  });

  it("a day that keeps its own hours reads them", () => {
    const html = renderToStaticMarkup(
      createElement(JobScheduleCard, {
        job: {
          id: "j011",
          name: "Herringbone",
          job_number: "J-011",
          status: "in_progress",
          scheduled_start: at("2026-09-24", "09:00"),
          scheduled_end: at("2026-09-28", "17:00"),
          planned_minutes: null,
          assigned_to: [],
          customers: null,
        },
        members: [],
        tz: LA,
        workDay: { start: "09:00", end: "17:00" },
        day: "2026-09-28",
        dayHours: { start: "12:00", end: "17:00" },
        onOpen: () => {},
      }),
    );
    expect(text(html)).toContain("12:00 PM – 5:00 PM · 5 hours");
    expect(html).toMatch(/border-dashed[^>]*>Nobody</);
  });
});

describe("the rail's card", () => {
  it("a job reads its name, then who (its name is its street), then its crew; a visit its street and its one person", () => {
    const html = renderToStaticMarkup(
      createElement(PlaceRail, {
        items: [
          {
            id: "j1",
            kind: "job",
            name: "498 Mil Drae Lane",
            address: "498 Mil Drae Lane",
            city: "Truckee",
            customer: "Jackie Burks",
            crew: [{ id: "p-erik", initials: "ET", name: "Erik Taylor" }],
            status: "to_be_scheduled",
          },
          {
            id: "a1",
            kind: "appointment",
            name: "Site inspection: Rita Moss",
            address: "12 Elm St, Testville, CA 96161",
            city: null,
            customer: "Rita Moss",
            crew: [],
          },
        ],
        todayStr: "2026-09-28",
      }),
    );
    const t = text(html);
    expect(t).toContain("498 Mil Drae Lane");
    expect(t).toContain("Jackie Burks");
    expect(t.match(/498 Mil Drae Lane/g)?.length).toBe(1);
    expect(html).toMatch(/title="Erik Taylor"[^>]*>ET</);
    expect(t).toContain("12 Elm St");
    expect(t).not.toContain("CA 96161");
    expect(html).toMatch(/border-dashed[^>]*>Nobody</);
  });
});

describe("My Day's rows and the schedule read the same words, with no money", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  const code = (f: string) =>
    read(f)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");

  it("My Day's job rows: the place line, that day's block (its own hours), the crew; visits likewise; the company's clock", () => {
    const src = read("src/app/(app)/planner/page.tsx");
    expect(src).toContain("...jobRowInfo(j, todayStr, ownToday.get(j.id)?.get(todayStr) ?? null)");
    expect(src).toContain("...visitRowInfo(a)");
    expect(src).toContain("<CrewInitials crew={i.crew} />");
    expect(src).toContain("const fmtTime = (iso: string) => formatTime(iso, tz);");
    expect(src).toMatch(/placeLine\(\{ name: j\.name, street: j\.address, customer: j\.customers\?\.name \}\)/);
  });

  it("the calendar's blocks carry the place, the time and the crew; the rail's cards carry who and the crew", () => {
    const view = read("src/app/(app)/calendar/calendar-view.tsx");
    expect(view).toMatch(/info: \{\s*place: placeLine\(\{ name: job\.name, street: job\.address/);
    // The crew as that day's Everyone's Day rows leave it (the day row wins; lib/schedule/block-info);
    // a past day judged shows what happened instead (Wave 2, SV-actual).
    expect(view).toContain("crew: judged ? null : jobCrewOn(job, k)");
    expect(view).toContain("crewChips(job.assigned_to, team, { rows: dayRows[day], jobId: job.id, jobNames, people })");
    expect(view).toContain("dayHours: ownHours.get(job.id)?.get(k) ?? null");
    const page = read("src/app/(app)/schedule/page.tsx");
    expect(page).toContain("crew: crewChips((r as unknown as { assigned_to?: string[] | null }).assigned_to ?? [], team)");
  });

  it("a visit with no place of its own says its job's street on the grid and the day drill, as My Day does", () => {
    const panel = read("src/app/(app)/schedule/calendar-panel.tsx");
    expect(panel).toContain("jobs(job_number, name, address), customers(name)");
    const view = code("src/app/(app)/calendar/calendar-view.tsx");
    expect(view).toContain("street: streetOf(visitPlace(a))");
    expect(view).toContain("town: townOf(visitPlace(a))");
    expect(view).toContain("const place = visitPlace(a);");
    expect(view).not.toMatch(/\{a\.location && \(/);
    expect(code("src/app/(app)/planner/page.tsx")).toContain("street: streetOf(visitPlace(a))");
  });

  it("a dateless job's card says where and who like every other tile, never the job number (its home since the tray was cut, W2-05)", () => {
    // The To Schedule tray is gone: every job it held waits on the rail, whose card reads the same words.
    const view = code("src/app/(app)/calendar/calendar-view.tsx");
    expect(view).not.toContain("To Schedule ·");
    const page = read("src/app/(app)/schedule/page.tsx");
    expect(page).toMatch(/const RAIL_JOB_COLS = "id, job_number, name, address, city, planned_minutes, status, hold_reason, assigned_to, scheduled_start, customers\(name, phone, email\)"/);
    const rail = code("src/app/(app)/schedule/place-rail.tsx");
    expect(rail).toContain("const place = placeLine({ name: i.name, street: i.address, customer: i.customer });");
    expect(rail).toContain("<CrewInitials crew={i.crew} />");
    expect(rail).not.toContain("job_number");
  });

  it("no price, amount, total, cost or rate on any of them", () => {
    for (const f of [
      "src/lib/schedule/block-info.ts",
      "src/components/crew-initials.tsx",
      "src/components/time-grid.tsx",
      "src/app/(app)/schedule/job-schedule-card.tsx",
    ]) {
      expect(code(f), f).not.toMatch(/\b(prices?|amounts?|totals?|costs?|rates?|bill_rate|pay_rate)\b|formatCurrency|\$\d/i);
    }
  });
});
