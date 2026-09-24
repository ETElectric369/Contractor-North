// Lightweight i18n for employee-facing screens. Spanish falls back to English
// for any missing key; UI strings use semantic keys (tc_* timeclock, s_* settings).
// The old nav-label dictionary (English-text keys for a sidebar that would
// "translate in place") was dead data — no nav code ever imported i18n (the glass
// dock hardcodes labels) and several keys named features retired in cn-v496
// (Scheduler, Plans & LiDAR) — removed in the 2026-07-16 churn audit.

export type Lang = "en" | "es";

export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
];

type Dict = Record<string, string>;

const en: Dict = {
  // timeclock
  tc_title: "Timeclock",
  tc_desc: "Clock in and out, log lunch, and record what you worked on.",
  tc_notClockedIn: "You're not clocked in.",
  tc_clockedIn: "Clocked in",
  tc_clockIn: "Clock in",
  tc_clockOut: "Clock out",
  tc_clockingIn: "Clocking in…",
  tc_clockingOut: "Clocking out…",
  tc_job: "Job (optional)",
  tc_noJob: "— No job —",
  tc_jobCode: "Job code",
  tc_selectCode: "— Select code —",
  tc_whatToday: "What did you do today?",
  tc_dictate: "Dictate",
  tc_stop: "Stop",
  tc_summarize: "Summarize the work performed…",
  // Honest about the web ceiling: no background GPS — the catch happens at next open,
  // and the evening sweep flags anything still running.
  tc_locationNote: "Location is stamped at clock in/out when it's available. Drive off with the app closed? You'll get a clock-out prompt the next time you open it.",
  tc_since: "Since",
  tc_thisWeek: "This week",
  // After a Switch Job the running entry is only the part since the switch (0288); these say the
  // whole shift, where the lunch lands, and what the switch did. {x} fills from the panel.
  tc_shiftSoFar: "This shift so far: {total}",
  tc_wrapUpTitle: "Wrapping up your day",
  tc_wrapUpBody: "You worked {total} on {job}. Add miles and a note, then clock out.",
  tc_wrapUpBodySplit: "You worked {total} this shift, {part} of it on {job}. Add miles and a note, then clock out.",
  tc_lunchOnPrev: "The lunch goes on {job}.",
  tc_lunchOnThis: "The lunch goes on this part of your shift.",
  tc_putOnThis: "Put It On This Part Instead",
  tc_putOnPrev: "Put It On {job} Instead",
  tc_switchedCut: "Switched to {job}. The first part is its own entry ({hours}).",
  tc_switchedWhole: "Now on {job}. This whole shift moved over.",
  // A clock running LONG_SHIFT_HOURS (twelve) or more (lib/long-shift): the card asks when he stopped instead of
  // closing at now. {when} fills from the panel.
  tc_longShiftTitle: "You're still clocked in from {when}.",
  tc_longShiftBody: "When did you stop?",
  tc_whenStopped: "The time you stopped work on this shift.",
  tc_nowChip: "Now ({hours} h)",
  tc_clockOutAtThatTime: "Clock Out At That Time",
  tc_pickStop: "Pick the time you stopped.",
  // settings
  s_language: "Language",
  s_languageDesc: "Your preferred language for the app and the AI assistant.",
};

const es: Dict = {
  tc_title: "Reloj de tiempo",
  tc_desc: "Marca entrada y salida, registra el almuerzo y lo que trabajaste.",
  tc_notClockedIn: "No has marcado entrada.",
  tc_clockedIn: "Entrada marcada",
  tc_clockIn: "Marcar entrada",
  tc_clockOut: "Marcar salida",
  tc_clockingIn: "Marcando entrada…",
  tc_clockingOut: "Marcando salida…",
  tc_job: "Trabajo (opcional)",
  tc_noJob: "— Sin trabajo —",
  tc_jobCode: "Código de trabajo",
  tc_selectCode: "— Selecciona código —",
  tc_whatToday: "¿Qué hiciste hoy?",
  tc_dictate: "Dictar",
  tc_stop: "Detener",
  tc_summarize: "Resume el trabajo realizado…",
  tc_locationNote: "La ubicación se registra al marcar entrada/salida cuando está disponible. ¿Te fuiste con la app cerrada? Se te pedirá marcar salida al volver a abrirla.",
  tc_since: "Desde",
  tc_thisWeek: "Esta semana",
  tc_shiftSoFar: "Este turno hasta ahora: {total}",
  tc_wrapUpTitle: "Terminando tu día",
  tc_wrapUpBody: "Trabajaste {total} en {job}. Agrega millas y una nota, y marca salida.",
  tc_wrapUpBodySplit: "Trabajaste {total} en este turno, {part} de eso en {job}. Agrega millas y una nota, y marca salida.",
  tc_lunchOnPrev: "El almuerzo va en {job}.",
  tc_lunchOnThis: "El almuerzo va en esta parte de tu turno.",
  tc_putOnThis: "Ponerlo En Esta Parte",
  tc_putOnPrev: "Ponerlo En {job}",
  tc_switchedCut: "Cambiaste a {job}. La primera parte es su propia entrada ({hours}).",
  tc_switchedWhole: "Ahora en {job}. Todo este turno se movió.",
  tc_longShiftTitle: "Sigues con entrada marcada desde {when}.",
  tc_longShiftBody: "¿A qué hora terminaste?",
  tc_whenStopped: "La hora en que terminaste de trabajar en este turno.",
  tc_nowChip: "Ahora ({hours} h)",
  tc_clockOutAtThatTime: "Marcar Salida A Esa Hora",
  tc_pickStop: "Elige la hora en que terminaste.",
  s_language: "Idioma",
  s_languageDesc: "Tu idioma preferido para la app y el asistente de IA.",
};

export function dict(lang: string | null | undefined): Dict {
  return lang === "es" ? { ...en, ...es } : en;
}

/** Convenience translator bound to a language. */
export function translator(lang: string | null | undefined) {
  const d = dict(lang);
  return (key: string) => d[key] ?? key;
}

/** A translated string with its {name} slots filled: fillText(t("tc_lunchOnPrev"), { job }). */
export function fillText(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}
