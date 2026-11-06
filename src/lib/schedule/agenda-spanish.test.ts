import { describe, it, expect } from "vitest";
import { translator } from "@/lib/i18n";
import { formatTime, formatDateShort } from "@/lib/utils";
import { weekdayHeadings, prettyDay } from "@/lib/tz";
import { spanLabel, dayLabel } from "./span-label";
import { shortDayWords } from "./week-columns";
import { lengthWords, dayWords, hmWords, blockWords, dayBlockWords } from "./job-block";
import { crewChips, crewWords, crewDayLines } from "./block-info";
import { dayTargetLabel, armedInstruction, placeMessage, dayLabelFrom } from "./placement-plan";
import { clockWords, rangeWords, blockSentence, peopleWords, type WorkedPerson } from "./plan-vs-actual";
import { kindLabel, durationLabel, dayLoad, durationBuckets } from "./work-shape";
import { nextAction, groupByTown } from "./place-by-town";
import { backWords, checkComeBackDay, offHoldWords, shortDay } from "@/lib/come-back-days";
import { jobLabel, toStaffOptions, defaultJobName } from "@/lib/schedule-options";
import { jobWords } from "@/lib/action-items/words";
import { modalWords } from "@/components/ui/modal-words";
import { esTitleCase } from "../../../tests/title-case-words";

/**
 * THE AGENDA'S LIBRARIES IN SPANISH (the agenda-in-Spanish wave's foundation). Each library keeps its
 * English by default (its own tests pin that, untouched); handed "es" and the translator, it says the
 * ag_ catalog's words, a clock's half of the day as "a. m." / "p. m.", and a date through Intl es-US.
 */
const t = translator("es");

