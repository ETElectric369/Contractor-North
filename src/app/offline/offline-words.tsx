"use client";

import { useEffect, useState } from "react";
import { asLang, translator, type Lang } from "@/lib/i18n";

/**
 * THE OFFLINE PAGE'S WORDS, IN THE PERSON'S LANGUAGE (cn-v1138). This page is the PWA's cached
 * fallback: no session, no profile, no server — so profiles.language cannot be read here. The one
 * honest signal the phone still has is its own language (navigator.language): a Spanish phone reads
 * Spanish, anything else reads English, and the first paint is English so the cached HTML and the
 * hydrated page never disagree. The link is Title Case in both languages (Erik's law).
 */
export function phoneLang(navigatorLanguage: string | null | undefined): Lang {
  return asLang(String(navigatorLanguage ?? "").toLowerCase().startsWith("es") ? "es" : "en");
}

export function OfflineWords() {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    try {
      setLang(phoneLang(navigator.language));
    } catch {
      /* a browser with no language answers in English */
    }
  }, []);
  const t = translator(lang);
  return (
    <>
      <h1 className="text-xl font-bold text-slate-900">{t("cs_youreOffline")}</h1>
      <p className="max-w-xs text-sm text-slate-500">{t("cs_offlineBody")}</p>
      <a href="/planner" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
        {t("cs_tryAgain")}
      </a>
    </>
  );
}
