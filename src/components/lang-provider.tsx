"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { Lang } from "@/lib/locale";

/**
 * THE PERSON'S LANGUAGE, FOR EVERY CLIENT COMPONENT (cn-v1138). The (app) layout reads
 * profiles.language once and mounts this around the shell; a client component asks useLang() and
 * hands it to translator(). Outside a provider (a public page, a test) it is English. The document's
 * lang attribute follows it, so the browser's spell-check, hyphenation and screen reader speak the
 * same language the screen does.
 */
const LangContext = createContext<Lang>("en");

export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext);
}
