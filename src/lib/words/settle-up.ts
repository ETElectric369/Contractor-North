import type { WordCatalog } from "./types";
import { TEXTS_NOT_READY_LINE } from "@/lib/sms-readiness";

/**
 * THE SETTLE UP BUTTON'S WORDS (su_, the visit-page-in-Spanish wave, cn-v1144): the one Get Paid
 * sheet (components/settle-up-button — the door, the card panel with Tap to Pay and the QR, the
 * receipt row, "Or They Paid Another Way", the send-first question) that the visit page, the job hub
 * and the invoice page draw. It is the critical path's one button (schedule → done → paid), so it
 * follows the signed-in person's language wherever it is drawn; the office pages that mount it stay
 * English in everything else, by design, so only the button's own file is named here.
 *
 * The convention is lib/words/agenda's: a clickable key is su_btn_…, Title Case in both languages;
 * everything else sentence case; a {slot} is filled by fillText (lib/i18n). The English is byte for
 * byte what the sheet said before the catalog (components/settle-up-spanish.test pins each one to the
 * literal it replaced). The send-first words (lib/pay-door-words) keep their English inline and take
 * the caller's language + translator, the way the agenda's libraries do, because the server refusal
 * (lib/pay-door-send) says the same sentence. The texting line is lib/sms-readiness's own constant, so
 * the sheet and Settings › Customers › Texting never say two things.
 *
 * APPLE'S WORDS. "Tap to Pay" is Apple's short form on the button and is the Title Case law's one
 * exception (tests/title-case.test.ts PROPER_NAMES): it is keyed su_apple_tapToPay, not su_btn_, and
 * reads the same in both languages. In a sentence the full name is "Tap to Pay on iPhone" / "Tap to
 * Pay en el iPhone", Apple's own localisation.
 *
 * WHAT THE CUSTOMER READS STAYS ENGLISH (skeptic #50, cn-v1144). The three strings that leave the tech's
 * phone for the CUSTOMER — the pay-link text (su_payLinkSms, su_invoiceDash), the receipt's share sheet
 * and its Text From This Phone body (su_receiptTitle, su_declinedTitle, su_paidLine, su_declinedLine,
 * su_invoiceN, su_yourInvoice) — are composed through customer_t = translator("en") whatever the tech
 * reads on screen: the customer has no language of their own yet, the same rule start-job-actions keeps
 * for the office's bell (office_t). Their Spanish below is DORMANT BY DESIGN until a customer carries a
 * language. The business's own text and email (textInvoice, emailInvoice) are the server's.
 *
 * Spanish is tú, US/Mexican, the house words: Cobrar (Get Paid, jb_getPaid), Factura (the invoice and
 * the bill), Borrador (a draft), Recibo, Tarjeta, Cliente, Negocio, Ajustes › Cobros (Settings ›
 * Getting Paid, nv_set_getpaid), Dueño (the owner), Hecho (done), Activar / Desactivado (a switch).
 * A payment method the company spelled in Settings is its own word; the four the sheet names itself
 * (cash, check, transfer, other) are chips a person taps, so each is a su_btn_ key with a Spanish of
 * its own (su_btn_method_<key>, by lib/payment-method's key); a brand (Venmo, Zelle, Stripe, Apple Pay)
 * is its own name.
 * cn-v1147: in Spanish the function words (a, de, la, y…) stay lowercase after the first word ("Lista de
 * Precios", "Mover a un Día"); English keeps every word capitalized.
 */
