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
  dailyReportJobChoices: vi.fn(async () => ({ ok: true, decided: null, dayJobs: [], otherJobs: [] })),
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
import { DailyReportDebrief, ReportJobLine, readReportJobs } from "./daily-report-debrief";
import { esTitleCase, titleCaseIn } from "../../../../tests/title-case-words";

const ROOT = process.cwd();
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");
const TZ = "America/Los_Angeles";
// Children go in createElement's third argument (react/no-children-prop); the props cast the way row-more-sheet.test.ts does.
const inLang = (lang: Lang, el: ReactElement) => renderToStaticMarkup(createElement(LangProvider, { lang } as Parameters<typeof LangProvider>[0], el));
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
  it("lists the twelve screens (My Pay Periods' three since cn-v1166), every key is tc_, and the shared headline is in both languages", () => {
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
      "src/app/(app)/timeclock/pay/page.tsx",
      "src/app/(app)/timeclock/pay/[period]/page.tsx",
      "src/app/(app)/timeclock/pay/my-pay-views.tsx",
    ]);
    expect(Object.keys(words.en).every((k) => k.startsWith("tc_"))).toBe(true);
    expect(Object.keys(words.en).length).toBeGreaterThanOrEqual(190);
    expect(en.tc_whichJobHeadline).toBe("Which Job Are You On?");
    expect(es.tc_whichJobHeadline).toBe("¿En Qué Trabajo Estás?");
  });

  it("no screen it names formats a clock or a day in en-US by hand any more: the locale follows the person", () => {
    for (const f of words.files) expect(src(f), f).not.toContain('"en-US"');
    expect(src("src/app/(app)/timeclock/page.tsx")).toContain("toLocaleDateString(localeOf(lang), {");
    // The pay card's words are My Pay Periods' (cn-v1166): one row's words, worked out in the views.
    expect(src("src/app/(app)/timeclock/page.tsx")).toContain("<MyPayCard newest={newest} cantShow={myPayCantShow} lang={lang} />");
    expect(src("src/app/(app)/timeclock/pay/my-pay-views.tsx")).toContain("const w = newest ? rowWords(newest, lang) : null;");
    expect(src("src/app/(app)/timeclock/pay/my-pay-views.tsx")).toContain("formatCurrency(p.gross, lang)");
    expect(src("src/app/(app)/timeclock/pay/my-pay-views.tsx")).toContain("formatDate(start, undefined, lang)");
    expect(src("src/app/(app)/timeclock/timeclock-panel.tsx")).toContain("const locale = localeOf(lang);");
    expect(src("src/app/(app)/timeclock/same-day-shifts.tsx")).toContain("toLocaleTimeString(localeOf(lang), {");
  });

  it("the English is what the clock said before (the tests that read rendered English stay green)", () => {
    expect(en.tc_offline).toBe("No connection — your entry is kept, try again when you have bars.");
    expect(en.tc_noJobSelected).toBe("No job selected");
    expect(en.tc_clockOutWithDetails).toBe("Clock Out with Details…");
    expect(en.tc_confirmClockOut).toBe("Confirm & Clock Out");
    expect(en.tc_techJobNote).toBe(
      "Your job comes from today's crew assignment. Nothing assigned? Clock in anyway — you'll be asked which job, or skip and the office picks it.",
    );
    expect(en.tc_nextUp).toBe("Next up");
    expect(en.tc_myTimecard).toBe("My timecard");
    expect(en.tc_weekTotal).toBe("Week total");
    expect(en.tc_myPayPeriod).toBe("My pay period");
    expect(en.tc_nortEndOfDay).toBe("Nort — End of Day");
    expect(en.tc_savedSplit).toBe("Saved. The shift is split into 2 entries.");
    expect(en.tc_startingNowPick).toBe("Starting Now · Pick a Different Time");
    // The only English that moved: the picker's two template-literal doors, now Title Case like every button.
    expect(en.tc_roundedTo).toBe("Rounded to {time} · Tap for Now");
    expect(en.tc_startingNowRound).toBe("Starting Now · Round Back to {time}");
  });

  it("the glossary's exact words are the Spanish on the doors", () => {
    expect(es.tc_clockIn).toBe("Marcar Entrada");
    expect(es.tc_clockOut).toBe("Marcar Salida");
    expect(es.tc_switchJob).toBe("Cambiar de Trabajo");
    expect(es.tc_cancel).toBe("Cancelar");
    expect(es.tc_undo).toBe("Deshacer");
    expect(es.tc_done).toBe("Hecho");
    expect(es.tc_nortEndOfDay).toBe("Nort — Reporte del Día");
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

  it("clocked in on no job, staff: Pick the Job, Clock Out and More Options read in Spanish", () => {
    const html = inLang("es", createElement(TimeclockPanel, { ...props, openEntry: openPunch, isStaff: true, lang: "es" }));
    expect(html).toContain("Esta marcación aún no tiene trabajo.");
    expect(html).toContain(">Elegir el Trabajo</button>");
    expect(html).toContain("Entrada marcada — Sin trabajo elegido");
    expect(html).toContain("Marcar Salida");
    expect(html).toContain("Más Opciones");
    expect(html).not.toContain("Pick the Job");
    expect(html).not.toContain("More Options");
    const enHtml = inLang("en", createElement(TimeclockPanel, { ...props, openEntry: openPunch, isStaff: true, lang: "en" }));
    expect(enHtml).toContain("No job on this punch yet.");
    expect(enHtml).toContain(">Pick the Job</button>");
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
    expect(html).toContain("Cambié de Trabajo durante Este Turno");
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

  it("in English: Starting Now · Pick a Different Time, Stop date / Stop time, the forgot-to-clock-in caption", () => {
    expect(inLang("en", createElement(ClockStartPicker, { onChange: () => {}, staff: true, tz: TZ }))).toContain("Starting Now · Pick a Different Time");
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
        if (lang === "es") expect(esTitleCase(label), `${lang}:${key} "${label}"`).toBe(true); // Spanish: the significant words (cn-v1147)
        else expect(titleCaseIn(label, "en"), `${lang}:${key} "${label}"`).toBe(true); // the one judge (cn-v1148)
      }
    }
  });
});

