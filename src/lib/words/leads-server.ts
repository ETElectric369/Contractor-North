import type { WordCatalog } from "./types";

/**
 * THE LEADS' SERVER WORDS (ld_srv_, the Ventas-2 wave, cn-v1146): what leads/actions sends back to a
 * screen — its refusals and its toasts' sentences. The foundation (builder A) made the shelf and named
 * the file, so the leak test (tests/tech-words-in-the-catalog.test.ts) already lists every English
 * literal actions.ts still shows: that list is the work.
 *
 * A "use server" file exports only async functions (tests/use-server-exports.test.ts): read the caller's
 * language once per call (callerLang, lib/lang-of) and its translator (translator(lang), lib/i18n), the
 * way schedule/actions' private wordsOf does. A clickable's words are ld_srv_btn_…, Title Case in both
 * languages. Spanish is tú, US/Mexican, the house words (Prospecto, Cliente, Inspección, Trabajo,
 * Presupuesto) — the glossary in lib/words/leads. A database's own words (dbError) pass through as
 * they are; nothing a tenant's CUSTOMER reads moves here.
 * cn-v1147: in Spanish the function words (a, de, la, y…) stay lowercase after the first word ("Lista de
 * Precios", "Mover a un Día"); English keeps every word capitalized.
 */
export const words: WordCatalog = {
  prefix: "ld_srv_",
  files: ["src/app/(app)/leads/actions.ts"],
  sameInBoth: [],
  en: {
    ld_srv_leadNotFound: "Lead not found.",
    ld_srv_addNameToSave: "Add a name, phone, or note to save the lead.",
    ld_srv_leadUnavailable: "That lead isn't available.",
    ld_srv_typeDidntSave: "The lead saved, but its residential or commercial type didn't: {error}",
    ld_srv_nowCommercial: "Saved. This lead is now Commercial, because of its Company.",
    ld_srv_nowResidential: "Saved. This lead is now Residential, because of its Company.",
    ld_srv_linkedTo: "Linked to {name}.",
    ld_srv_linkedToExisting: "Linked to an existing customer.",
    // lib/inquiries/known-customer carryFromCustomer's note (its English inline is the default, byte for byte).
    ld_srv_lib_carriedFrom: "Linked to {name} — brought their {list} across.",
    ld_srv_lib_anExistingCustomer: "an existing customer",
    ld_srv_lib_and: " and ",
    ld_srv_lib_field_phone: "phone",
    ld_srv_lib_field_email: "email",
    ld_srv_lib_field_address: "address",
    ld_srv_lib_field_city: "city",
    ld_srv_lib_field_state: "state",
    ld_srv_lib_field_zip: "ZIP",
    ld_srv_lib_field_company_name: "company",
    ld_srv_sameNameMany:
      'You have {count} customers named "{name}" — a name alone can\'t pick between them, so this lead isn\'t linked to either. Add their phone or email and converting it will find the right one.',
    ld_srv_wonFailed: "Couldn't mark this lead won — it isn't available, or its contact card couldn't be created.",
    ld_srv_alreadyConverted: "This lead was already converted — open its customer or estimate instead.",
    ld_srv_couldntMakeJob: "Couldn't turn this into a job.",
    ld_srv_jobDidntLand: "The job was created but didn't land on the day — place it from the board.",
    ld_srv_pickValidDay: "Pick a valid day for the inspection.",
    ld_srv_estimatesOff: "Estimates are off for this company. The owner can turn them on in Settings, Features.",
    ld_srv_duplicateJobLeft: "This lead was already converted, and the duplicate job it minted couldn't be removed — delete job {id} by hand.",
    ld_srv_tooManyReadings: "A lot of readings in a row — give it a few minutes.",
    ld_srv_notFound: "Not found.",
    ld_srv_couldntOpenFile: "Couldn't open that file.",
    ld_srv_pickOneLead: "Pick at least one lead.",
    ld_srv_pickADay: "Pick a day.",
    ld_srv_alreadyBooked: "This one already has a visit booked — move that one instead.",
    ld_srv_couldntBook: "Couldn't book this one.",
    ld_srv_notAKind: "That isn't a kind of work.",
    ld_srv_durationOff: "That duration isn't sensible.",
    ld_srv_emailLooksWrong: "That email doesn't look right.",
    ld_srv_rideAlongNear: "These ride along with visits already booked near them.",
    ld_srv_rideAlongDays: "These ride along with days that already have visits booked.",
  },
  es: {
    ld_srv_leadNotFound: "Prospecto no encontrado.",
    ld_srv_addNameToSave: "Agrega un nombre, teléfono o nota para guardar el prospecto.",
    ld_srv_leadUnavailable: "Ese prospecto no está disponible.",
    ld_srv_typeDidntSave: "El prospecto se guardó, pero su tipo residencial o comercial no: {error}",
    ld_srv_nowCommercial: "Guardado. Este prospecto ahora es Comercial, por su Empresa.",
    ld_srv_nowResidential: "Guardado. Este prospecto ahora es Residencial, por su Empresa.",
    ld_srv_linkedTo: "Enlazado a {name}.",
    ld_srv_linkedToExisting: "Enlazado a un cliente existente.",
    ld_srv_lib_carriedFrom: "Enlazado a {name} — de su tarjeta de contacto se trajo: {list}.",
    ld_srv_lib_anExistingCustomer: "un cliente existente",
    ld_srv_lib_and: " y ",
    ld_srv_lib_field_phone: "teléfono",
    ld_srv_lib_field_email: "correo",
    ld_srv_lib_field_address: "dirección",
    ld_srv_lib_field_city: "ciudad",
    ld_srv_lib_field_state: "estado",
    ld_srv_lib_field_zip: "código postal",
    ld_srv_lib_field_company_name: "empresa",
    ld_srv_sameNameMany:
      'Tienes {count} clientes llamados "{name}" — un nombre solo no alcanza para elegir entre ellos, así que este prospecto no quedó enlazado a ninguno. Agrega su teléfono o correo y al convertirlo se encontrará el correcto.',
    ld_srv_wonFailed: "No se pudo marcar este prospecto como ganado — no está disponible, o no se pudo crear su tarjeta de contacto.",
    ld_srv_alreadyConverted: "Este prospecto ya se convirtió — abre su cliente o su presupuesto en su lugar.",
    ld_srv_couldntMakeJob: "No se pudo convertir esto en un trabajo.",
    ld_srv_jobDidntLand: "El trabajo se creó pero no quedó en el día — colócalo desde el tablero.",
    ld_srv_pickValidDay: "Elige un día válido para la inspección.",
    ld_srv_estimatesOff: "Los presupuestos están desactivados en esta empresa. El dueño puede activarlos en Ajustes, Funciones.",
    ld_srv_duplicateJobLeft: "Este prospecto ya se convirtió, y el trabajo duplicado que creó no se pudo quitar — borra el trabajo {id} a mano.",
    ld_srv_tooManyReadings: "Muchas lecturas seguidas — dale unos minutos.",
    ld_srv_notFound: "No se encontró.",
    ld_srv_couldntOpenFile: "No se pudo abrir ese archivo.",
    ld_srv_pickOneLead: "Elige al menos un prospecto.",
    ld_srv_pickADay: "Elige un día.",
    ld_srv_alreadyBooked: "Este ya tiene una visita agendada — mueve esa en su lugar.",
    ld_srv_couldntBook: "No se pudo agendar este.",
    ld_srv_notAKind: "Ese no es un tipo de trabajo.",
    ld_srv_durationOff: "Esa duración no tiene sentido.",
    ld_srv_emailLooksWrong: "Ese correo no se ve bien.",
    ld_srv_rideAlongNear: "Estos van junto con visitas ya agendadas cerca de ellos.",
    ld_srv_rideAlongDays: "Estos van junto con días que ya tienen visitas agendadas.",
  },
};
