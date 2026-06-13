"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, Pause, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { generateDue, generateOne, setRecurringActive } from "./actions";

export function GenerateDueButton({ count }: { count: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="relative">
      <Button
        variant="outline"
        onClick={() =>
          start(async () => {
            const res = await generateDue();
            setMsg(res.ok ? `Generated ${res.count ?? 0}` : res.error ?? "Failed");
            setTimeout(() => setMsg(null), 2500);
            router.refresh();
          })
        }
        disabled={pending}
      >
        <Zap className="h-4 w-4" /> {pending ? "Generating…" : `Generate ${count} due`}
      </Button>
      {msg && <span className="absolute left-0 top-full mt-1 text-xs text-green-600">{msg}</span>}
    </div>
  );
}

export function RecurringRowActions({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => start(async () => { await generateOne(id); router.refresh(); })}
        disabled={pending}
        className="rounded-md p-1 text-slate-400 hover:bg-brand/10 hover:text-brand"
        title="Generate one now"
      >
        <Zap className="h-4 w-4" />
      </button>
      <button
        onClick={() => start(async () => { await setRecurringActive(id, !active); router.refresh(); })}
        disabled={pending}
        className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        title={active ? "Pause" : "Resume"}
      >
        {active ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
    </div>
  );
}
