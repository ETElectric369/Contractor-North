import type { WordCatalog } from "./types";

/**
 * THE TASK BREAKDOWN (qb_, the estimates-in-Spanish wave, cn-v1145): quotes/task-breakdown, a task
 * line's labor rows, parts and Remember As A Kit. OWNER: builder B (with qt_). The foundation (builder A)
 * made the shelf and named the screen, so the leak test (tests/tech-words-in-the-catalog.test.ts) already
 * lists every English literal it still shows: that list is the work.
 *
 * The convention is lib/words/quotes' (qt_): a clickable key is qb_btn_…, Title Case in both languages;
 * everything else sentence case; plurals paired (…One/…Many). The kit rule's own sentences (its refusals
 * and kitSummary) live in lib/estimate/kit-from-task with their English inline and their Spanish under
 * qs_lib_kit… (lib/words/quotes-server): pass the screen's `lang` and `t` to kitFromTaskDetail(detail,
 * input, lang, t) and kitSummary(value, fromUnits, lang, t).
 * cn-v1147: in Spanish the function words (a, de, la, y…) stay lowercase after the first word ("Lista de
 * Precios", "Mover a un Día"); English keeps every word capitalized.
 */
export const words: WordCatalog = {
  prefix: "qb_",
  files: ["src/app/(app)/quotes/task-breakdown.tsx"],
  sameInBoth: ["qb_perHour"],
  en: {
    // ── A line's description box (LineDescInput): the book's dropdown and the note door ──
    qb_description: "Description",
    qb_noPriceBookYet: "No price book yet. Upload or build one under Money → Price List and these will autocomplete.",
    qb_nothingMatches: "Nothing in your price list matches that.",
    qb_showingNofTotal: "Showing {n} of {total} — type to narrow it down.",
    qb_note: "Note",
    qb_notePlaceholder: "A note under this line — it prints on the estimate.",
    qb_btn_editNote: "Edit Note",
    qb_btn_addANote: "Add a Note",

    // ── A task's labor rows: who, the hours, the rate chip and the way back to the rule ──
    qb_rateTyped: "× {at} · typed",
    qb_rateFromScope: "× {at} · from the scope",
    qb_rateQuotedAt: "quoted at {at}",
    qb_rateRuleMoved: "quoted at {at} · the rule says {rule} now",
    qb_noRate: "no rate",
    qb_usePersonsRate: "Use {name}'s Rate",
    qb_btn_useCustomersLevel: "Use the Customer's Level",
    qb_btn_useCompanyDefault: "Use the Company Default",
    qb_who: "Who",
    qb_labor: "Labor",
    qb_someoneNoLongerOnTeam: "Someone No Longer on the Team",
    qb_other: "Other…",
    qb_whoInYourWords: "Who, in your words",
    qb_whoPlaceholder: "Helper, 2-man crew…",
    qb_hours: "Hours",
    qb_hoursQ: "hours?",
    qb_btn_changeTheRate: "Change the Rate",
    qb_rate: "Rate",
    qb_perHour: "$/h",
    qb_btn_removeThisLabor: "Remove This Labor",
    qb_btn_addLaborAtAnotherRate: "Add Labor at Another Rate",
    qb_laborTotal: "Labor {amount}",

    // ── A task's parts ──
    qb_part: "Part",
    qb_howMany: "How many",
    qb_howManyPlaceholder: "how many",
    qb_priceEach: "Price each",
    qb_priceQ: "price?",
    qb_btn_removeThisPart: "Remove This Part",
    qb_btn_addAPart: "Add a Part",
    qb_partsTotal: "Parts {amount}",

    // ── The kit it came from, and Remember as a Kit (kitSummary and the kit rule's refusals are lib/estimate/kit-from-task's, qs_lib_kit…) ──
    qb_fromKitNamed: "From the kit {name}",
    qb_fromKitGone: "From the kit it was built from (no longer in your kits)",
    qb_fromKitHidden: "From the kit it was built from",
    qb_dotUnits: "· Units",
    qb_units: "Units",
    qb_unitsPlaceholder: "units",
    qb_hoursStand: "· your hours stand; the kit’s parts follow the units",
    qb_kitName: "Kit name",
    qb_per: "per",
    qb_unit: "Unit",
    qb_ea: "ea",
    qb_under: "under",
    qb_scope: "Scope",
    qb_scopePlaceholder: "the scope, like Deck",
    qb_btn_saving: "Saving…",
    qb_btn_saveTheKit: "Save the Kit",
    qb_btn_cancel: "Cancel",
    qb_btn_rememberAsAKit: "Remember as a Kit",
    qb_willSave: "Will save: {summary}",
    qb_rememberedAsKit: "Remembered as the kit {name} — it's under Kits on the Price List and in the Inspector's kit picker.",
    qb_couldNotRememberKit: "Could not remember the kit.",
    qb_couldNotReachServer: "Could not reach the server — press Save the Kit again.",
    qb_priceSetByHand: "Price set by hand — the breakdown stays off the paper",

    // ── Where a rate came from (lib/pricing/labor-rate laborRateFromWords; its English stays inline there) ──
    qb_lib_rateFromPerson: "{name}'s rate",
    qb_lib_rateFromTheirs: "their rate",
    qb_lib_rateFromLevel: "the customer's level",
    qb_lib_rateFromDefault: "company default",
    qb_lib_rateFromNone: "no rate set",
  },
  es: {
    // ── A line's description box (LineDescInput): the book's dropdown and the note door ──
    qb_description: "Descripción",
    qb_noPriceBookYet: "Aún no hay lista de precios. Súbela o ármala en Dinero → Lista de Precios y esto se autocompletará.",
    qb_nothingMatches: "Nada en tu lista de precios coincide con eso.",
    qb_showingNofTotal: "Mostrando {n} de {total} — escribe para acotar.",
    qb_note: "Nota",
    qb_notePlaceholder: "Una nota debajo de esta línea — se imprime en el presupuesto.",
    qb_btn_editNote: "Editar Nota",
    qb_btn_addANote: "Agregar una Nota",

    // ── A task's labor rows: who, the hours, the rate chip and the way back to the rule ──
    qb_rateTyped: "× {at} · escrita",
    qb_rateFromScope: "× {at} · del alcance",
    qb_rateQuotedAt: "cotizada a {at}",
    qb_rateRuleMoved: "cotizada a {at} · la regla ahora dice {rule}",
    qb_noRate: "sin tarifa",
    qb_usePersonsRate: "Usar la Tarifa de {name}",
    qb_btn_useCustomersLevel: "Usar el Nivel del Cliente",
    qb_btn_useCompanyDefault: "Usar el Predeterminado de la Empresa",
    qb_who: "Quién",
    qb_labor: "Mano de Obra",
    qb_someoneNoLongerOnTeam: "Alguien que Ya No Está en el Equipo",
    qb_other: "Otro…",
    qb_whoInYourWords: "Quién, en tus palabras",
    qb_whoPlaceholder: "Ayudante, cuadrilla de 2…",
    qb_hours: "Horas",
    qb_hoursQ: "¿horas?",
    qb_btn_changeTheRate: "Cambiar la Tarifa",
    qb_rate: "Tarifa",
    qb_perHour: "$/h",
    qb_btn_removeThisLabor: "Quitar Esta Mano de Obra",
    qb_btn_addLaborAtAnotherRate: "Agregar Mano de Obra a Otra Tarifa",
    qb_laborTotal: "Mano de obra {amount}",

    // ── A task's parts ──
    qb_part: "Pieza",
    qb_howMany: "Cuántas",
    qb_howManyPlaceholder: "cuántas",
    qb_priceEach: "Precio por pieza",
    qb_priceQ: "¿precio?",
    qb_btn_removeThisPart: "Quitar Esta Pieza",
    qb_btn_addAPart: "Agregar una Pieza",
    qb_partsTotal: "Piezas {amount}",

    // ── The kit it came from, and Remember As A Kit (kitSummary and the kit rule's refusals are lib/estimate/kit-from-task's, qs_lib_kit…) ──
    qb_fromKitNamed: "Del kit {name}",
    qb_fromKitGone: "Del kit con el que se armó (ya no está en tus kits)",
    qb_fromKitHidden: "Del kit con el que se armó",
    qb_dotUnits: "· Unidades",
    qb_units: "Unidades",
    qb_unitsPlaceholder: "unidades",
    qb_hoursStand: "· tus horas se quedan; las piezas del kit siguen a las unidades",
    qb_kitName: "Nombre del kit",
    qb_per: "por",
    qb_unit: "Unidad",
    qb_ea: "c/u",
    qb_under: "en",
    qb_scope: "Alcance",
    qb_scopePlaceholder: "el alcance, como Terraza",
    qb_btn_saving: "Guardando…",
    qb_btn_saveTheKit: "Guardar el Kit",
    qb_btn_cancel: "Cancelar",
    qb_btn_rememberAsAKit: "Recordar como un Kit",
    qb_willSave: "Se guardará: {summary}",
    qb_rememberedAsKit: "Guardado como el kit {name} — está en Kits de la Lista de Precios y en el selector de kits del Inspector.",
    qb_couldNotRememberKit: "No se pudo guardar el kit.",
    qb_couldNotReachServer: "No se pudo conectar con el servidor — toca Guardar el Kit otra vez.",
    qb_priceSetByHand: "Precio puesto a mano — el desglose no sale en el papel",

    // ── Where a rate came from (lib/pricing/labor-rate laborRateFromWords; its English stays inline there) ──
    qb_lib_rateFromPerson: "la tarifa de {name}",
    qb_lib_rateFromTheirs: "su tarifa",
    qb_lib_rateFromLevel: "el nivel del cliente",
    qb_lib_rateFromDefault: "predeterminado de la empresa",
    qb_lib_rateFromNone: "sin tarifa fijada",
  },
};
