"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { NumberInput } from "@/components/ui/number-input";
import { updateMemberRate } from "./actions";

/** Inline pay + charge rate editor on the Team list. Pay = what you pay this
 *  person (job cost); Bill = what the customer is charged for their labor. */
export function MemberRate({
  id,
  rate,
  billRate,
}: {
  id: string;
  rate: number | null;
  billRate: number | null;
}) {
  const router = useRouter();
  const [pay, setPay] = useState(rate ?? 0);
  const [bill, setBill] = useState(billRate ?? 0);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  function save() {
    if ((rate ?? 0) === pay && (billRate ?? 0) === bill) return;
    start(async () => {
      await updateMemberRate(id, pay || null, bill || null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    });
  }

  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
      <span className="flex items-center gap-1" title="What you pay this person — job cost">
        Pay $
        <NumberInput value={pay} onValueChange={setPay} onBlur={save} className="h-7 w-14 text-right text-xs" aria-label="Pay rate" />
        /hr
      </span>
      <span className="flex items-center gap-1" title="What the customer is charged — invoice labor">
        Bill $
        <NumberInput value={bill} onValueChange={setBill} onBlur={save} className="h-7 w-14 text-right text-xs" aria-label="Charge rate" />
        /hr
      </span>
      {pending && <span className="text-slate-400">…</span>}
      {saved && <Check className="h-3.5 w-3.5 text-green-600" />}
    </span>
  );
}
