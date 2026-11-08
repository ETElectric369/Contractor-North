/**
 * THE SHEET'S OWN SIX WORDS, IN BOTH LANGUAGES (the agenda-in-Spanish wave; the drag hint since cn-v1151).
 * Every Modal in the app says Close, Save, Cancel, Saving…, the armed-discard line and the title bar's
 * drag hint, so a Spanish-speaking person read them in English on every sheet. Modal rides public pages
 * too (src/app/content), and a "use client" file there must not pull lib/i18n's every catalog into a
 * customer's bundle (lib/catalog-free-libs.test.ts), so the six words live HERE, beside the component,
 * and the agenda catalog (lib/words/agenda, the ag_btn_close… and ag_modal… keys) reads them from this
 * file — one spelling, in the catalog's parity and Title Case tests, with no dictionary in the sheet.
 * The two sentences (tapAgain, dragHint) end in a period and sit under keys with no _btn_, so the Title
 * Case judge leaves them alone the way it leaves every sentence.
 */
export const MODAL_WORDS = {
  en: {
    close: "Close",
    save: "Save",
    cancel: "Cancel",
    saving: "Saving…",
    tapAgain: "Tap again to discard what you typed",
    dragHint: "Drag to move this. Double-click to put it back.",
  },
  es: {
    close: "Cerrar",
    save: "Guardar",
    cancel: "Cancelar",
    saving: "Guardando…",
    tapAgain: "Toca de nuevo para descartar lo que escribiste",
    dragHint: "Arrastra para moverla. Doble clic para regresarla.",
  },
} as const;

/** The six words for a language: Spanish for "es", English for anything else. */
export function modalWords(lang: string | null | undefined): (typeof MODAL_WORDS)["en"] | (typeof MODAL_WORDS)["es"] {
  return lang === "es" ? MODAL_WORDS.es : MODAL_WORDS.en;
}
