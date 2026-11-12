"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { shortDay } from "@/lib/come-back-days";
import { translator } from "@/lib/i18n";
import { fillSlots, type Words } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";
import type { WaitingItem } from "@/lib/action-items/types";

const EN = translator("en");

/**
 * WAITING (N) — Erik: Needs You shows only what he can act on NOW, and everything waiting sits in one
 * fold where each row says why and the day it comes back. "Too quiet gets things lost": nothing is in
 * here without its day (the build folds only rows waitingRow accepted), and on that day it is back on
 * Needs You.
 *
 * Under the Needs You list, collapsed. Its count is grey: a count of things waiting is inventory,
 * never a badge (a badge counts only what is open for him now). Drawn only when something waits.
 * Each row reads "<what> · <why> · Back Oct 3" (the day is the company's, handed over as a calendar
 * day, so no clock here decides it) and opens its thing. Every row, and the toggle, is 44px.
 */
export function WaitingFold({ items }: { items: WaitingItem[] }) {
  const lang = useLang();
  const t = translator(lang);
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="border-t border-slate-100">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center justify-between px-5 text-left text-sm font-medium text-slate-500 hover:bg-slate-50"
      >
        <span>
          {t("ny_waiting")} <span className="text-slate-500">({items.length})</span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="divide-y divide-slate-50 pb-1">
          {items.map((w) => (
            <li key={`${w.kind}:${w.id}`}>
              <Link href={w.href} className="flex min-h-11 items-center px-5 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                <span className="min-w-0">{waitingLine(w, lang, t)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Tupelo Panel · J-034 · Waiting on the permit · Back Oct 3": the day said in the reader's language. */
export function waitingLine(w: Pick<WaitingItem, "title" | "why" | "backOn">, lang: Lang = "en", words: Words = EN): string {
  return [w.title, w.why, fillSlots(words("ag_btn_backOn"), { day: shortDay(w.backOn, lang) })].filter(Boolean).join(" · ");
}
