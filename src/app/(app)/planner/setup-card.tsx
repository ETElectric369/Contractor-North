"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ClipboardList, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { TellNort } from "@/components/tell-nort";
import { SETUP_PLAYBOOK } from "@/lib/onboarding/setup-playbook";
import { missingNeeds } from "@/lib/playbook/resolve";
import { looseNumber } from "@/lib/inspection/capture";
import { hearSetup, saveSetup } from "../setup-actions";
import type { Answers, AnswerValue } from "@/lib/playbook/types";

/**
 * THE FIRST THING A NEW COMPANY SEES — and it is an interview, not a tutorial.
 *
 * Erik: "onboarding needs to be smart like that and nort runs the show … an onboarding interview
 * with built in training rather than a tutorial focus."
 *
 * The first outside tenant signed up and landed on an empty My Day: no trade, so a generic
 * six-question walk-through; no town, so the weather widget threw; no rate, so an estimate
 * couldn't price labour. Three dead surfaces, none of them explained, and the only visible
 * response was "the software is thin."
 *
 * WHY IT TEACHES BY EXISTING. It is the same component, the same playbook shape and the same
 * extraction as the inspector he'll use on his first job — say a sentence, watch boxes fill,
 * check them, press save. By the time setup is done he has already used the app's one real
 * interaction, which is the whole difference between an interview and a tour of the menus.
 *
 * IT IS NEVER A GATE. Every box is optional, the card never blocks anything, and it disappears on
 * its own when there is nothing left to ask.
 */
export function SetupCard({ initial }: { initial: Answers }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Answers>(initial);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const open = missingNeeds(SETUP_PLAYBOOK, answers);
  const total = SETUP_PLAYBOOK.needs.length;
  const done = total - open.length;

  // Nothing left to ask and nothing unsaved — the card has done its job and gets out of the way.
  if (!open.length && !dirty && !msg) return null;

  const set = (key: string, v: AnswerValue) => {
    setAnswers((a) => ({ ...a, [key]: v }));
    setDirty(true);
  };

  return (
    <Card className="border-brand/30">
      <CardContent className="py-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Let&rsquo;s get you set up</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {done} of {total} · say it in one breath, or fill the boxes — whichever&rsquo;s faster.
            </p>
          </div>
          <span className="shrink-0 text-xs font-medium text-slate-400">{done}/{total}</span>
        </div>

        <TellNort
          hear={hearSetup}
          answers={answers}
          hint={open[0]?.ask}
          label="Tell Nort about your business"
          placeholder="I'm Andrew Cohen, general contractor out of Reno — I sub out electrical and plumbing, I cover the whole valley, and I bill 110 an hour."
          onFilled={(next) => {
            setAnswers(next);
            setDirty(true);
          }}
        />

        {/* THE SAME BOXES, ALWAYS EDITABLE. What Nort fills lands here and what he types lands
            here; there is one place a value lives, so there is nothing to reconcile. */}
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
                setMsg(
                  r.seededSheet
                    ? "Saved — and your walk-through questions are ready."
                    : "Saved.",
                );
                router.refresh();
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
        <p className="mt-3 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-400">
          <ClipboardList className="h-3.5 w-3.5" />
          All of this lives in
          <Link href="/settings" className="underline underline-offset-2 hover:text-slate-600">Settings</Link>
          — and the questions your walk-through asks are under
          <Link href="/settings?tab=playbook" className="underline underline-offset-2 hover:text-slate-600">Playbook</Link>.
        </p>
      </CardContent>
    </Card>
  );
}
