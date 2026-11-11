"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { Input, Label } from "@/components/ui/input";
import { setAppointmentTitle } from "../actions";

/**
 * WHAT IS THIS FOR? One field above the inspection sheet while the visit's title is still only the
 * bare word (isGenericInspectionTitle). The owner names what an inspection is for so he can open it
 * later and know; he missed it a couple of times in the field, so the page asks, once, and blocks
 * nothing: Mark Inspection Done and the sheet work with or without it. It saves on blur or Enter
 * through setAppointmentTitle (the title column Edit Details writes) and says Saving, Saved, or the
 * refusal in words. Once the title is a real one the page stops drawing this.
 */
export function VisitTitleField({ appointmentId }: { appointmentId: string }) {
  const lang = useLang();
  const t = translator(lang);
  const router = useRouter();
  const [value, setValue] = useState("");
  const [state, setState] = useState<"idle" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () => {
    const title = value.trim();
    if (!title || pending) return;
    setState("idle");
    setMessage(null);
    start(async () => {
      const res = await setAppointmentTitle(appointmentId, title);
      if (!res.ok) {
        setState("error");
        setMessage(res.error ?? t("vp_titleNotSaved"));
        return;
      }
      setState("saved");
      router.refresh();
    });
  };

  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
      <Label htmlFor="visit-title-field">{t("vp_whatIsThisFor")}</Label>
      <Input
        id="visit-title-field"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setState("idle");
        }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
        placeholder={t("vp_whatIsThisForHint")}
        maxLength={200}
        className="mt-1"
      />
      <p className="mt-1 min-h-4 text-xs text-slate-500" role="status" aria-live="polite">
        {pending ? t("vp_titleSaving") : state === "saved" ? t("vp_titleSaved") : state === "error" ? <span className="text-red-600">{message}</span> : ""}
      </p>
    </div>
  );
}
