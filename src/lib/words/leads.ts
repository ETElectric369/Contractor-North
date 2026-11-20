import type { WordCatalog } from "./types";

/**
 * THE LEADS' SCREENS (ld_, the Ventas-2 wave, cn-v1146): the Leads board and its row, Convert, the
 * lead's fields and modal, the referral tally, the plan brief, the intake files. The foundation
 * (builder A) made the shelf, named the screens, and moved in the status family and the two shared
 * libraries' words, so the leak test (tests/tech-words-in-the-catalog.test.ts) already lists every
 * English literal each screen still shows: that list is the work.
 *
 * The convention is lib/words/agenda's and lib/words/quotes': a clickable key is ld_btn_…, Title Case
 * in both languages (tests/words-parity.test.ts TITLE_CASE_FAMILIES holds the family); everything else
 * sentence case; plurals as paired keys (…One/…Many); a gendered noun as a whole-phrase key; a JSX
 * fragment as one key with {slots} through fillText (lib/i18n). The English is byte for byte what each
 * screen says today. Spanish is tú, US/Mexican, the house words: Prospecto = lead, Cliente = customer,
 * Inspección, Visita, Trabajo = job, Presupuesto = estimate, Cotización = quote, planos = plans,
 * Terraza = deck — grep the other catalogs before coining a word. Nothing a tenant's CUSTOMER reads
 * (the public /estimate configurator, the intake page) moves here: PROJECT_TYPES and LEAD_BUCKETS stay
 * English constants for those readers.
 *
 * THE LEAD STATUS FAMILY (ld_status_…): lib/statuses inquiryStatusLabel reads these for a Spanish
 * reader through the caller's translator. Lowercase, like the raw values every badge prints in English
 * ("new"); the SAME words as ag_srv_leadStatus_… (nuevo / contactado / cotizado / ganado / perdido).
 *
 * THE LIBRARIES (ld_lib_…). lib/lead-triage projectTypeLabel(value, lang, words) and
 * leadBucketWords(bucket, lang, words) (lib/leads/next-step's chip went with cn-v1170's row). Each keeps its English inline
 * — the default, byte for byte — and reads these keys only when handed a Spanish caller's translator
 * (lib/lang-words say); a library under src/lib never imports a catalog.
 *
 * WORDS COINED HERE (builder A, cn-v1146): barandal = railing; escaleras = stairs; ampliación =
 * add-on; tinte = staining; boceto = sketch; Consulta De Diseño = design consult; Visitado = Walked
 * (a lead, masculine: el prospecto); Volver A Llamar = Call Back; Reunión = Meeting (the chip's short
 * word, as jb_apptMeeting's long one).
 *
 * WORDS COINED HERE (builder B, cn-v1146, the screens): Follow Up = Seguimiento (nv_desc_leads said "dar
 * seguimiento" until cn-v1172); Follow-Ups Due = Seguimientos Pendientes; Mark Contacted / Mark Lost = Marcar Como
 * Contactado / Perdido; Referral tally = Conteo de referidos; Referrer = Referente; Book It = Agendar and
 * Let Them Pick = Que Ellos Elijan; Not Sure Yet = Aún No Sé; Arrival window = Ventana de llegada; Zip =
 * Código postal; State = Estado (EE. UU.); Town = Ciudad (agenda's); Schedule (the page) = Agenda, Schedule (the verb) = Agendar.
 * The text Text It hands the CUSTOMER (convert-menu's smsBody) stays English; leads-spanish.test pins it.
 * cn-v1147: in Spanish the function words (a, de, la, y…) stay lowercase after the first word ("Lista de
 * Precios", "Mover a un Día"); English keeps every word capitalized.
 */
