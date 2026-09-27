"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, Pause, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { generateDue, generateOne, setRecurringActive } from "./actions";

export function GenerateDueButton({ count }: { count: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <div className="relative">
      <Button
        variant="outline"
        onClick={() =>
          start(async () => {
            const res = await generateDue();
            if (!res?.ok) { toast(res?.error ?? "Couldn't generate — try again.", "error"); return; }
            const n = res.count ?? 0;
            toast(n === 1 ? "Generated 1 invoice" : `Generated ${n} invoices`, "success");
            router.refresh();
          })
        }
        disabled={pending}
      >
        <Zap className="h-4 w-4" /> {pending ? "Generating…" : `Generate ${count} Due`}
      </Button>
    </div>
  );
}

/** `canGenerate` false = a repeat invoice while Recurring Billing is off (0352): Generate One Now
 *  isn't drawn, because generateOne would refuse it. Pause and Resume stay. Absent = on. */
export function RecurringRowActions({ id, active, canGenerate = true }: { id: string; active: boolean; canGenerate?: boolean }) {
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
              toast("Invoice generated", "success");
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
