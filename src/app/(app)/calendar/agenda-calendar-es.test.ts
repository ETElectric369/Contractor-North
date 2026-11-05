import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE CALENDAR SURFACE IN SPANISH (the agenda-in-Spanish wave, lib/words/agenda-calendar ag_cal_). Each
 * screen rendered inside a LangProvider with "es": its doors in Title Case ("Quitar La Fecha"), one
 * sentence, one date or time in es-US ("jue, 5 nov", "10:00 a. m."). The English renders (no provider)
 * stay in their own tests, untouched: tile-sheet.test, calendar-view-render.test, block-info-render.test.
 */
const nav = vi.hoisted(() => ({ params: new URLSearchParams("view=day&date=2026-11-05") }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => "/schedule",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "" }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("../schedule/actions", () => ({
  clearJobDate: vi.fn(),
  moveJobDay: vi.fn(),
  setJobTimes: vi.fn(),
  setJobDayTimes: vi.fn(),
  setVisitTimes: vi.fn(),
  changeJobCrew: vi.fn(),
  bookWorkedDay: vi.fn(),
  unbookWorkedDay: vi.fn(),
}));
vi.mock("../appointments/actions", () => ({
  rescheduleAppointment: vi.fn(),
  setAppointmentAssignee: vi.fn(),
  unscheduleAppointment: vi.fn(),
}));
vi.mock("../tasks/actions", () => ({}));
vi.mock("../leads/actions", () => ({}));
vi.mock("../jobs/actions", () => ({}));

import { LangProvider } from "@/components/lang-provider";
import { CalendarView, type CalJob } from "./calendar-view";
import { TileSheetBody, type TileTarget } from "../schedule/tile-sheet";
import { GhostRow, GhostSheetBody } from "../schedule/ghost-sheet";
import { JobScheduleCard } from "../schedule/job-schedule-card";
import { TimeGrid } from "@/components/time-grid";
import { MoveToDay } from "@/components/move-to-day";
import { JobsMap } from "@/components/jobs-map";
import { CrewInitials } from "@/components/crew-initials";
import { RowMoreSheet } from "@/components/row-more-sheet";
import { mergePeople } from "@/lib/schedule/plan-vs-actual";
import { todayStrInTz, tzDateTimeUtc } from "@/lib/tz";

const LA = "America/Los_Angeles";
const WORK_DAY = { start: "09:00", end: "17:00" };
const DAY = "2026-11-05"; // a Thursday
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA) as string;
const team = [
  { id: "p-larkspur", full_name: "Lara Larkspur" },
  { id: "p-snowbell", full_name: "Sam Snowbell" },
];
const es = (el: ReactElement) => renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: el }));
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

const bayberry = (over: Partial<Extract<TileTarget, { kind: "job" }>["job"]> = {}): TileTarget => ({
  kind: "job",
  day: DAY,
  job: {
    id: "j-bayberry",
    name: "14 Bayberry Ln",
    status: "scheduled",
    scheduled_start: at(DAY, "10:00"),
    scheduled_end: at(DAY, "12:00"),
    planned_minutes: null,
    assigned_to: ["p-larkspur"],
    customers: { name: "Thistlewood" },
    ...over,
  },
});
const sheet = (target: TileTarget, canEdit = true) =>
  es(createElement(TileSheetBody, { target, tz: LA, workDay: WORK_DAY, team, canEdit, onClose: () => {} }));

