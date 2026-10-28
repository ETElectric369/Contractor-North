// THE ROOT ERROR BOUNDARY'S OWN SEVEN WORDS (cn-v1138). src/app/error.tsx is a client component that
// rides EVERY page's bundle — /estimate, /intake, /i, /q, /portal, /print, the pages a CUSTOMER
// opens — so it must not import lib/i18n, which statically carries every catalog (~230 KB of a
// tech's words). The seven words live here as a local map in both languages; error-words.test.ts
// pins each one to the shell catalog's entry, so the catalog stays the one source and this copy
// cannot drift. Outside the (app) shell there is no LangProvider, so a customer reads English.
import type { Lang } from "@/lib/locale";

export type RootErrorWords = {
  connectionDropped: string;
  checkSignal: string;
  somethingWrong: string;
  unexpectedError: string;
  tryAgain: string;
  tryingAgain: string;
  dashboard: string;
};

/** The shell catalog key behind each word, for the test that pins them together. */
export const ROOT_ERROR_KEYS: Record<keyof RootErrorWords, string> = {
  connectionDropped: "sh_connectionDropped",
  checkSignal: "sh_checkSignal",
  somethingWrong: "sh_somethingWrong",
  unexpectedError: "sh_unexpectedError",
  tryAgain: "sh_tryAgain",
  tryingAgain: "sh_tryingAgain",
  dashboard: "sh_dashboard",
};

const EN: RootErrorWords = {
  connectionDropped: "The connection dropped",
  checkSignal: "Check your signal and try again — nothing was lost.",
  somethingWrong: "Something went wrong",
  unexpectedError: "An unexpected error occurred. You can try again, or head back to the dashboard.",
  tryAgain: "Try Again",
  tryingAgain: "Trying Again…",
  dashboard: "Dashboard",
};

const ES: RootErrorWords = {
  connectionDropped: "Se cortó la conexión",
  checkSignal: "Revisa tu señal e inténtalo de nuevo. No se perdió nada.",
  somethingWrong: "Algo salió mal",
  unexpectedError: "Ocurrió un error inesperado. Puedes intentar de nuevo o volver al panel.",
  tryAgain: "Intentar De Nuevo",
  tryingAgain: "Intentando De Nuevo…",
  dashboard: "Panel",
};

export function rootErrorWords(lang: Lang): RootErrorWords {
  return lang === "es" ? ES : EN;
}
