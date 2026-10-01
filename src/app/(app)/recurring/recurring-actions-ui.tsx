"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, Pause, Zap } from "lucide-react";
import { useToast } from "@/components/toast";
import { generateOne, setRecurringActive } from "./actions";

/** What Generate One Now made, in the words the rest of the app uses for it. */
export function madeWords(kind: string): string {
  return kind === "job" ? "Job created" : kind === "expense" ? "Expense added" : "Invoice generated";
}

/* No Generate Due here any more (W2-12): the daily cron makes every template that is due. A row that
 * is due keeps its Generate One Now below, for the one wanted right now. */

/** `canGenerate` false = a repeat invoice while Recurring Billing is off (0352): Generate One Now
 *  isn't drawn, because generateOne would refuse it. Pause and Resume stay. Absent = on.
 *  `kind` names what Generate One Now made, so a repeat job or expense isn't called an invoice. */
export function RecurringRowActions({
  id,
  active,
  canGenerate = true,
  kind = "invoice",
}: {
  id: string;
  active: boolean;
  canGenerate?: boolean;
  kind?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <div className="flex items-center gap-1">
      {canGenerate && (
        <button
          onClick={() =>
            start(async () => {
              const res = await generateOne(id);
              if (!res?.ok) { toast(res?.error ?? "Couldn't generate — try again.", "error"); return; }
              toast(madeWords(kind), "success");
              router.refresh();
            })
          }
          disabled={pending}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-brand/10 hover:text-brand"
          title="Generate One Now"
          aria-label="Generate One Now"
        >
          <Zap className="h-4 w-4" />
        </button>
      )}
      <button
        onClick={() =>
          start(async () => {
            const res = await setRecurringActive(id, !active);
            if (!res?.ok) { toast(res?.error ?? "Couldn't update — try again.", "error"); return; }
            router.refresh();
          })
        }
        disabled={pending}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        title={active ? "Pause" : "Resume"}
        aria-label={active ? "Pause" : "Resume"}
      >
        {active ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
    </div>
  );
}
