import type { WordCatalog } from "./types";
import { MODAL_WORDS } from "@/components/ui/modal-words";

/**
 * THE AGENDA'S FOUNDATION WORDS (ag_, the agenda-in-Spanish wave): what the schedule's pure libraries
 * say (lib/schedule/job-block, block-info, placement-plan, plan-vs-actual, work-shape, place-by-town,
 * lib/come-back-days, lib/schedule-options, lib/action-items/words), the words every sheet says
 * (components/ui/modal-words), and the handful of doors every agenda surface shares (Day, Week,
 * Month, Today…). A library never imports this file: it keeps its English inline and takes the
 * caller's `lang` + translator (lib/lang-words say), the way lib/job-status jobStatusLabel does.
 *
 * THE FOUR AGENDA CATALOGS, AND ONE CONVENTION FOR ALL OF THEM:
 *   ag_       this file — the libraries, the sheet, the shared doors;
 *   ag_cal_   lib/words/agenda-calendar — the calendar surface (week/day/month grids, the tile and ghost sheets);
 *   ag_rail_  lib/words/agenda-rail — the rail, the add-to-schedule and new-job sheets, the crew board;
 *   ag_srv_   lib/words/agenda-server — the schedule's and the appointments' server messages.
 * A CLICKABLE KEY CONTAINS `_btn_` RIGHT AFTER ITS PREFIX (ag_btn_, ag_cal_btn_, ag_rail_btn_,
 * ag_srv_btn_): a door, a chip, a tab, a menu row, a sheet's title — Title Case in BOTH
 * languages ("Abrir el Trabajo", "Vuelve Hoy"; tests/words-parity.test.ts TITLE_CASE_FAMILIES holds
 * the four families). A sentence (ends in a period) under a _btn_ key is not judged. A key that is
 * not a door is sentence case. Plurals are paired keys (ag_minute / ag_minutes); a {slot} is filled
 * by fillText (lib/i18n) or, in a library, by lib/lang-words say.
 *
 * Spanish is tú, US/Mexican, the house words: Trabajo, Visita, Presupuesto, Agenda, Cuadrilla, Día,
 * Semana, Mes. Booked = Agendado; Worked = Trabajado; Off (that day) = Libre; On Hold = En Pausa (the
 * job status, jb_statusOnHold); Town = Ciudad; Inspection = Inspección. The clock's half of the day
 * is "a. m." / "p. m." (lib/lang-words clock12 / esMeridiem), dates through Intl es-US ("jue, 5 nov").
 * cn-v1147: in Spanish the function words (a, de, la, y…) stay lowercase after the first word ("Lista de
 * Precios", "Mover a un Día"); English keeps every word capitalized.
 */
