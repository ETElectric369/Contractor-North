"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe } from "lucide-react";
import { translator } from "@/lib/i18n";
import { setLanguage } from "@/app/(app)/settings/actions";

/** Compact language toggle for the account menu's Language row. Two languages → click toggles.
 *  Under the row (the row wraps), what Spanish covers today, in the language picked (cn-v1138). */
export function LanguageSwitcher({ current }: { current?: string }) {
  const router = useRouter();
  const [lang, setLang] = useState(current === "es" ? "es" : "en");
  const [pending, start] = useTransition();
  const t = translator(lang);

  function toggle() {
    const next = lang === "en" ? "es" : "en";
    setLang(next);
    start(async () => {
      await setLanguage(next);
      router.refresh();
    });
  }

  return (
    <>
      <button
        onClick={toggle}
        disabled={pending}
        // The title invites the reader to the OTHER language, in that language: the target
        // language's own translator is asked on purpose (an English reader reads "Cambiar a Español").
        title={lang === "en" ? translator("es")("sh_switchToSpanish") : translator("en")("sh_switchToEnglish")}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-60"
      >
        <Globe className="h-4 w-4 shrink-0" />
        {lang.toUpperCase()}
      </button>
      <p className="basis-full pb-1 text-xs text-slate-500">{t("sh_spanishCovers")}</p>
    </>
  );
}
