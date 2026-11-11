import type { WordCatalog } from "./types";

/**
 * THE ESTIMATES' SCREENS (qt_, the estimates-in-Spanish wave, cn-v1145): the Estimates list and its
 * page, New Estimate and its kit picker, the estimate's own page and its cards (the circuit schedule,
 * the customer pick, Fixed / Time & Material, the status, Duplicate), the paper-format switch, Add Line
 * Items, the share and email buttons, and New Inspection. OWNER: builder B (qt_ and qb_). The foundation
 * (builder A) made the shelf, named the screens and wired the estimate status family below, so the leak
 * test (tests/tech-words-in-the-catalog.test.ts) already lists every English literal each screen still
 * shows: that list is the work.
 *
 * The convention is lib/words/agenda's: a clickable key is qt_btn_…, Title Case in both languages
 * (tests/words-parity.test.ts TITLE_CASE_FAMILIES holds the family); everything else sentence case;
 * plurals as paired keys (…One/…Many); a gendered noun as a whole-phrase key; a JSX fragment as one key
 * with {slots} through fillText (lib/i18n). The English is byte for byte what each screen says today.
 * Spanish is tú, US/Mexican, the house words (Presupuesto, borrador, Cliente, Trabajo, factura, Enviar,
 * Guardar, Cancelar, Eliminar, Lista De Precios, Mano De Obra, Impuesto, Descuento, Tareas) — grep the
 * other catalogs before coining a word. Nothing a tenant's CUSTOMER reads (the estimate paper, the PDF,
 * the email, the text, the public page) moves here: those stay English.
 *
 * WORDS COINED HERE, once (builder B, cn-v1145): line item = partida (an estimate's line, as the other
 * catalogs already say it); a part = pieza (qs_lib_…); Breaker = Interruptor and Wire = Cable (the circuit
 * schedule); Vendor = Proveedor (jb_noVendor); Default = Predeterminado; Quote (Fixed) = Cotización
 * (Precio Fijo) and Estimate (T&M) = Presupuesto (Tiempo Y Material) (nv_page_quotes, ag_rail_billingTm);
 * Revise = Crear Revisión; Not Yet = Aún No (mt_notYetTick); Size To Job = Calcular Para El Trabajo.
 * Shared pieces (Add Line Items, the share and email buttons, the header's Preview) read the language themselves, so a Spanish
 * office seat sees them in Spanish on billing too. The Text chip's not-set-up refusal is lib/sms-readiness's
 * own constant and stays English with it.
 *
 * THE ESTIMATE STATUS FAMILY (qt_status_…): lib/statuses estimateStatusLabel reads these for a Spanish
 * reader through the caller's translator. Lowercase, like the raw values every badge prints in English
 * ("draft"); a caller that capitalizes (the status select) capitalizes the Spanish the same way.
 * cn-v1147: in Spanish the function words (a, de, la, y…) stay lowercase after the first word ("Lista de
 * Precios", "Mover a un Día"); English keeps every word capitalized.
 *
 * DOCUMENT STUDIO'S LABOR AND PARTS ON ESTIMATES (cn-v1158): the company's default for the paper format is the
 * other end of the estimate's paper switch, so its control's words sit beside the switch's here and the two are
 * ONE set: each of the three formats has one name, and both controls read it from the same key. The control is
 * its own small file (doc-studio/estimate-lines-control) and reads the language itself; the rest of the studio is
 * still English, like the other office pages' contents.
 *
 * THE ESTIMATE'S JOB SITE (cn-v1158): the line under the customer card and its one sheet (quotes/[id]/job-site-line).
 * A job site = sitio de trabajo, the word the clock and the geofence already use. The Unit / Apt box is New Job's
 * own, so its three words are read from the agenda's catalog (ag_rail_unitApt, ag_rail_optional, ag_rail_unitExample)
 * and Open the Job from ag_btn_openTheJob: one box and one door, one set of words. The address it shows is what the
 * PAPER prints, so a unit reads "Unit 14" in both languages, as the paper does.
 */
