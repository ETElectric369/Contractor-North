// Lightweight i18n for employee-facing screens. Spanish falls back to English
// for any missing key. Keyed two ways: nav labels use their English text as the
// key (so the sidebar can translate in place); UI strings use semantic keys.

export type Lang = "en" | "es";

export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
];

type Dict = Record<string, string>;

const en: Dict = {
  // nav sections
  Overview: "Overview",
  Sales: "Sales",
  Operations: "Operations",
  Office: "Office",
  System: "System",
  // nav items
  Dashboard: "Dashboard",
  Assistant: "Assistant",
  Leads: "Leads",
  CRM: "CRM",
  Quotes: "Quotes",
  Schedule: "Schedule",
  "Work Orders": "Work Orders",
  Timeclock: "Timeclock",
  "Material Lists": "Material Lists",
  Purchasing: "Purchasing",
  Inventory: "Inventory",
  Billing: "Billing",
  "Change Orders": "Change Orders",
  Forms: "Forms",
  "Plans & LiDAR": "Plans & LiDAR",
  Settings: "Settings",
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
  tc_lunch: "Lunch (minutes)",
  tc_jobsToday: "Jobs worked today",
  tc_addJob: "Add job",
  tc_breakdownHint: "Optional: break your day down by job, with time and what you did.",
  tc_whatDone: "What was done on this job?",
  tc_allocated: "Allocated",
  tc_whatToday: "What did you do today?",
  tc_dictate: "Dictate",
  tc_stop: "Stop",
  tc_summarize: "Summarize the work performed…",
  tc_locationNote: "Your location is captured at clock in/out for job verification.",
  tc_since: "Since",
  tc_thisWeek: "This week",
  tc_recent: "Recent entries",
  tc_open: "open",
  tc_noEntries: "No entries in the last 7 days.",
  // settings
  s_language: "Language",
  s_languageDesc: "Your preferred language for the app and the AI assistant.",
};

const es: Dict = {
  Overview: "Resumen",
  Sales: "Ventas",
  Operations: "Operaciones",
  Office: "Oficina",
  System: "Sistema",
  Dashboard: "Panel",
  Assistant: "Asistente",
  Leads: "Prospectos",
  CRM: "Clientes",
  Quotes: "Cotizaciones",
  Schedule: "Agenda",
  "Work Orders": "Órdenes de trabajo",
  Timeclock: "Reloj",
  "Material Lists": "Listas de materiales",
  Purchasing: "Compras",
  Inventory: "Inventario",
  Billing: "Facturación",
  "Change Orders": "Órdenes de cambio",
  Forms: "Formularios",
  "Plans & LiDAR": "Planos y LiDAR",
  Settings: "Configuración",
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
  tc_lunch: "Almuerzo (minutos)",
  tc_jobsToday: "Trabajos de hoy",
  tc_addJob: "Agregar trabajo",
  tc_breakdownHint: "Opcional: desglosa tu día por trabajo, con tiempo y lo que hiciste.",
  tc_whatDone: "¿Qué se hizo en este trabajo?",
  tc_allocated: "Asignado",
  tc_whatToday: "¿Qué hiciste hoy?",
  tc_dictate: "Dictar",
  tc_stop: "Detener",
  tc_summarize: "Resume el trabajo realizado…",
  tc_locationNote: "Tu ubicación se captura al marcar entrada/salida para verificación.",
  tc_since: "Desde",
  tc_thisWeek: "Esta semana",
  tc_recent: "Entradas recientes",
  tc_open: "abierta",
  tc_noEntries: "Sin entradas en los últimos 7 días.",
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
