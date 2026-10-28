import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE TIME CLOCK IN SPANISH (cn-v1138). Every word a tech reads on the clock's client side — the
 * panel, the finish-your-timecard card, the start-time picker, the new-job box, Nort's end-of-day
 * debrief, Next Up and the page's own cards — comes through the tc_ catalog (lib/words/timeclock),
 * so a Spanish-speaking tech reads Spanish and the office reads the English it always did, byte for
 * byte. Each component is rendered inside the LangProvider in both languages; the server pieces
 * (Next Up, the page) are read at the source for the keys they ask for.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("./actions", () => ({
  clockIn: vi.fn(),
  clockOut: vi.fn(),
  switchJob: vi.fn(),
  saveEntryNotes: vi.fn(),
  completeAutoClockOut: vi.fn(),
  joinTimeEntries: vi.fn(),
  fileDailyReport: vi.fn(),
  shiftsOnDay: vi.fn(),
  putShiftOnJob: vi.fn(),
  takeShiftOffJob: vi.fn(),
}));
vi.mock("./which-job-actions", () => ({ putPunchOnJob: vi.fn(), whichJobChoices: vi.fn() }));
vi.mock("../schedule/actions", () => ({ createJob: vi.fn() }));

import { dict, type Lang } from "@/lib/i18n";
import { LangProvider } from "@/components/lang-provider";
import { words } from "@/lib/words/timeclock";
import { TimeclockPanel } from "./timeclock-panel";
import { AutoClockoutPrompt } from "./auto-clockout-prompt";
import { ClockStartPicker } from "./clock-start-picker";
import { NewJobInline } from "./new-job-inline";
import { DailyReportDebrief } from "./daily-report-debrief";

const ROOT = process.cwd();
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");
const TZ = "America/Los_Angeles";
const inLang = (lang: Lang, el: ReactElement) => renderToStaticMarkup(createElement(LangProvider, { lang, children: el }));
const en = dict("en");
const es = dict("es");

const openPunch = {
  id: "e1",
  profile_id: "p1",
  org_id: "o1",
  clock_in: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  clock_out: null,
  status: "open",
  job_id: null,
  job_code: null,
  notes: null,
  lunch_minutes: 0,
  gps_in: null,
} as never;

describe("the catalog names the clock's client side", () => {
  it("lists the nine screens, every key is tc_, and the shared headline is in both languages", () => {
    expect(words.files).toEqual([
      "src/app/(app)/timeclock/page.tsx",
      "src/app/(app)/timeclock/timeclock-panel.tsx",
      "src/app/(app)/timeclock/auto-clockout-prompt.tsx",
      "src/app/(app)/timeclock/clock-start-picker.tsx",
      "src/app/(app)/timeclock/new-job-inline.tsx",
      "src/app/(app)/timeclock/same-day-shifts.tsx",
      "src/app/(app)/timeclock/next-up.tsx",
      "src/app/(app)/timeclock/app-chose-notice.tsx",
      "src/app/(app)/timeclock/daily-report-debrief.tsx",
    ]);
    expect(Object.keys(words.en).every((k) => k.startsWith("tc_"))).toBe(true);
    expect(Object.keys(words.en).length).toBeGreaterThanOrEqual(190);
    expect(en.tc_whichJobHeadline).toBe("Which Job Are You On?");
    expect(es.tc_whichJobHeadline).toBe("¿En Qué Trabajo Estás?");
  });

  it("no screen it names formats a clock or a day in en-US by hand any more: the locale follows the person", () => {
    for (const f of words.files) expect(src(f), f).not.toContain('"en-US"');
    expect(src("src/app/(app)/timeclock/page.tsx")).toContain("toLocaleDateString(localeOf(lang), {");
    expect(src("src/app/(app)/timeclock/page.tsx")).toContain("formatCurrency(myPeriod.gross, lang)");
    expect(src("src/app/(app)/timeclock/page.tsx")).toContain("formatDate(period.start, undefined, lang)");
    expect(src("src/app/(app)/timeclock/timeclock-panel.tsx")).toContain("const locale = localeOf(lang);");
    expect(src("src/app/(app)/timeclock/same-day-shifts.tsx")).toContain("toLocaleTimeString(localeOf(lang), {");
  });

  it("the English is what the clock said before (the tests that read rendered English stay green)", () => {
    expect(en.tc_offline).toBe("No connection — your entry is kept, try again when you have bars.");
    expect(en.tc_noJobSelected).toBe("No job selected");
    expect(en.tc_clockOutWithDetails).toBe("Clock Out With Details…");
    expect(en.tc_confirmClockOut).toBe("Confirm & Clock Out");
    expect(en.tc_techJobNote).toBe(
      "Your job comes from today's crew assignment. Nothing assigned? Clock in anyway — you'll be asked which job, or skip and the office picks it.",
    );
    expect(en.tc_nextUp).toBe("Next up");
    expect(en.tc_myTimecard).toBe("My timecard");
    expect(en.tc_weekTotal).toBe("Week total");
    expect(en.tc_myPayPeriod).toBe("My pay period");
    expect(en.tc_nortEndOfDay).toBe("Nort — End Of Day");
    expect(en.tc_savedSplit).toBe("Saved. The shift is split into 2 entries.");
    expect(en.tc_startingNowPick).toBe("Starting Now · Pick A Different Time");
    // The only English that moved: the picker's two template-literal doors, now Title Case like every button.
    expect(en.tc_roundedTo).toBe("Rounded To {time} · Tap For Now");
    expect(en.tc_startingNowRound).toBe("Starting Now · Round Back To {time}");
  });

  it("the glossary's exact words are the Spanish on the doors", () => {
    expect(es.tc_clockIn).toBe("Marcar Entrada");
    expect(es.tc_clockOut).toBe("Marcar Salida");
    expect(es.tc_switchJob).toBe("Cambiar De Trabajo");
    expect(es.tc_cancel).toBe("Cancelar");
    expect(es.tc_undo).toBe("Deshacer");
    expect(es.tc_done).toBe("Hecho");
    expect(es.tc_nortEndOfDay).toBe("Nort — Reporte Del Día");
    expect(es.tc_officeReadsMyDay).toContain("Mi Día");
    // Brand words and job numbers stay; "mi" is the unit in both.
    expect(es.tc_confirmedByNort).toContain("Nort");
    expect(words.sameInBoth).toEqual(["tc_milesShort"]);
  });
});

