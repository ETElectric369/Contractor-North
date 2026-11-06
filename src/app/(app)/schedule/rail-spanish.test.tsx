import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE RAIL AND THE SHEETS IN SPANISH (the agenda-in-Spanish wave, ag_rail_). Each screen the rail
 * catalog names (lib/words/agenda-rail) rendered inside a LangProvider with "es": its doors read the
 * catalog's Title Case Spanish, and one sentence with a slot is filled. The English renders are the
 * screens' own tests (rail-more, add-to-schedule, job-form, appointments/kinds), untouched, with no
 * provider: English is the default, byte for byte.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/schedule",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../timeclock/crew-actions", () => ({ setCrewDayAssignment: vi.fn(), setCrewOffRange: vi.fn(), clearCrewOffRange: vi.fn() }));
vi.mock("./actions", () => ({
  addJobDay: vi.fn(),
  createJob: vi.fn(),
  setJobContact: vi.fn(),
  setJobHold: vi.fn(),
  sizeAppointment: vi.fn(),
  sizeJob: vi.fn(),
  snoozeJobHold: vi.fn(),
  placeAppointmentOnDay: vi.fn(),
  placeJobOnDay: vi.fn(),
  planDayTimes: vi.fn(),
  undoPlaceJob: vi.fn(),
  undoPlaceVisit: vi.fn(),
}));
vi.mock("../leads/actions", () => ({ setLeadContact: vi.fn(), sizeLead: vi.fn(), scheduleLeadsOnDay: vi.fn() }));

const { LangProvider } = await import("@/components/lang-provider");
const { CrewBoard } = await import("./crew-board");
const { TimeOffButton } = await import("./time-off-button");
const { PlaceRail, RailCardRows } = await import("./place-rail");
const { PlacementProvider } = await import("./placement-context");
const { AddToScheduleSheet } = await import("./add-to-schedule-sheet");
const { NewJobButton, CustomerPicker } = await import("./new-job-button");
const { ComeBackPicker } = await import("@/components/come-back-picker");
const { WorkShapeControls } = await import("@/components/work-shape-controls");

const es = (el: ReactElement) => renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: el }));
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const WORK_DAY = { start: "08:00", end: "16:00" };