export const words: WordCatalog = {
  prefix: "ld_",
  files: [
    "src/app/(app)/leads/page.tsx",
    "src/app/(app)/leads/inquiry-row.tsx",
    "src/app/(app)/leads/convert-menu.tsx",
    "src/app/(app)/leads/lead-doors.tsx",
    "src/app/(app)/leads/lead-clock.tsx",
    "src/app/(app)/leads/lead-marks.tsx",
    "src/app/(app)/leads/not-sold-fold.tsx",
    "src/app/(app)/leads/inquiry-fields.tsx",
    "src/app/(app)/leads/inquiry-modal.tsx",
    "src/app/(app)/leads/referral-tally.tsx",
    "src/app/(app)/leads/plan-brief-panel.tsx",
    // Also named by vp_ (the visit page's intake files, cn-v1144): its words already live there.
    "src/app/(app)/leads/intake-files.tsx",
    // FILE (cn-v1170): the lead's file.
    "src/app/(app)/leads/[id]/page.tsx",
    "src/app/(app)/leads/[id]/lead-file.tsx",
    "src/app/(app)/leads/[id]/file-doors.tsx",
    "src/app/(app)/leads/[id]/file-estimates.tsx",
    // cn-v1171 (CUST): a person's file, drawn on the lead's file and the customer's page.
    "src/components/file/visit-list.tsx",
    "src/components/file/lead-stage.ts",
    // cn-v1171 (PEOPLE): the one person block, drawn by the lead form and the customer form.
    "src/components/person-fields.tsx",
  ],
  sameInBoth: [],
  en: {
    // ── A lead's status (lib/statuses inquiryStatusLabel) ──
    ld_status_new: "new",
    ld_status_contacted: "contacted",
    ld_status_quoted: "quoted",
    ld_status_won: "won",
    ld_status_lost: "not sold",

    // ── lib/lead-triage: PROJECT_TYPES (projectTypeLabel) ──
    ld_lib_type_new_deck: "New deck",
    ld_lib_type_full_replacement: "Full deck replacement",
    ld_lib_type_resurface: "Resurface — new boards, keep the frame",
    ld_lib_type_railing: "Railing only",
    ld_lib_type_stairs: "Stairs only",
    ld_lib_type_extension: "Add-on / extension",
    ld_lib_type_repair: "Repair (rot, damage, loose boards)",
    ld_lib_type_staining: "Staining / refinishing",
    ld_lib_type_unsure: "Not sure — I need help",

    // ── lib/lead-triage: LEAD_BUCKETS (leadBucketWords) ──
    ld_lib_bucketA_label: "Ready to quote",
    ld_lib_bucketA_blurb: "Has plans — straight to a firm estimate.",
    ld_lib_bucketB_label: "Measure & quote",
    ld_lib_bucketB_blurb: "No plans, but a sketch and/or real dimensions.",
    ld_lib_bucketC_label: "Design consult",
    ld_lib_bucketC_blurb: "Needs a design conversation before any number.",

    // ── The Leads list (leads/page.tsx): the empty state ──
    ld_noOpenLeads: "No open leads",
    ld_emptyDesc: "Web submissions and leads you add show up here until they are scheduled or marked Not Sold — or add one with New Lead above.",
    ld_nothingOpen: "Nothing open right now.",

    // ── A lead's row and its doors (leads/inquiry-row.tsx, leads/lead-doors.tsx) ──
    ld_couldntMarkLost: "Couldn't mark it Not Sold — try again.",
    ld_markedLost: "Marked {name} Not Sold",
    ld_btn_undo: "Undo",
    ld_putBack: "Put back.",
    ld_couldntPutBack: "Couldn't put it back.",
    ld_fromYourWebsite: "From Your Website",
    ld_triageScore: "The website's triage score — bigger, readier and easier to reach scores higher.",
    ld_priority: "Priority {n}",
    ld_added: "Added {when}",
    ld_openInMaps: "Open in Maps",
    ld_btn_markLost: "Not Sold",
    ld_leadDeleted: "Lead deleted.",
    ld_btn_deleteLead: "Delete Lead",

    // ── The Schedule sheet: Book It, Let Them Pick, Start Now (leads/convert-menu.tsx) ──
    ld_bookInspectionStaysOpen: "Book an inspection, or start one now",
    ld_btn_schedule: "Schedule",
    ld_somethingWrong: "Something went wrong.",
    ld_btn_textThemTheseTimes: "Text Them These Times",
    ld_btn_bookAnInspection: "Book an Inspection",
    ld_btn_done: "Done",
    ld_btn_createLink: "Create Link",
    ld_btn_bookIt: "Book It",
    ld_btn_letThemPick: "Let Them Pick",
    ld_linkReady: "Link ready — text it to {name}. The visit confirms onto your calendar the moment they tap a time.",
    ld_btn_copied: "Copied",
    ld_btn_copyLink: "Copy Link",
    ld_btn_textIt: "Text It",
    ld_textItNotBusiness: "Text It opens this phone’s own messaging app, so it sends from this phone’s number — not {phone}. To send it from the business line, use Copy Link and paste it there.",
    ld_textItNoBusiness: "Text It opens this phone’s own messaging app, so it sends from this phone’s number. No business number is saved yet — Settings → Company is where it goes.",
    ld_booksInspectionFor: "Books an inspection for {name} onto your Schedule (a booking you can move or reassign). While the visit stands, the lead is off the Leads list.",
    ld_day: "Day",
    ld_defaultsToNine: "Defaults to 9:00 AM — fine-tune the time on the Schedule.",
    ld_offerUpToThree: "Offer up to 3 times — they tap one and it books itself",
    ld_optionDate: "Option {n} date",
    ld_optionTime: "Option {n} time",
    ld_arrivalWindow: "Arrival window (optional)",
    ld_arrivalExample: "e.g. 8–10 AM",

    // ── CORE (cn-v1170): the list, the row's clock, the doors, Start Now and the Not Sold fold ──
    ld_listCouldntLoad: "The leads couldn't load. Reload to try again.",
    ld_visitsUnread: "Couldn't check this lead's visits, so it is listed here in case.",
    ld_clockMinutes: "{m}m",
    ld_clockHoursMinutes: "{h}h {m}m",
    ld_clockDaysHours: "{d}d {h}h",
    ld_clockLabel: "Waiting {time} since it came in",
    ld_btn_reopen: "Reopen",
    ld_reopened: "Back on the Leads list.",
    ld_couldntReopen: "Couldn't reopen it — try again.",
    ld_btn_startNow: "Start Now",
    ld_startNowTitle: "Start the Inspection Now",
    ld_startNowSays: "Starts an inspection for {name} right now and opens it, for when you're already there.",
    ld_couldntStartInspection: "Couldn't start the inspection.",
    ld_btn_notSoldFold: "Not Sold ({n})",
    ld_notSoldCut: "Showing the {n} most recent.",
    ld_notSoldUnread: "The Not Sold leads couldn't load. Reload to try again.",
    // cn-v1170 fixer: a pick-a-time request that ran out unanswered; the customer's own visit request.
    ld_pickPending: "The times were sent and no pick has come back.",
    ld_needsVisit: "Needs a Visit",

    // ── FORM (cn-v1170): the lead form (leads/inquiry-fields.tsx) ──
    ld_name: "Name",
    ld_namePlaceholder: "Contact name (phone or note alone works)",
    ld_btn_business: "Business",
    ld_business: "Business",
    ld_address: "Address",
    ld_btn_cityStateZip: "City, State, ZIP",
    ld_city: "City",
    ld_state: "State",
    ld_zip: "Zip",
    ld_phone: "Phone",
    ld_email: "Email",
    ld_scope: "Scope",
    ld_scopePlaceholder: "What they need and the kind of work…",
    ld_notes: "Notes",
    ld_notesPlaceholder: "Only your team sees these.",
    ld_leadSource: "Lead Source",
    ld_leadSourcesUnread: "Your lead sources didn't load. Close the form and open it again to pick one.",

    // ── New Lead / Edit Lead (leads/inquiry-modal.tsx) ──
    ld_draftRestored: "Draft restored — pick up where you left off",
    ld_addSomethingToSave: "Add a name, phone number, or note to save this lead.",
    ld_btn_editDetails: "Edit Details",
    ld_btn_newLead: "New Lead",
    ld_btn_editLead: "Edit Lead",
    ld_btn_saveChanges: "Save Changes",
    ld_btn_createLead: "Create Lead",
    ld_couldntDelete: "Couldn't delete.",
    ld_btn_tapToConfirm: "Tap to Confirm",

    // ── The referral tally (leads/referral-tally.tsx) ──
    ld_refTitle: "Referral tally",
    ld_refDesc: "Who's sending work in — commission is a lookup, not a memory.",
    ld_refColReferrer: "Referrer",
    ld_refColLeads: "Leads",
    ld_refColWon: "Won",
    ld_refColWonValue: "Won value",
    ld_refUnknown: "Unknown",
    ld_refFoot: "Won value = accepted quote totals for the customer a lead converted into.",
    ld_refFootUnlinked: "Some converted leads have no accepted quote yet, so they count but carry no value.",

    // ── The plan brief (leads/plan-brief-panel.tsx) ──
    ld_couldntReadPlans: "Couldn't read the plans.",
    ld_reportReady: "Preliminary report ready.",
    ld_btn_readingThePlans: "Reading the Plans…",
    ld_btn_readThePlans: "Read the Plans",
    ld_readingPlansWait: "Reading the plans — the preliminary report will be here in a minute.",
    ld_planReadingUnfinished: "The plan reading didn't finish.",
    ld_plansCouldntBeRead: "The plans couldn't be read.",
    ld_btn_tryAgain: "Try Again",
    ld_reportFromPlans: "Preliminary report — from the plans",
    ld_includes: "Includes:",
    ld_excludes: "Excludes:",
    ld_verifyOnSite: "Verify on site:",
    ld_notRead: "Not read:",
    ld_couldntOpenInspection: "Couldn't open the inspection.",
    ld_btn_openTheInspection: "Open the Inspection",
    ld_answersReadyOne: "(1 answer ready)",
    ld_answersReadyMany: "({n} answers ready)",
    ld_btn_readAgain: "Read Again",

    // ── FILE (cn-v1170): the lead's file, /leads/<id> (leads/[id]/lead-file.tsx, file-doors.tsx) ──
    ld_btn_fileBackToLeads: "Back to Leads",
    ld_file_stageOpen: "On the Leads List",
    ld_btn_fileStageStanding: "{what} on the Books · {when}",
    ld_file_stageNotSold: "Not Sold",
    ld_file_stageCustomer: "Became a Customer",
    ld_file_stageEstimate: "Became an Estimate",
    ld_file_stageJob: "Became a Job",
    ld_file_stageConverted: "Converted",
    ld_file_arrived: "Came in {when}",
    ld_file_leadUnread: "This lead couldn't load. Reload to try again.",
    ld_file_contact: "Contact",
    ld_file_referredBy: "Referred by {name}",
    ld_file_lastContacted: "Last contacted {day}",
    ld_file_handOver: "This lead has its own customer file.",
    ld_btn_fileOpenCustomer: "Open Customer File · {name}",
    ld_btn_fileOpenCustomerPlain: "Open the Customer's File",
    ld_file_noScope: "No scope written yet.",
    ld_file_fromRequest: "From Their Request",
    ld_file_inspections: "Inspections",
    ld_file_noInspections: "No inspection yet.",
    ld_file_visitsUnread: "Couldn't check this lead's visits, so its doors are offered in case. Reload to try again.",
    ld_file_inspectionsUnread: "Couldn't load its inspections. Reload to try again.",
    ld_btn_fileWaitingForADay: "Waiting for a Day",
    ld_btn_fileWaitingOnPick: "Waiting on Their Pick",
    ld_btn_fileVisitBooked: "Booked",
    ld_btn_fileVisitDone: "Done",
    ld_btn_fileVisitWon: "Won",
    ld_btn_fileVisitNotSold: "Not Sold",
    ld_file_estimates: "Estimates",
    ld_file_noEstimates: "No estimate yet.",
    ld_file_estimatesUnread: "Couldn't load its estimates. Reload to try again.",
    ld_btn_fileStartEstimate: "Start an Estimate",
    ld_btn_fileStarting: "Starting…",
    ld_file_couldntStartEstimate: "Couldn't start the estimate — try again.",
    ld_file_jobs: "Jobs",
    ld_file_jobsUnread: "Couldn't load its jobs. Reload to try again.",
    ld_btn_fileSaveAsContact: "Save as Contact",
    ld_file_savedAsContact: "Saved {name} as a Contact",
    ld_file_linkedTo: "Linked to {name}",
    ld_file_couldntMakeContact: "Couldn't make a contact from this lead.",
    ld_btn_fileOpen: "Open",
    // cn-v1171 (CUST)
    ld_btn_fileVisitCancelled: "Cancelled",
    // cn-v1171 (fixer, skeptic #74)
    ld_wonPending: "Its inspection was marked Won and no job was picked. Open the inspection to pick the job.",
    // cn-v1172 (EST): the Not Sold fold's second kind (fixer: one word for an ending, Not Sold)
    ld_notSoldByEstimate: "Estimate Not Sold",
    // cn-v1172 (fixer): the estimates' part of the fold could not be read; the hand-marked still are
    ld_notSoldByEstimateUnread: "The leads whose estimate was not sold couldn't load. Reload to try again.",
  },
  es: {
    ld_status_new: "nuevo",
    ld_status_contacted: "contactado",
    ld_status_quoted: "cotizado",
    ld_status_won: "ganado",
    ld_status_lost: "no vendido",

    ld_lib_type_new_deck: "Terraza nueva",
    ld_lib_type_full_replacement: "Reemplazo completo de la terraza",
    ld_lib_type_resurface: "Renovar la superficie — tablas nuevas, la misma estructura",
    ld_lib_type_railing: "Solo barandal",
    ld_lib_type_stairs: "Solo escaleras",
    ld_lib_type_extension: "Ampliación / extensión",
    ld_lib_type_repair: "Reparación (madera podrida, daños, tablas sueltas)",
    ld_lib_type_staining: "Tinte / renovar el acabado",
    ld_lib_type_unsure: "No estoy seguro — necesito ayuda",

    ld_lib_bucketA_label: "Listo para cotizar",
    ld_lib_bucketA_blurb: "Tiene planos — directo a un presupuesto firme.",
    ld_lib_bucketB_label: "Medir y cotizar",
    ld_lib_bucketB_blurb: "Sin planos, pero con un boceto y/o medidas reales.",
    ld_lib_bucketC_label: "Consulta de diseño",
    ld_lib_bucketC_blurb: "Necesita una conversación de diseño antes de cualquier número.",

    ld_noOpenLeads: "No hay prospectos abiertos",
    ld_emptyDesc: "Las solicitudes de la web y los prospectos que agregas aparecen aquí hasta que se agendan o se marcan como no vendidos — o agrega uno con Nuevo Prospecto arriba.",
    ld_nothingOpen: "Nada abierto por ahora.",

    ld_couldntMarkLost: "No se pudo marcar como no vendido — intenta de nuevo.",
    ld_markedLost: "{name} marcado como no vendido",
    ld_btn_undo: "Deshacer",
    ld_putBack: "Devuelto.",
    ld_couldntPutBack: "No se pudo devolver.",
    ld_fromYourWebsite: "Desde Tu Sitio Web",
    ld_triageScore: "La puntuación de clasificación del sitio web — más grande, más listo y más fácil de contactar puntúa más alto.",
    ld_priority: "Prioridad {n}",
    ld_added: "Agregado {when}",
    ld_openInMaps: "Abrir en Mapas",
    ld_btn_markLost: "No Vendido",
    ld_leadDeleted: "Prospecto eliminado.",
    ld_btn_deleteLead: "Eliminar Prospecto",

    ld_bookInspectionStaysOpen: "Agenda una inspección o empieza una ahora",
    ld_btn_schedule: "Agendar",
    ld_somethingWrong: "Algo salió mal.",
    ld_btn_textThemTheseTimes: "Envíales Estas Horas por Mensaje",
    ld_btn_bookAnInspection: "Agendar una Inspección",
    ld_btn_done: "Hecho",
    ld_btn_createLink: "Crear Enlace",
    ld_btn_bookIt: "Agendar",
    ld_btn_letThemPick: "Que Ellos Elijan",
    ld_linkReady: "Enlace listo — envíaselo por mensaje a {name}. La visita se confirma en tu calendario en cuanto toquen una hora.",
    ld_btn_copied: "Copiado",
    ld_btn_copyLink: "Copiar Enlace",
    ld_btn_textIt: "Enviar por Mensaje",
    ld_textItNotBusiness: "Enviar por Mensaje abre la app de mensajes de este teléfono, así que lo manda desde el número de este teléfono — no desde {phone}. Para mandarlo desde la línea del negocio, usa Copiar Enlace y pégalo ahí.",
    ld_textItNoBusiness: "Enviar por Mensaje abre la app de mensajes de este teléfono, así que lo manda desde el número de este teléfono. Aún no hay un número del negocio guardado — va en Ajustes → Empresa.",
    ld_booksInspectionFor: "Pone una inspección para {name} en tu Agenda (una cita que puedes mover o reasignar). Mientras la visita siga en pie, el prospecto sale de la lista de prospectos.",
    ld_day: "Día",
    ld_defaultsToNine: "Queda a las 9:00 AM — ajusta la hora en la Agenda.",
    ld_offerUpToThree: "Ofrece hasta 3 horas — tocan una y se agenda sola",
    ld_optionDate: "Fecha de la opción {n}",
    ld_optionTime: "Hora de la opción {n}",
    ld_arrivalWindow: "Ventana de llegada (opcional)",
    ld_arrivalExample: "p. ej. 8–10 AM",

    // ── CORE (cn-v1170): la lista, el reloj de la fila, las puertas, Empezar Ahora y No Vendidos ──
    ld_listCouldntLoad: "No se pudieron cargar los prospectos. Recarga para intentar de nuevo.",
    ld_visitsUnread: "No se pudieron revisar las visitas de este prospecto, así que aparece aquí por si acaso.",
    ld_clockMinutes: "{m} min",
    ld_clockHoursMinutes: "{h} h {m} min",
    ld_clockDaysHours: "{d} d {h} h",
    ld_clockLabel: "Esperando {time} desde que llegó",
    ld_btn_reopen: "Reabrir",
    ld_reopened: "De vuelta en la lista de prospectos.",
    ld_couldntReopen: "No se pudo reabrir — intenta de nuevo.",
    ld_btn_startNow: "Empezar Ahora",
    ld_startNowTitle: "Empezar la Inspección Ahora",
    ld_startNowSays: "Empieza una inspección para {name} ahora mismo y la abre, para cuando ya estás ahí.",
    ld_couldntStartInspection: "No se pudo empezar la inspección.",
    ld_btn_notSoldFold: "No Vendidos ({n})",
    ld_notSoldCut: "Se muestran los {n} más recientes.",
    ld_notSoldUnread: "No se pudieron cargar los prospectos no vendidos. Recarga para intentar de nuevo.",
    // cn-v1170 fixer: una petición de horarios sin respuesta; la visita que el cliente pidió.
    ld_pickPending: "Se enviaron los horarios y no ha elegido ninguno.",
    ld_needsVisit: "Necesita una Visita",

    // ── FORM (cn-v1170): the lead form ──
    ld_name: "Nombre",
    ld_namePlaceholder: "Nombre del contacto (basta con un teléfono o una nota)",
    ld_btn_business: "Empresa",
    ld_business: "Empresa",
    ld_address: "Dirección",
    ld_btn_cityStateZip: "Ciudad, Estado, Código Postal",
    ld_city: "Ciudad",
    ld_state: "Estado (EE. UU.)",
    ld_zip: "Código postal",
    ld_phone: "Teléfono",
    ld_email: "Correo",
    ld_scope: "Alcance",
    ld_scopePlaceholder: "Lo que necesitan y el tipo de trabajo…",
    ld_notes: "Notas",
    ld_notesPlaceholder: "Solo tu equipo las ve.",
    ld_leadSource: "Origen del Prospecto",
    ld_leadSourcesUnread: "Tus orígenes de prospectos no cargaron. Cierra el formulario y ábrelo de nuevo para elegir uno.",

    ld_draftRestored: "Borrador recuperado — sigue donde lo dejaste",
    ld_addSomethingToSave: "Agrega un nombre, un número de teléfono o una nota para guardar este prospecto.",
    ld_btn_editDetails: "Editar Detalles",
    ld_btn_newLead: "Nuevo Prospecto",
    ld_btn_editLead: "Editar Prospecto",
    ld_btn_saveChanges: "Guardar Cambios",
    ld_btn_createLead: "Crear Prospecto",
    ld_couldntDelete: "No se pudo eliminar.",
    ld_btn_tapToConfirm: "Toca para Confirmar",

    ld_refTitle: "Conteo de referidos",
    ld_refDesc: "Quién te manda trabajo — la comisión se consulta, no se recuerda.",
    ld_refColReferrer: "Referente",
    ld_refColLeads: "Prospectos",
    ld_refColWon: "Ganados",
    ld_refColWonValue: "Valor ganado",
    ld_refUnknown: "Desconocido",
    ld_refFoot: "Valor ganado = los totales de las cotizaciones aceptadas del cliente en que se convirtió un prospecto.",
    ld_refFootUnlinked: "Algunos prospectos convertidos aún no tienen una cotización aceptada, así que cuentan pero no suman valor.",

    ld_couldntReadPlans: "No se pudieron leer los planos.",
    ld_reportReady: "Informe preliminar listo.",
    ld_btn_readingThePlans: "Leyendo los Planos…",
    ld_btn_readThePlans: "Leer los Planos",
    ld_readingPlansWait: "Leyendo los planos — el informe preliminar estará aquí en un minuto.",
    ld_planReadingUnfinished: "La lectura de los planos no terminó.",
    ld_plansCouldntBeRead: "No se pudieron leer los planos.",
    ld_btn_tryAgain: "Intentar de Nuevo",
    ld_reportFromPlans: "Informe preliminar — de los planos",
    ld_includes: "Incluye:",
    ld_excludes: "Excluye:",
    ld_verifyOnSite: "Verificar en el sitio:",
    ld_notRead: "Sin leer:",
    ld_couldntOpenInspection: "No se pudo abrir la inspección.",
    ld_btn_openTheInspection: "Abrir la Inspección",
    ld_answersReadyOne: "(1 respuesta lista)",
    ld_answersReadyMany: "({n} respuestas listas)",
    ld_btn_readAgain: "Leer de Nuevo",

    // ── FILE (cn-v1170): la ficha del prospecto, /leads/<id> ──
    ld_btn_fileBackToLeads: "Volver a Prospectos",
    ld_file_stageOpen: "En la Lista de Prospectos",
    ld_btn_fileStageStanding: "{what} Agendada · {when}",
    ld_file_stageNotSold: "No Vendido",
    ld_file_stageCustomer: "Se Convirtió en Cliente",
    ld_file_stageEstimate: "Se Convirtió en Presupuesto",
    ld_file_stageJob: "Se Convirtió en Trabajo",
    ld_file_stageConverted: "Convertido",
    ld_file_arrived: "Llegó el {when}",
    ld_file_leadUnread: "No se pudo cargar este prospecto. Recarga para intentar de nuevo.",
    ld_file_contact: "Contacto",
    ld_file_referredBy: "Referido por {name}",
    ld_file_lastContacted: "Último contacto: {day}",
    ld_file_handOver: "Este prospecto ya tiene su propia ficha de cliente.",
    ld_btn_fileOpenCustomer: "Abrir Ficha de Cliente · {name}",
    ld_btn_fileOpenCustomerPlain: "Abrir la Ficha del Cliente",
    ld_file_noScope: "Aún no hay alcance escrito.",
    ld_file_fromRequest: "De Su Solicitud",
    ld_file_inspections: "Inspecciones",
    ld_file_noInspections: "Aún no hay inspección.",
    ld_file_visitsUnread: "No se pudieron revisar las visitas de este prospecto, así que sus puertas se ofrecen por si acaso. Recarga para intentar de nuevo.",
    ld_file_inspectionsUnread: "No se pudieron cargar sus inspecciones. Recarga para intentar de nuevo.",
    ld_btn_fileWaitingForADay: "Esperando un Día",
    ld_btn_fileWaitingOnPick: "Esperando Su Elección",
    ld_btn_fileVisitBooked: "Agendada",
    ld_btn_fileVisitDone: "Hecha",
    ld_btn_fileVisitWon: "Ganada",
    ld_btn_fileVisitNotSold: "No Vendida",
    ld_file_estimates: "Presupuestos",
    ld_file_noEstimates: "Aún no hay presupuesto.",
    ld_file_estimatesUnread: "No se pudieron cargar sus presupuestos. Recarga para intentar de nuevo.",
    ld_btn_fileStartEstimate: "Empezar un Presupuesto",
    ld_btn_fileStarting: "Empezando…",
    ld_file_couldntStartEstimate: "No se pudo empezar el presupuesto — intenta de nuevo.",
    ld_file_jobs: "Trabajos",
    ld_file_jobsUnread: "No se pudieron cargar sus trabajos. Recarga para intentar de nuevo.",
    ld_btn_fileSaveAsContact: "Guardar como Contacto",
    ld_file_savedAsContact: "Guardado como Contacto: {name}",
    ld_file_linkedTo: "Enlazado a {name}",
    ld_file_couldntMakeContact: "No se pudo crear un contacto con este prospecto.",
    ld_btn_fileOpen: "Abrir",
    // cn-v1171 (CUST)
    ld_btn_fileVisitCancelled: "Cancelada",
    // cn-v1171 (fixer, skeptic #74)
    ld_wonPending: "Su inspección se marcó como Ganada y no se eligió un trabajo. Abre la inspección para elegir el trabajo.",
    // cn-v1172 (EST): the Not Sold fold's second kind (fixer: one word for an ending, Not Sold)
    ld_notSoldByEstimate: "Presupuesto No Vendido",
    // cn-v1172 (fixer): the estimates' part of the fold could not be read; the hand-marked still are
    ld_notSoldByEstimateUnread: "No se pudieron cargar los prospectos cuyo presupuesto no se vendió. Recarga para intentar de nuevo.",
  },
};
