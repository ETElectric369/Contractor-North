"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ClipboardList, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { TellNort } from "@/components/tell-nort";
import { SETUP_PLAYBOOK } from "@/lib/onboarding/setup-playbook";
import { missingNeeds } from "@/lib/playbook/resolve";
import { looseNumber } from "@/lib/inspection/capture";
import { hearSetup, saveSetup } from "@/app/(app)/setup-actions";
import type { Answers, AnswerValue } from "@/lib/playbook/types";

/**
 * THE INTERVIEW — an interview, not a tutorial, and not a wizard.
 *
 * Erik: "onboarding needs to be smart like that and nort runs the show … an onboarding interview
 * with built in training rather than a tutorial focus."
 *
 * It is deliberately not its own engine. Setup is a PLAYBOOK: the same `Need` shape the inspector
 * renders, the same resolver deciding what is still missing, the same extraction turning a sentence
 * into typed answers, the same TellNort component. A second mechanism here would be a second set of
 * bugs and a second thing to teach — there is one Nort, and a surface contributes a target and a
 * projection, never an assistant of its own.
 *
 * Which is why it TEACHES THE APP BY BEING THE APP: say it, watch boxes fill, check them, press
 * save. That is exactly the inspector they'll open on their first job.
 *
 * IT LIVES IN THE TOP BAR (cn-v633), not on a page. It used to be a card on My Day that hid itself
 * once setup was done — which is correct behaviour for a card and wrong for this. Erik: "i would
 * prefer the interview to be front and center on the top bar next to the speak button so nobody has
 * to search for it." A vanishing card is unfindable the moment you want to change an answer, and
 * "where did that thing go" is the same failure as the questions nobody could find.
 */
export function SetupInterview({ initial, onSaved }: { initial: Answers; onSaved?: () => void }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Answers>(initial);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const open = missingNeeds(SETUP_PLAYBOOK, answers);
  const total = SETUP_PLAYBOOK.needs.length;
  const done = total - open.length;

  const set = (key: string, v: AnswerValue) => {
    setAnswers((a) => ({ ...a, [key]: v }));
    setDirty(true);
  };

  return (
    <div>
      <p className="text-sm text-slate-500">
        {done === total
          ? "That's everything. Change anything here whenever it changes in real life."
          : `${done} of ${total} — say it in one breath, or fill the boxes. Whichever's faster.`}
      </p>

      <TellNort
        hear={hearSetup}
        answers={answers}
        hint={open[0]?.ask}
        label="Tell Nort about your business"
        placeholder="I'm Justin Vivian, general contractor out of Truckee — I sub out electrical and plumbing, I cover Nevada County, and I bill 150 an hour."
        onFilled={(next) => {
          setAnswers(next);
          setDirty(true);
        }}
      />

      {/* THE SAME BOXES, ALWAYS EDITABLE. What Nort fills lands here and what they type lands here;
          one place a value lives, so there is nothing to reconcile. */}
      <div className="mt-4 space-y-3">
        {SETUP_PLAYBOOK.needs.map((n) => {
          const v = answers[n.key];
          const still = open.some((o) => o.key === n.key);
          return (
            <div key={n.key}>
              <Label className="mb-1">
                {n.ask}
                {!still && <Check className="ml-1.5 inline h-3.5 w-3.5 text-emerald-600" />}
              </Label>
              {n.why && still && <p className="mb-1.5 line-clamp-2 text-xs leading-snug text-slate-500">{n.why}</p>}
              {n.slot?.type === "number" ? (
                <div className="flex items-center gap-2">
                  <Input
                    inputMode="decimal"
                    value={typeof v === "number" ? String(v) : ""}
                    onChange={(e) => set(n.key, looseNumber(e.target.value))}
                  />
                  <span className="shrink-0 text-sm text-slate-500">{n.slot.unit}</span>
                </div>
              ) : (
                <Input value={typeof v === "string" ? v : ""} onChange={(e) => set(n.key, e.target.value)} />
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* FILLING WAS FREE; THIS IS THE COMMIT. Saying it changed nothing about the company —
            pressing this changes what every estimate is priced against and what the public page
            says, so it is deliberately its own button. */}
        <Button
          type="button"
          disabled={pending || !dirty}
          onClick={() =>
            start(async () => {
              setErr(null);
              setMsg(null);
              const r = await saveSetup(answers);
              if (!r.ok) return setErr(r.error);
              setDirty(false);
              setMsg(r.seededSheet ? "Saved — and your walk-through questions are ready." : "Saved.");
              router.refresh();
              onSaved?.();
            })
          }
        >
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : <><Check className="h-4 w-4" /> Save</>}
        </Button>
        {err && <span className="text-sm text-rose-600">{err}</span>}
        {msg && !err && <span className="text-sm font-medium text-emerald-700">{msg}</span>}
      </div>

      {/* WHERE IT LIVES AFTERWARDS. Part of the training is knowing where to go back to — an
          interview that leaves somebody unable to find what they just set up taught nothing. */}
      <p className="mt-4 flex flex-wrap items-center gap-x-1.5 border-t border-slate-100 pt-3 text-xs text-slate-400">
        <ClipboardList className="h-3.5 w-3.5" />
        All of this lives in
        <Link href="/settings" className="underline underline-offset-2 hover:text-slate-600">Settings</Link>
        — and the questions your walk-through asks on site are under
        <Link href="/settings?tab=playbook" className="underline underline-offset-2 hover:text-slate-600">Playbook</Link>.
      </p>
    </div>
  );
}