describe("the rail and the sheets speak Spanish to a Spanish reader", () => {
  it("Everyone's Day: Hoy, the legend's chips, a lane's door with its name, and a free day", () => {
    const lane = { id: "p1", name: "Larkspur Snowbell", jobs: [], appts: [], decision: null, scheduledJobId: null, scheduledLabel: null };
    const unassigned = { ...lane, id: "__unassigned__", name: "Sin asignar" };
    const t = text(
      es(
        createElement(CrewBoard, {
          day: "2026-11-05",
          dayLabel: "jueves, 5 de noviembre",
          isToday: true,
          prevHref: "/p",
          nextHref: "/n",
          todayHref: "/t",
          lanes: [lane],
          unassigned,
          canEdit: true,
          jobOptions: [],
          offToday: [],
        }),
      ),
    );
    for (const w of ["Hoy", "En Este Trabajo", "Programado", "Libre", "Días Libres", "Poner a Larkspur en un Trabajo"]) expect(t, w).toContain(w);
    expect(t).toContain("Nada programado. Tiene espacio.");
    expect(t).toContain("abierto");
    expect(t).not.toMatch(/Has room|On This Job|Put Larkspur/);
  });

  it("Time Off: its door", () => {
    expect(text(es(createElement(TimeOffButton, { members: [{ id: "p1", full_name: "Bayberry" }] })))).toBe("Días Libres");
  });

  it("a rail card's ⋯: Abrir el Trabajo and Poner en Pausa…; a held one Posponer…, Cambiar Motivo…, Quitar la Pausa", () => {
    const job = { id: "j1", kind: "job", name: "12 Thistlewood Ln", address: "12 Thistlewood Ln", city: "Catbird", status: "to_be_scheduled" };
    const a = text(es(createElement(RailCardRows, { i: job as never, todayStr: "2026-11-05", close: () => {} })));
    expect(a).toContain("Abrir el Trabajo");
    expect(a).toContain("Poner en Pausa…");
    const held = text(es(createElement(RailCardRows, { i: { ...job, onHold: true, holdReason: "x" } as never, todayStr: "2026-11-05", close: () => {} })));
    for (const w of ["Posponer…", "Cambiar Motivo…", "Quitar la Pausa"]) expect(held, w).toContain(w);
  });

  it("the rail: the town's count, the kind, the hold badge and its day back, No Address Yet in Spanish", () => {
    const items = [
      { id: "j1", kind: "job", name: "12 Thistlewood Ln", address: "12 Thistlewood Ln", city: "Catbird", status: "on_hold", onHold: true, holdReason: "el permiso", holdUntil: "2026-11-05" },
      { id: "l1", kind: "lead", name: "Larkspur", address: null, city: null, phone: "5305550133" },
    ];
    const t = text(
      es(
        createElement(PlacementProvider, {
          items: items as never,
          todayISO: "2026-11-05",
          workDay: WORK_DAY,
          children: createElement(PlaceRail, { items: items as never, todayStr: "2026-11-05" }),
        }),
      ),
    );
    expect(t).toContain("1 esperando");
    expect(t).toContain("1 esperando · sin dirección aún");
    expect(t).toContain("En Pausa — el permiso");
    expect(t).toContain("Vuelve Hoy");
    expect(t).toContain("Sin Dirección Aún");
    expect(t).toContain("Sin ciudad aún");
    expect(t).not.toMatch(/waiting|No Address Yet|On Hold/);
  });

  it("Add to Schedule: its title and doors, and the day said with its slot", () => {
    const jobs = [{ id: "j1", name: "12 Thistlewood Ln", status: "in_progress", address: "12 Thistlewood Ln", assigned_to: [] }];
    const t = text(es(createElement(AddToScheduleSheet, { at: { day: "2026-11-05", minute: null }, jobs, team: [], workDay: WORK_DAY, onClose: () => {} })));
    for (const w of ["Agregar a la Agenda", "Trabajo", "Día", "Hora", "O una Cita", "En Curso"]) expect(t, w).toContain(w);
    expect(t).toMatch(/Nueva Cita el jue, 5 de nov/);
    expect(t).toMatch(/jue, 5 de nov\. El trabajo conserva sus otros días\./);
    expect(t).not.toMatch(/Add to Schedule|Or an Appointment|keeps every other day/);
  });

  it("New Job: its door, and the customer picker's", () => {
    expect(text(es(createElement(NewJobButton, { customers: [], todayStr: "2026-11-05" })))).toContain("Trabajo Nuevo");
    const pick = (isNew: boolean) =>
      text(
        es(
          createElement(CustomerPicker, {
            idPrefix: "nj",
            customers: [{ id: "c1", name: "Bayberry" }],
            customerId: "",
            onCustomerId: () => {},
            isNew,
            onIsNew: () => {},
            newName: "",
            onNewName: () => {},
            newPhone: "",
            onNewPhone: () => {},
          }),
        ),
      );
    expect(pick(false)).toContain("Cliente");
    expect(pick(false)).toContain("+ Cliente Nuevo");
    expect(pick(false)).toContain("— Ninguno —");
    expect(pick(true)).toContain("Elegir Existente");
  });

  it("the come-back picker: the chips, and the day it comes back said with its slot", () => {
    const t = text(es(createElement(ComeBackPicker, { label: "Pausar", requireWhy: true, todayStr: "2026-11-05", onSubmit: () => {}, onCancel: () => {} })));
    for (const w of ["Mañana", "Lun", "En una Semana", "Elegir un Día", "Pausar", "Cancelar"]) expect(t, w).toContain(w);
    // In a Week is picked: Thursday the 5th + 7.
    expect(t).toContain("Vuelve el 12 nov");
    expect(t).toContain("Di por qué: es el recordatorio cuando vuelva el trabajo");
    expect(t).not.toMatch(/Comes back|Pick a Day|Tomorrow/);
  });

  it("Kind? · How long?: the kinds and the lengths in Spanish", () => {
    const t = text(es(createElement(WorkShapeControls, { workKind: null, plannedMinutes: null, onPatch: () => {} })));
    for (const w of ["¿Tipo?", "Inspección", "Trabajo", "Llamada", "¿Cuánto Tiempo?", "Medio día", "Día completo", "Otro…"]) expect(t, w).toContain(w);
    expect(t).not.toMatch(/Kind\?|How Long\?|Half day/);
  });
});
