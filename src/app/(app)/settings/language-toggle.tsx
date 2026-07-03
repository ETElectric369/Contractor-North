"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LANGUAGES } from "@/lib/i18n";
import { setLanguage } from "./actions";

export function LanguageToggle({ current }: { current: string }) {
  const router = useRouter();
  const [lang, setLang] = useState(current || "en");
  const [pending, start] = useTransition();

  function choose(code: string) {
    setLang(code);
    start(async () => {
      await setLanguage(code);
      router.refresh();
    });
  }

  return (
    <div className="inline-flex rounded-lg border border-slate-200 p-0.5">
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          onClick={() => choose(l.code)}
          disabled={pending}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            lang === l.code
              ? "seaglass-active"
              : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <span className="relative z-10">{l.label}</span>
        </button>
      ))}
    </div>
  );
}