describe("the agenda's libraries in Spanish", () => {
  it("lib/utils: formatTime says a. m. / p. m., formatDateShort the day before the month; English unchanged", () => {
    expect(formatTime("2026-11-05T17:30:00Z", "America/Los_Angeles", "es")).toBe("9:30 a. m.");
    expect(formatTime("2026-11-05T22:00:00Z", "America/Los_Angeles", "es")).toBe("2:00 p. m.");
    expect(formatTime("2026-11-05T17:30:00Z", "America/Los_Angeles")).toBe("9:30 AM");
    expect(formatDateShort("2026-11-05", undefined, "es")).toBe("5 nov");
    expect(formatDateShort("2026-11-05")).toBe("Nov 5");
  });

  it("lib/tz: the weekday headings and the pretty day in Spanish; English byte for byte the old list", () => {
    expect(weekdayHeadings("sunday")).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(weekdayHeadings("monday")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(weekdayHeadings("monday", "es")).toEqual(["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]);
    expect(prettyDay("2026-11-05", "es")).toBe("jueves, 5 de noviembre");
    expect(prettyDay("2026-11-05")).toBe("Thursday, November 5");
  });

  it("span-label and week-columns: the day before the month in Spanish, English in the reader's own locale", () => {
    const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
    expect(spanLabel(d(2026, 8, 25), d(2026, 8, 31), { month: "long", lang: "es" })).toBe("25–31 de agosto de 2026");
    expect(spanLabel(d(2026, 3, 30), d(2026, 4, 5), { month: "long", lang: "es" })).toBe("30 de marzo – 5 de abril de 2026");
    expect(spanLabel(d(2026, 8, 25), d(2026, 8, 31), { month: "long" })).toBe("August 25–31, 2026");
    expect(dayLabel(d(2026, 8, 31), "es")).toContain("lunes");
    expect(shortDayWords("2026-07-18", "es")).toBe("sáb 18");
    expect(shortDayWords("2026-07-18")).toBe("Sat 18");
  });

  it("job-block: lengths with their plural pair, the day, the clock, the block line", () => {
    expect(lengthWords(1, "es", t)).toBe("1 minuto");
    expect(lengthWords(45, "es", t)).toBe("45 minutos");
    expect(lengthWords(60, "es", t)).toBe("1 hora");
    expect(lengthWords(90, "es", t)).toBe("1.5 horas");
    expect(lengthWords(80, "es", t)).toBe("1 hora 20 minutos");
    expect(lengthWords(80)).toBe("1 hour 20 minutes");
    expect(dayWords("2026-11-05", "es")).toBe("jue, 5 de nov");
    expect(hmWords("13:30", "es")).toBe("1:30 p. m.");
    expect(hmWords("10:00", "es")).toBe("10:00 a. m.");
    expect(hmWords("13:30")).toBe("1:30 PM");
    expect(blockWords({ allDay: true, minutes: 480, sized: true }, "es", t)).toBe("Todo el día");
    expect(blockWords({ allDay: false, minutes: 120, sized: false }, "es", t)).toBe("2 horas — cámbialo");
    const w = dayBlockWords({ day: "2026-11-05", scheduledStart: null, scheduledEnd: null, tz: "America/Los_Angeles", workDay: { start: "08:00", end: "16:00" } }, "es", t);
    expect(w.words).toBe("Día trabajado · aún sin día planeado");
  });

  it("block-info: the chips' titles Title Case, the crew line, the day lines", () => {
    const team = [{ id: "a", full_name: "Larkspur Catbird" }];
    const chips = crewChips(["a", "b"], team, { rows: [{ profile_id: "a", work_date: "2026-11-05", kind: "off", job_id: null }] }, "es", t);
    expect(chips[0].title).toBe("Larkspur Catbird · Libre Ese Día");
    expect(esTitleCase(chips[0].title!)).toBe(true);
    expect(chips[1].name).toBe("Sin nombre");
    expect(crewWords([], "es", t)).toBe("Nadie asignado");
    expect(crewWords(chips, "es", t)).toBe("Cuadrilla: Larkspur Catbird (libre ese día), Sin nombre");
    expect(crewDayLines(chips, "es", t)).toEqual(["Larkspur está libre ese día."]);
  });

  it("placement-plan: the target, the instruction, the plural message pair", () => {
    expect(dayTargetLabel(1, "es", t)).toBe("Ponlo aquí");
    expect(dayTargetLabel(3, "es", t)).toBe("Pon 3 aquí");
    expect(armedInstruction(2, "es", t)).toContain("van todos juntos");
    const base = { leadsBooked: 0, leadsFailed: 0, jobsPlaced: 0, jobsFailed: 0, dayLabel: "hoy" };
    expect(placeMessage({ ...base, jobsPlaced: 1 }, "es", t).text).toBe("Para hoy.");
    expect(placeMessage({ ...base, jobsPlaced: 2, jobsDefaulted: 2 }, "es", t).text).toBe(
      "2 para hoy. 2 no tenían duración, así que quedaron en 2 horas. Toca uno en el calendario para cambiarla.",
    );
    expect(placeMessage({ ...base, jobsFailed: 2 }, "es", t).text).toBe("Ninguno de esos 2 quedó para hoy.");
    expect(dayLabelFrom("2026-11-05", "2026-11-05", "es", t)).toBe("hoy");
    expect(dayLabelFrom("2026-11-05", undefined, "es")).toContain("jueves");
  });

  it("plan-vs-actual: the clock, the shared half, the block's sentence, who worked", () => {
    expect(clockWords(664, "es")).toBe("11:04 a. m.");
    expect(rangeWords(750, 1050, "es")).toBe("12:30–5:30 p. m.");
    expect(rangeWords(664, 826, "es")).toBe("11:04 a. m.–1:46 p. m.");
    expect(rangeWords(750, 1050)).toBe("12:30–5:30 PM");
    expect(blockSentence({ startMin: 540, endMin: 1020 }, { people: [], lateMin: null, overMin: null, shortMin: null }, "es", t)).toBe(
      "Agendado 9–5 · Sin tiempo marcado en este trabajo",
    );
    const p: WorkedPerson = { profileId: "x", name: "Snowbell Bayberry", first: "Snowbell", initials: "SB", dot: "", startMin: 420, endMin: null, spans: [{ startMin: 420, endMin: 600, open: true, running: true }] };
    expect(peopleWords([p], "es", t)).toBe("Snowbell en el reloj desde 7:00 a. m.");
  });

  it("work-shape: the kind chips Title Case, days, unsized, the buckets", () => {
    expect(kindLabel("service", "es", t)).toBe("Llamada de Servicio");
    expect(kindLabel("walkthrough", "es", t)).toBe("Inspección");
    expect(kindLabel("walkthrough")).toBe("Inspection");
    for (const k of ["job", "walkthrough", "service", "office", "quote", "call", "other"] as const) expect(esTitleCase(kindLabel(k, "es", t))).toBe(true); // Spanish: the significant words (cn-v1147)
    expect(durationLabel(1440, "es", t)).toBe("3 días");
    expect(dayLoad([{ planned_minutes: 120 }, {}], "es", t).label).toBe("2h · 1 sin duración");
    expect(durationBuckets("es", t).map((b) => b.label)).toContain("Medio día");
    expect(durationBuckets().map((b) => b.label)).toContain("Half day");
  });

  it("place-by-town: the next action and the townless bucket", () => {
    expect(nextAction("nothing", "es", t)).toBe("Listo para programar");
    const g = groupByTown([{ id: "1", kind: "job", name: "Thistlewood", city: null, address: null } as never], "es", t);
    expect(g[0].town).toBe("Sin ciudad aún");
    expect(g[0].unlocatable).toBe(true);
  });

  it("come-back-days: the chips Title Case, the refusals, the off-hold line", () => {
    expect(backWords(null, "2026-11-05", "es", t)).toBe("Sin Día");
    expect(backWords("2026-11-05", "2026-11-05", "es", t)).toBe("Vuelve Hoy");
    expect(backWords("2026-11-09", "2026-11-05", "es", t)).toBe("Vuelve 9 nov");
    expect(backWords("2026-11-09", "2026-11-05")).toBe("Back Nov 9");
    expect(shortDay("2026-10-03", "es")).toBe("3 oct");
    expect(checkComeBackDay("2026-11-05", "x", "es", t)).toEqual({ ok: false, error: "Elige un día." });
    expect(checkComeBackDay("2026-11-05", "2026-11-01", "es", t)).toEqual({ ok: false, error: "Elige hoy o después" });
    expect(offHoldWords({ jobNumber: "J-048", reason: "waiting on the permit." }, "es", t)).toBe("J-048 estaba en pausa (waiting on the permit). Ya no está en pausa.");
  });

  it("schedule-options and action-items/words: a job with no name, a person with none, the default name", () => {
    expect(jobLabel({}, "es", t)).toBe("Trabajo");
    expect(jobLabel({})).toBe("Job");
    expect(toStaffOptions([{ id: "1", full_name: null }], "es", t)[0].label).toBe("Sin nombre");
    expect(defaultJobName({ todayStr: "2026-09-28", lang: "es", words: t })).toBe("Trabajo Nuevo · 28 sept");
    expect(defaultJobName({ todayStr: "2026-09-28" })).toBe("New Job · Sep 28");
    expect(jobWords(null, "es", t)).toBe("Un Trabajo");
    expect(jobWords(null)).toBe("A Job");
  });

  it("the sheet's words: one spelling in the component and the catalog", () => {
    expect(modalWords("es").save).toBe(t("ag_btn_save"));
    expect(modalWords("es").tapAgain).toBe("Toca de nuevo para descartar lo que escribiste");
    expect(modalWords(undefined).close).toBe("Close");
  });

  it("English dates keep the reader's own locale (undefined), as before the wave; Spanish is es-US", () => {
    const own = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(undefined, o);
    const d = new Date(2026, 10, 5);
    expect(dayLabelFrom("2026-11-05")).toBe(own(d, { weekday: "long", month: "short", day: "numeric" }));
    expect(dayLabelFrom("2026-11-05", undefined, "es", t)).toBe(d.toLocaleDateString("es-US", { weekday: "long", month: "short", day: "numeric" }));
    expect(spanLabel(d, new Date(2026, 10, 11))).toBe(`${own(d, { month: "short" })} 5–11, 2026`);
    expect(dayLabel(d)).toBe(own(d, { weekday: "long", month: "short", day: "numeric", year: "numeric" }));
  });
});

describe("the agenda's house words (one word per idea, the older catalogs' spelling)", () => {
  it("Schedule/Scheduled is Programar/Programado; Book/Booked stays Agendar/Agendado", () => {
    expect(t("ag_rail_scheduled")).toBe("Programado");
    expect(t("ag_rail_btn_notScheduledYet")).toBe("Sin Programar Aún");
    expect(t("ag_rail_hasRoom")).toBe("Nada programado. Tiene espacio.");
    expect(t("ag_cal_scheduledJobs")).toBe("Trabajos programados");
    expect(t("ag_cal_nothingScheduled")).toBe("Nada programado.");
    expect(t("ag_srv_badNewJobDate")).toContain("toca Sin Programar Aún.");
    expect(t("ag_srv_nowScheduledDay")).toBe("El trabajo quedó programado el {day}.");
    expect(t("ag_srv_nowScheduledRange")).toBe("El trabajo quedó programado del {from} al {to}.");
    expect(t("ag_srv_pickDayToSchedule")).toBe("Elige el día para programarlo.");
    expect(t("ag_srv_onlyScheduledWaits")).toBe("Solo una visita programada puede volver a esperar.");
    expect(t("ag_srv_apptStatus_scheduled")).toBe("programada");
    expect(t("ag_readyToSchedule")).toBe("Listo para programar");
    expect(t("ag_booked")).toBe("Agendado {span}");
    expect(t("ag_cal_btn_bookThisDay")).toBe("Agendar Este Día");
  });

  it("Done is Hecho/hecha, never Listo; New Appointment is Nueva Cita; Delete is Eliminar; Hold It is Pausarlo", () => {
    expect(t("ag_btn_done")).toBe("Hecho");
    expect(t("ag_srv_apptStatus_completed")).toBe("hecha");
    expect(t("ag_srv_toastMarkedDone")).toBe("Marcada como hecha");
    expect(t("ag_srv_markDoneTip")).toBe("Marcar como hecha");
    expect(t("ag_srv_visitDidHappen")).toContain("marcada como Hecha,");
    expect(t("ag_srv_visitChangedDone")).toContain("marcada como Hecha.");
    expect(t("ag_rail_btn_newApptAt")).toBe("Nueva Cita a las {time}");
    expect(t("ag_rail_btn_newApptOn")).toBe("Nueva Cita el {day}");
    expect(t("ag_srv_confirmCancel")).toContain("usa Eliminar para quitarla.");
    expect(t("ag_rail_btn_holdIt")).toBe("Pausarlo");
    expect(t("ag_srv_movedAllWorkedRange")).toMatch(/se agrega como día nuevo\.$/);
    expect(t("ag_srv_undoNoHold")).toContain(`en ${t("nv_sched_waitingForADay")}.`);
  });

  it("the date-ranges failure says what happened, in both languages", () => {
    expect(translator("en")("ag_srv_multiRanges")).toBe("The separate date ranges didn't save — please try again. The job's overall window was updated.");
    expect(t("ag_srv_multiRanges")).toBe("Los rangos de fechas por separado no se guardaron — inténtalo de nuevo. Las fechas generales del trabajo sí cambiaron.");
  });
});