export const words: WordCatalog = {
  prefix: "ag_",
  // The sheet is the one SCREEN here (the libraries keep their English default inline, by design, so
  // the leak scan does not read them; their callers' screens are named in the other three catalogs).
  files: ["src/components/ui/modal.tsx"],
  sameInBoth: [],
  en: {
    // ── The doors every agenda surface shares ──
    ag_btn_day: "Day",
    ag_btn_week: "Week",
    ag_btn_month: "Month",
    ag_btn_today: "Today",
    ag_btn_tomorrow: "Tomorrow",
    ag_btn_map: "Map",
    ag_btn_done: "Done",
    ag_btn_move: "Move",
    ag_btn_undo: "Undo",
    ag_btn_openTheJob: "Open the Job",
    ag_btn_openTheVisit: "Open the Visit",
    ag_btn_workedNotBooked: "Worked, Not Booked",

    // ── The sheet's own words (components/ui/modal-words: one spelling) ──
    ag_btn_close: MODAL_WORDS.en.close,
    ag_btn_save: MODAL_WORDS.en.save,
    ag_btn_cancel: MODAL_WORDS.en.cancel,
    ag_btn_saving: MODAL_WORDS.en.saving,
    ag_modalTapAgain: MODAL_WORDS.en.tapAgain,

    // ── Lengths (job-block lengthWords; paired plurals) ──
    ag_minute: "{n} minute",
    ag_minutes: "{n} minutes",
    ag_hour: "{n} hour",
    ag_hours: "{n} hours",
    ag_allDay: "All day",
    ag_changeIt: "{words} — change it",
    ag_workedDay: "Worked day · {hours}",
    ag_workedDayNoPlan: "Worked day · no day planned yet",
    ag_workedDayPlanned: "Worked day · planned {day}",

    // ── The crew on a block (block-info) ──
    ag_unnamed: "Unnamed",
    ag_chipGone: "{name} · No Longer on the Team",
    ag_chipOff: "{name} · Off That Day",
    ag_chipOnOther: "{name} · On {job} That Day",
    ag_chipOnAnother: "{name} · On Another Job That Day",
    ag_nobodyOnIt: "Nobody on it",
    ag_anotherJob: "another job",
    ag_nameOffThatDay: "{name} (off that day)",
    ag_nameOnThatDay: "{name} (on {job} that day)",
    ag_crewList: "Crew: {list}",
    ag_firstIsOff: "{first} is off that day.",
    ag_firstIsOn: "{first} is on {job} that day.",

    // ── Tap the work, then the day (placement-plan) ──
    ag_putItHere: "Put it here",
    ag_putNHere: "Put {n} here",
    ag_nowTapTheDay: "Now tap the day on the calendar →",
    ag_nowTapTheDayAll: "Now tap the day on the calendar — they all go together →",
    ag_defaultedOne: "It had no length, so it's down as 2 hours. Tap it on the calendar to change it.",
    ag_defaultedMany: "{n} had no length, so they're down as 2 hours. Tap one on the calendar to change it.",
    ag_placeNoneOne: "That one didn't go on {day}.",
    ag_placeNoneMany: "None of those {n} went on {day}.",
    ag_placeSome: "{n} on {day}. {failed} didn't — open them and try again.",
    ag_placeOne: "On {day}.",
    ag_placeMany: "{n} on {day}.",
    ag_todayLower: "today",

    // ── Booked against worked (plan-vs-actual) ──
    ag_someone: "Someone",
    ag_aJob: "A Job",
    ag_onClockSince: "on the clock since {time}",
    ag_inNeverOut: "in at {time}, never clocked out",
    ag_nMore: "+{n} more",
    ag_booked: "Booked {span}",
    ag_noTimeClocked: "No time clocked to this job",
    ag_late: "{d} late",
    ag_over: "{d} over",
    ag_short: "{d} short",

    // ── What kind of work, how long (work-shape) ──
    ag_btn_kindJob: "Job",
    ag_btn_kindInspection: "Inspection",
    ag_btn_kindServiceCall: "Service Call",
    ag_btn_kindOffice: "Office",
    ag_btn_kindQuote: "Quote",
    ag_btn_kindPhoneCall: "Phone Call",
    ag_btn_kindOther: "Other",
    ag_nDays: "{n} days",
    ag_nUnsized: "{n} unsized",
    ag_halfDay: "Half day",
    ag_fullDay: "Full day",
    ag_twoDays: "2 days",
    ag_threeDays: "3 days",
    ag_aWeek: "A week (5 days)",

    // ── Every wait has a day (come-back-days) ──
    ag_pickADay: "Pick a day.",
    ag_pickTodayOrLater: "Pick today or later",
    ag_btn_noDaySet: "No Day Set",
    ag_btn_backToday: "Back Today",
    ag_btn_backOn: "Back {day}",
    ag_thatJob: "That job",
    ag_offHold: "{who} was on hold. It's off hold now.",
    ag_offHoldWhy: "{who} was on hold ({why}). It's off hold now.",

    // ── A job's name when it has none (schedule-options) ──
    ag_job: "Job",
    ag_newJobOn: "New Job · {day}",

    // ── What is unplaced, and where (place-by-town) ──
    ag_noTownYet: "No town yet",
    ag_readyToSchedule: "Ready to schedule",
    ag_callForAddress: "Call to get the address",
    ag_noPhoneOrEmail: "No phone or email — go and look, or find a number",
    ag_needsAddressAndNumber: "Needs an address and a number",
  },
  es: {
    ag_btn_day: "Día",
    ag_btn_week: "Semana",
    ag_btn_month: "Mes",
    ag_btn_today: "Hoy",
    ag_btn_tomorrow: "Mañana",
    ag_btn_map: "Mapa",
    ag_btn_done: "Hecho",
    ag_btn_move: "Mover",
    ag_btn_undo: "Deshacer",
    ag_btn_openTheJob: "Abrir el Trabajo",
    ag_btn_openTheVisit: "Abrir la Visita",
    ag_btn_workedNotBooked: "Trabajado, sin Agendar",

    ag_btn_close: MODAL_WORDS.es.close,
    ag_btn_save: MODAL_WORDS.es.save,
    ag_btn_cancel: MODAL_WORDS.es.cancel,
    ag_btn_saving: MODAL_WORDS.es.saving,
    ag_modalTapAgain: MODAL_WORDS.es.tapAgain,

    ag_minute: "{n} minuto",
    ag_minutes: "{n} minutos",
    ag_hour: "{n} hora",
    ag_hours: "{n} horas",
    ag_allDay: "Todo el día",
    ag_changeIt: "{words} — cámbialo",
    ag_workedDay: "Día trabajado · {hours}",
    ag_workedDayNoPlan: "Día trabajado · aún sin día planeado",
    ag_workedDayPlanned: "Día trabajado · planeado para {day}",

    ag_unnamed: "Sin nombre",
    ag_chipGone: "{name} · Ya No Está en el Equipo",
    ag_chipOff: "{name} · Libre Ese Día",
    ag_chipOnOther: "{name} · En {job} Ese Día",
    ag_chipOnAnother: "{name} · En Otro Trabajo Ese Día",
    ag_nobodyOnIt: "Nadie asignado",
    ag_anotherJob: "otro trabajo",
    ag_nameOffThatDay: "{name} (libre ese día)",
    ag_nameOnThatDay: "{name} (en {job} ese día)",
    ag_crewList: "Cuadrilla: {list}",
    ag_firstIsOff: "{first} está libre ese día.",
    ag_firstIsOn: "{first} está en {job} ese día.",

    ag_putItHere: "Ponlo aquí",
    ag_putNHere: "Pon {n} aquí",
    ag_nowTapTheDay: "Ahora toca el día en el calendario →",
    ag_nowTapTheDayAll: "Ahora toca el día en el calendario — van todos juntos →",
    ag_defaultedOne: "No tenía duración, así que quedó en 2 horas. Tócalo en el calendario para cambiarla.",
    ag_defaultedMany: "{n} no tenían duración, así que quedaron en 2 horas. Toca uno en el calendario para cambiarla.",
    ag_placeNoneOne: "Ese no quedó para {day}.",
    ag_placeNoneMany: "Ninguno de esos {n} quedó para {day}.",
    ag_placeSome: "{n} para {day}. {failed} no — ábrelos e inténtalo de nuevo.",
    ag_placeOne: "Para {day}.",
    ag_placeMany: "{n} para {day}.",
    ag_todayLower: "hoy",

    ag_someone: "Alguien",
    ag_aJob: "Un Trabajo",
    ag_onClockSince: "en el reloj desde {time}",
    ag_inNeverOut: "entró a las {time}, nunca marcó salida",
    ag_nMore: "+{n} más",
    ag_booked: "Agendado {span}",
    ag_noTimeClocked: "Sin tiempo marcado en este trabajo",
    ag_late: "{d} tarde",
    ag_over: "{d} de más",
    ag_short: "{d} de menos",

    ag_btn_kindJob: "Trabajo",
    ag_btn_kindInspection: "Inspección",
    ag_btn_kindServiceCall: "Llamada de Servicio",
    ag_btn_kindOffice: "Oficina",
    ag_btn_kindQuote: "Cotización",
    ag_btn_kindPhoneCall: "Llamada",
    ag_btn_kindOther: "Otro",
    ag_nDays: "{n} días",
    ag_nUnsized: "{n} sin duración",
    ag_halfDay: "Medio día",
    ag_fullDay: "Día completo",
    ag_twoDays: "2 días",
    ag_threeDays: "3 días",
    ag_aWeek: "Una semana (5 días)",

    ag_pickADay: "Elige un día.",
    ag_pickTodayOrLater: "Elige hoy o después",
    ag_btn_noDaySet: "Sin Día",
    ag_btn_backToday: "Vuelve Hoy",
    ag_btn_backOn: "Vuelve {day}",
    ag_thatJob: "Ese trabajo",
    ag_offHold: "{who} estaba en pausa. Ya no está en pausa.",
    ag_offHoldWhy: "{who} estaba en pausa ({why}). Ya no está en pausa.",

    ag_job: "Trabajo",
    ag_newJobOn: "Trabajo Nuevo · {day}",

    ag_noTownYet: "Sin ciudad aún",
    ag_readyToSchedule: "Listo para programar",
    ag_callForAddress: "Llama para pedir la dirección",
    ag_noPhoneOrEmail: "Sin teléfono ni correo — ve a ver, o busca un número",
    ag_needsAddressAndNumber: "Falta una dirección y un número",
  },
};