export const words: WordCatalog = {
  prefix: "su_",
  files: ["src/components/settle-up-button.tsx"],
  // Apple's short form is Apple's in both languages; the Venmo line is a handle and a figure.
  sameInBoth: ["su_apple_tapToPay", "su_venmoHandleAmount"],
  en: {
    // ── The door and the sheet (GetPaidButton) ──
    su_btn_getPaid: "Get Paid",
    su_btn_gettingPaidNow: "Getting Paid Now?",
    su_getPaidAmount: "Get Paid {amount}",
    su_cardsNotOnForCompany: "Cards aren't switched on for this company yet: Settings → Getting Paid → Set Up Card Payments takes about five minutes.",

    // ── Apple's words (see the header) ──
    su_apple_tapToPay: "Tap to Pay",

    // ── The card panel, before and after the QR ──
    su_cardOnJobLine: "A card is taken on the job's open bill (or writes one if there's none), then the card door goes in front of the customer.",
    su_cardOnVisitLine: "A card writes the bill, sends it, and marks the visit done — then the card door goes in front of the customer.",
    su_btn_gettingItReady: "Getting It Ready…",
    su_btn_showCardQr: "Show Card QR",
    su_btn_sendBillShowCardQr: "Send The Bill & Show Card QR",
    su_draftAtOpen: "{doc} is still a draft, so a card asks to send it as the bill first. Money recorded below doesn't.",
    su_thisInvoiceCap: "This invoice",
    su_scanToPay: "Scan to pay — {amount}",
    su_scanToPayByCard: "Scan to pay by card",
    su_cardApplePayLine: "Card, Apple Pay or Google Pay on their phone. It records itself the moment it lands.",
    su_btn_textThePayLink: "Text The Pay Link",
    su_btn_copied: "Copied",
    su_btn_copyLink: "Copy Link",
    su_waitingForPayment: "Waiting for the payment…",
    su_payLinkNote: "Text The Pay Link sends from this phone’s number. Copy Link to send it from the business line.",
    // The customer's text (customer_t = translator("en"), the header): its Spanish is dormant by design.
    su_payLinkSms: "{inv}{amount}. Pay by card here: {url}",
    su_invoiceDash: "Invoice {n} — ",

    // ── Tap to Pay: the busy screen, the terms gate, the outcomes ──
    su_holdCard: "Hold their card to the top of the phone: {amount}",
    su_gettingReady: "Getting Tap to Pay on iPhone ready…",
    su_gettingReadyPct: "Getting Tap to Pay on iPhone ready… {percent}%",
    su_appleSettingUp: "Apple is setting this iPhone up as a card reader — the first time takes a minute or two.",
    su_processingPayment: "Processing the payment…",
    su_confirmingStripe: "Confirming with Stripe — a few seconds.",
    su_turningOnTap: "Turning on Tap to Pay on iPhone — Apple's terms come up first.",
    su_appleGuideUp: "Apple's guide to Tap to Pay on iPhone is up.",
    su_appleGuideUnavailable: "Apple's guide isn't available on this iPhone — the steps are in Settings › Getting Paid › How To Tap.",
    su_balanceChanged: "The balance changed while Apple's terms were up. Press Tap to Pay again for the new amount.",
    su_cardApprovedChecking: "Card approved — checking with Stripe…",
    su_askAdmin: "Ask an owner or admin to enable Tap to Pay on iPhone first.",
    su_updateIos: "Update iOS to use Tap to Pay on iPhone.",
    su_declined: "Declined",
    su_timedOut: "Timed out",
    su_notEnabledYet: "Not enabled yet",
    su_didntGoThrough: "Didn't go through",
    su_timeoutFlips: "If the card was read, this flips to Paid on its own within a minute. If it doesn’t, press Tap to Pay again.",
    su_btn_tryAgain: "Try Again",
    su_btn_cancel: "Cancel",
    su_appleSheetCloses: "Apple’s sheet closes on its own once the terms are accepted or declined.",
    su_closeAppleGuide: "Close Apple’s guide when you’re done — the card is next.",
    su_flipsToPaid: "This flips to Paid the moment the payment lands on the invoice.",
    su_paidAmount: "Paid — {amount}",
    su_recordedOnInvoice: "Recorded on the invoice. The money lands in your Stripe balance.",
    su_btn_done: "Done",
    su_paidByCardDone: "Paid — {amount} by card. Done.",
    su_couldntBuildCode: "Couldn't build the payment code.",
    su_cardsNotOn: "Card payments aren't switched on yet — Settings → Getting Paid → Set Up Card Payments.",
    su_didntReachServer: "That didn't reach the server — check your connection and try again.",
    su_couldntRecord: "Couldn't record that.",
    su_couldntSettle: "Couldn't settle that.",

    // ── "Send INV-078 as the bill first?" (lib/pay-door-words says these; the sheet's two doors) ──
    su_sendFirstQuestion: "Send {doc} as the bill first?",
    su_thisInvoice: "this invoice",
    su_sendFirstCard: "{doc} is still a draft, so there's no bill to pay yet. Sending records it as sent today, then the card can be taken. Nothing is emailed or texted.",
    su_sendFirstPayment:
      "{doc} is still a draft, and this pays all of it. A draft never reads as paid, so sending records it as sent today, then the payment goes on it. Nothing is emailed or texted.",
    su_btn_notNow: "Not Now",
    su_btn_sendIt: "Send It",
    su_sendingAsBill: "Sending {inv} as the bill.",
    su_theInvoice: "the invoice",

    // ── The receipt row (Apple 5.10) ──
    su_receipt: "Receipt",
    su_gettingReceiptLink: "Getting the receipt link…",
    su_btn_textReceipt: "Text Receipt",
    su_btn_texted: "Texted",
    su_btn_sending: "Sending…",
    su_btn_textFromThisPhone: "Text From This Phone",
    su_btn_emailReceipt: "Email Receipt",
    su_btn_emailed: "Emailed",
    su_btn_share: "Share",
    su_btn_hideQr: "Hide QR",
    su_btn_showQr: "Show QR",
    su_noPhoneOnFile: "No phone number on file for this customer — text it from this phone instead.",
    su_textsNotReady: TEXTS_NOT_READY_LINE,
    su_untilThenTextFromPhone: "Until then, text it from this phone.",
    su_scanForReceipt: "Scan for the receipt",
    su_noteTextReceipt: "Text Receipt sends from the business’s number.",
    su_noteTextFromPhone: "Text From This Phone sends from this phone’s number.",
    su_noteEmailReceipt: "Email Receipt sends from the business’s email.",
    su_noteShare: "Share opens this phone’s share sheet.",
    su_receiptTexted: "Receipt texted — the paid invoice, from the business's number.",
    su_textingNotSetUp: "Texting isn't set up yet, so the business can't text it. Text From This Phone sends it from yours.",
    su_textDidntSend: "The text didn't send — open the invoice and send it from there.",
    su_textDidntReach: "The text didn't reach the server — check your connection and try again.",
    su_receiptEmailed: "Receipt emailed — the paid invoice.",
    su_emailDidntSend: "The email didn't send — open the invoice and send it from there.",
    su_emailDidntReach: "The email didn't reach the server — check your connection and try again.",
    su_shareFailed: "Couldn't open the share sheet — use Text or Email instead.",
    // The customer's receipt text — the share sheet and Text From This Phone (customer_t = translator("en"),
    // the header): the Spanish of these six is dormant by design.
    su_invoiceN: "Invoice {n}",
    su_yourInvoice: "Your invoice",
    su_receiptTitle: "Receipt — {inv}",
    su_declinedTitle: "Card declined — {inv}",
    su_paidLine: "{who}{inv} — {amount} paid by card on {date}. Your receipt:",
    su_declinedLine: "{who}{inv} — {amount} card payment declined on {date}; nothing was charged. The invoice is still open:",
    su_declinedDraftNoLink: "Nothing was charged, and this invoice is still a draft, so there's no link to send yet. Finish it and send it when you're ready.",
    su_couldntGetReceiptLink: "Couldn't get the receipt link — open the invoice and share it from there.",

    // ── Or They Paid Another Way (Record Payment's half) ──
    su_orTheyPaidAnotherWay: "Or They Paid Another Way",
    su_howTheyPaid: "How They Paid",
    su_moneyOutsideStripe: "Money that moved outside Stripe — cash, a check, a transfer, Venmo.",
    su_dontRecordByHand: "Don't record it by hand, or it counts twice.",
    su_amount: "Amount",
    su_amountPlaceholder: "$ amount",
    su_howTheyPaidLower: "How they paid",
    su_btn_showVenmoQr: "Show Venmo QR",
    su_btn_sendBillShowVenmoQr: "Send The Bill & Show Venmo QR",
    su_datePaid: "Date Paid",
    su_note: "Note",
    su_notePlaceholder: "e.g. check #1042",
    su_btn_saving: "Saving…",
    su_btn_recordIt: "Record It",
    su_enterWhatTheyPaid: "Enter what they paid.",
    su_enterWhatTheyrePaying: "Enter what they're paying.",
    su_addVenmoFirst: "Add your Venmo username in Settings → Payment methods first.",
    su_paidMethodDone: "Paid — {amount} {method}. Done.",
    su_paidVenmoDone: "Paid — {amount} Venmo. Done.",
    su_venmoHandleAmount: "Venmo @{handle} — {amount}",
    su_venmoQrCode: "Venmo QR code",
    su_venmoTheyScan: "They scan, they pay. Venmo can't tell the app when it lands — tap the button when it does.",
    su_btn_theyPaidRecordIt: "They Paid — Record It",
    su_btn_back: "Back",
    // The four methods the sheet names itself, drawn as chips a person taps (lib/payment-method keys); a company's own
    // spelling stays its own.
    su_btn_method_cash: "Cash",
    su_btn_method_check: "Check",
    su_btn_method_transfer: "Transfer",
    su_btn_method_other: "Other",
  },
  es: {
    su_btn_getPaid: "Cobrar",
    su_btn_gettingPaidNow: "¿Cobrar Ahora?",
    su_getPaidAmount: "Cobrar {amount}",
    su_cardsNotOnForCompany: "Las tarjetas aún no están activadas para esta empresa: Ajustes → Cobros → Configurar Pagos con Tarjeta toma unos cinco minutos.",

    su_apple_tapToPay: "Tap to Pay",

    su_cardOnJobLine: "Una tarjeta se cobra sobre la factura abierta del trabajo (o escribe una si no hay); luego el cobro con tarjeta pasa al cliente.",
    su_cardOnVisitLine: "Una tarjeta escribe la factura, la envía y marca la visita como hecha; luego el cobro con tarjeta pasa al cliente.",
    su_btn_gettingItReady: "Preparándolo…",
    su_btn_showCardQr: "Mostrar QR de Tarjeta",
    su_btn_sendBillShowCardQr: "Enviar la Factura y Mostrar QR de Tarjeta",
    su_draftAtOpen: "{doc} sigue en borrador, así que una tarjeta pide enviarla como factura primero. El dinero registrado abajo no.",
    su_thisInvoiceCap: "Esta factura",
    su_scanToPay: "Escanea para pagar — {amount}",
    su_scanToPayByCard: "Escanea para pagar con tarjeta",
    su_cardApplePayLine: "Tarjeta, Apple Pay o Google Pay en su teléfono. Se registra solo en cuanto llega.",
    su_btn_textThePayLink: "Enviar el Enlace de Pago por Mensaje",
    su_btn_copied: "Copiado",
    su_btn_copyLink: "Copiar Enlace",
    su_waitingForPayment: "Esperando el pago…",
    su_payLinkNote: "Enviar el Enlace de Pago por Mensaje lo manda desde el número de este teléfono. Copiar Enlace, para mandarlo desde la línea del negocio.",
    su_payLinkSms: "{inv}{amount}. Paga con tarjeta aquí: {url}",
    su_invoiceDash: "Factura {n} — ",

    su_holdCard: "Acerca su tarjeta a la parte de arriba del teléfono: {amount}",
    su_gettingReady: "Preparando Tap to Pay en el iPhone…",
    su_gettingReadyPct: "Preparando Tap to Pay en el iPhone… {percent}%",
    su_appleSettingUp: "Apple está configurando este iPhone como lector de tarjetas — la primera vez toma uno o dos minutos.",
    su_processingPayment: "Procesando el pago…",
    su_confirmingStripe: "Confirmando con Stripe — unos segundos.",
    su_turningOnTap: "Activando Tap to Pay en el iPhone — primero aparecen los términos de Apple.",
    su_appleGuideUp: "La guía de Apple para Tap to Pay en el iPhone está abierta.",
    su_appleGuideUnavailable: "La guía de Apple no está disponible en este iPhone — los pasos están en Ajustes › Cobros › Cómo Usar Tap to Pay.",
    su_balanceChanged: "El saldo cambió mientras estaban abiertos los términos de Apple. Presiona Tap to Pay de nuevo por el monto nuevo.",
    su_cardApprovedChecking: "Tarjeta aprobada — verificando con Stripe…",
    su_askAdmin: "Pídele a un dueño o administrador que active Tap to Pay en el iPhone primero.",
    su_updateIos: "Actualiza iOS para usar Tap to Pay en el iPhone.",
    su_declined: "Rechazada",
    su_timedOut: "Se agotó el tiempo",
    su_notEnabledYet: "Aún no activado",
    su_didntGoThrough: "No pasó",
    su_timeoutFlips: "Si la tarjeta se leyó, esto cambia a Pagado solo en menos de un minuto. Si no, presiona Tap to Pay de nuevo.",
    su_btn_tryAgain: "Intentar de Nuevo",
    su_btn_cancel: "Cancelar",
    su_appleSheetCloses: "La hoja de Apple se cierra sola cuando los términos se aceptan o se rechazan.",
    su_closeAppleGuide: "Cierra la guía de Apple cuando termines — la tarjeta sigue.",
    su_flipsToPaid: "Esto cambia a Pagado en cuanto el pago llega a la factura.",
    su_paidAmount: "Pagado — {amount}",
    su_recordedOnInvoice: "Registrado en la factura. El dinero llega a tu saldo de Stripe.",
    su_btn_done: "Hecho",
    su_paidByCardDone: "Pagado — {amount} con tarjeta. Hecho.",
    su_couldntBuildCode: "No se pudo generar el código de pago.",
    su_cardsNotOn: "Los pagos con tarjeta aún no están activados — Ajustes → Cobros → Configurar Pagos con Tarjeta.",
    su_didntReachServer: "Eso no llegó al servidor — revisa tu conexión e inténtalo de nuevo.",
    su_couldntRecord: "No se pudo registrar.",
    su_couldntSettle: "No se pudo liquidar.",

    su_sendFirstQuestion: "¿Enviar {doc} como factura primero?",
    // One Spanish word per English word (skeptic #50): the English stand-in says "this invoice", so this one does
    // too, mirroring the English sentence word for word (invoice and bill are both factura).
    su_thisInvoice: "esta factura",
    su_sendFirstCard: "{doc} sigue en borrador, así que aún no hay factura que pagar. Enviarla la registra como enviada hoy, y luego se puede cobrar la tarjeta. No se manda nada por correo ni por mensaje.",
    su_sendFirstPayment:
      "{doc} sigue en borrador, y esto la paga completa. Un borrador nunca se lee como pagado, así que enviarla la registra como enviada hoy, y luego el pago queda en ella. No se manda nada por correo ni por mensaje.",
    su_btn_notNow: "Ahora No",
    su_btn_sendIt: "Enviarla",
    su_sendingAsBill: "Enviando {inv} como factura.",
    su_theInvoice: "la factura",

    su_receipt: "Recibo",
    su_gettingReceiptLink: "Obteniendo el enlace del recibo…",
    su_btn_textReceipt: "Enviar Recibo por Mensaje",
    su_btn_texted: "Mensaje Enviado",
    su_btn_sending: "Enviando…",
    su_btn_textFromThisPhone: "Mensaje desde Este Teléfono",
    su_btn_emailReceipt: "Enviar Recibo por Correo",
    su_btn_emailed: "Correo Enviado",
    su_btn_share: "Compartir",
    su_btn_hideQr: "Ocultar QR",
    su_btn_showQr: "Mostrar QR",
    su_noPhoneOnFile: "Este cliente no tiene teléfono registrado — mándalo desde este teléfono.",
    su_textsNotReady: "Los mensajes empiezan cuando se configure el envío de mensajes.",
    su_untilThenTextFromPhone: "Mientras tanto, mándalo desde este teléfono.",
    su_scanForReceipt: "Escanea para ver el recibo",
    su_noteTextReceipt: "Enviar Recibo por Mensaje lo manda desde el número del negocio.",
    su_noteTextFromPhone: "Mensaje desde Este Teléfono lo manda desde el número de este teléfono.",
    su_noteEmailReceipt: "Enviar Recibo por Correo lo manda desde el correo del negocio.",
    su_noteShare: "Compartir abre la hoja para compartir de este teléfono.",
    su_receiptTexted: "Recibo enviado por mensaje — la factura pagada, desde el número del negocio.",
    su_textingNotSetUp: "El envío de mensajes aún no está configurado, así que el negocio no puede mandarlo. Mensaje desde Este Teléfono lo manda desde el tuyo.",
    su_textDidntSend: "El mensaje no se envió — abre la factura y mándalo desde ahí.",
    su_textDidntReach: "El mensaje no llegó al servidor — revisa tu conexión e inténtalo de nuevo.",
    su_receiptEmailed: "Recibo enviado por correo — la factura pagada.",
    su_emailDidntSend: "El correo no se envió — abre la factura y mándalo desde ahí.",
    su_emailDidntReach: "El correo no llegó al servidor — revisa tu conexión e inténtalo de nuevo.",
    su_shareFailed: "No se pudo abrir la hoja para compartir — usa Mensaje o Correo.",
    su_invoiceN: "Factura {n}",
    su_yourInvoice: "Tu factura",
    su_receiptTitle: "Recibo — {inv}",
    su_declinedTitle: "Tarjeta rechazada — {inv}",
    su_paidLine: "{who}{inv} — {amount} pagado con tarjeta el {date}. Tu recibo:",
    su_declinedLine: "{who}{inv} — pago con tarjeta de {amount} rechazado el {date}; no se cobró nada. La factura sigue abierta:",
    su_declinedDraftNoLink: "No se cobró nada, y esta factura sigue en borrador, así que aún no hay enlace que enviar. Termínala y envíala cuando estés listo.",
    su_couldntGetReceiptLink: "No se pudo obtener el enlace del recibo — abre la factura y compártelo desde ahí.",

    su_orTheyPaidAnotherWay: "O Pagaron de Otra Forma",
    su_howTheyPaid: "Cómo Pagaron",
    su_moneyOutsideStripe: "Dinero que se movió fuera de Stripe — efectivo, un cheque, una transferencia, Venmo.",
    su_dontRecordByHand: "No lo registres a mano, o se cuenta dos veces.",
    su_amount: "Monto",
    su_amountPlaceholder: "$ monto",
    su_howTheyPaidLower: "Cómo pagaron",
    su_btn_showVenmoQr: "Mostrar QR de Venmo",
    su_btn_sendBillShowVenmoQr: "Enviar la Factura y Mostrar QR de Venmo",
    su_datePaid: "Fecha de Pago",
    su_note: "Nota",
    su_notePlaceholder: "p. ej. cheque #1042",
    su_btn_saving: "Guardando…",
    su_btn_recordIt: "Registrarlo",
    su_enterWhatTheyPaid: "Escribe cuánto pagaron.",
    su_enterWhatTheyrePaying: "Escribe cuánto van a pagar.",
    su_addVenmoFirst: "Agrega tu usuario de Venmo en Ajustes → Métodos de pago primero.",
    su_paidMethodDone: "Pagado — {amount}, {method}. Hecho.",
    su_paidVenmoDone: "Pagado — {amount} por Venmo. Hecho.",
    su_venmoHandleAmount: "Venmo @{handle} — {amount}",
    su_venmoQrCode: "Código QR de Venmo",
    su_venmoTheyScan: "Escanean y pagan. Venmo no le avisa a la app cuando llega — toca el botón cuando llegue.",
    su_btn_theyPaidRecordIt: "Ya Pagaron — Registrarlo",
    su_btn_back: "Atrás",
    su_btn_method_cash: "Efectivo",
    su_btn_method_check: "Cheque",
    su_btn_method_transfer: "Transferencia",
    su_btn_method_other: "Otro",
  },
};
