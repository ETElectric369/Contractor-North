import type { WordCatalog } from "./types";

/**
 * THE VISIT PAGE (vp_, the visit-page-in-Spanish wave, cn-v1144): the page a tech opens from the
 * schedule (/appointments/[id]) and its pieces — the header's actions, the start card, the link
 * picker, the ending, Mark Complete — and what its hear-actions answer. Builder C fills this
 * catalog; the foundation (builder A) made the shelf and named the screens, so the leak test
 * (tests/tech-words-in-the-catalog.test.ts) already lists every English literal each one still
 * shows: that list is the work.
 *
 * The convention is lib/words/agenda's: a clickable key is vp_btn_…, Title Case in both languages
 * (tests/words-parity.test.ts TITLE_CASE_FAMILIES holds the family); everything else sentence case;
 * plurals as paired keys (…One/…Many); a gendered noun as a whole-phrase key; a JSX fragment as one
 * key with {slots} through fillText (lib/i18n). The page is a server component: it reads
 * translator(currentLangFor(...)) the way the schedule's page does; its client pieces read
 * useLang(); a "use server" file (hear-actions) reads the caller's language once per call
 * (callerLang, lib/lang-of) and exports only async functions. The English must be byte for byte
 * what each screen says today. Spanish is tú, US/Mexican, the house words (Visita, Cita, Trabajo,
 * Cliente, Programado, Agendar; done = Hecho/hecha; delete = Eliminar; hold it = Pausarlo) — grep
 * the other catalogs before coining a word. The Inspector's words are lib/words/visit-inspector
 * (vi_); the Settle Up button's are lib/words/settle-up (su_); the appointment status control's
 * and the actions' are lib/words/agenda-server (ag_srv_).
 *
 * THE WORDS THE OTHER CATALOGS ALREADY SAY, kept to one Spanish each (the visit-page-spanish test
 * cross-checks them): Start = Empezar (sh_help_startHere, tc_startingNow), Clock In = Marcar Entrada
 * (tc_clockIn), on the clock = en el reloj and a punch = la marcación (jb_switchCutBody, jb_switchedWhole),
 * Link = Enlazar (jb_link, jb_linking), Pick = Elegir (ag_rail_btn_pickADay, md_pickTheJob), Keep =
 * Dejar (jb_keep, ag_cal_btn_keep), Make = Crear (ag_rail_btn_createJob), Ask = Pídele (sh_askTheOwner),
 * Back To = Volver A (mt_backToLists), Schedule = Agenda (sh_dock_schedule), My Day = Mi Día (sh_myDay),
 * Lead = Prospecto (nv_page_leads), Inspection = Inspección (jb_apptInspection), Estimate = Presupuesto
 * (nt_estimate), the office = la oficina (cs_theOffice), No connection = Sin conexión and a bar or two =
 * una o dos barras de señal (jb_noConnection), Marked done = Marcada como hecha (ag_srv_toastMarkedDone),
 * Put back = Devuelta (ag_srv_toastPutBack), Edit Details = Editar Detalles (ag_srv_visitDidHappen),
 * Waiting For A Day = Esperando Un Día (jb_waitingForADay), pending pick = esperando elección
 * (ag_cal_pendingPick), cancelled = cancelada (ag_srv_apptStatus_cancelled), done = hecha
 * (ag_cal_doneLower). Coined here, once: Won = Ganada and Lost = Perdida (the visit's own ending, so
 * feminine), Won't Happen = No Se Hará, Actions = Acciones, Planned = Planeado, Written up as =
 * Redactada como.
 *
 * A SPANISH CLOCK ENDS IN A PERIOD ("8:00 a. m.", lib/lang-words esMeridiem), so no Spanish sentence here
 * ends on one: "Desde {since} estás en el reloj en {label}." — the clock leads where the English trails.
 * TWO "NONE YET" KEYS: the sheet's Customer row and its Address row both read "None yet" in English;
 * Spanish says Ninguno for a customer and Ninguna for an address, so each row has its own key.
 * THE PICKER'S ONE SENTENCE-CASE DOOR: the closed picker's default button reads "Connect this to a
 * lead, customer or job" today (a sentence, not Title Case, and the English may not change in this
 * wave), so it is keyed vp_connectThisTo, not vp_btn_; the Spanish follows the English's case.
 *
 * BUILDER D'S HALF (the same wave): the English a Spanish tech still met on the page because it came
 * from a piece the page draws or a sentence the server returns — the Edit Details modal
 * (appointment-button), the Clear The Date row (unschedule-button), Start The Job's server
 * (start-job-actions, wordsOf like hear-actions), and the pure libraries the page and its server share
 * (lib/appointments/visit-start and wont-happen, lib/inspection/inspection-access INSPECTION_UNREAD,
 * lib/estimate/task-kits kitsReadWords): a library keeps its English inline as the default and takes
 * the caller's `lang` + translator (lib/lang-words say), so every existing caller and test reads the
 * same English byte for byte. House words added here, once: Appointment = Cita (nv_add_newAppointment),
 * Set A Time = Fijar Una Hora, Propose Times = Proponer Horas, Text It = Enviar Por Mensaje (the
 * Settle Up button's su_btn_textReceipt verb), Convert = Convertir, Anyone = Cualquiera, Type = Tipo,
 * Location = Ubicación (vi_btn_useMyLocation), Timecards = Tarjetas De Tiempo (the page's own name, as the
 * dock and the office's map spell it: sh_dock_ck-cards, nv_page_timecards),
 * Clear The Date = Quitar La Fecha (ag_cal_btn_clearTheDate, the same words), Draft restored =
 * Borrador recuperado (ag_rail_draftRestored, the same line). Stays as it is, by design: the sms:
 * body a tech sends the CUSTOMER ("Hi! Pick a time that works…") is the customer's line, not the
 * tech's screen. The office bell Ask The Office rings (vp_bell…) is keyed here but read in English
 * through office_t = translator("en"), the long-shift route's rule, until the office reads Spanish.
 * cn-v1147: in Spanish the function words (a, de, la, y…) stay lowercase after the first word ("Lista de
 * Precios", "Mover a un Día"); English keeps every word capitalized.
 */
