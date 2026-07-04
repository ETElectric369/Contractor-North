"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe } from "lucide-react";
import { setLanguage } from "@/app/(app)/settings/actions";

/** Compact language toggle for the top bar. Two languages → click toggles. */
export function LanguageSwitcher({ current }: { current?: string }) {
  const router = useRouter();
  const [lang, setLang] = useState(current === "es" ? "es" : "en");
  const [pending, start] = useTransition();

  function toggle() {
    const next = lang === "en" ? "es" : "en";
    setLang(next);
    start(async () => {
      await setLanguage(next);
      router.refresh();
    });
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      title={lang === "en" ? "Cambiar a Español" : "Switch to English"}
      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-60"
    >
      <Globe className="h-4 w-4 shrink-0" />
      {lang.toUpperCase()}
    </button>
  );
}