describe("the panel", () => {
  const props = { jobCodes: [] as never[], jobs: [] as never[], tz: TZ };

  it("not clocked in, a tech: the Spanish start-time label, the job note and the location note; the English unchanged", () => {
    const html = inLang("es", createElement(TimeclockPanel, { ...props, openEntry: null, isStaff: false, lang: "es" }));
    expect(html).toContain("No has marcado entrada.");
    expect(html).toContain("Hora de inicio");
    expect(html).toContain("Tu trabajo viene de la asignación de cuadrilla de hoy.");
    expect(html).toContain("Marcar Entrada");
    expect(html).not.toContain("Start time");
    expect(html).not.toContain("Clock In");
    const enHtml = inLang("en", createElement(TimeclockPanel, { ...props, openEntry: null, isStaff: false, lang: "en" }));
    expect(enHtml).toContain("Start time");
    expect(enHtml).toContain("Your job comes from today");
    expect(enHtml).toContain("Clock In");
  });

  it("clocked in on no job, staff: Pick The Job, Clock Out and More Options read in Spanish", () => {
    const html = inLang("es", createElement(TimeclockPanel, { ...props, openEntry: openPunch, isStaff: true, lang: "es" }));
    expect(html).toContain("Esta marcación aún no tiene trabajo.");
    expect(html).toContain(">Elegir El Trabajo</button>");
    expect(html).toContain("Entrada marcada — Sin trabajo elegido");
    expect(html).toContain("Marcar Salida");
    expect(html).toContain("Más Opciones");
    expect(html).not.toContain("Pick The Job");
    expect(html).not.toContain("More Options");
    const enHtml = inLang("en", createElement(TimeclockPanel, { ...props, openEntry: openPunch, isStaff: true, lang: "en" }));
    expect(enHtml).toContain("No job on this punch yet.");
    expect(enHtml).toContain(">Pick The Job</button>");
    expect(enHtml).toContain("Clocked in — No job selected");
    expect(enHtml).toContain("More Options");
  });
});