export const words: WordCatalog = {
  prefix: "vp_",
  files: [
    "src/app/(app)/appointments/[id]/page.tsx",
    "src/app/(app)/appointments/[id]/visit-start-card.tsx",
    "src/app/(app)/appointments/[id]/link-picker.tsx",
    "src/app/(app)/appointments/[id]/visit-ending.tsx",
    "src/app/(app)/appointments/[id]/visit-header-actions.tsx",
    "src/app/(app)/appointments/[id]/mark-complete-button.tsx",
    "src/app/(app)/appointments/hear-actions.ts",
    // Builder D: the pieces the page draws and the server it taps (the Edit Details modal is shared
    // with the calendar, My Day and the leads; intake-files has no words of its own, named so the
    // scan guards it). back-link.tsx is the shell's: it takes its Back word (sh_back) from the caller.
    "src/app/(app)/appointments/appointment-button.tsx",
    "src/app/(app)/appointments/unschedule-button.tsx",
    "src/app/(app)/appointments/start-job-actions.ts",
    "src/app/(app)/leads/intake-files.tsx",
  ],
  sameInBoth: [],
  en: {
    // ── The page (page.tsx): the back link, the badges, the header's main button and ⋯, the lines ──
    vp_btn_backToSchedule: "Back To Schedule",
    vp_btn_backToMyDay: "Back To My Day",
    vp_btn_actions: "Actions",
    vp_pendingPick: "pending pick",
    vp_doneBadge: "done",
    vp_cancelledBadge: "cancelled",
    vp_btn_markInspectionDone: "Mark Inspection Done",
    vp_btn_editDetails: "Edit Details…",
    vp_waitingForADay: "Waiting For A Day",
    vp_noJob: "no job",
    vp_crewLeadsAfterUpdate: "Crew leads can fill this in once the office finishes an update. Until then only the office can change it.",
    vp_customerToldUsOnline: "What the customer told us online",
    vp_theirWordsConfirm: "Their words, not a finding — confirm on site.",
    vp_noneMatchedSheet: "None of these matched a question on your inspection sheet, so none of them could fill it in.",
    vp_couldntReadWebsiteForm: "Couldn't read the website form's questions just now, so the customer's answers aren't shown. Reload to try again.",
    vp_inspectionOrEstimate: "Inspection Or Estimate",
    vp_inspection: "Inspection",
    vp_thisJob: "This job",

    // ── The start card (visit-start-card.tsx): what a tap answers ──
    vp_noConnection: "No connection. That didn't go through; try again when you have a bar or two.",
    vp_pickAStartTime: "Pick a start time.",
    vp_somethingWrongNothingChanged: "Something went wrong. Nothing was changed.",
    vp_doneDot: "Done.",
    vp_btn_undoClockIn: "Undo Clock-In",
    vp_clockInUndone: "Clock-in undone. {job} stays.",
    vp_theJob: "The job",
    vp_clockInNotUndone: "The clock-in could not be undone.",
    vp_movedWholePunch: "Moved your whole punch since {since} onto {job}.",
    vp_switchedClock: "Switched your clock to {job} from {from} at {at}.",
    vp_theOtherJob: "the other job",
    vp_clockedYouIn: "Clocked you in on {job} at {at}.",
    vp_officeAsked: "The office has been asked.",
    vp_startTheWorkAria: "Start the work",

    // ── The start face: office, no job yet ──
    vp_thisVisitIsDone: "This visit is done",
    vp_hereToDoTheWork: "Here to do the work?",
    vp_onClockOnLinkJob: "You’re on the clock on {job} since {since}{name}. {customer} already has it. Link this visit to it.",
    vp_alreadyHasMadeThatDay: "{customer} already has {job}{name}, made that day.",
    vp_alreadyHasMadeThatDayFinished: "{customer} already has {job}{name}, made that day and finished.",
    vp_linkThisVisitToItQ: "Link this visit to it?",
    vp_useItInsteadQ: "Use it instead of making a second job?",
    vp_thisCustomer: "This customer",
    vp_theCustomer: "the customer",
    vp_overNoJobLine: "It has no job. If the work goes on, start one from it: it brings {customer}, the address and the visit time along, and it doesn’t start your clock.",
    vp_startAJobLine: "Start a job from this visit. It brings {customer}, the address and the visit time along.",
    vp_onClockSince: "You’re on the clock on {label} since {since}.",
    vp_startingMovesWhole: "Starting this job moves this whole punch onto it — none of it stays behind.",
    vp_startingSwitchesHere: "Starting this job switches your clock here.",
    vp_btn_linkTo: "Link To {job}",
    vp_btn_linkToInstead: "Link To {job} Instead",
    vp_btn_makeANewJobAnyway: "Make A New Job Anyway",
    vp_btn_startAJobFromThisVisit: "Start A Job From This Visit",
    vp_btn_startTheJobAndClockIn: "Start The Job And Clock In",
    vp_btn_startTheJob: "Start The Job",

    // ── The ask face: crew, no job yet ──
    vp_askOfficeToStart: "Ask the office to start the job",
    vp_askOverNoJob: "This visit is done and has no job. If the work goes on, ask the office to start one.",
    vp_askNoJobYet: "This visit has no job yet, and only the office can start one. Once they do, you can clock in right here.",
    vp_btn_askTheOffice: "Ask The Office",
    vp_btn_callTheOffice: "Call The Office",
    vp_btn_textTheOffice: "Text The Office",

    // ── A linked job: clock in, switch, here, closed ──
    vp_thisVisitIs: "This visit is {job}",
    vp_switchingMovesWhole: "Switching moves this whole punch onto {job} — none of it stays behind.",
    vp_switchingEndsPart: "Switching ends that part now and starts this one.",
    vp_closedLine: "The visit is done and {job} is finished, so there’s no clock to start here.",
    vp_youreOnTheClockHere: "You’re On The Clock Here",
    vp_btn_switchTo: "Switch To {job}",
    vp_btn_clockInOn: "Clock In On {job}",
    vp_btn_open: "Open {job}",

    // ── The sheet: what the job will be, when the clock starts ──
    vp_makeANewJob: "Make A New Job",
    vp_btn_cancel: "Cancel",
    vp_btn_linking: "Linking…",
    vp_btn_starting: "Starting…",
    vp_btn_switchToThisJob: "Switch To This Job",
    vp_alreadyHasSecondJob: "{customer} already has {job}, made that day. This makes a second job.",
    vp_theJobWillBe: "The job will be",
    vp_name: "Name",
    vp_customer: "Customer",
    vp_address: "Address",
    vp_planned: "Planned",
    vp_noCustomerYet: "None yet",
    vp_noAddressYet: "None yet",
    vp_onClockLinkInsteadSheet: "You’re on the clock on {job} since {since}. Link this visit to it instead; a new job here would take your clock off the job you are on.",
    vp_sheetMovesWhole: "You're on the clock on {label} since {since}. This moves this whole punch onto the new job, from {since} — none of it stays behind. No second clock is opened.",
    vp_sheetSwitchesNow: "You're on the clock on {label} since {since}. This switches your clock to the new job now: the part on {label} ends at this moment. No second clock is opened.",
    vp_startedAt: "Started at",
    vp_btn_now: "Now",
    vp_btn_visitTime: "Visit Time · {clock}",
    vp_btn_pickATime: "Pick A Time",
    vp_clockStartsAtTimeAbove: "Your clock starts at the time above.",

    // ── The link picker (link-picker.tsx): one box over three tables ──
    vp_noConnectionLink: "No connection, so that didn't go through. Try again when you have a bar or two.",
    vp_connectThisTo: "Connect this to a lead, customer or job",
    vp_for: "For",
    vp_kind_lead: "lead",
    vp_kind_customer: "customer",
    vp_kind_job: "job",
    vp_btn_change: "Change",
    vp_searchingSeed: "Searching “{seed}” — or type a name",
    vp_nameOrAddress: "Name or address",
    vp_looking: "looking…",
    vp_noJobMatchesYet: "No job matches yet — try the street or the customer's name.",
    vp_nobodyByThatName: "Nobody by that name yet.",
    vp_nothingMatchesYet: "Nothing matches yet — carry on, you can connect this later.",
    vp_couldntMakeTheLead: "Couldn't make the lead.",
    vp_btn_addAsANewLead: "Add As A New Lead",
    vp_addressGoesOnLead: "{typed} — this visit’s address goes on the lead",
    vp_couldntConnectIt: "Couldn't connect it — try again.",

    // ── How the visit ended (visit-ending.tsx) ──
    vp_won: "Won",
    vp_lost: "Lost",
    // The same word as a DOOR (the office's Lost button): a clickable is a vp_btn_ key; the status word above stays its own.
    vp_btn_lost: "Lost",
    vp_btn_wonPickTheJob: "Won · Pick The Job",
    vp_btn_clearTheAnswer: "Clear The Answer",
    vp_btn_keepIt: "Keep It",
    vp_writtenUpAs: "Written up as",
    // The estimate's link when it has no number yet: a navigating door, so a vp_btn_ key.
    vp_btn_theEstimate: "The Estimate",
    vp_estimateIsOver: "— that estimate is over; a new one can be started below.",
    vp_howDidThisOneEnd: "How did this one end?",
    vp_thatDidntSave: "That didn't save — try again.",
    vp_markedWon: "Marked Won.",
    vp_markedLost: "Marked Lost.",
    vp_answerCleared: "Answer cleared.",

    // ── The header's ⋯ rows (visit-header-actions.tsx) and Mark Complete (mark-complete-button.tsx) ──
    vp_btn_undo: "Undo",
    vp_putBack: "Put back.",
    vp_putBackNote: "Put back. {note}",
    vp_couldntPutItBack: "Couldn't put it back.",
    vp_couldntMarkItDone: "Couldn't mark it done — try again.",
    vp_markedDone: "Marked Done",
    vp_markedDoneNote: "Marked Done. {note}",
    vp_btn_saving: "Saving…",
    vp_btn_markDone: "Mark Done",
    vp_couldntPutBackOnSchedule: "Couldn't put it back on the schedule — try again.",
    vp_backOnTheSchedule: "Back on the schedule.",
    vp_btn_putItBackOnTheSchedule: "Put It Back On The Schedule",
    vp_thatVisitDidntChange: "That visit didn't change — try again.",
    vp_btn_wontHappen: "Won't Happen",
    vp_couldntUpdateStatus: "Couldn't update the status — try again.",

    // ── The voice fill's server words (hear-actions.ts) ──
    vp_signInFirst: "Sign in first.",
    vp_inspectionNoLongerExists: "That inspection no longer exists.",
    vp_pickAnInspectionFirst: "Pick an inspection first.",
    vp_couldntReadInspection: "Couldn't read the inspection just now. Try again.",
    vp_formIsntAnInspection: "That form isn't an inspection.",

    // ══ Builder D: the pieces the page draws and the sentences its server returns (cn-v1144) ══
    // ── The Edit Details modal (appointment-button.tsx): the one form the calendar, My Day, the leads
    //    and the visit page's ⋯ all open. Its door words follow the kind (apptFormWords): whole phrases,
    //    never a slot, because Cita and Inspección each carry their own article in Spanish. ──
    vp_btn_newAppointment: "New Appointment",
    vp_btn_newInspection: "New Inspection",
    vp_btn_editAppointment: "Edit Appointment",
    vp_btn_editInspection: "Edit Inspection",
    vp_btn_saveAppointment: "Save Appointment",
    vp_btn_saveInspection: "Save Inspection",
    vp_btn_textTheCustomerTheseTimes: "Text The Customer These Times",
    vp_btn_createLink: "Create Link",
    vp_btn_edit: "Edit",
    vp_btn_done: "Done",
    vp_btn_delete: "Delete",
    vp_btn_copied: "Copied",
    vp_btn_copyLink: "Copy Link",
    vp_btn_textIt: "Text It",
    vp_btn_setATime: "Set A Time",
    vp_btn_proposeTimes: "Propose Times",
    vp_btn_anyone: "— Anyone —",
    vp_btn_newLead: "New Lead",
    vp_btn_newCustomer: "New Customer",
    // The arrow after it stays in the JSX ("Convert To Job →"): a symbol is not a word.
    vp_btn_convertToJob: "Convert To Job",
    vp_draftRestored: "Draft restored — pick up where you left off",
    vp_zoneNote: "Times are {zone} time, the business's clock.",
    vp_couldNotCreateJob: "Could not create job.",
    vp_addAtLeastOneDateOption: "Add at least one date option.",
    vp_couldNotCreateTheLink: "Could not create the link.",
    vp_couldNotSave: "Could not save.",
    vp_deleteAppointmentAsk: "Delete the appointment \"{title}\"? This can't be undone.",
    vp_couldntDeleteAppointment: "Couldn't delete appointment — try again.",
    vp_appointmentDeleted: "Appointment deleted",
    vp_linkReadyAppointment: "Link ready — text it to the customer. The appointment confirms onto your calendar the moment they tap a time.",
    vp_textItNote: "Text It opens this phone’s own messaging app, so it sends from this phone’s number, not the business line. To send it from the business line, use Copy Link and paste it there.",
    vp_type: "Type",
    vp_assignedTo: "Assigned to",
    vp_title: "Title",
    vp_titlePlaceholder: "e.g. Inspection at the Smiths', follow-up visit",
    vp_date: "Date",
    vp_start: "Start",
    vp_end: "End",
    vp_offerUpToThreeTimes: "Offer up to 3 times — the customer taps one",
    vp_optionDateAria: "Option {n} date",
    vp_optionTimeAria: "Option {n} time",
    vp_job: "Job",
    vp_leadGoesOnIt: "A lead: this visit and its address go on it.",
    vp_someoneAlreadyYours: "Someone already yours who isn't in the list.",
    vp_notInTheList: "Not in the list? Add them here.",
    vp_newLeadName: "New lead name",
    vp_newCustomerName: "New customer name",
    vp_phone: "Phone",
    vp_optionalPlaceholder: "Optional",
    vp_location: "Location",
    vp_addressOrSite: "Address or site",
    vp_notes: "Notes",

    // ── Clear The Date (unschedule-button.tsx): the ⋯ row and what it says after ──
    vp_btn_clearTheDate: "Clear The Date",
    vp_btn_clearing: "Clearing…",
    vp_couldntClearTheDate: "Couldn't clear the date.",
    vp_waitsUnderWaitingForADay: "It waits under Waiting For A Day on the schedule. Place it there when they call.",

    // ── Start The Job's server (start-job-actions.ts): every message, error and warning it returns, in
    //    the caller's language (wordsOf). A warning the Time Clock's own clockIn / switchJob sends back is
    //    already in the caller's language (cs_) and rides through as received. ──
    vp_onlyOfficeStartsJob: "Only the office can start a job. Ask the office to start it, then clock in here.",
    vp_visitNotFound: "That visit could not be found.",
    vp_visitCancelledNothingStarted: "This visit was cancelled. Nothing was started.",
    vp_nothingWasStarted: "Nothing was started.",
    vp_onClockSwitchHere: "You're on the clock on {label} since {since}. Switch To This Job moves your clock here now. Nothing was started yet.",
    vp_onClockLinkInstead: "You're on the clock on {job}, the job {customer} already has from today. Link this visit to {job} instead. Nothing was started.",
    vp_thisCustomerLower: "this customer",
    vp_jobCouldNotBeStarted: "The job could not be started. Nothing was changed.",
    vp_jobMadeNotReadBack: "The job was made but could not be read back. Reload the page before trying again.",
    vp_clockStillOn: "Your clock is still on {from}: {why}",
    vp_switchDidntGoThrough: "the switch did not go through.",
    vp_alreadyOnClockOn: "You were already on the clock on {job}.",
    vp_clockInDidntGoThrough: "The clock-in didn't go through: {why}",
    vp_tryAgainFromJobPage: "try again from the job page.",
    vp_onlyOfficeLinksVisit: "Only the office can link a visit to a job.",
    vp_alreadyLinkedToThatJob: "This visit is already linked to that job.",
    vp_alreadyLinkedToAnotherJob: "This visit is already linked to another job. Nothing was changed.",
    vp_jobNoLongerOffered: "That job is no longer the one to offer here. Nothing was changed. Edit Details links any job by hand.",
    vp_visitCouldNotBeLinked: "The visit could not be linked. Nothing was changed.",
    vp_clockAlreadyRunningOn: "Your clock is already running on {job}.",
    vp_linkedThisVisitTo: "Linked this visit to {job}. {note}{onIt}",
    vp_nothingNewWasMade: "Nothing new was made.",
    vp_notSignedIn: "Not signed in.",
    vp_accountCantSendThat: "This account can't send that.",
    vp_visitAlreadyHasJobReload: "This visit already has a job. Reload the page to clock in on it.",
    vp_nobodyInOfficeGetsMessages: "Nobody in the office gets messages in the app yet. Call them instead.",
    vp_didntReachOffice: "That didn't reach the office. Call them instead.",
    vp_officeAskedToStartJob: "The office has been asked to start a job for this visit.",
    vp_officeAskedClockInHere: "The office has been asked. Once they start the job, you can clock in right here.",

    // ── lib/appointments/visit-start (a pure library: English inline, these words from the caller):
    //    startedAtProblem's sentences (the first is vp_pickAStartTime above), jobShort's fallback, and
    //    startedWords' one sentence after the tap. {who} is " for Pat" or nothing, {from} " from J-050"
    //    or nothing: each fragment its own key, so Spanish puts the clock first and ends on a word. ──
    vp_timeNotYet: "That time hasn't happened yet.",
    vp_pickSinceMidnightYesterday: "Pick a time since midnight yesterday. For older hours, add them on Timecards.",
    vp_theJobLower: "the job",
    vp_forCustomer: "for {customer}",
    vp_fromJob: "from {from}",
    vp_visitAlreadyHad: "This visit already had {job}{who}.",
    vp_clockedYouInOnIt: "Clocked you in on it at {at}.",
    vp_movedWholePunchOntoIt: "Moved your whole punch since {at} onto it.",
    vp_switchedClockToIt: "Switched your clock to it{from} at {at}.",
    vp_startedJob: "Started {job}{who}.",
    vp_startedAndClockedIn: "Started {job}{who} and clocked you in at {at}.",
    vp_startedAndMovedPunch: "Started {job}{who} and moved your whole punch since {at} onto it.",
    vp_startedAndSwitched: "Started {job}{who} and switched your clock here{from} at {at}.",

    // ── lib/appointments/wont-happen (pure): the confirm, the toast, Undo's note, and Put It Back's
    //    sentence (putBackPlan, said by appointments/actions putVisitBackOnSchedule) ──
    vp_wontHappenDeleteAsk: "This visit won't happen? Nothing was captured on it, so it will be deleted.",
    vp_wontHappenCancelAsk: "This visit won't happen? Its notes, photos and answers stay on file, marked Cancelled.",
    vp_deletedNothingOnIt: "Deleted. Nothing was on it.",
    vp_markedCancelledStays: "Marked Cancelled. Everything on it stays on file.",
    vp_pickLinkStaysWithdrawn: "The pick-a-time link stays withdrawn — send a new one.",
    vp_backOnScheduleFor: "Back on the schedule for {day}.",
    vp_backWaitingDayPassed: "Back on the schedule, waiting for a day: {day} had passed.",
    vp_backWaitingForADay: "Back on the schedule, waiting for a day.",

    // ── lib/inspection/inspection-access (INSPECTION_UNREAD) and lib/estimate/task-kits (kitsReadWords):
    //    page.tsx hands them the language; the Inspector receives the sentence as before ──
    vp_inspectionUnread: "Couldn't read this inspection just now, so it isn't shown (nothing on it changed). Reload the page to try again.",
    vp_kitsThin: "The kits were read without their vendors or part links — part names may differ from the estimate's.",
    vp_kitsNeedUpdate: "Kits need the database update before a task can pick one.",
    vp_kitsCouldNotBeRead: "The kits could not be read — a task's kit picker is off until you reload; its own hours stand.",
    // THE OFFICE'S BELL when a crew member asks for a job (start-job-actions askOfficeToStartJob): these three,
    // vp_aVisitLower and vp_forCustomer (above, in the visit-start block) are read ONLY through office_t =
    // translator("en") there — the long-shift route's rule (sh_spanishCovers): the office reads English today.
    // Their Spanish is DORMANT BY DESIGN until the office cluster speaks Spanish; the file keeps no literal so
    // that day one line changes. (vp_forCustomer's Spanish is live elsewhere: startedWords says it to the tech.)
    vp_bellNeedsJobStarted: "{first} needs a job started{forWho}",
    vp_bellVisitOverBody: "{first} asks for a job on {place}, a visit that is done, so the work can go on. Start it from the visit.",
    vp_bellAtVisitBody: "{first} is at {place} and can't clock in until it has a job. Start it from the visit.",
    vp_aVisitLower: "a visit",

    // ── lib/overlap-refusal clockInClashWords (pure: English inline, these words from the caller): the clock-in's
    //    refusal over hours already recorded, which Start The Job And Clock In shows to the tech (start-job-actions
    //    hands it `lang` + its translator; the Time Clock's own clockIn keeps the English default). {when} is the
    //    clash's day and clocks (vp_clashWhen; a running clock has only its start), {where} " on J-050" / " with no
    //    job" or nothing, {at} the start that was tapped, {end} the clash's end, {fix} one of the two fixes. ──
    vp_nothingWasRecorded: "Nothing was recorded.",
    vp_clashWhen: "{day}, {from} to {to}",
    vp_clashOnJob: "on {job}",
    vp_clashWithNoJob: "with no job",
    vp_clashFixOnTimecards: "fix that shift on Timecards",
    vp_clashAskOfficeToFix: "ask the office to fix that shift",
    vp_clashRecorded: "You already have hours recorded {when}{where}, so a clock started at {at} would count them twice. {nothing} Start the clock at {end} or later, or {fix}.",
    vp_clashRunning: "You already have a clock running since {when}{where}. {nothing}",
  },
  es: {
    vp_btn_backToSchedule: "Volver a la Agenda",
    vp_btn_backToMyDay: "Volver a Mi Día",
    vp_btn_actions: "Acciones",
    vp_pendingPick: "esperando elección",
    vp_doneBadge: "hecha",
    vp_cancelledBadge: "cancelada",
    vp_btn_markInspectionDone: "Marcar Inspección Hecha",
    vp_btn_editDetails: "Editar Detalles…",
    vp_waitingForADay: "Esperando un Día",
    vp_noJob: "sin trabajo",
    vp_crewLeadsAfterUpdate: "Los líderes de cuadrilla podrán llenar esto cuando la oficina termine una actualización. Hasta entonces solo la oficina puede cambiarlo.",
    vp_customerToldUsOnline: "Lo que el cliente nos dijo en línea",
    vp_theirWordsConfirm: "Sus palabras, no un hallazgo — confírmalo en el sitio.",
    vp_noneMatchedSheet: "Ninguna coincidió con una pregunta de tu hoja de inspección, así que ninguna pudo llenarla.",
    vp_couldntReadWebsiteForm: "No se pudieron leer las preguntas del formulario del sitio web ahora mismo, así que no se muestran las respuestas del cliente. Recarga para intentar de nuevo.",
    vp_inspectionOrEstimate: "Inspección o Presupuesto",
    vp_inspection: "Inspección",
    vp_thisJob: "Este trabajo",

    vp_noConnection: "Sin conexión. Eso no pasó; inténtalo de nuevo cuando tengas una o dos barras de señal.",
    vp_pickAStartTime: "Elige una hora de inicio.",
    vp_somethingWrongNothingChanged: "Algo salió mal. No se cambió nada.",
    vp_doneDot: "Hecho.",
    vp_btn_undoClockIn: "Deshacer la Entrada",
    vp_clockInUndone: "Entrada deshecha. {job} se queda.",
    vp_theJob: "El trabajo",
    vp_clockInNotUndone: "No se pudo deshacer la entrada.",
    vp_movedWholePunch: "Toda tu marcación desde {since} pasó a {job}.",
    vp_switchedClock: "A las {at} tu reloj cambió a {job} desde {from}.",
    vp_theOtherJob: "el otro trabajo",
    vp_clockedYouIn: "A las {at} marcaste entrada en {job}.",
    vp_officeAsked: "Ya se le pidió a la oficina.",
    vp_startTheWorkAria: "Empezar el trabajo",

    vp_thisVisitIsDone: "Esta visita está hecha",
    vp_hereToDoTheWork: "¿Vienes a hacer el trabajo?",
    vp_onClockOnLinkJob: "Desde {since} estás en el reloj en {job}{name}. {customer} ya lo tiene. Enlaza esta visita a él.",
    vp_alreadyHasMadeThatDay: "{customer} ya tiene {job}{name}, hecho ese día.",
    vp_alreadyHasMadeThatDayFinished: "{customer} ya tiene {job}{name}, hecho ese día y terminado.",
    vp_linkThisVisitToItQ: "¿Enlazar esta visita a él?",
    vp_useItInsteadQ: "¿Usarlo en vez de crear un segundo trabajo?",
    vp_thisCustomer: "Este cliente",
    vp_theCustomer: "el cliente",
    vp_overNoJobLine: "No tiene trabajo. Si el trabajo sigue, empieza uno desde ella: trae {customer}, la dirección y la hora de la visita, y no empieza tu reloj.",
    vp_startAJobLine: "Empieza un trabajo desde esta visita. Trae {customer}, la dirección y la hora de la visita.",
    vp_onClockSince: "Desde {since} estás en el reloj en {label}.",
    vp_startingMovesWhole: "Empezar este trabajo pasa toda esta marcación a él — nada se queda atrás.",
    vp_startingSwitchesHere: "Empezar este trabajo cambia tu reloj aquí.",
    vp_btn_linkTo: "Enlazar a {job}",
    vp_btn_linkToInstead: "Enlazar a {job} en Su Lugar",
    vp_btn_makeANewJobAnyway: "Crear Nuevo Trabajo de Todos Modos",
    vp_btn_startAJobFromThisVisit: "Empezar un Trabajo desde Esta Visita",
    vp_btn_startTheJobAndClockIn: "Empezar el Trabajo y Marcar Entrada",
    vp_btn_startTheJob: "Empezar el Trabajo",

    vp_askOfficeToStart: "Pídele a la oficina que empiece el trabajo",
    vp_askOverNoJob: "Esta visita está hecha y no tiene trabajo. Si el trabajo sigue, pídele a la oficina que empiece uno.",
    vp_askNoJobYet: "Esta visita aún no tiene trabajo, y solo la oficina puede empezar uno. En cuanto lo haga, puedes marcar entrada aquí mismo.",
    vp_btn_askTheOffice: "Pídele a la Oficina",
    vp_btn_callTheOffice: "Llamar a la Oficina",
    vp_btn_textTheOffice: "Enviar Mensaje a la Oficina",

    vp_thisVisitIs: "Esta visita es {job}",
    vp_switchingMovesWhole: "Al cambiar, toda esta marcación pasa a {job} — nada se queda atrás.",
    vp_switchingEndsPart: "Al cambiar, esa parte termina ahora y empieza esta.",
    vp_closedLine: "La visita está hecha y {job} está terminado, así que no hay reloj que empezar aquí.",
    vp_youreOnTheClockHere: "Estás en el Reloj Aquí",
    vp_btn_switchTo: "Cambiar a {job}",
    vp_btn_clockInOn: "Marcar Entrada en {job}",
    vp_btn_open: "Abrir {job}",

    vp_makeANewJob: "Crear Nuevo Trabajo",
    vp_btn_cancel: "Cancelar",
    vp_btn_linking: "Enlazando…",
    vp_btn_starting: "Empezando…",
    vp_btn_switchToThisJob: "Cambiar a Este Trabajo",
    vp_alreadyHasSecondJob: "{customer} ya tiene {job}, hecho ese día. Esto crea un segundo trabajo.",
    vp_theJobWillBe: "El trabajo será",
    vp_name: "Nombre",
    vp_customer: "Cliente",
    vp_address: "Dirección",
    vp_planned: "Planeado",
    vp_noCustomerYet: "Ninguno aún",
    vp_noAddressYet: "Ninguna aún",
    vp_onClockLinkInsteadSheet: "Desde {since} estás en el reloj en {job}. Mejor enlaza esta visita a él; un trabajo nuevo aquí quitaría tu reloj del trabajo en el que estás.",
    vp_sheetMovesWhole: "Desde {since} estás en el reloj en {label}. Esto pasa toda esta marcación al trabajo nuevo, desde {since} — nada se queda atrás. No se abre un segundo reloj.",
    vp_sheetSwitchesNow: "Desde {since} estás en el reloj en {label}. Esto cambia tu reloj al trabajo nuevo ahora: la parte en {label} termina en este momento. No se abre un segundo reloj.",
    vp_startedAt: "Hora de inicio",
    vp_btn_now: "Ahora",
    vp_btn_visitTime: "Hora de la Visita · {clock}",
    vp_btn_pickATime: "Elegir una Hora",
    vp_clockStartsAtTimeAbove: "Tu reloj empieza a la hora de arriba.",

    vp_noConnectionLink: "Sin conexión, así que eso no pasó. Inténtalo de nuevo cuando tengas una o dos barras de señal.",
    vp_connectThisTo: "Conectar esto a un prospecto, cliente o trabajo",
    vp_for: "Para",
    vp_kind_lead: "prospecto",
    vp_kind_customer: "cliente",
    vp_kind_job: "trabajo",
    vp_btn_change: "Cambiar",
    vp_searchingSeed: "Buscando “{seed}” — o escribe un nombre",
    vp_nameOrAddress: "Nombre o dirección",
    vp_looking: "buscando…",
    vp_noJobMatchesYet: "Ningún trabajo coincide aún — prueba con la calle o el nombre del cliente.",
    vp_nobodyByThatName: "Nadie con ese nombre aún.",
    vp_nothingMatchesYet: "Nada coincide aún — sigue, puedes conectar esto después.",
    vp_couldntMakeTheLead: "No se pudo crear el prospecto.",
    vp_btn_addAsANewLead: "Agregar como Nuevo Prospecto",
    vp_addressGoesOnLead: "{typed} — la dirección de esta visita va en el prospecto",
    vp_couldntConnectIt: "No se pudo conectar — inténtalo de nuevo.",

    vp_won: "Ganada",
    vp_lost: "Perdida",
    vp_btn_lost: "Perdida",
    vp_btn_wonPickTheJob: "Ganada · Elegir el Trabajo",
    vp_btn_clearTheAnswer: "Borrar la Respuesta",
    vp_btn_keepIt: "Dejarla",
    vp_writtenUpAs: "Redactada como",
    vp_btn_theEstimate: "El Presupuesto",
    vp_estimateIsOver: "— ese presupuesto terminó; se puede empezar uno nuevo abajo.",
    vp_howDidThisOneEnd: "¿Cómo terminó esta?",
    vp_thatDidntSave: "Eso no se guardó — inténtalo de nuevo.",
    vp_markedWon: "Marcada como Ganada.",
    vp_markedLost: "Marcada como Perdida.",
    vp_answerCleared: "Respuesta borrada.",

    vp_btn_undo: "Deshacer",
    vp_putBack: "Devuelta.",
    vp_putBackNote: "Devuelta. {note}",
    vp_couldntPutItBack: "No se pudo devolver.",
    vp_couldntMarkItDone: "No se pudo marcar como hecha — inténtalo de nuevo.",
    vp_markedDone: "Marcada como Hecha",
    vp_markedDoneNote: "Marcada como Hecha. {note}",
    vp_btn_saving: "Guardando…",
    vp_btn_markDone: "Marcar Hecha",
    vp_couldntPutBackOnSchedule: "No se pudo devolver a la agenda — inténtalo de nuevo.",
    vp_backOnTheSchedule: "De vuelta en la agenda.",
    vp_btn_putItBackOnTheSchedule: "Devolverla a la Agenda",
    vp_thatVisitDidntChange: "Esa visita no cambió — inténtalo de nuevo.",
    vp_btn_wontHappen: "No Se Hará",
    vp_couldntUpdateStatus: "No se pudo actualizar el estado — inténtalo de nuevo.",

    vp_signInFirst: "Inicia sesión primero.",
    vp_inspectionNoLongerExists: "Esa inspección ya no existe.",
    vp_pickAnInspectionFirst: "Elige una inspección primero.",
    vp_couldntReadInspection: "No se pudo leer la inspección ahora mismo. Inténtalo de nuevo.",
    vp_formIsntAnInspection: "Ese formulario no es una inspección.",

    // ══ Builder D ══
    vp_btn_newAppointment: "Nueva Cita",
    vp_btn_newInspection: "Nueva Inspección",
    vp_btn_editAppointment: "Editar Cita",
    vp_btn_editInspection: "Editar Inspección",
    vp_btn_saveAppointment: "Guardar Cita",
    vp_btn_saveInspection: "Guardar Inspección",
    vp_btn_textTheCustomerTheseTimes: "Enviar Estas Horas al Cliente por Mensaje",
    vp_btn_createLink: "Crear Enlace",
    vp_btn_edit: "Editar",
    vp_btn_done: "Hecho",
    vp_btn_delete: "Eliminar",
    vp_btn_copied: "Copiado",
    vp_btn_copyLink: "Copiar Enlace",
    vp_btn_textIt: "Enviar por Mensaje",
    vp_btn_setATime: "Fijar una Hora",
    vp_btn_proposeTimes: "Proponer Horas",
    vp_btn_anyone: "— Cualquiera —",
    vp_btn_newLead: "Nuevo Prospecto",
    vp_btn_newCustomer: "Cliente Nuevo",
    vp_btn_convertToJob: "Convertir en Trabajo",
    vp_draftRestored: "Borrador recuperado — sigue donde lo dejaste",
    vp_zoneNote: "Las horas son hora de {zone}, el reloj del negocio.",
    vp_couldNotCreateJob: "No se pudo crear el trabajo.",
    vp_addAtLeastOneDateOption: "Agrega al menos una opción de fecha.",
    vp_couldNotCreateTheLink: "No se pudo crear el enlace.",
    vp_couldNotSave: "No se pudo guardar.",
    vp_deleteAppointmentAsk: "¿Eliminar la cita \"{title}\"? No se puede deshacer.",
    vp_couldntDeleteAppointment: "No se pudo eliminar la cita — inténtalo de nuevo.",
    vp_appointmentDeleted: "Cita eliminada",
    vp_linkReadyAppointment: "Enlace listo — envíaselo al cliente por mensaje. La cita se confirma en tu calendario en cuanto toque una hora.",
    vp_textItNote: "Enviar por Mensaje abre la app de mensajes de este teléfono, así que lo manda desde el número de este teléfono, no desde la línea del negocio. Para mandarlo desde la línea del negocio, usa Copiar Enlace y pégalo ahí.",
    vp_type: "Tipo",
    vp_assignedTo: "Asignado a",
    vp_title: "Título",
    vp_titlePlaceholder: "p. ej. Inspección en casa de los Smith, visita de seguimiento",
    vp_date: "Fecha",
    vp_start: "Inicio",
    vp_end: "Fin",
    vp_offerUpToThreeTimes: "Ofrece hasta 3 horas — el cliente toca una",
    vp_optionDateAria: "Fecha de la opción {n}",
    vp_optionTimeAria: "Hora de la opción {n}",
    vp_job: "Trabajo",
    vp_leadGoesOnIt: "Un prospecto: esta visita y su dirección van en él.",
    vp_someoneAlreadyYours: "Alguien que ya es tu cliente y no está en la lista.",
    vp_notInTheList: "¿No está en la lista? Agrégalo aquí.",
    vp_newLeadName: "Nombre del nuevo prospecto",
    vp_newCustomerName: "Nombre del nuevo cliente",
    vp_phone: "Teléfono",
    vp_optionalPlaceholder: "Opcional",
    vp_location: "Ubicación",
    vp_addressOrSite: "Dirección o sitio",
    vp_notes: "Notas",

    vp_btn_clearTheDate: "Quitar la Fecha",
    vp_btn_clearing: "Quitando…",
    vp_couldntClearTheDate: "No se pudo quitar la fecha.",
    vp_waitsUnderWaitingForADay: "Espera bajo Esperando un Día en la agenda. Ponla ahí cuando llamen.",

    vp_onlyOfficeStartsJob: "Solo la oficina puede empezar un trabajo. Pídele a la oficina que lo empiece, y luego marca entrada aquí.",
    vp_visitNotFound: "No se encontró esa visita.",
    vp_visitCancelledNothingStarted: "Esta visita se canceló. No se empezó nada.",
    vp_nothingWasStarted: "No se empezó nada.",
    vp_onClockSwitchHere: "Desde {since} estás en el reloj en {label}. Cambiar a Este Trabajo mueve tu reloj aquí ahora. Aún no se ha empezado nada.",
    vp_onClockLinkInstead: "Estás en el reloj en {job}, el trabajo que {customer} ya tiene de hoy. Mejor enlaza esta visita a {job}. No se empezó nada.",
    vp_thisCustomerLower: "este cliente",
    vp_jobCouldNotBeStarted: "No se pudo empezar el trabajo. No se cambió nada.",
    vp_jobMadeNotReadBack: "El trabajo se creó pero no se pudo leer de vuelta. Recarga la página antes de intentar de nuevo.",
    vp_clockStillOn: "Tu reloj sigue en {from}: {why}",
    vp_switchDidntGoThrough: "el cambio no pasó.",
    vp_alreadyOnClockOn: "Ya estabas en el reloj en {job}.",
    vp_clockInDidntGoThrough: "La entrada no pasó: {why}",
    vp_tryAgainFromJobPage: "inténtalo de nuevo desde la página del trabajo.",
    vp_onlyOfficeLinksVisit: "Solo la oficina puede enlazar una visita a un trabajo.",
    vp_alreadyLinkedToThatJob: "Esta visita ya está enlazada a ese trabajo.",
    vp_alreadyLinkedToAnotherJob: "Esta visita ya está enlazada a otro trabajo. No se cambió nada.",
    vp_jobNoLongerOffered: "Ese trabajo ya no es el que se ofrece aquí. No se cambió nada. Editar Detalles enlaza cualquier trabajo a mano.",
    vp_visitCouldNotBeLinked: "No se pudo enlazar la visita. No se cambió nada.",
    vp_clockAlreadyRunningOn: "Tu reloj ya está corriendo en {job}.",
    vp_linkedThisVisitTo: "Esta visita se enlazó a {job}. {note}{onIt}",
    vp_nothingNewWasMade: "No se creó nada nuevo.",
    vp_notSignedIn: "No has iniciado sesión.",
    vp_accountCantSendThat: "Esta cuenta no puede enviar eso.",
    vp_visitAlreadyHasJobReload: "Esta visita ya tiene trabajo. Recarga la página para marcar entrada en él.",
    vp_nobodyInOfficeGetsMessages: "Nadie en la oficina recibe mensajes en la app todavía. Mejor llámalos.",
    vp_didntReachOffice: "Eso no llegó a la oficina. Mejor llámalos.",
    vp_officeAskedToStartJob: "Ya se le pidió a la oficina que empiece un trabajo para esta visita.",
    vp_officeAskedClockInHere: "Ya se le pidió a la oficina. En cuanto empiece el trabajo, puedes marcar entrada aquí mismo.",

    vp_timeNotYet: "Esa hora todavía no ha llegado.",
    vp_pickSinceMidnightYesterday: "Elige una hora desde la medianoche de ayer. Para horas más antiguas, agrégalas en Tarjetas de Tiempo.",
    vp_theJobLower: "el trabajo",
    vp_forCustomer: "para {customer}",
    vp_fromJob: "desde {from}",
    vp_visitAlreadyHad: "Esta visita ya tenía {job}{who}.",
    vp_clockedYouInOnIt: "A las {at} marcaste entrada en él.",
    vp_movedWholePunchOntoIt: "Toda tu marcación desde {at} pasó a él.",
    vp_switchedClockToIt: "A las {at} tu reloj cambió a él{from}.",
    vp_startedJob: "Empezaste {job}{who}.",
    vp_startedAndClockedIn: "Empezaste {job}{who} y a las {at} marcaste entrada.",
    vp_startedAndMovedPunch: "Empezaste {job}{who} y toda tu marcación desde {at} pasó a él.",
    vp_startedAndSwitched: "Empezaste {job}{who} y a las {at} tu reloj cambió aquí{from}.",

    vp_wontHappenDeleteAsk: "¿Esta visita no se hará? No se capturó nada en ella, así que se eliminará.",
    vp_wontHappenCancelAsk: "¿Esta visita no se hará? Sus notas, fotos y respuestas se quedan guardadas, marcada como Cancelada.",
    vp_deletedNothingOnIt: "Eliminada. No tenía nada.",
    vp_markedCancelledStays: "Marcada como Cancelada. Todo lo que tiene se queda guardado.",
    vp_pickLinkStaysWithdrawn: "El enlace para elegir hora sigue retirado — envía uno nuevo.",
    vp_backOnScheduleFor: "De vuelta en la agenda para el {day}.",
    vp_backWaitingDayPassed: "De vuelta en la agenda, esperando un día: el {day} ya pasó.",
    vp_backWaitingForADay: "De vuelta en la agenda, esperando un día.",

    vp_inspectionUnread: "No se pudo leer esta inspección ahora mismo, así que no se muestra (nada en ella cambió). Recarga la página para intentar de nuevo.",
    vp_kitsThin: "Los kits se leyeron sin sus proveedores ni enlaces de piezas — los nombres de las piezas pueden diferir de los del presupuesto.",
    vp_kitsNeedUpdate: "Los kits necesitan la actualización de la base de datos antes de que una tarea pueda elegir uno.",
    vp_kitsCouldNotBeRead: "No se pudieron leer los kits — el selector de kit de una tarea está apagado hasta que recargues; sus propias horas se quedan.",
    // DORMANT BY DESIGN (the office bell): start-job-actions reads these three and vp_aVisitLower only through
    // office_t = translator("en") until the office cluster speaks Spanish; nothing reads this Spanish today.
    vp_bellNeedsJobStarted: "{first} necesita que se empiece un trabajo{forWho}",
    vp_bellVisitOverBody: "{first} pide un trabajo para {place}, una visita que ya terminó, para que el trabajo pueda seguir. Empiézalo desde la visita.",
    vp_bellAtVisitBody: "{first} está en {place} y no puede marcar entrada hasta que tenga trabajo. Empiézalo desde la visita.",
    vp_aVisitLower: "una visita",

    // The clock-in's clash (lib/overlap-refusal clockInClashWords): the day and the clock lead with an article, "de … a …"
    // between the two clocks, and neither sentence ends on the clock ("a. m." carries its own period).
    vp_nothingWasRecorded: "No se registró nada.",
    vp_clashWhen: "{day}, de {from} a {to}",
    vp_clashOnJob: "en {job}",
    vp_clashWithNoJob: "sin trabajo",
    vp_clashFixOnTimecards: "corrige ese turno en Tarjetas de Tiempo",
    vp_clashAskOfficeToFix: "pídele a la oficina que corrija ese turno",
    vp_clashRecorded: "Ya tienes horas registradas el {when}{where}, así que un reloj que empiece a las {at} las contaría dos veces. {nothing} Empieza el reloj a las {end} o más tarde, o {fix}.",
    vp_clashRunning: "Desde el {when}{where} ya tienes un reloj corriendo. {nothing}",
  },
};
