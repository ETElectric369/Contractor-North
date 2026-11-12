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
 * cn-v1158: Lost is the filed pile's third heading (lib/inspections filedUnder: a visit whose outcome is
 * lost, whatever its status). A pile's name, so feminine plural like its two neighbours: Perdidas. The
 * row's own button, ip_btn_lost, stays the singular Perdida: it answers for one visit.
 * cn-v1163: THE PILES ARE TILES. A tile is a button, so its name is ip_btn_tile… (Title Case, both
 * languages): Write Up, Coming Up, Needs a Day, Didn't Happen?, and under Filed: Completed, Lost,
 * Cancelled. Falta el Día is Needs You's own phrase for a thing with no day (ny_btn_pile_wonNeedsADay).
 * Each tile's quiet line is a phrase (sentence case). A row's ⋯ holds Move to Another Day…, It Happened:
 * Write It Up, Lost and Delete…; the old headings and the two big buttons of the Didn't Happen? group
 * are gone with their keys.
 */
export const words: WordCatalog = {
  prefix: "ip_",
  files: [
    "src/app/(app)/inspections/page.tsx",
    "src/app/(app)/inspections/inspections-board.tsx",
    "src/app/(app)/inspections/inspection-row-menu.tsx",
  ],
  sameInBoth: [],
  en: {
    // ── lib/inspections inspectionRowTags / rowTagWords ──
    ip_lib_pendingPick: "pending pick",
    ip_lib_cancelled: "cancelled",
    ip_lib_noFieldNotes: "no field notes",

    // ── The page (inspections/page.tsx): the switch, the tiles, the empty states ──
    ip_btn_open: "Open",
    ip_btn_filed: "Filed",
    ip_btn_tileWriteUp: "Write Up",
    ip_btn_tileComingUp: "Coming Up",
    ip_btn_tileNeedsADay: "Needs a Day",
    ip_btn_tileMissed: "Didn't Happen?",
    ip_btn_tileCompleted: "Completed",
    ip_btn_tileLost: "Lost",
    ip_btn_tileCancelled: "Cancelled",
    ip_tileOldest: "Oldest: {age}",
    ip_tileNext: "Next: {when}",
    ip_tilePastNoNotes: "Past, no notes",
    ip_tileWrittenUp: "Written up",
    ip_tileDidntBecomeWork: "Didn't become work",
    ip_tileCalledOff: "Called off",
    ip_tileNothing: "{name}: nothing here",
    ip_tileEmpty: "Nothing here now.",
    ip_capped: "Showing the {n} latest inspections. Older ones are not listed.",
    ip_nothingFiledTitle: "Nothing filed away yet",
    ip_nothingFiledDesc: "Inspections land here once they're written up into an estimate (or called off).",
    ip_noOpenInspections: "No open inspections",
    ip_emptyDescLeadsOn: "Start one from a lead, book one, or tap Start an Inspection when you're already there.",
    ip_emptyDescLeadsOff: "Nothing open right now.",
    ip_btn_bookAnInspection: "Book an Inspection",

    // ── A row's own verb and its ⋯ (inspection-row-menu.tsx) ──
    ip_btn_createEstimate: "Create Estimate",
    ip_btn_pickADay: "Pick a Day",
    ip_btn_moveToAnotherDay: "Move to Another Day…",
    ip_btn_itHappened: "It Happened: Write It Up",
    ip_btn_lost: "Lost",
    ip_btn_delete: "Delete…",
    ip_deleteAsk: "Delete this visit? It is removed if nothing is on it. If anything is (notes, an estimate, an invoice, a time-pick link), it is cancelled and kept on file.",
    ip_btn_deleteIt: "Delete",
    ip_movedToWriteUp: "Moved to Write Up.",
    ip_movedToDay: "Moved to {day}.",
    ip_backWhereItWas: "Back where it was.",
  },
  es: {
    ip_lib_pendingPick: "por elegir",
    ip_lib_cancelled: "cancelada",
    ip_lib_noFieldNotes: "sin notas de campo",

    // ── The page (inspections/page.tsx): the switch, the tiles, the empty states ──
    ip_btn_open: "Abiertas",
    ip_btn_filed: "Archivadas",
    ip_btn_tileWriteUp: "Por Redactar",
    ip_btn_tileComingUp: "Próximas",
    ip_btn_tileNeedsADay: "Falta el Día",
    ip_btn_tileMissed: "¿No Se Hizo?",
    ip_btn_tileCompleted: "Terminadas",
    ip_btn_tileLost: "Perdidas",
    ip_btn_tileCancelled: "Canceladas",
    ip_tileOldest: "La más antigua: {age}",
    ip_tileNext: "La próxima: {when}",
    ip_tilePastNoNotes: "Ya pasaron, sin notas",
    ip_tileWrittenUp: "Redactadas",
    ip_tileDidntBecomeWork: "No se volvieron trabajo",
    ip_tileCalledOff: "Se cancelaron",
    ip_tileNothing: "{name}: nada aquí",
    ip_tileEmpty: "No hay nada aquí por ahora.",
    ip_capped: "Se muestran las {n} inspecciones más recientes. Las más antiguas no aparecen.",
    ip_nothingFiledTitle: "Aún no hay nada archivado",
    ip_nothingFiledDesc: "Las inspecciones llegan aquí una vez que se redactan en un presupuesto (o se cancelan).",
    ip_noOpenInspections: "No hay inspecciones abiertas",
    ip_emptyDescLeadsOn: "Empieza una desde un prospecto, agenda una, o toca Empezar una Inspección cuando ya estés ahí.",
    ip_emptyDescLeadsOff: "No hay nada abierto ahora.",
    ip_btn_bookAnInspection: "Agendar una Inspección",

    // ── A row's own verb and its ⋯ (inspection-row-menu.tsx) ──
    ip_btn_createEstimate: "Crear Presupuesto",
    ip_btn_pickADay: "Elegir un Día",
    ip_btn_moveToAnotherDay: "Mover a Otro Día…",
    ip_btn_itHappened: "Sí Se Hizo: Redactarla",
    ip_btn_lost: "Perdida",
    ip_btn_delete: "Eliminar…",
    ip_deleteAsk: "¿Eliminar esta visita? Se elimina si no tiene nada. Si tiene algo (notas, un presupuesto, una factura, un enlace para elegir hora), se cancela y se conserva en el archivo.",
    ip_btn_deleteIt: "Eliminar",
    ip_movedToWriteUp: "Pasó a Por Redactar.",
    ip_movedToDay: "Se movió al {day}.",
    ip_backWhereItWas: "Volvió a donde estaba.",
  },
};