describe("finish your timecard (the auto clock-out card)", () => {
  const entry = { id: "a1", clock_in: "2026-10-27T15:00:00Z", clock_out: "2026-10-27T23:30:00Z", lunch_minutes: 0, jobId: null, jobLabel: "Larkspur" };
  const props = { entry, jobCodes: [], jobs: [], isStaff: true, tz: TZ };

  it("the heading, the lunch sentence, the office's switch box and Save My Hours are Spanish", () => {
    const html = inLang("es", createElement(AutoClockoutPrompt, props));
    expect(html).toContain("Termina tu tarjeta de tiempo: marcaste salida a las 4:30pm.");
    expect(html).toContain("8:00am–4:30pm en Larkspur. Nadie preguntó por el almuerzo cuando se cerró.");
    expect(html).toContain("Cambié De Trabajo Durante Este Turno");
    expect(html).toContain(">Guardar Mis Horas</button>");
    expect(html).not.toContain("Save My Hours");
  });

  it("in English it says what it said", () => {
    const html = inLang("en", createElement(AutoClockoutPrompt, props));
    expect(html).toContain("Finish your timecard — you clocked out at 4:30pm.");
    expect(html).toContain("8:00am–4:30pm on Larkspur. Nobody was asked about lunch when it closed.");
    expect(html).toContain("I Switched Jobs During This Shift");
    expect(html).toContain(">Save My Hours</button>");
  });
});

describe("the start-time picker", () => {
  it("collapsed, staff: the one door is Spanish; expanded as a stop picker: the fields are named in Spanish and so is the caption", () => {
    const collapsed = inLang("es", createElement(ClockStartPicker, { onChange: () => {}, staff: true, tz: TZ }));
    expect(collapsed).toContain("Empezando Ahora · Elegir Otra Hora");
    expect(collapsed).not.toContain("Starting Now");
    const stop = inLang("es", createElement(ClockStartPicker, { onChange: () => {}, staff: true, startExpanded: true, fieldLabel: "Stop", tz: TZ }));
    expect(stop).toContain('aria-label="Fecha de fin"');
    expect(stop).toContain('aria-label="Hora de fin"');
    expect(stop).toContain("El turno empieza a la hora de arriba");
    const start = inLang("es", createElement(ClockStartPicker, { onChange: () => {}, staff: true, startExpanded: true, tz: TZ }));
    expect(start).toContain('aria-label="Fecha de inicio"');
  });

  it("in English: Starting Now · Pick A Different Time, Stop date / Stop time, the forgot-to-clock-in caption", () => {
    expect(inLang("en", createElement(ClockStartPicker, { onChange: () => {}, staff: true, tz: TZ }))).toContain("Starting Now · Pick A Different Time");
    const stop = inLang("en", createElement(ClockStartPicker, { onChange: () => {}, staff: true, startExpanded: true, fieldLabel: "Stop", tz: TZ }));
    expect(stop).toContain('aria-label="Stop date"');
    expect(stop).toContain('aria-label="Stop time"');
    expect(stop).toContain("Starting the shift at the time above — use this if you forgot to clock in.");
    const start = inLang("en", createElement(ClockStartPicker, { onChange: () => {}, staff: true, startExpanded: true, tz: TZ }));
    expect(start).toContain('aria-label="Start date"');
  });

  it("a tech's rounding door is Title Case in both languages, with the half hour in its slot", () => {
    for (const lang of ["en", "es"] as const) {
      for (const key of ["tc_roundedTo", "tc_startingNowRound", "tc_startingNow"]) {
        const label = dict(lang)[key].replace("{time}", "7:00 AM");
        for (const w of label.split(/\s+/)) if (/\p{L}/u.test(w)) expect(w, `${lang}:${key} "${label}"`).toMatch(/^\p{Lu}/u);
      }
    }
  });
});

describe("New Job, from the clock", () => {
  it("the trigger reads in the person's language; a caller's own label still wins", () => {
    expect(inLang("es", createElement(NewJobInline, { onCreated: () => {} }))).toContain("Trabajo Nuevo");
    expect(inLang("en", createElement(NewJobInline, { onCreated: () => {} }))).toContain("New Job");
    expect(inLang("es", createElement(NewJobInline, { onCreated: () => {}, label: "Open One Here" }))).toContain("Open One Here");
  });

  it("the refusals and the box's words are in the catalog, in both languages", () => {
    expect(en.tc_giveItAName).toBe("Give it a name first — the street address works fine.");
    expect(es.tc_giveItAName).toBe("Ponle un nombre primero: la dirección de la calle funciona bien.");
    expect(en.tc_tagOnlyName).toBe("\"{name}\" says what kind of visit, not which job. Give it the street or the customer.");
    expect(en.tc_jobNamePlaceholder).toBe("Job name or address");
    expect(es.tc_createJob).toBe("Crear Trabajo");
    const s = src("src/app/(app)/timeclock/new-job-inline.tsx");
    expect(s).toContain('setError(fillText(t("tc_tagOnlyName"), { name: trimmed }));');
    expect(s).toContain('placeholder={t("tc_jobNamePlaceholder")}');
  });
});

