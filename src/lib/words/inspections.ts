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
 * Write It Up, Lost and Dismiss… (cn-v1166: the door's one name); the old headings and the two big buttons of the Didn't Happen? group
 * are gone with their keys.
 * cn-v1170: Lost reads Not Sold (Erik: "Not Sold" replaces "Lost" everywhere). The tile is No Vendidas,
 * the row's button No Vendida; the key ids keep their old names.
 * cn-v1171: THE TILES ARE GONE: one list, the Open / Filed switch and the header's two buttons removed
 * with their keys. A row's boxed button is Start Inspection (Empezar Inspección, qt_btn_'s verb) or
 * Open Inspection (Abrir Inspección); its state words are plain keys in Title Case, Falta el Día as
 * before. The fold of filed inspections with nobody to file under: No Están a Nombre de Nadie. A
 * filed one's ending is singular and feminine (la inspección): Terminada, No Vendida, Cancelada.
 */
export const words: WordCatalog = {
  prefix: "ip_",
  files: [
    "src/app/(app)/inspections/page.tsx",
    "src/app/(app)/inspections/inspection-list.tsx",
    "src/app/(app)/inspections/inspection-row-menu.tsx",
    // cn-v1172 (EST): the one row builder, used by this page and the Estimates page's top list
    "src/app/(app)/inspections/row-words.ts",
    // cn-v1175 (ROWS): the offer's button and its ask
    "src/app/(app)/inspections/visit-offer-button.tsx",
    // cn-v1181 (I2b): the Not Sold fold's Delete… and its ask
    "src/app/(app)/inspections/fold-delete.tsx",
  ],
  sameInBoth: [],
  en: {
    // ── lib/inspections inspectionRowTags / rowTagWords ──
    ip_lib_pendingPick: "pending pick",
    ip_lib_cancelled: "cancelled",
    ip_lib_noFieldNotes: "no field notes",

    // ── The page (inspections/page.tsx): the cap and the empty state ──
    ip_capped: "Showing the {n} latest inspections. Older ones are not listed.",
    ip_noOpenInspections: "Nobody is waiting on an inspection",
    ip_emptyDescLeadsOn: "An inspection is scheduled from a lead.",
    ip_emptyDescLeadsOff: "Nothing open right now.",

    // ── A row's own verb and its ⋯ (inspection-row-menu.tsx) ──
    ip_btn_createEstimate: "Create Estimate",
    ip_btn_pickADay: "Pick a Day",
    ip_btn_moveToAnotherDay: "Move to Another Day…",
    ip_btn_itHappened: "It Happened: Write It Up",
    ip_btn_lost: "Not Sold",
    ip_btn_delete: "Dismiss…",
    ip_deleteAsk: "Dismiss this visit? It is deleted if nothing is on it. If anything is (notes, an estimate, an invoice, a time-pick link), it is cancelled and kept on file.",
    ip_btn_deleteIt: "Dismiss",
    ip_movedToWriteUp: "Marked as happened. It needs an estimate now.",
    ip_movedToDay: "Moved to {day}.",
    ip_backWhereItWas: "Back where it was.",

    // cn-v1171 (INSP): the one list, its row's words and buttons, the fold, the empty state's door
    ip_btn_startInspection: "Start Inspection",
    ip_btn_openInspection: "Open Inspection",
    ip_needsADay: "Needs a Day",
    ip_needsAnEstimate: "Needs an Estimate",
    ip_dayPassed: "Day Passed",
    // cn-v1175 (ROWS): the fold is Not Sold, its line in plain words; a win with no job says so on its row
    ip_btn_notSoldFold: "Not Sold ({n})",
    ip_notSoldLine: "Inspections that ended without becoming work and have no lead, customer or job to keep them. Each one says how it ended.",
    ip_wonNoJob: "Won, No Job Picked",
    // cn-v1175 (ROWS): the offer, asked in place and never assumed (lib/appointments/visit-offer)
    ip_btn_doneAs: "Done as {job}?",
    ip_offerAsk: "Tie this inspection to {job}? It is marked Won with that job and leaves this list.",
    ip_btn_doneAsYes: "Yes, Done as {job}",
    ip_offerTied: "Tied to {job}.",
    ip_endedCompleted: "Completed",
    ip_endedNotSold: "Not Sold",
    ip_endedCancelled: "Cancelled",
    ip_btn_goToLeads: "Go to Leads",
    // cn-v1171 (fixer, skeptic #74): with Estimates off, nothing says an estimate is needed
    ip_inspected: "Inspected",
    ip_markedHappened: "Marked as happened.",
    // cn-v1172 (EST): the inspected ones are on the Estimates page; a failed read is said
    ip_toEstimateWaiting: "{n} inspected and waiting on an estimate.",
    ip_btn_goToEstimates: "Go to Estimates",
    ip_readFailed: "The inspections couldn't load. Reload to try again.",
    // cn-v1181 (I2b): the Not Sold fold's Delete…, its ask, and the one door's answers (appointments/actions deleteEndedVisit)
    ip_btn_deleteVisit: "Delete…",
    ip_deleteVisitAsk: "Delete this visit for good? Only a visit with nothing on it is deleted. If anything is on it, it stays on file.",
    ip_btn_deleteVisitIt: "Delete",
    ip_srv_deleteNotEnded: "Only a visit that ended Not Sold or Cancelled is deleted here.",
    ip_srv_deleteHasSomebody: "This visit belongs to a lead, a customer or a job, so it stays on file with them.",
    ip_srv_keptOnFile: "Not deleted: this visit has {what} on it. It stays on file.",
    ip_srv_onNotes: "notes or answers",
    ip_srv_onEstimate: "an estimate",
    ip_srv_onInvoice: "an invoice",
    ip_srv_onLink: "a time-pick link",
    ip_srv_keptUnread: "Not deleted: part of this visit couldn't be checked. It stays on file.",
    ip_srv_deleteChanged: "This visit changed after it was read, so nothing was deleted. Try again.",
    // cn-v1181 (I3): the by-hand New Job door says the visit it filed (schedule/actions createJob)
    ip_srv_filedWithJob: "{visit} ({day}) is filed with this job.",
    ip_srv_tieFailed: "{visit} ({day}) matches this job but couldn't be filed with it. File it from Inspections.",
    ip_srv_tieUnread: "The open inspections couldn't be checked for this job. Any that match it are offered on Inspections.",
  },
  es: {
    ip_lib_pendingPick: "por elegir",
    ip_lib_cancelled: "cancelada",
    ip_lib_noFieldNotes: "sin notas de campo",

    // ── The page (inspections/page.tsx): the cap and the empty state ──
    ip_capped: "Se muestran las {n} inspecciones más recientes. Las más antiguas no aparecen.",
    ip_noOpenInspections: "Nadie está esperando una inspección",
    ip_emptyDescLeadsOn: "Una inspección se agenda desde un prospecto.",
    ip_emptyDescLeadsOff: "No hay nada abierto ahora.",

    // ── A row's own verb and its ⋯ (inspection-row-menu.tsx) ──
    ip_btn_createEstimate: "Crear Presupuesto",
    ip_btn_pickADay: "Elegir un Día",
    ip_btn_moveToAnotherDay: "Mover a Otro Día…",
    ip_btn_itHappened: "Sí Se Hizo: Redactarla",
    ip_btn_lost: "No Vendida",
    ip_btn_delete: "Descartar…",
    ip_deleteAsk: "¿Descartar esta visita? Se elimina si no tiene nada. Si tiene algo (notas, un presupuesto, una factura, un enlace para elegir hora), se cancela y se conserva en el archivo.",
    ip_btn_deleteIt: "Descartar",
    ip_movedToWriteUp: "Marcada como hecha. Ahora falta el presupuesto.",
    ip_movedToDay: "Se movió al {day}.",
    ip_backWhereItWas: "Volvió a donde estaba.",

    // cn-v1171 (INSP): the one list, its row's words and buttons, the fold, the empty state's door
    ip_btn_startInspection: "Empezar Inspección",
    ip_btn_openInspection: "Abrir Inspección",
    ip_needsADay: "Falta el Día",
    ip_needsAnEstimate: "Falta el Presupuesto",
    ip_dayPassed: "Ya Pasó el Día",
    // cn-v1175 (ROWS): the fold is Not Sold, its line in plain words; a win with no job says so on its row
    ip_btn_notSoldFold: "No Vendidas ({n})",
    ip_notSoldLine: "Inspecciones que terminaron sin convertirse en trabajo y no tienen prospecto, cliente ni trabajo donde guardarlas. Cada una dice cómo terminó.",
    ip_wonNoJob: "Ganada, Sin Trabajo Elegido",
    // cn-v1175 (ROWS): the offer, asked in place and never assumed (lib/appointments/visit-offer)
    ip_btn_doneAs: "¿Terminada como {job}?",
    ip_offerAsk: "¿Unir esta inspección a {job}? Se marca como Ganada con ese trabajo y sale de esta lista.",
    ip_btn_doneAsYes: "Sí, Terminada como {job}",
    ip_offerTied: "Unida a {job}.",
    ip_endedCompleted: "Terminada",
    ip_endedNotSold: "No Vendida",
    ip_endedCancelled: "Cancelada",
    ip_btn_goToLeads: "Ir a Prospectos",
    // cn-v1171 (fixer, skeptic #74): with Estimates off, nothing says an estimate is needed
    ip_inspected: "Inspeccionada",
    ip_markedHappened: "Marcada como hecha.",
    // cn-v1172 (EST): the inspected ones are on the Estimates page; a failed read is said
    ip_toEstimateWaiting: "{n} inspeccionadas y esperando un presupuesto.",
    ip_btn_goToEstimates: "Ir a Presupuestos",
    ip_readFailed: "No se pudieron cargar las inspecciones. Recarga para intentar de nuevo.",
    // cn-v1181 (I2b): the Not Sold fold's Delete…, its ask, and the one door's answers (appointments/actions deleteEndedVisit)
    ip_btn_deleteVisit: "Eliminar…",
    ip_deleteVisitAsk: "¿Eliminar esta visita para siempre? Solo se elimina una visita que no tiene nada. Si tiene algo, se conserva en el archivo.",
    ip_btn_deleteVisitIt: "Eliminar",
    ip_srv_deleteNotEnded: "Aquí solo se elimina una visita que terminó No Vendida o Cancelada.",
    ip_srv_deleteHasSomebody: "Esta visita pertenece a un prospecto, un cliente o un trabajo, así que se conserva en su archivo.",
    ip_srv_keptOnFile: "No se eliminó: esta visita tiene {what}. Se conserva en el archivo.",
    ip_srv_onNotes: "notas o respuestas",
    ip_srv_onEstimate: "un presupuesto",
    ip_srv_onInvoice: "una factura",
    ip_srv_onLink: "un enlace para elegir hora",
    ip_srv_keptUnread: "No se eliminó: no se pudo revisar parte de esta visita. Se conserva en el archivo.",
    ip_srv_deleteChanged: "Esta visita cambió después de leerla, así que no se eliminó nada. Intenta de nuevo.",
    // cn-v1181 (I3): the by-hand New Job door says the visit it filed (schedule/actions createJob)
    ip_srv_filedWithJob: "{visit} ({day}) quedó archivada con este trabajo.",
    ip_srv_tieFailed: "{visit} ({day}) coincide con este trabajo pero no se pudo archivar con él. Archívala desde Inspecciones.",
    ip_srv_tieUnread: "No se pudieron revisar las inspecciones abiertas para este trabajo. Las que coincidan se ofrecen en Inspecciones.",
  },
};
