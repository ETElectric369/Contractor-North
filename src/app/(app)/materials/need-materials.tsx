"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, PackagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { requestMaterials } from "./actions";

/**
 * THE ASK-THE-OFFICE DOOR UNDER A TECH'S MATERIALS LIST.
 *
 * Erik: *"If a tech on a job says he needs materials for that job, it should show up as an
 * alert for the boss."*
 *
 * It was born (cn-v649) as what a tech got INSTEAD of an editor: the six Materials writes
 * refused for techs at the policy, the editor rendered for everyone, and a zero-row update
 * read as success — so Brian could tick "purchased" and watch it spring back with no message.
 * He didn't edit the list, he ASKED, and it became the boss's problem on the boss's phone.
 *
 * Then Erik decided (2026-09-11) the tech gets THE SAME list the office has — add, edit,
 * remove, tick — with only the money kept out of his hands. So this panel no longer stands
 * in for the list; it rides UNDER an editable one, for the things a list line can't say: a
 * rush, a substitution, a question about what's specified, "the van has none of this". The
 * plumbing is untouched — still a task with the job attached, still a bell and a push to
 * every active boss (requestMaterials) — only the words changed to fit the new place.
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
            Something else?
          </button>
        </span>
      </div>
    );

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-900">
        <PackagePlus className="h-4 w-4 text-brand" /> Anything else the office should know about this job&rsquo;s materials?
      </div>
      <p className="mb-2 text-xs text-slate-500">
        Add what you need to the list above. Use this for the rest &mdash; a rush, a swap, a question
        &mdash; and it goes straight to the office with this job attached. You don&rsquo;t have to chase anybody.
      </p>
      <Textarea
        rows={2}
        value={text}
        placeholder="The 12-2 on the list won't do it for the far wall — need it by tomorrow morning."
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
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : "Tell the Office"}
        </Button>
        {err && <span className="text-sm text-rose-600">{err}</span>}
      </div>
    </div>
  );
}