export const words: WordCatalog = {
  prefix: "qt_",
  files: [
    "src/app/(app)/quotes/page.tsx",
    "src/app/(app)/quotes/quotes-list.tsx",
    "src/app/(app)/quotes/new/page.tsx",
    "src/app/(app)/quotes/new/kit-picker-modal.tsx",
    "src/app/(app)/quotes/[id]/page.tsx",
    "src/app/(app)/quotes/[id]/circuit-schedule-card.tsx",
    "src/app/(app)/quotes/[id]/customer-select.tsx",
    "src/app/(app)/quotes/[id]/job-site-line.tsx",
    "src/app/(app)/quotes/[id]/quote-type-toggle.tsx",
    "src/app/(app)/quotes/[id]/status-control.tsx",
    "src/app/(app)/quotes/[id]/duplicate-quote-button.tsx",
    "src/app/(app)/quotes/paper-format-switch.tsx",
    "src/app/(app)/doc-studio/estimate-lines-control.tsx",
    "src/components/add-line-items.tsx",
    "src/components/share-icon-button.tsx",
    "src/components/preview-button.tsx",
    "src/app/(app)/appointments/new-inspection-button.tsx",
  ],
  sameInBoth: ["qt_colTotal", "qt_breakerExample"],
  en: {
    // ── An estimate's status (lib/statuses estimateStatusLabel) ──
    qt_status_draft: "draft",
    qt_status_sent: "sent",
    qt_status_accepted: "accepted",
    qt_status_declined: "declined",
    qt_status_expired: "expired",
    qt_status_superseded: "superseded",

    // ── The Estimates list (quotes/page, quotes-list) ──
    qt_btn_newEstimate: "New Estimate",
    qt_filtered: "Filtered:",
    qt_noEstimatesYet: "No estimates yet",
    qt_emptyFirstEstimate: "Create your first estimate with New Estimate above — the AI can draft line items from a scope of work.",
    qt_estimatesOff: "Estimates are off for this company.",
    qt_unknownCustomer: "Unknown customer",
    qt_colEstimateNo: "Estimate #",
    qt_fixed: "Fixed",
    qt_colCustomer: "Customer",
    qt_dotLead: "· lead",
    qt_colDate: "Date",
    qt_colTotal: "Total",
    qt_colStatus: "Status",
    qt_confirmDeleteDraft: "Delete this draft?",
    qt_couldntDeleteDraft: "Couldn't delete the draft.",
    qt_draftDeleted: "Draft deleted.",
    qt_deleteThisDraft: "Delete this draft",
    qt_possibleDuplicates: "Possible duplicates",
    qt_groupsOne: "{n} group",
    qt_groupsMany: "{n} groups",
    qt_confirmKeepDeleteOthers: "Keep {which} and delete the other {n}?",
    qt_thisDraft: "this draft",
    qt_theDraft: "the draft",
    qt_couldntCleanDuplicates: "Couldn't clean up the duplicates.",
    qt_keptDeleted: "Kept {which}, deleted {n}.",
    qt_onAJob: "On a Job",
    qt_keepThisDeleteRest: "Keep this one, delete the rest",
    qt_btn_keepThis: "Keep This",
    qt_pinnedOnAJob: "{which} is on a job — keeping that one is usually right.",

    // ── New Estimate and the saved estimate's page (quotes/new/page, quotes/[id]/page) ──
    qt_btn_backToEstimates: "Back to Estimates",
    qt_btn_backToQuotes: "Back to Quotes",
    qt_priceListDidntLoad: "Price list didn't load",
    qt_kitsDidntLoadWhole: "Kits didn't load whole",

    // ── The kit picker (quotes/new/kit-picker-modal) ──
    qt_addFromKit: "Add from kit: {name}",
    qt_addItemsOne: "Add {n} item — {amount}",
    qt_addItemsMany: "Add {n} items — {amount}",
    qt_kitTickLines: "Tick the lines this estimate needs. Qty and price edits apply to THIS estimate only — the kit itself is unchanged.",
    qt_kitLinkedPriced: "lines are priced from the Price List for this customer.",
    qt_kitSizesItself: "This list sizes itself.",
    qt_kitTakenFromInspection: "Taken from the inspection — change them if the job did.",
    qt_kitEnterMeasurements: "Enter the job’s measurements and the quantities fill in.",
    qt_squareFeet: "Square feet",
    qt_linearFeet: "Linear feet",
    qt_btn_sizeToJob: "Size to Job",
    qt_nOfTotalSelected: "{n} of {total} selected",
    qt_includeLine: "Include {name}",
    qt_pricedFromPriceList: "Priced from the Price List",
    qt_description: "Description",
    qt_qty: "Qty",
    qt_quantity: "Quantity",
    qt_unitDollar: "Unit $",
    qt_unitPrice: "Unit price",
    qt_kitNoItemsYet: "This kit has no items yet — add the first one below.",
    qt_kitChangeItself: "Need to change the kit itself — add, remove or re-price a line for every future estimate? Do it in Price list & kits.",

    // ── The circuit schedule card (quotes/[id]/circuit-schedule-card) ──
    qt_theJob: "the job",
    qt_couldntSave: "Couldn't save.",
    qt_circuitSchedule: "Circuit Schedule",
    qt_printsAsSecondPage: "· prints as a second page",
    qt_btn_reading: "Reading…",
    qt_btn_regenerate: "Regenerate",
    qt_btn_generateFromLineItems: "Generate from Line Items",
    qt_btn_saving: "Saving…",
    qt_btn_saved: "Saved",
    qt_btn_save: "Save",
    qt_proposalNotJobList: "This Is the Proposal. The Job Keeps Its Own List On the Panel Tab.",
    qt_openJobPanel: "Open {job}'s Panel",
    qt_noCircuitScheduleYet: "No circuit schedule yet. Tap Generate from Line Items to read the breakers and wire in the line items, or Add Circuit to type rows by hand.",
    qt_colCkt: "Ckt",
    qt_colWire: "Wire",
    qt_colBreaker: "Breaker",
    qt_colLoadNotes: "Load / Notes",
    qt_breakerExample: "20A",
    qt_btn_removeCircuit: "Remove Circuit",
    qt_btn_addCircuit: "Add Circuit",

    // ── The estimate's customer (quotes/[id]/customer-select) ──
    qt_nameRequired: "Name is required.",
    qt_couldntCreateCustomer: "Couldn't create the customer.",
    qt_createdNotAttached: "Created them, but couldn't attach — pick them from the list.",
    qt_couldntChangeCustomer: "Couldn't change the customer.",
    qt_name: "Name",
    qt_customerName: "Customer name",
    qt_address: "Address",
    qt_jobAddress: "Job address",
    qt_btn_createAndAttach: "Create & Attach",
    qt_btn_cancel: "Cancel",
    qt_restFromContact: "Phone, email and the rest can go in from the contact afterwards.",
    qt_noCustomerLeaveWithLead: "— No customer — leave it with the lead {name} —",
    qt_noCustomer: "— No customer —",
    qt_btn_newCustomer: "+ New Customer",
    qt_startedFromLead: "Started from the lead {name}.",
    qt_leadNotCustomerYet: "Lead — not a customer yet",
    // qt_leadNoAddress ("No address on this lead yet.") was retired in both languages in cn-v1158: the lead's
    // address is the estimate's job site, and the Job Site line below is the one place that says it now.
    qt_madeOutToLead: "This estimate is made out to them. They become a customer when you win the work — there's nothing to do here now.",
    qt_preparedFor: "Prepared for",
    qt_nobodyAttachedYet: "Nobody attached yet — it prints without a name until you pick someone.",
    qt_changeCustomerTitle: "Change the customer on this estimate",
    qt_attachCustomerTitle: "Attach a customer",
    qt_btn_change: "Change",
    qt_btn_attachCustomer: "Attach Customer",

    // ── The estimate's job site (quotes/[id]/job-site-line, cn-v1158; the owner, 2026-11-10: "we need to have sites
    //    available to pick from on the estimate sheet"). The line under the customer card says the address the paper
    //    prints and where it comes from; Change Job Site opens the one sheet. The words inside a row of that sheet are
    //    a door's words, so they are Title Case (qt_btn_); the sentences beside the line are not ──
    qt_jobSite: "Job Site",
    qt_siteSetHere: "Set on this estimate",
    qt_siteFromTheJob: "From the job",
    qt_siteFromTheLead: "From the lead",
    qt_siteFromTheCustomer: "From the customer",
    qt_siteNone: "No job site yet. This estimate prints without one.",
    // The address is short of a whole town: ANY of the city, the state or the zip is missing (the paper prints whatever
    // part there is, so the old "prints it without a city, state or zip" was not true of an address with a city and
    // no zip). Each sentence names the ONE thing to do, by where the address can be fixed: this sheet for an estimate
    // with no job, the job itself for an estimate on one (a job owns its site).
    qt_siteNoTown: "Part of this address's town is missing (city, state or zip). Change Job Site and pick a suggestion to fill it in.",
    qt_siteNoTownJob: "Part of this address's town is missing (city, state or zip). Fix the address on the job.",
    // An estimate that carried its own address into its job, after the job's address was changed: the estimate's own
    // still outranks the job's on the paper, so the line says both and offers the one way back.
    qt_siteJobDiffers: "This estimate prints its own address. The job's is {address}.",
    qt_btn_changeJobSite: "Change Job Site",
    qt_btn_useJobAddress: "Use the Job's Address",
    // The sheet. The why line (140 characters at most): where the answer lands, on the paper and on the job after it.
    qt_siteSheetWhy: "The estimate prints this as its job site, and a job made from it starts at this address.",
    qt_btn_useCustomerAddress: "Use the Customer's Address",
    qt_btn_useLeadAddress: "Use the Lead's Address",
    qt_btn_customersAddress: "The Customer's Address",
    qt_btn_siteFromJob: "From {job}",
    qt_btn_siteInUse: "In Use",
    qt_siteJobsNotLoaded: "The addresses from this customer's earlier jobs could not be loaded. Reload the page to see them.",
    // Under the rows, when the page's read of the customer's jobs came back full or the picker's cap left an address
    // out (lib/quote-site siteChoicesShort): a short list says it is short, and points at the boxes below it.
    qt_siteListShort: "Showing this customer's most recent addresses. Type any other one below.",
    qt_differentAddress: "A Different Address",
    qt_btn_useThisAddress: "Use This Address",

    // ── The estimate's type, status, Duplicate and the paper format (quote-type-toggle, status-control, duplicate-quote-button, paper-format-switch) ──
    qt_btn_typeQuote: "Quote (Fixed)",
    qt_btn_typeEstimate: "Estimate (T&M)",
    qt_couldntChangeType: "Couldn't change the type — try again.",
    qt_typeSetAlreadySent: "Already sent, so the type is set - the copy the customer has states the pricing basis. Duplicate it to start a new one.",
    qt_typeTitle: "Quote = fixed price · Estimate = time & materials",
    qt_didntSaveTryAgain: "That didn't save — try again.",
    qt_couldntRevise: "Couldn't revise.",
    qt_couldntDuplicate: "Couldn't duplicate.",
    qt_reviseTitle: "Revise this estimate: a copy that replaces it when accepted",
    qt_duplicateTitle: "Duplicate quote",
    qt_btn_revising: "Revising…",
    qt_btn_duplicating: "Duplicating…",
    qt_btn_revise: "Revise",
    qt_btn_duplicate: "Duplicate",
    qt_laborPartsOnPaper: "Labor and Parts on the Paper",
    // ONE CONTROL, FOUR SEGMENTS (cn-v1158; Erik, 2026-11-10: "an option to list out all the materials shown as it is
    // now and an option to group the materials into one materials line"). The first says what the company's default
    // is today, by the word Document Studio stored ('detailed' / 'grouped' / 'tasks'); the other three are the
    // estimate's own choice. The old On / Off pair and Show went with the three-segment switch, their only reader.
    //
    // ONE NAME FOR EACH OF THE THREE FORMATS, EVERYWHERE (the owner's law: fewer words per door). The same three
    // states used to wear three sets of names: List Every Part / One Materials Line / Hide on the estimate's switch,
    // Every Part / One Line / Hidden after the dot of its first segment, and Tasks with Labor and Parts / Labor and
    // One Materials Line / Tasks Only in Document Studio. Now each state has ONE name, said by ONE key that all three
    // places read (quotes/paper-format-switch FORMAT_NAME): 'detailed' Every Part, 'grouped' One Materials Line (the
    // name the owner knows), 'tasks' Hidden. The words after the dot of a Company Default segment are that name too,
    // letter for letter (paper-format-switch.test.tsx holds them to it). Retired with their readers: qt_btn_listEveryPart,
    // qt_btn_hide, qt_btn_linesTasksOnly, qt_btn_linesLaborAndParts, qt_btn_linesOneMaterialsLine.
    qt_btn_companyDefaultEveryPart: "Company Default · Every Part",
    qt_btn_companyDefaultOneLine: "Company Default · One Materials Line",
    qt_btn_companyDefaultHidden: "Company Default · Hidden",
    qt_btn_everyPart: "Every Part",
    qt_btn_oneMaterialsLine: "One Materials Line",
    qt_btn_hidden: "Hidden",
    // The why line (140 characters at most): where the answer lands on the paper, and that the price does not move.
    qt_paperFormatHelp: "Changes what prints under each task, never its price or total. Company default: Document Studio.",
    // ── Document Studio's control for the company's default (doc-studio/estimate-lines-control). Its three choices are
    // the three state names above. Its heading was "Estimate Lines", which reads wrongly over a choice called Hidden
    // (hidden lines?), so it says what the choice is about, as the estimate's own switch does: the labor and the parts ──
    qt_estimateLines: "Labor and Parts on Estimates",

    // ── Add Line Items (components/add-line-items; also drawn on billing) ──
    qt_addFromPriceList: "Add from Price List — tap to browse, or search…",
    qt_vendorsOne: "{n} Vendor",
    qt_vendorsMany: "{n} Vendors",
    qt_default: "Default",
    qt_priceListEmpty: "Your price list is empty.",
    qt_nothingMatches: "Nothing matches that.",
    qt_showingNofTotal: "Showing {n} of {total} — type to narrow it down.",
    qt_addFromAList: "Add from a list",
    // The typed line (cn-v1152; Erik, 2026-11-07: "add from pricelist should be with or integrated into the add
    // a line item on the bottom"): the invoice's hand row, drawn under the picker's box, which is also its
    // description box. The row's words were the invoice page's own English until the row moved here.
    qt_addLineOrPick: "Add a line item — type it, or pick from the Price List…",
    qt_addALineItem: "Add a line item…",
    qt_whatThisChargeIsFor: "What this charge is for",
    qt_unitPh: "unit",
    qt_unitAria: "Unit",
    qt_price: "Price",
    qt_btn_add: "Add",
    // What the row is still missing, said under it (lib/invoice-math addLineAsk decides which; skeptic #56b):
    // the words, or a price nobody typed. A 0 typed on purpose is a no-charge line and goes on.
    qt_askWords: "Type what this charge is for in the box above, then tap Add.",
    qt_askPrice: "Type the price, or 0 if there's no charge, then tap Add.",

    // ── The share button (components/share-icon-button; also drawn on billing) ──
    qt_btn_share: "Share",
    qt_couldntBuildLink: "Couldn't build the link.",
    qt_copiedPasteIt: "Copied — paste it into a text or email.",
    qt_couldntShare: "Couldn't share that — try Email instead.",
    qt_stillADraft: "This is still a draft.",
    qt_btn_shareThisNow: "Share This Now?",
    qt_btn_markSentAndShare: "Mark Sent and Share",
    qt_btn_notYet: "Not Yet",
    qt_sharingIsSending: "Sharing the link is sending it, so this marks it sent and opens your share sheet in the same motion. You can still change it afterwards.",

    // ── The Email and Text chips (the old components/email-button, gone in cn-v1155: Send now opens components/send-sheet). The texting-not-set-up refusal is lib/sms-readiness's own constant and stays English with it ──
    qt_couldntSendTryAgain: "Couldn't send — try again.",
    qt_theCustomer: "the customer",
    qt_confirmEmailInvoiceAmount: "Send this {money} invoice to {who} by email? This marks it Sent.",
    qt_confirmEmailInvoice: "Send this invoice to {who} by email? This marks it Sent.",
    qt_confirmTextInvoiceAmount: "Text this {money} invoice to {who}? This marks it Sent.",
    qt_confirmTextInvoice: "Text this invoice to {who}? This marks it Sent.",
    qt_confirmEmail: "Email?",
    qt_confirmText: "Text?",
    qt_btn_sendInvoice: "Send Invoice",
    qt_btn_send: "Send",
    // The header's Preview, beside Send on an estimate and on an invoice (components/preview-button, 2026-11-10): the real PDF, with Print and Download PDF inside it
    qt_btn_preview: "Preview",
    qt_previewStillSaving: "That change is still saving, so the preview would be missing it. Try Preview again in a moment.",
    qt_btn_email: "Email",
    qt_btn_text: "Text",
    qt_invoiceEmailed: "Invoice emailed",
    qt_estimateEmailed: "Estimate emailed",
    qt_invoiceTexted: "Invoice texted",
    qt_estimateTexted: "Estimate texted",

    // ── New Inspection (appointments/new-inspection-button; drawn on New Estimate, the Inspections tab and the lead row) ──
    qt_couldNotStartInspection: "Could not start the inspection.",
    qt_btn_starting: "Starting…",
    qt_btn_startAnInspection: "Start an Inspection",
    qt_btn_bookAnInspection: "Book an Inspection",
  },
  es: {
    qt_status_draft: "borrador",
    qt_status_sent: "enviado",
    qt_status_accepted: "aceptado",
    qt_status_declined: "rechazado",
    qt_status_expired: "vencido",
    qt_status_superseded: "reemplazado",
    // ── The Estimates list (quotes/page, quotes-list) ──
    qt_btn_newEstimate: "Nuevo Presupuesto",
    qt_filtered: "Filtrado:",
    qt_noEstimatesYet: "Aún no hay presupuestos",
    qt_emptyFirstEstimate: "Crea tu primer presupuesto con Nuevo Presupuesto arriba — la IA puede redactar las partidas a partir del alcance del trabajo.",
    qt_estimatesOff: "Los presupuestos están desactivados para esta empresa.",
    qt_unknownCustomer: "Cliente desconocido",
    qt_colEstimateNo: "Presupuesto #",
    qt_fixed: "Fijo",
    qt_colCustomer: "Cliente",
    qt_dotLead: "· prospecto",
    qt_colDate: "Fecha",
    qt_colTotal: "Total",
    qt_colStatus: "Estado",
    qt_confirmDeleteDraft: "¿Eliminar este borrador?",
    qt_couldntDeleteDraft: "No se pudo eliminar el borrador.",
    qt_draftDeleted: "Borrador eliminado.",
    qt_deleteThisDraft: "Eliminar este borrador",
    qt_possibleDuplicates: "Posibles duplicados",
    qt_groupsOne: "{n} grupo",
    qt_groupsMany: "{n} grupos",
    qt_confirmKeepDeleteOthers: "¿Dejar {which} y eliminar los otros {n}?",
    qt_thisDraft: "este borrador",
    qt_theDraft: "el borrador",
    qt_couldntCleanDuplicates: "No se pudieron limpiar los duplicados.",
    qt_keptDeleted: "Se dejó {which}, se eliminaron {n}.",
    qt_onAJob: "En un Trabajo",
    qt_keepThisDeleteRest: "Dejar este, eliminar los demás",
    qt_btn_keepThis: "Dejar Este",
    qt_pinnedOnAJob: "{which} está en un trabajo — casi siempre conviene dejar ese.",

    // ── New Estimate and the saved estimate's page (quotes/new/page, quotes/[id]/page) ──
    qt_btn_backToEstimates: "Volver a Presupuestos",
    qt_btn_backToQuotes: "Volver a Cotizaciones",
    qt_priceListDidntLoad: "La lista de precios no cargó",
    qt_kitsDidntLoadWhole: "Los kits no cargaron completos",

    // ── The kit picker (quotes/new/kit-picker-modal) ──
    qt_addFromKit: "Agregar del kit: {name}",
    qt_addItemsOne: "Agregar {n} partida — {amount}",
    qt_addItemsMany: "Agregar {n} partidas — {amount}",
    qt_kitTickLines: "Marca las líneas que necesita este presupuesto. Los cambios de cantidad y precio solo cuentan para ESTE presupuesto — el kit no cambia.",
    qt_kitLinkedPriced: "las líneas marcadas toman su precio de la Lista de Precios para este cliente.",
    qt_kitSizesItself: "Esta lista se calcula sola.",
    qt_kitTakenFromInspection: "Tomadas de la inspección — cámbialas si el trabajo cambió.",
    qt_kitEnterMeasurements: "Escribe las medidas del trabajo y las cantidades se llenan solas.",
    qt_squareFeet: "Pies cuadrados",
    qt_linearFeet: "Pies lineales",
    qt_btn_sizeToJob: "Calcular para el Trabajo",
    qt_nOfTotalSelected: "{n} de {total} seleccionadas",
    qt_includeLine: "Incluir {name}",
    qt_pricedFromPriceList: "Con precio de la Lista de Precios",
    qt_description: "Descripción",
    qt_qty: "Cant.",
    qt_quantity: "Cantidad",
    qt_unitDollar: "$ por unidad",
    qt_unitPrice: "Precio por unidad",
    qt_kitNoItemsYet: "Este kit aún no tiene partidas — agrega la primera abajo.",
    qt_kitChangeItself: "¿Necesitas cambiar el kit mismo — agregar, quitar o cambiar el precio de una línea para todos los presupuestos futuros? Hazlo en Lista de Precios y kits.",

    // ── The circuit schedule card (quotes/[id]/circuit-schedule-card) ──
    qt_theJob: "el trabajo",
    qt_couldntSave: "No se pudo guardar.",
    qt_circuitSchedule: "Tabla de Circuitos",
    qt_printsAsSecondPage: "· se imprime como segunda página",
    qt_btn_reading: "Leyendo…",
    qt_btn_regenerate: "Regenerar",
    qt_btn_generateFromLineItems: "Generar desde las Partidas",
    qt_btn_saving: "Guardando…",
    qt_btn_saved: "Guardado",
    qt_btn_save: "Guardar",
    qt_proposalNotJobList: "Esta Es la Propuesta. El Trabajo Lleva Su Propia Lista en la Pestaña Panel.",
    qt_openJobPanel: "Abrir el Panel de {job}",
    qt_noCircuitScheduleYet: "Aún no hay tabla de circuitos. Toca Generar desde las Partidas para leer los interruptores y el cable de las partidas, o Agregar Circuito para escribir las filas a mano.",
    qt_colCkt: "Cto.",
    qt_colWire: "Cable",
    qt_colBreaker: "Interruptor",
    qt_colLoadNotes: "Carga / Notas",
    qt_breakerExample: "20A",
    qt_btn_removeCircuit: "Quitar Circuito",
    qt_btn_addCircuit: "Agregar Circuito",

    // ── The estimate's customer (quotes/[id]/customer-select) ──
    qt_nameRequired: "El nombre es obligatorio.",
    qt_couldntCreateCustomer: "No se pudo crear el cliente.",
    qt_createdNotAttached: "Se creó, pero no se pudo adjuntar — elígelo de la lista.",
    qt_couldntChangeCustomer: "No se pudo cambiar el cliente.",
    qt_name: "Nombre",
    qt_customerName: "Nombre del cliente",
    qt_address: "Dirección",
    qt_jobAddress: "Dirección del trabajo",
    qt_btn_createAndAttach: "Crear y Adjuntar",
    qt_btn_cancel: "Cancelar",
    qt_restFromContact: "El teléfono, el correo y lo demás se agregan después desde el contacto.",
    qt_noCustomerLeaveWithLead: "— Sin cliente — dejarlo con el prospecto {name} —",
    qt_noCustomer: "— Sin cliente —",
    qt_btn_newCustomer: "+ Nuevo Cliente",
    qt_startedFromLead: "Empezó con el prospecto {name}.",
    qt_leadNotCustomerYet: "Prospecto — aún no es cliente",
    qt_madeOutToLead: "Este presupuesto está a su nombre. Se vuelve cliente cuando ganas el trabajo — no hay nada que hacer aquí por ahora.",
    qt_preparedFor: "Preparado para",
    qt_nobodyAttachedYet: "Nadie adjunto todavía — se imprime sin nombre hasta que elijas a alguien.",
    qt_changeCustomerTitle: "Cambiar el cliente de este presupuesto",
    qt_attachCustomerTitle: "Adjuntar un cliente",
    qt_btn_change: "Cambiar",
    qt_btn_attachCustomer: "Adjuntar Cliente",

    // ── The estimate's job site (cn-v1158). Sitio de trabajo, as the clock and the geofence already say a job site
    //    (tc_theJobsite, gf_theJobSite); ciudad for a town (ag_noTownYet); prospecto, cliente, trabajo, presupuesto and
    //    el papel as everywhere else. "Fijado" agrees with "sitio", the heading it sits under ──
    qt_jobSite: "Sitio de Trabajo",
    qt_siteSetHere: "Fijado en este presupuesto",
    qt_siteFromTheJob: "Del trabajo",
    qt_siteFromTheLead: "Del prospecto",
    qt_siteFromTheCustomer: "Del cliente",
    qt_siteNone: "Aún no hay sitio de trabajo. Este presupuesto se imprime sin uno.",
    // Tú ("usa", "elige", "corrige"); the door is named as it reads on the screen (qt_btn_changeJobSite).
    qt_siteNoTown: "A esta dirección le falta parte de la ciudad (ciudad, estado o código postal). Usa Cambiar el Sitio de Trabajo y elige una sugerencia para completarla.",
    qt_siteNoTownJob: "A esta dirección le falta parte de la ciudad (ciudad, estado o código postal). Corrige la dirección en el trabajo.",
    qt_siteJobDiffers: "Este presupuesto imprime su propia dirección. La del trabajo es {address}.",
    qt_btn_changeJobSite: "Cambiar el Sitio de Trabajo",
    qt_btn_useJobAddress: "Usar la Dirección del Trabajo",
    qt_siteSheetWhy: "El presupuesto imprime esto como su sitio de trabajo, y un trabajo creado de él empieza en esta dirección.",
    qt_btn_useCustomerAddress: "Usar la Dirección del Cliente",
    qt_btn_useLeadAddress: "Usar la Dirección del Prospecto",
    qt_btn_customersAddress: "La Dirección del Cliente",
    qt_btn_siteFromJob: "De {job}",
    qt_btn_siteInUse: "En Uso",
    qt_siteJobsNotLoaded: "No se pudieron cargar las direcciones de los trabajos anteriores de este cliente. Recarga la página para verlas.",
    qt_siteListShort: "Se muestran las direcciones más recientes de este cliente. Escribe cualquier otra abajo.",
    qt_differentAddress: "Otra Dirección",
    qt_btn_useThisAddress: "Usar Esta Dirección",

    // ── The estimate's type, status, Duplicate and the paper format (quote-type-toggle, status-control, duplicate-quote-button, paper-format-switch) ──
    qt_btn_typeQuote: "Cotización (Precio Fijo)",
    qt_btn_typeEstimate: "Presupuesto (Tiempo y Material)",
    qt_couldntChangeType: "No se pudo cambiar el tipo — inténtalo de nuevo.",
    qt_typeSetAlreadySent: "Ya se envió, así que el tipo queda fijo - la copia que tiene el cliente dice cómo se cobra. Usa Duplicar para empezar uno nuevo.",
    qt_typeTitle: "Cotización = precio fijo · Presupuesto = tiempo y materiales",
    qt_didntSaveTryAgain: "No se guardó — inténtalo de nuevo.",
    qt_couldntRevise: "No se pudo crear la revisión.",
    qt_couldntDuplicate: "No se pudo duplicar.",
    qt_reviseTitle: "Crea una revisión de este presupuesto: una copia que lo reemplaza cuando se acepta",
    qt_duplicateTitle: "Duplicar cotización",
    qt_btn_revising: "Creando Revisión…",
    qt_btn_duplicating: "Duplicando…",
    qt_btn_revise: "Crear Revisión",
    qt_btn_duplicate: "Duplicar",
    qt_laborPartsOnPaper: "Mano de Obra y Piezas en el Papel",
    // The four segments (cn-v1158): pieza, as the catalog says a part; "Una" opens its own name, and its segment after
    // the dot, so it is capital in both. ONE name per format, the same three keys in all three places: Cada Pieza,
    // Una Línea de Materiales, Oculto (the word the first segment's "· Oculto" already used).
    qt_btn_companyDefaultEveryPart: "Predeterminado de la Empresa · Cada Pieza",
    qt_btn_companyDefaultOneLine: "Predeterminado de la Empresa · Una Línea de Materiales",
    qt_btn_companyDefaultHidden: "Predeterminado de la Empresa · Oculto",
    qt_btn_everyPart: "Cada Pieza",
    qt_btn_oneMaterialsLine: "Una Línea de Materiales",
    qt_btn_hidden: "Oculto",
    qt_paperFormatHelp: "Cambia lo que se imprime debajo de cada tarea, nunca su precio ni su total. Predeterminado de la empresa: Document Studio.",
    // Document Studio's control for the company's default: the heading says what the three names are about.
    qt_estimateLines: "Mano de Obra y Piezas en Presupuestos",

    // ── Add Line Items (components/add-line-items; also drawn on billing) ──
    qt_addFromPriceList: "Agregar de la Lista de Precios — toca para ver, o busca…",
    qt_vendorsOne: "{n} Proveedor",
    qt_vendorsMany: "{n} Proveedores",
    qt_default: "Predeterminado",
    qt_priceListEmpty: "Tu lista de precios está vacía.",
    qt_nothingMatches: "Nada coincide con eso.",
    qt_showingNofTotal: "Mostrando {n} de {total} — escribe para acotar.",
    qt_addFromAList: "Agregar de una lista",
    // The typed line (cn-v1152): partida, as the catalog says a line item; tú ("escríbela", "elige").
    qt_addLineOrPick: "Agregar una partida — escríbela, o elige de la Lista de Precios…",
    qt_addALineItem: "Agregar una partida…",
    qt_whatThisChargeIsFor: "De qué es este cargo",
    qt_unitPh: "unidad",
    qt_unitAria: "Unidad",
    qt_price: "Precio",
    qt_btn_add: "Agregar",
    // The ask under the row: casilla, as the other catalogs say a box; "no se cobra" for a no-charge line.
    qt_askWords: "Escribe de qué es este cargo en la casilla de arriba y luego toca Agregar.",
    qt_askPrice: "Escribe el precio, o 0 si no se cobra, y luego toca Agregar.",

    // ── The share button (components/share-icon-button; also drawn on billing) ──
    qt_btn_share: "Compartir",
    qt_couldntBuildLink: "No se pudo armar el enlace.",
    qt_copiedPasteIt: "Copiado — pégalo en un mensaje o un correo.",
    qt_couldntShare: "No se pudo compartir — mejor usa Correo.",
    qt_stillADraft: "Esto todavía es un borrador.",
    qt_btn_shareThisNow: "¿Compartirlo Ahora?",
    qt_btn_markSentAndShare: "Marcar el Envío y Compartir",
    qt_btn_notYet: "Aún No",
    qt_sharingIsSending: "Compartir el enlace es enviarlo, así que esto marca el envío y abre la hoja para compartir en el mismo paso. Aún puedes cambiarlo después.",

    // ── The Email and Text chips (the old components/email-button, gone in cn-v1155: Send now opens components/send-sheet). The texting-not-set-up refusal is lib/sms-readiness's own constant and stays English with it ──
    qt_couldntSendTryAgain: "No se pudo enviar — inténtalo de nuevo.",
    qt_theCustomer: "el cliente",
    qt_confirmEmailInvoiceAmount: "¿Enviar esta factura de {money} a {who} por correo? Esto la marca como Enviada.",
    qt_confirmEmailInvoice: "¿Enviar esta factura a {who} por correo? Esto la marca como Enviada.",
    qt_confirmTextInvoiceAmount: "¿Enviar esta factura de {money} a {who} por mensaje? Esto la marca como Enviada.",
    qt_confirmTextInvoice: "¿Enviar esta factura a {who} por mensaje? Esto la marca como Enviada.",
    qt_confirmEmail: "¿Enviar por correo?",
    qt_confirmText: "¿Enviar por mensaje?",
    qt_btn_sendInvoice: "Enviar Factura",
    qt_btn_send: "Enviar",
    qt_btn_preview: "Vista Previa",
    qt_previewStillSaving: "Ese cambio aún se está guardando, así que la vista previa no lo tendría. Intenta de nuevo en un momento.",
    qt_btn_email: "Correo",
    qt_btn_text: "Mensaje",
    qt_invoiceEmailed: "Factura enviada por correo",
    qt_estimateEmailed: "Presupuesto enviado por correo",
    qt_invoiceTexted: "Factura enviada por mensaje",
    qt_estimateTexted: "Presupuesto enviado por mensaje",

    // ── New Inspection (appointments/new-inspection-button; drawn on New Estimate, the Inspections tab and the lead row) ──
    qt_couldNotStartInspection: "No se pudo empezar la inspección.",
    qt_btn_starting: "Empezando…",
    qt_btn_startAnInspection: "Empezar una Inspección",
    qt_btn_bookAnInspection: "Agendar una Inspección",
  },
};
