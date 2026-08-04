"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, PackagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { requestMaterials } from "./actions";

/**
 * WHAT A TECH SEES ON THE MATERIALS TAB, instead of an editor that silently did nothing.
 *
 * Erik: *"If I tech on a job, it says he needs materials for that job, it should show up as an
 * alert for the boss."*
 *
 * The audit found the six Materials writes failing silently for techs — the policy needs staff, the
 * editor rendered for everyone, and a zero-row update reads as success. Brian could tick "purchased"
 * and watch it spring back with no message.
 *
 * The two obvious fixes were both wrong. Letting techs edit hands the office's priced take-off to
 * the crew. Hiding the tab leaves a man standing on site who needs conduit with nowhere to say so.
 * Erik's answer is the third thing: he doesn't edit the list, he ASKS — and it becomes the boss's
 * problem, on the boss's phone, with the job attached.
 *
 * THE LIST STAYS VISIBLE ABOVE THIS, read-only. He still needs to know what's already on it, or
 * he'll ask for something that's in the van.
 */
export function NeedMaterials({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (sent)
    return (
      <div className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
        <Check className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Sent — the office has it, on their phone, with this job attached.{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => { setSent(false); setText(""); }}
          >
            Need something else?
          </button>
        </span>
      </div>
    );

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-900">
        <PackagePlus className="h-4 w-4 text-brand" /> Need something for this job?
      </div>
      <p className="mb-2 text-xs text-slate-500">
        Say what you need and it goes straight to the office with this job attached. You don&rsquo;t have to
        chase anybody.
      </p>
      <Textarea
        rows={2}
        value={text}
        placeholder="Another 100' of 12-2 and two 20A breakers — I'm short for the far wall."
        onChange={(e) => { setText(e.target.value); setErr(null); }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={!text.trim() || pending}
          onClick={() =>
            start(async () => {
              const r = await requestMaterials(jobId, text);
              if (!r.ok) return setErr(r.error ?? "Couldn't send that.");
              setSent(true);
              router.refresh();
            })
          }
        >
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : "Tell the office"}
        </Button>
        {err && <span className="text-sm text-rose-600">{err}</span>}
      </div>
    </div>
  );
}
