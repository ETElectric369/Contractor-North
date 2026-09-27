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
 * remove, tick — with only the money kept out of his hands. So this panel rides UNDER the
 * editable list, for the ask that can't wait: a rush, a swap, "the van has none of this".
 *
 * Since 2026-09-27 the ask lands ON the list as a line (requestMaterials), so the job's one live
 * "Buy Materials · N Open" task and the Materials badge count it, and it is never a second task
 * saying the same thing. The bell and the push to every active boss are unchanged, and now open the
 * list it is on.
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
          On the list above, and on the office&rsquo;s phone with this job attached.{" "}
          <button
            type="button"
            className="inline-flex min-h-[44px] items-center underline underline-offset-2"
            onClick={() => { setSent(false); setText(""); }}
          >
            Something Else?
          </button>
        </span>
      </div>
    );

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-900">
        <PackagePlus className="h-4 w-4 text-brand" /> Need it fast? Tell the office.
      </div>
      <p className="mb-2 text-xs text-slate-500">
        Say the item: it goes on the list above as a line to buy, and straight to the office&rsquo;s
        phone with this job attached. You don&rsquo;t have to chase anybody.
      </p>
      <Textarea
        rows={2}
        value={text}
        placeholder="Two 3-gang faceplates — need them tomorrow"
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