describe("the tile's sheet in Spanish", () => {
  it("a job: its doors Title Case, its time in a. m./p. m., its crew sentence", () => {
    const html = sheet(bayberry());
    const t = text(html);
    expect(html).toMatch(/<a[^>]*href="\/jobs\/j-bayberry"[^>]*>Abrir El Trabajo<\/a>/);
    for (const door of ["Quitar La Fecha", "Mover", "Día Completo"]) expect(t).toContain(door);
    for (const heading of ["Día", "Hora", "Cuadrilla", "Inicio", "Fin"]) expect(t).toContain(heading);
    expect(t).toContain("10:00 a. m. – 12:00 p. m. · 2 horas — cámbialo");
    expect(t).toContain("Todo el trabajo, cada día.");
    expect(html).toContain('aria-label="Hora de inicio"');
    expect(html).toContain('aria-label="2 horas"');
    expect(t).not.toMatch(/Clear The Date|Open The Job|Full Day|Start time/);
  });

  it("a job's day kept as its own: This Day in one sentence, its date in es-US", () => {
    const html = sheet({ ...bayberry({ scheduled_end: at("2026-11-07", "12:00") }), dayHours: { start: "12:00", end: "17:00" } } as TileTarget);
    // The sheet reads This Day only once 0370 is applied; without the switch it is the job's time.
    const per = es(
      createElement(TileSheetBody, { target: { ...bayberry({ scheduled_end: at("2026-11-07", "12:00") }), dayHours: { start: "12:00", end: "17:00" } } as TileTarget, tz: LA, workDay: WORK_DAY, team, canEdit: true, perDayHours: true, onClose: () => {} }),
    );
    expect(text(per)).toMatch(/Este Día, jue, 5 (de )?nov: sus propias horas\. Los otros días del trabajo mantienen las suyas\./);
    expect(text(per)).toContain("Usar Las Horas Del Trabajo");
    expect(text(html)).toMatch(/cada día hasta sáb, 7 (de )?nov/);
  });

  it("a visit: Quién Va, Nadie lit, Abrir La Visita", () => {
    const visit: TileTarget = {
      kind: "visit",
      day: DAY,
      visit: { id: "v-catbird", title: "Inspection: Catbird", status: "scheduled", starts_at: at(DAY, "09:00"), ends_at: null, assigned_to: null },
    };
    const html = sheet(visit);
    expect(text(html)).toContain("Quién Va");
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*border-dashed[^>]*>Nadie<\/button>/);
    expect(html).toMatch(/<a[^>]*href="\/appointments\/v-catbird"[^>]*>Abrir La Visita<\/a>/);
    expect(html).toContain('aria-label="Quién va"');
  });
});

describe("the ghost (work nobody booked) in Spanish", () => {
  const ghost = {
    jobId: "j-catbird",
    name: "5 Catbird Ct",
    jobNumber: "J-011",
    customer: "Snowbell",
    people: mergePeople([{ profileId: "p-snowbell", name: "Sam Snowbell", jobId: "j-catbird", dayStr: "2026-09-25", startMin: 11 * 60 + 4, endMin: 13 * 60 + 46 }], (m) => m),
  };
  it("its sheet: Agendar Este Día, Abrir El Trabajo, the sentence in Spanish with a. m./p. m.", () => {
    const html = es(createElement(GhostSheetBody, { day: "2026-09-25", ghost, canEdit: true, onClose: () => {} }));
    const t = text(html);
    expect(t).toContain("Agendar Este Día");
    expect(t).toContain("Abrir El Trabajo");
    expect(t).toContain("No se agendó nada este día.");
    expect(t).toMatch(/11:04 a\. m\./);
  });
  it("today's row: Trabajado, Sin Agendar, and when it can be booked", () => {
    const t = text(es(createElement(GhostRow, { day: "2026-09-25", ghost, canEdit: true, today: true })));
    expect(t).toContain("Trabajado, Sin Agendar");
    expect(t).toContain("Agéndalo cuando termine el día.");
  });
});

