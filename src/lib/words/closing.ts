import type { WordCatalog } from "./types";

/**
 * SALES > CLOSING (cl_, cn-v1172): the inbox of estimates that are out with no answer yet.
 *
 * Erik, 2026-11-19, after the second meeting: "a new sub-nav tab right below Estimates called
 * Closing as an inbox for estimates that havent been accepted [...] once an estimate is accepted it
 * will disappear from there and file with the customer file", and, asked whether it replaces the
 * follow-up day: "Closing is the reminder yes". The page's title and line are the map's (nv_page_closing,
 * nv_desc_closing); everything inside the page is here. Clickables are Title Case in both languages.
 */
export const words: WordCatalog = {
  prefix: "cl_",
  files: ["src/app/(app)/closing/page.tsx", "src/app/(app)/closing/closing-list.tsx", "src/app/(app)/closing/closing-clock.tsx"],
  sameInBoth: [],
  en: {
    cl_empty: "No estimate is waiting on an answer.",
    cl_emptyDesc: "An estimate shows up here once it is sent, and leaves when it is Accepted or Not Sold.",
    cl_estimatesOff: "An estimate already sent still waits here for its answer.",
    cl_btn_goToEstimates: "Go to Estimates",
    cl_listCouldntLoad: "The estimates that are out couldn't be read just now. Try again in a minute, or open Estimates.",
    cl_cut: "The {n} estimates written first are shown.",
    cl_noName: "No name on it",
    cl_anEstimate: "Estimate",
    cl_sentOn: "Sent {day}",
    cl_noSendOnRecord: "No send on record",
    cl_quiet: "No answer in a week or more",
    cl_offerOpen: "Offer good until {day}",
    cl_offerEnds: "Offer ends {day}",
    cl_offerEnded: "Offer ended {day}",
    cl_clockMinutes: "{m}m",
    cl_clockHoursMinutes: "{h}h {m}m",
    cl_clockDaysHours: "{d}d {h}h",
    cl_clockLabel: "Waiting {time}",
    cl_btn_accepted: "Accepted",
    cl_btn_notSold: "Not Sold",
    cl_btn_sendAgain: "Send Again",
    cl_btn_yes: "Yes",
    cl_btn_cancel: "Cancel",
    cl_askAccepted: "Mark {ref} accepted? It goes on its job, and a job is made if it has none.",
    cl_askNotSold: "Mark {ref} Not Sold? It leaves Closing and stays in the customer's file.",
    cl_doneAccepted: "{ref} is accepted.",
    cl_doneNotSold: "{ref} is marked Not Sold.",
    cl_btn_openJob: "Open the Job",
    cl_btn_dismiss: "Got It",
    cl_dropped: "Nothing changed: the connection dropped. Try again.",
    // cn-v1172 (fixer): the line that outlives the row can send the person back to the estimate
    cl_btn_openEstimate: "Open the Estimate",
  },
  es: {
    cl_empty: "Ningún presupuesto está esperando respuesta.",
    cl_emptyDesc: "Un presupuesto aparece aquí cuando se envía, y sale cuando queda Aceptado o No Vendido.",
    cl_estimatesOff: "Un presupuesto ya enviado sigue esperando su respuesta aquí.",
    cl_btn_goToEstimates: "Ir a Presupuestos",
    cl_listCouldntLoad: "No se pudieron leer los presupuestos enviados en este momento. Inténtalo en un minuto, o abre Presupuestos.",
    cl_cut: "Se muestran los {n} presupuestos escritos primero.",
    cl_noName: "Sin nombre",
    cl_anEstimate: "Presupuesto",
    cl_sentOn: "Enviado el {day}",
    cl_noSendOnRecord: "Sin envío registrado",
    cl_quiet: "Sin respuesta en una semana o más",
    cl_offerOpen: "Oferta válida hasta el {day}",
    cl_offerEnds: "La oferta vence el {day}",
    cl_offerEnded: "La oferta venció el {day}",
    cl_clockMinutes: "{m} min",
    cl_clockHoursMinutes: "{h} h {m} min",
    cl_clockDaysHours: "{d} d {h} h",
    cl_clockLabel: "Esperando {time}",
    cl_btn_accepted: "Aceptado",
    cl_btn_notSold: "No Vendido",
    cl_btn_sendAgain: "Enviar de Nuevo",
    cl_btn_yes: "Sí",
    cl_btn_cancel: "Cancelar",
    cl_askAccepted: "¿Marcar {ref} como aceptado? Pasa a su trabajo, y si no tiene uno, se crea.",
    cl_askNotSold: "¿Marcar {ref} como No Vendido? Sale de Cierre y se queda en el expediente del cliente.",
    cl_doneAccepted: "{ref} quedó aceptado.",
    cl_doneNotSold: "{ref} quedó como No Vendido.",
    cl_btn_openJob: "Abrir el Trabajo",
    cl_btn_dismiss: "Entendido",
    cl_dropped: "No cambió nada: se cortó la conexión. Inténtalo de nuevo.",
    // cn-v1172 (fixer): the line that outlives the row can send the person back to the estimate
    cl_btn_openEstimate: "Abrir el Presupuesto",
  },
};
