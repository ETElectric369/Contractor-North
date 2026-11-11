import type { WordCatalog } from "./types";

/**
 * THE INSPECTIONS TAB (ip_, the Ventas-2 wave, cn-v1146): Sales › Inspections (/inspections), its
 * piles and its rows. The foundation (builder A) made the shelf, named the screen and moved in the
 * row tags' words (lib/inspections inspectionRowTags), so the leak test
 * (tests/tech-words-in-the-catalog.test.ts) already lists every English literal the page still shows:
 * that list is the work. (lib/inspections.ts is the LIBRARY; this file is its words.)
 *
 * A clickable key is ip_btn_…, Title Case in both languages. Spanish is tú, US/Mexican, the house words
 * (Inspección, Visita — feminine, so a visit's tag agrees: cancelada, the word of ag_srv_apptStatus_ and
 * vp_cancelledBadge — Presupuesto, Prospecto). The tags are lowercase, like the English.
 *
 * THE LIBRARY (ip_lib_…). inspectionRowTags(row, writeUp, lang, words) keeps its English inline — the
 * default, byte for byte — and reads these keys only when handed a Spanish caller's translator.
 *
 * WORDS COINED HERE (builder A, cn-v1146): notas de campo = field notes; por elegir = pending pick.
 * (builder D): the piles are the inspections' own, so feminine plural — Abiertas (Open), Terminadas
 * (Completed: jb_completedShelf's Terminados, agreeing), Canceladas, Próximas y propuestas; written up =
 * redactada (vp_writtenUpAs); Book An Inspection / Start An Inspection = qt_btn_'s Agendar / Empezar Una
 * Inspección; Create Estimate = Crear Presupuesto.
 * cn-v1147: in Spanish the function words (a, de, la, y…) stay lowercase after the first word ("Lista de
 * Precios", "Mover a un Día"); English keeps every word capitalized.
 * cn-v1158: ip_lost, the filed pile's third heading (lib/inspections filedUnder: a visit whose outcome is
 * lost, whatever its status). A pile's name, so feminine plural like its two neighbours: Perdidas. The
 * row's own button, ip_btn_lost, stays the singular Perdida: it answers for one visit.
 */
export const words: WordCatalog = {
  prefix: "ip_",
  files: ["src/app/(app)/inspections/page.tsx", "src/app/(app)/inspections/missed-doors.tsx"],
  sameInBoth: [],
  en: {
    // ── lib/inspections inspectionRowTags ──
    ip_lib_pendingPick: "pending pick",
    ip_lib_cancelled: "cancelled",
    ip_lib_noFieldNotes: "no field notes",

    // ── The page (inspections/page.tsx) ──
    ip_btn_open: "Open",
    ip_btn_completed: "Completed",
    ip_nothingFiledTitle: "Nothing filed away yet",
    ip_nothingFiledDesc: "Inspections land here once they're written up into an estimate (or called off).",
    ip_completedWrittenUp: "Completed & written up",
    ip_lost: "Lost",
    ip_cancelled: "Cancelled",
    ip_noOpenInspections: "No open inspections",
    ip_emptyDescLeadsOn: "Start one from a lead, book one, or tap Start an Inspection when you're already there.",
    ip_emptyDescLeadsOff: "Nothing open right now.",
    ip_toWriteUp: "To write up ({n})",
    ip_upcomingProposed: "Upcoming & proposed",
    ip_waitingForADay: "Waiting for a Day",
    ip_btn_createEstimate: "Create Estimate",
    ip_btn_bookAnInspection: "Book an Inspection",
    ip_missed: "Didn't Happen?",
    ip_btn_didntHappen: "Didn't Happen",
    ip_btn_lost: "Lost",
    ip_didntHappenAsk: "This visit didn't happen? It is removed if nothing was captured on it, otherwise it is cancelled and kept on file.",
  },
  es: {
    ip_lib_pendingPick: "por elegir",
    ip_lib_cancelled: "cancelada",
    ip_lib_noFieldNotes: "sin notas de campo",

    // ── The page (inspections/page.tsx) ──
    ip_btn_open: "Abiertas",
    ip_btn_completed: "Terminadas",
    ip_nothingFiledTitle: "Aún no hay nada archivado",
    ip_nothingFiledDesc: "Las inspecciones llegan aquí una vez que se redactan en un presupuesto (o se cancelan).",
    ip_completedWrittenUp: "Terminadas y redactadas",
    ip_lost: "Perdidas",
    ip_cancelled: "Canceladas",
    ip_noOpenInspections: "No hay inspecciones abiertas",
    ip_emptyDescLeadsOn: "Empieza una desde un prospecto, agenda una, o toca Empezar una Inspección cuando ya estés ahí.",
    ip_emptyDescLeadsOff: "No hay nada abierto ahora.",
    ip_toWriteUp: "Por redactar ({n})",
    ip_upcomingProposed: "Próximas y propuestas",
    ip_waitingForADay: "Esperando un Día",
    ip_btn_createEstimate: "Crear Presupuesto",
    ip_btn_bookAnInspection: "Agendar una Inspección",
    ip_missed: "¿No Se Hizo?",
    ip_btn_didntHappen: "No Se Hizo",
    ip_btn_lost: "Perdida",
    ip_didntHappenAsk: "¿Esta visita no se hizo? Se elimina si no se capturó nada en ella; si no, se cancela y se conserva en el archivo.",
  },
};