describe("Nort's end-of-day debrief", () => {
  it("open, in Spanish: the sheet's title, the two questions, the placeholders and the doors", () => {
    const html = inLang("es", createElement(DailyReportDebrief, { open: true, onClose: () => {} }));
    expect(html).toContain("Nort — Reporte Del Día");
    expect(html).toContain("¿Qué hiciste hoy?");
    expect(html).toContain("¿Qué materiales necesitas mañana?");
    expect(html).toContain('placeholder="Qué se hizo hoy, en palabras sencillas…"');
    expect(html).toContain("Enviar Reporte");
    expect(html).toContain("Omitir");
    expect(html).toContain("Ya marcaste salida. Antes de irte, dos preguntas rápidas para la oficina.");
    expect(html).not.toContain("File Report");
    expect(html).not.toContain("End Of Day");
  });

  it("open, in English: what it said", () => {
    const html = inLang("en", createElement(DailyReportDebrief, { open: true, onClose: () => {} }));
    expect(html).toContain("Nort — End Of Day");
    expect(html).toContain("What did you do today?");
    expect(html).toContain("What materials do you need tomorrow?");
    expect(html).toContain('placeholder="What got done today, in plain words…"');
    expect(html).toContain("File Report");
    expect(html).toContain("Skip");
    expect(html).toContain("two quick questions for the office");
  });
});

describe("the server pieces read the same catalog", () => {
  it("Next Up takes the page's lang and asks for its rows, its heading and its reasons by key", () => {
    const s = src("src/app/(app)/timeclock/next-up.tsx");
    expect(s).toContain("export async function NextUp({ userId, tz, lang }");
    expect(s).toContain("const t = translator(lang);");
    expect(s).toContain('{ when: t("tc_today"), answer: answerFor(today) }');
    expect(s).toContain('{ when: t("tc_tomorrow"), answer: answerFor(tomorrow) }');
    expect(s).toContain('{t("tc_nextUp")}');
    expect(s).toContain('fillText(t("tc_offWithReason"), { reason: reasonWord(a.reason) })');
    expect(src("src/app/(app)/timeclock/page.tsx")).toContain("<NextUp userId={user.id} tz={orgSettings.timezone} lang={lang} />");
    expect(es.tc_today).toBe("Hoy");
    expect(es.tc_tomorrow).toBe("Mañana");
    expect(es.tc_nextUp).toBe("Lo que sigue");
    expect(en.tc_offWithReason.replace("{reason}", "vacation")).toBe("Off (vacation)");
    expect(es.tc_offWithReason.replace("{reason}", es.tc_reasonVacation)).toBe("Libre (vacaciones)");
    expect(en.tc_nothingScheduled).toBe("nothing scheduled yet");
  });

  it("the page's cards: My timecard, Week total, My pay period, the badges and the two notes, by key", () => {
    const s = src("src/app/(app)/timeclock/page.tsx");
    for (const key of ["tc_myTimecard", "tc_last7Days", "tc_weekTotal", "tc_myPayPeriod", "tc_paid", "tc_partlyPaid", "tc_unpaid", "tc_openNotCounted", "tc_basePayOnly", "tc_onTheClock", "tc_now", "tc_checkingSchedule"]) {
      expect(s, key).toContain(`t("${key}")`);
      expect(es[key], key).not.toBe(en[key]);
    }
    expect(s).toContain('fillText(t("tc_lunchShort"), { min: String(r.lunch) })');
    expect(s).toContain('t("tc_thePartBefore")');
    expect(s).toContain('t("tc_theJobsite")');
    expect(es.tc_myTimecard).toBe("Mi tarjeta de tiempo");
    expect(es.tc_weekTotal).toBe("Total de la semana");
    expect(es.tc_partlyPaid).toBe("pagado en parte");
  });
});
