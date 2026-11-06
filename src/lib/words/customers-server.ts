import type { WordCatalog } from "./types";

/**
 * THE CUSTOMERS' SERVER WORDS (cu_srv_, the Ventas-2 wave, cn-v1146): what crm/actions, share-actions
 * and portal-look-actions send back to a screen — refusals and toasts' sentences. The foundation
 * (builder A) made the shelf and named the files, so the leak test
 * (tests/tech-words-in-the-catalog.test.ts) already lists every English literal they still show: that
 * list is the work.
 *
 * A "use server" file exports only async functions (tests/use-server-exports.test.ts): read the caller's
 * language once per call (callerLang, lib/lang-of) and its translator (translator(lang), lib/i18n). A
 * clickable's words are cu_srv_btn_…, Title Case in both languages. Spanish is tú, US/Mexican, the
 * house words (Cliente, Prospecto, Empresa, enlace, portal) — the glossary in lib/words/customers.
 * What a tenant's CUSTOMER reads (the shared page, the portal, an email or text to them) stays English.
 *
 * A count of a contact's records is its own sentence (cu_srv_child…One / …Many): the delete guard names
 * each kind with its number, and Spanish nouns carry their own plural and gender.
 *
 * WORDS COINED HERE (builder D, cn-v1146): enlace a un trabajo = job link; plantilla recurrente = recurring
 * template. Reused from builder C's lib/words/customers: combinar = merge, libreta de contactos = your
 * book, crédito a favor = account credit, and the portal card's buttons the refusals name — New Link =
 * Nuevo Enlace (cu_btn_newLink), Turn On = Activar (cu_btn_turnOn).
 */