describe("New Job, from the clock", () => {
  it("the trigger reads in the person's language; a caller's own label still wins", () => {
    expect(inLang("es", createElement(NewJobInline, { onCreated: () => {} }))).toContain("Nuevo Trabajo");
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
  it("open, in Spanish: the sheet's title, the one line and the optional second, the placeholders and the doors", () => {
    const html = inLang("es", createElement(DailyReportDebrief, { open: true, onClose: () => {} }));
    expect(html).toContain("Nort — Reporte del Día");
    expect(html).toContain("¿Qué hiciste hoy?");
    expect(html).toContain("¿Qué materiales necesitas mañana?");
    expect(html).toContain('placeholder="Qué se hizo hoy, en palabras sencillas…"');
    expect(html).toContain("Enviar Reporte");
    expect(html).toContain("Omitir");
    // ONE LINE LEADS (cn-v1174): no intro box; the jobs are read as the sheet opens.
    expect(html).not.toContain("dos preguntas rápidas");
    expect(html).toContain("Leyendo tus trabajos…");
    expect(html.indexOf("¿Qué hiciste hoy?")).toBeLessThan(html.indexOf("¿Qué materiales necesitas mañana?"));
    expect(html).not.toContain("File Report");
    expect(html).not.toContain("End of Day");
  });

  it("open, in English: what it said", () => {
    const html = inLang("en", createElement(DailyReportDebrief, { open: true, onClose: () => {} }));
    expect(html).toContain("Nort — End of Day");
    expect(html).toContain("What did you do today?");
    expect(html).toContain("What materials do you need tomorrow?");
    expect(html).toContain('placeholder="What got done today, in plain words…"');
    expect(html).toContain("File Report");
    expect(html).toContain("Skip");
    expect(html).not.toContain("two quick questions for the office");
    expect(html).toContain("Reading your jobs…");
    // Each answer is one line that grows: no three-row boxes.
    expect(html.match(/rows="1"/g)?.length).toBe(2);
    // Filing waits for the job to be read, so a day that decides its job is never filed on none.
    expect(html).toMatch(/type="button" disabled="">File Report<\/button>/);
  });
});

describe("the debrief says which job the report is for, or asks (cn-v1174)", () => {
  const d = src("src/app/(app)/timeclock/daily-report-debrief.tsx");
  it("always asked (the day's job preselected when it decided one); the day's jobs before the others; one quiet line for no job", () => {
    // The sentence alone is gone from the open sheet (skeptic, cn-v1174): it left no way to change the
    // job or to file with none. tc_reportForJob is read by the filed confirmation only.
    expect(d).not.toContain('fillText(t("tc_reportForJob"), { job: ready.decided.label })');
    expect(d).toContain('fillText(t("tc_reportForJob"), { job: jobLabelOf(jobId) as string })');
    expect(d).toContain("<ReportJobLine choices={choices} jobId={jobId} onPick={setJobId} />");
    expect(d.indexOf('label={t("tc_todaysJobs")}')).toBeGreaterThan(0);
    expect(d.indexOf('label={t("tc_todaysJobs")}')).toBeLessThan(d.indexOf('label={t("tc_otherJobs")}'));
    expect(d).toContain('{!jobId && <p className="mt-1.5 text-xs text-slate-500">{t("tc_reportInNoJobFile")}</p>}');
    expect(d).toContain("job_id: jobId || null");
    // Never a key around the open Modal: a new opening resets with state.
    expect(d).not.toMatch(/<Modal[^>]*\bkey=/);
    expect(d).toContain("if (open !== wasOpen) {");
  });
  it("the words, in both languages", () => {
    for (const [k, e, sp] of [
      ["tc_reportForJob", "This report is for {job}.", "Este reporte es para {job}."],
      ["tc_whichJobReport", "Which job is this report for?", "¿Para qué trabajo es este reporte?"],
      ["tc_noJobOption", "No Job", "Sin Trabajo"],
      ["tc_todaysJobs", "Today's Jobs", "Trabajos de Hoy"],
      ["tc_otherJobs", "Other Jobs", "Otros Trabajos"],
      ["tc_reportInNoJobFile", "This report won't be in any job's file.", "Este reporte no quedará en el archivo de ningún trabajo."],
    ]) {
      expect(en[k], k).toBe(e);
      expect(es[k], k).toBe(sp);
    }
    expect("tc_debriefIntro" in en).toBe(false);
  });
});

describe("the report's job line, drawn (skeptic, cn-v1174)", () => {
  const J1 = { id: "j1", label: "Larkspur Panel" };
  const J2 = { id: "j2", label: "Snowbell Deck" };
  const line = (lang: Lang, choices: object, jobId: string) =>
    inLang(lang, createElement(ReportJobLine, { choices: choices as never, jobId, onPick: () => {} }));

  it("a day that decided its job: the Select is drawn with that job PRESELECTED, No Job still an option, no quiet line", () => {
    const html = line("en", { state: "ready", decided: J1, dayJobs: [J1], otherJobs: [J2] }, "j1");
    expect(html).toContain("Which job is this report for?");
    expect(html).toMatch(/<select [^>]*id="dr-job"/);
    expect(html).toMatch(/<option value="j1" selected="">Larkspur Panel<\/option>/);
    expect(html).toContain('<option value="">No Job</option>');
    expect(html).toContain("Snowbell Deck");
    expect(html).not.toContain("This report won&#x27;t be in any job&#x27;s file.");
    expect(html).not.toContain("This report is for");
  });

  it("No Job chosen: the quiet no-file line shows, in both languages", () => {
    const decided = { state: "ready", decided: J1, dayJobs: [J1], otherJobs: [] };
    expect(line("en", decided, "")).toContain("This report won&#x27;t be in any job&#x27;s file.");
    expect(line("en", decided, "")).toMatch(/<option value="" selected="">No Job<\/option>/);
    expect(line("es", decided, "")).toContain("Este reporte no quedará en el archivo de ningún trabajo.");
  });

  it("a day that decided nothing: asked, nothing preselected; a read that failed says so and files with no job", () => {
    expect(line("en", { state: "ready", decided: null, dayJobs: [J1, J2], otherJobs: [] }, "")).toMatch(/<option value="" selected="">No Job<\/option>/);
    const failed = line("en", { state: "failed", error: en.tc_reportJobsDidntLoad }, "");
    expect(failed).toContain(en.tc_reportJobsDidntLoad.replace(/'/g, "&#x27;"));
    expect(failed).toContain("This report won&#x27;t be in any job&#x27;s file.");
    expect(failed).not.toContain("<select");
  });
});

describe("the report's jobs read never hangs the sheet (skeptic, cn-v1174)", () => {
  it("a read still out after 8 seconds lands in the didn't-load state, and a later answer is not taken", async () => {
    vi.useFakeTimers();
    try {
      let answer!: (v: unknown) => void;
      const load = () => new Promise((res) => (answer = res)) as never;
      const seen: unknown[][] = [];
      readReportJobs(load, "didn't load", (next, id) => seen.push([next, id]));
      vi.advanceTimersByTime(7_999);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(seen).toEqual([[{ state: "failed", error: "didn't load" }, null]]);
      answer({ ok: true, decided: { id: "j1", label: "Larkspur Panel" }, dayJobs: [], otherJobs: [] });
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      expect(seen).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an answer in time is taken (the decided job handed back to be preselected), and the timer is gone", async () => {
    vi.useFakeTimers();
    try {
      const seen: unknown[][] = [];
      readReportJobs(async () => ({ ok: true, decided: { id: "j1", label: "L" }, dayJobs: [{ id: "j1", label: "L" }], otherJobs: [] }), "x", (n, id) => seen.push([n, id]));
      await Promise.resolve();
      await Promise.resolve();
      expect(seen).toEqual([[{ state: "ready", decided: { id: "j1", label: "L" }, dayJobs: [{ id: "j1", label: "L" }], otherJobs: [] }, "j1"]]);
      vi.advanceTimersByTime(10_000);
      expect(seen).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the sheet reads through it, with the catalog's didn't-load sentence", () => {
    const d = src("src/app/(app)/timeclock/daily-report-debrief.tsx");
    expect(d).toContain('return readReportJobs(dailyReportJobChoices, t("tc_reportJobsDidntLoad"), (next, decidedId) => {');
    expect(d).toContain("const REPORT_JOBS_TIMEOUT_MS = 8_000;");
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
    // The pay card is drawn in pay/my-pay-views (MyPayCard) since cn-v1166, so it renders in a test.
    const card = src("src/app/(app)/timeclock/pay/my-pay-views.tsx");
    for (const key of ["tc_myTimecard", "tc_last7Days", "tc_weekTotal", "tc_myPayPeriod", "tc_paid", "tc_partlyPaid", "tc_unpaid", "tc_openNotCounted", "tc_basePayOnly", "tc_onTheClock", "tc_now", "tc_checkingSchedule"]) {
      expect(s.includes(`t("${key}")`) || card.includes(`t("${key}")`), key).toBe(true);
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