describe("the day drill's card, the grid, the chips, the map, the ⋯ and Move To Day in Spanish", () => {
  it("a job's card: its status badge and its 44px door in Spanish", () => {
    const html = es(
      createElement(JobScheduleCard, {
        job: { id: "j-bayberry", name: "14 Bayberry Ln", job_number: "J-020", status: "scheduled", scheduled_start: null, scheduled_end: null, assigned_to: [], customers: null },
        members: team,
        tz: LA,
        workDay: WORK_DAY,
        day: DAY,
        onOpen: () => {},
      }),
    );
    expect(text(html)).toContain("Programado");
    expect(text(html)).toContain("Día trabajado · aún sin día planeado");
    expect(html).toContain('aria-label="14 Bayberry Ln: día, hora y cuadrilla"');
    expect(html).toMatch(/border-dashed[^>]*>Nadie</);
  });

  it("the grid: hoy, todo el día, the hours in a. m./p. m., Agregar A La Agenda", () => {
    const html = es(
      createElement(TimeGrid, {
        days: [{ dayStr: DAY, label: "jue 5", isToday: true }],
        events: [{ id: "e1", dayStr: DAY, startMin: 600, endMin: 720, label: "14 Bayberry Ln", color: "x" }],
        allDay: [{ id: "a1", dayStr: DAY, label: "Thistlewood", color: "x" }],
        workStartMin: 540,
        workEndMin: 1020,
        tz: LA,
        onSlotTap: () => {},
      }),
    );
    expect(text(html)).toContain("hoy");
    expect(text(html)).toContain("todo el día");
    expect(text(html)).toContain("8 a. m.");
    expect(text(html)).toContain("1 p. m.");
    expect(html).toContain('aria-label="Agregar A La Agenda, jue 5"');
    expect(html).toContain('title="Agregar A La Agenda: toca una hora libre"');
  });

  it("the chips say Nadie; the ⋯ says Más Para; Move To Day's trigger says Mover A Un Día (Title Case, Erik's cn-v1144 decision)", () => {
    expect(es(createElement(CrewInitials, { crew: [], lang: "es" }))).toContain(">Nadie<");
    const more = es(createElement(RowMoreSheet, { title: "14 Bayberry Ln", children: "rows" }));
    expect(more).toContain('aria-label="Más Para 14 Bayberry Ln"');
    expect(more).toContain('title="Más"');
    expect(es(createElement(MoveToDay, { onPick: () => {} }))).toContain('aria-label="Mover A Un Día"');
    // The one intended English change of the visit-page wave: the trigger's words are a clickable's.
    expect(renderToStaticMarkup(createElement(MoveToDay, { onPick: () => {} }))).toContain('aria-label="Move To A Day"');
  });

  it("the map, before its key is set, says so in Spanish", () => {
    const html = es(createElement(JobsMap, { jobs: [] }));
    if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) expect(text(html)).toContain("El mapa aún no está disponible.");
    else expect(text(html)).toContain("0 trabajos con dirección");
  });
});

describe("the calendar in Spanish", () => {
  const job = (over: Partial<CalJob>): CalJob => ({
    id: "j1",
    job_number: "J-030",
    name: "14 Bayberry Ln",
    status: "scheduled",
    scheduled_start: at(DAY, "10:00"),
    scheduled_end: at(DAY, "12:00"),
    planned_minutes: 120,
    assigned_to: ["p-larkspur"],
    customers: { name: "Thistlewood" },
    address: "14 Bayberry Ln",
    city: "Truckee",
    ...over,
  });
  const render = (view: "day" | "week", date = DAY) => {
    nav.params = new URLSearchParams(`view=${view}&date=${date}`);
    return es(
      createElement(CalendarView, {
        jobs: [job({})],
        members: team,
        picker: { jobs: [], customers: [], staff: [] },
        now: `${DAY}T18:00:00.000Z`,
        tz: LA,
        workDayStart: "09:00",
        workDayEnd: "17:00",
        canEdit: true,
        actuals: null,
      }),
    );
  };

  it("the day: Día / Semana / Mes, Hoy, its headings, its sentence, its date in es-US", () => {
    const html = render("day");
    const t = text(html);
    for (const door of ["Día", "Semana", "Mes", "Hoy", "Agregar A La Agenda"]) expect(t).toContain(door);
    expect(t).toContain("← Semana");
    for (const line of ["Citas", "Trabajos programados", "Nada agendado este día."]) expect(t).toContain(line);
    expect(t).toContain("El tiempo marcado no cargó, así que hoy y los días pasados muestran solo lo agendado.");
    expect(html).toContain('aria-label="Anterior"');
    expect(html).toContain('aria-label="Filtrar por persona"');
    // The header names the day with its year; the grid's column names it short.
    expect(t).toMatch(/jueves, 5 (de )?nov\.? (de )?2026/);
    expect(t).toMatch(/jue, 5 (de )?nov\.? (de )?2026/);
    expect(t).not.toMatch(/Nothing booked|Scheduled jobs|Appointments|Add To Schedule/);
  });

  it("the week: its span in Spanish, the day columns es-US", () => {
    const today = todayStrInTz(LA);
    const t = text(render("week", today));
    expect(t).toContain("esta semana");
    expect(t).toMatch(/\d+–\d+ de [a-z]+ de \d{4}|\d+ de [a-z]+ – \d+ de [a-z]+ de \d{4}/);
    expect(t).not.toContain("this week");
  });
});
