"use client";

import { useState, useTransition } from "react";
import { Plus, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { leadSourceLabel, LEAD_SOURCE_MAX_COUNT, LEAD_SOURCE_MAX_LEN } from "@/lib/org-settings";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import { updateOrgSettings } from "./actions";

/**
 * LEAD SOURCES (cn-v1170). Erik, 2026-11-19: "lead source/type dropdown editable list (i.e.: web,
 * signage, word of mouth, referral)". The list the lead form's Lead Source box offers, kept in
 * settings.lead_sources through the same door and role guard as Payment Methods. Each add or remove
 * saves at once (nothing waits on a Save), and a refused save puts the list back and says why.
 */
export function LeadSources({ sources }: { sources: readonly string[] }) {
  const t = translator(useLang());
  const [list, setList] = useState<string[]>([...sources]);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function persist(next: string[]) {
    const before = list;
    setList(next);
    setNote(null);
    start(async () => {
      const res = await updateOrgSettings({ lead_sources: next });
      if (res.ok) {
        setNote({ ok: true, text: t("sh_saved") });
      } else {
        setList(before);
        setNote({ ok: false, text: fillSlots(t("sh_leadSourcesNotSaved"), { error: res.error ?? "" }) });
      }
    });
  }

  function add() {
    const v = leadSourceLabel(draft);
    if (!v) return;
    if (list.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setNote({ ok: false, text: t("sh_leadSourceAlready") });
      return;
    }
    if (list.length >= LEAD_SOURCE_MAX_COUNT) {
      setNote({ ok: false, text: fillSlots(t("sh_leadSourceListFull"), { n: LEAD_SOURCE_MAX_COUNT }) });
      return;
    }
    setDraft("");
    persist([...list, v]);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">{t("sh_leadSourcesDesc")}</p>
      <div className="flex flex-wrap gap-2">
        {list.map((s) => (
          <span key={s} className="flex items-center gap-1 rounded-full bg-slate-100 py-1 pl-3 pr-1 text-sm text-slate-700">
            {s}
            <button
              type="button"
              disabled={pending}
              onClick={() => persist(list.filter((x) => x !== s))}
              className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full text-slate-400 hover:text-red-600"
              aria-label={fillSlots(t("sh_btn_removeLeadSource"), { name: s })}
              title={fillSlots(t("sh_btn_removeLeadSource"), { name: s })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
      </div>
      {list.length === 0 && <p className="text-sm text-slate-500">{t("sh_leadSourcesEmptyDefault")}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={draft}
          maxLength={LEAD_SOURCE_MAX_LEN}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={t("sh_leadSourceAddPlaceholder")}
          className="max-w-xs"
        />
        <Button size="sm" variant="outline" disabled={pending || !draft.trim()} onClick={add}>
          <Plus className="h-3.5 w-3.5" /> {t("sh_btn_addLeadSource")}
        </Button>
        {pending && <span className="text-sm text-slate-500">{t("sh_saving")}</span>}
        {!pending && note && (
          <span className={`flex items-center gap-1 text-sm font-medium ${note.ok ? "text-green-600" : "text-red-700"}`}>
            {note.ok && <Check className="h-4 w-4" />} {note.text}
          </span>
        )}
      </div>
    </div>
  );
}
