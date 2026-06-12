"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { NumberInput } from "@/components/ui/number-input";
import { updateMemberRate } from "./actions";

/** Inline billable-rate editor on the Team list ($/hr — used by invoice labor import). */
export function MemberRate({ id, rate }: { id: string; rate: number | null }) {
  const router = useRouter();
  const [value, setValue] = useState(rate ?? 0);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  function save() {
    if ((rate ?? 0) === value) return;
    start(async () => {
      await updateMemberRate(id, value || null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    });
  }

  return (
    <span className="flex items-center gap-1 text-xs text-slate-500">
      $
      <NumberInput
        value={value}
        onValueChange={setValue}
        onBlur={save}
        className="h-7 w-16 text-right text-xs"
        aria-label="Hourly rate"
      />
      /hr
      {pending && <span className="text-slate-400">…</span>}
      {saved && <Check className="h-3.5 w-3.5 text-green-600" />}
    </span>
  );
}