export const words: WordCatalog = {
  prefix: "cu_srv_",
  files: [
    "src/app/(app)/crm/actions.ts",
    "src/app/(app)/share-actions.ts",
    "src/app/(app)/portal-look-actions.ts",
  ],
  sameInBoth: [],
  en: {
    cu_srv_customerNotFound: "Customer not found.",
    cu_srv_signedOutCardUnread: "They were signed out, but the card couldn't be read back. Refresh the page.",
    cu_srv_didntTake: "That didn't take. Refresh the page and try again.",
    cu_srv_noEmail: "This customer has no email address.",
    cu_srv_noLinkYet: "This customer has no link yet. Tap New Link first.",
    cu_srv_linkOff: "Their link is turned off. Tap Turn On first.",
    cu_srv_newLinkUnread: "The new link was made but couldn't be read back. Refresh the page.",
    cu_srv_notSignedIn: "Not signed in.",
    cu_srv_nameRequired: "Name is required.",
    cu_srv_subTypeUnavailable: "The Subcontractor type isn't available yet. Pick another type.",
    cu_srv_contactUnavailable: "That contact isn't available.",
    cu_srv_nameEmpty: "Name can't be empty.",
    cu_srv_nothingToUpdate: "Nothing to update.",
    cu_srv_noRowsToImport: "No rows with a name to import.",
    cu_srv_maxRows: "Max 2,000 rows per import.",
    cu_srv_hasBlocking: "This contact has {list}. Reassign those first, merge this record into the one you're keeping, or mark the contact inactive instead of deleting it.",
    cu_srv_leavesOrphans: "Deleting this contact leaves {list} with no contact attached.",
    cu_srv_childJobOne: "{n} job",
    cu_srv_childJobMany: "{n} jobs",
    cu_srv_childEstimateOne: "{n} estimate",
    cu_srv_childEstimateMany: "{n} estimates",
    cu_srv_childInvoiceOne: "{n} invoice",
    cu_srv_childInvoiceMany: "{n} invoices",
    cu_srv_childJobLinkOne: "{n} job link",
    cu_srv_childJobLinkMany: "{n} job links",
    cu_srv_childContractOne: "{n} contract",
    cu_srv_childContractMany: "{n} contracts",
    cu_srv_childAccountCreditOne: "{n} account credit",
    cu_srv_childAccountCreditMany: "{n} account credits",
    cu_srv_childInquiryOne: "{n} inquiry",
    // Byte for byte what plural() always printed ("inquiry" + "s"): English is never improved in a wave.
    cu_srv_childInquiryMany: "{n} inquiries",
    cu_srv_childDocumentOne: "{n} document",
    cu_srv_childDocumentMany: "{n} documents",
    cu_srv_childWorkOrderOne: "{n} work order",
    cu_srv_childWorkOrderMany: "{n} work orders",
    cu_srv_childAppointmentOne: "{n} appointment",
    cu_srv_childAppointmentMany: "{n} appointments",
    cu_srv_childRecurringTemplateOne: "{n} recurring template",
    cu_srv_childRecurringTemplateMany: "{n} recurring templates",
    cu_srv_pickMergeTarget: "Pick a customer to merge into.",
    cu_srv_mergeIntoItself: "Can't merge a customer into itself.",
    cu_srv_sourceNotFound: "Source customer not found.",
    cu_srv_targetNotFound: "Target customer not found.",
    cu_srv_couldntMove: "Couldn't move {table}: {error}",
    cu_srv_noCompany: "No company on this account.",
    cu_srv_customerNotInBook: "That customer isn't in your book.",
    cu_srv_jobNotInBook: "That job isn't in your book.",
    cu_srv_pageCouldntOpen: "Their page couldn't be opened. Refresh and try again.",
  },
  es: {
    cu_srv_customerNotFound: "Cliente no encontrado.",
    cu_srv_signedOutCardUnread: "Se cerró su sesión, pero la tarjeta no se pudo volver a leer. Recarga la página.",
    cu_srv_didntTake: "Eso no se aplicó. Recarga la página e inténtalo de nuevo.",
    cu_srv_noEmail: "Este cliente no tiene correo electrónico.",
    cu_srv_noLinkYet: "Este cliente aún no tiene enlace. Toca Nuevo Enlace primero.",
    cu_srv_linkOff: "Su enlace está desactivado. Toca Activar primero.",
    cu_srv_newLinkUnread: "El enlace nuevo se creó, pero no se pudo volver a leer. Recarga la página.",
    cu_srv_notSignedIn: "No has iniciado sesión.",
    cu_srv_nameRequired: "El nombre es obligatorio.",
    cu_srv_subTypeUnavailable: "El tipo Subcontratista aún no está disponible. Elige otro tipo.",
    cu_srv_contactUnavailable: "Ese contacto no está disponible.",
    cu_srv_nameEmpty: "El nombre no puede estar vacío.",
    cu_srv_nothingToUpdate: "No hay nada que actualizar.",
    cu_srv_noRowsToImport: "No hay filas con nombre para importar.",
    cu_srv_maxRows: "Máximo 2,000 filas por importación.",
    cu_srv_hasBlocking: "Este contacto tiene {list}. Reasígnalos primero, combina este registro con el que te quedas, o marca el contacto como inactivo en lugar de eliminarlo.",
    cu_srv_leavesOrphans: "Eliminar este contacto deja {list} sin contacto.",
    cu_srv_childJobOne: "{n} trabajo",
    cu_srv_childJobMany: "{n} trabajos",
    cu_srv_childEstimateOne: "{n} presupuesto",
    cu_srv_childEstimateMany: "{n} presupuestos",
    cu_srv_childInvoiceOne: "{n} factura",
    cu_srv_childInvoiceMany: "{n} facturas",
    cu_srv_childJobLinkOne: "{n} enlace a un trabajo",
    cu_srv_childJobLinkMany: "{n} enlaces a trabajos",
    cu_srv_childContractOne: "{n} contrato",
    cu_srv_childContractMany: "{n} contratos",
    cu_srv_childAccountCreditOne: "{n} crédito a favor",
    cu_srv_childAccountCreditMany: "{n} créditos a favor",
    cu_srv_childInquiryOne: "{n} prospecto",
    cu_srv_childInquiryMany: "{n} prospectos",
    cu_srv_childDocumentOne: "{n} documento",
    cu_srv_childDocumentMany: "{n} documentos",
    cu_srv_childWorkOrderOne: "{n} orden de trabajo",
    cu_srv_childWorkOrderMany: "{n} órdenes de trabajo",
    cu_srv_childAppointmentOne: "{n} cita",
    cu_srv_childAppointmentMany: "{n} citas",
    cu_srv_childRecurringTemplateOne: "{n} plantilla recurrente",
    cu_srv_childRecurringTemplateMany: "{n} plantillas recurrentes",
    cu_srv_pickMergeTarget: "Elige el cliente con el que se va a combinar.",
    cu_srv_mergeIntoItself: "No se puede combinar un cliente consigo mismo.",
    cu_srv_sourceNotFound: "Cliente de origen no encontrado.",
    cu_srv_targetNotFound: "Cliente de destino no encontrado.",
    cu_srv_couldntMove: "No se pudo mover {table}: {error}",
    cu_srv_noCompany: "No hay una empresa en esta cuenta.",
    cu_srv_customerNotInBook: "Ese cliente no está en tu libreta de contactos.",
    cu_srv_jobNotInBook: "Ese trabajo no está en tu libreta de contactos.",
    cu_srv_pageCouldntOpen: "Su página no se pudo abrir. Recarga e inténtalo de nuevo.",
  },
};
