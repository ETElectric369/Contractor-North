"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, ClipboardList, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { WhyField } from "@/components/playbook/why-field";
import { TellNort } from "@/components/tell-nort";
import { SETUP_PLAYBOOK } from "@/lib/onboarding/setup-playbook";
import { missingNeeds } from "@/lib/playbook/resolve";
import { looseNumber } from "@/lib/inspection/capture";
import { savePlaybook } from "@/app/(app)/settings/playbook-actions";
import { explainWhy } from "@/lib/onboarding/draft-playbook";
import { draftMyPlaybook, finishOnboarding, hearSetup, saveSetup } from "@/app/(app)/setup-actions";
import type { Answers, AnswerValue, Need } from "@/lib/playbook/types";

/**
 * THE WALK-THROUGH — an interview with training in it, and EVERYONE takes it.
 *
 * Erik, correcting me twice:
 *   "His onboarding isn't complete if he hasn't been guided through the training and why lines"
 *   "everyone should go through it even if they have a lot of it setup to learn the system"
 *
 * I had built a gap-filler: five boxes that vanished once they were full. Andrew filled Vivian
 * Builders' settings in and the thing declared him finished — he had never seen a why line, never
 * been shown that the questions his inspector asks are HIS and can be changed. A populated
 * settings row is evidence somebody typed, not evidence anybody learned.
 *
 * So it is three steps and it always runs end to end:
 *
 *   1. YOUR COMPANY   the five facts. Prefilled when known — seeing them already answered IS the
 *                     lesson ("this is where that lives"), and it is where they meet Tell Nort.
 *   2. YOUR QUESTIONS  Nort drafts the ask and the WHY for every question their walk-through will
 *                     put in front of them, in their trade's terms, from what they just said. They
 *                     correct it. THE CORRECTION IS THE TRAINING — nobody writes a good why from a
 *                     blank box; you find out you have one by reading a version that's wrong.
 *   3. WHERE IT LIVES  the short orientation, so nobody has to hunt for what they just made.
 *
 * Finishing records a fact (profiles.onboarded_at, 0180) rather than deriving one. Never a gate,
 * and re-takeable forever from the top bar.
 */

type Step = 1 | 2 | 3;

export function SetupInterview({
  initial,
  onSaved,
  startAt = 1,
}: {
  initial: Answers;
  onSaved?: () => void;
  /** Where to open. The TOUR already asks the company questions out loud and already explains what
   *  a why line is, so it hands off at 2 — straight to the draft it just promised. Opening at 1
   *  after that would ask everything twice, which is how a tutorial teaches people to skip. */
  startAt?: Step;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(startAt);
  const [answers, setAnswers] = useState<Answers>(initial);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Step 2 state — the drafted questions, and whether a model actually wrote them.
  const [formId, setFormId] = useState<string | null>(null);
  const [needs, setNeeds] = useState<Need[] | null>(null);
  const drafting = useRef(false);
  const [whyAt, setWhyAt] = useState(0);

  // ENTERING AT STEP 2 (straight off the tour) has to fetch its own draft — the transition that
  // normally does it was never taken. Guarded so React's double-invoke in dev can't ask twice.
  useEffect(() => {
    if (startAt !== 2 || needs || drafting.current) return;
    drafting.current = true;
    start(async () => {
      const d = await draftMyPlaybook();
      if (!d.ok) return setErr(d.error);
      setFormId(d.formId);
      setNeeds(d.needs);
    });
  }, [startAt, needs, start]);

  const open = missingNeeds(SETUP_PLAYBOOK, answers);
  const total = SETUP_PLAYBOOK.needs.length;
  const answered = total - open.length;

  const set = (key: string, v: AnswerValue) => {
    setAnswers((a) => ({ ...a, [key]: v }));
    setDirty(true);
  };

  const run = (fn: () => Promise<string | null>) =>
    start(async () => {
      setErr(null);
      setMsg(null);
      const e = await fn();
      if (e) setErr(e);
    });

  // ── STEP 1 → 2. Save what they said, then ask Nort to draft their questions. ────────────────
  const toQuestions = () =>
    run(async () => {
      if (dirty) {
        const r = await saveSetup(answers);
        if (!r.ok) return r.error;
        setDirty(false);
        router.refresh();
      }
      const d = await draftMyPlaybook();
      if (!d.ok) return d.error;
      setFormId(d.formId);
      setNeeds(d.needs);
      setStep(2);
      return null;
    });

  const editNeed = (i: number, patch: Partial<Need>) =>
    setNeeds((ns) => (ns ? ns.map((n, j) => (j === i ? { ...n, ...patch } : n)) : ns));

  // BOTH ESCAPE HATCHES SAVE EVERYTHING. This writes the WHOLE drafted set — every question and
  // every why line Nort wrote, including the fourteen nobody read. That is the right behaviour (a
  // drafted playbook beats an empty one, and Settings → Playbook is where you fix it) and it was
  // the wrong label for it: "Skip these for now" reads as "write nothing", which is the opposite
  // of what it does.
  const toWhere = () =>
    run(async () => {
      if (formId && needs) {
        const r = await savePlaybook(formId, needs);
        if (!r.ok) return r.error;
        router.refresh();
      }
      setStep(3);
      return null;
    });

  const done = () =>
    run(async () => {
      const r = await finishOnboarding();
      if (!r.ok) return r.error ?? "Couldn't finish.";
      setMsg("All set.");
      router.refresh();
      onSaved?.();
      return null;
    });

  return (
    <div>
      {/* Three dots, not a percentage. Somebody mid-walkthrough wants to know how much is left,
          not how much they've done. */}
      <div className="mb-4 flex items-center gap-2 text-xs text-slate-400">
        {([1, 2, 3] as Step[]).map((s) => (
          <span key={s} className={`h-1.5 flex-1 rounded-full ${s <= step ? "bg-brand" : "bg-slate-200"}`} />
        ))}
        <span className="shrink-0 tabular-nums">{step}/3</span>
      </div>

      {step === 1 && (
        <>
          <h4 className="text-sm font-semibold text-slate-900">First, your company</h4>
          <p className="mt-0.5 text-sm text-slate-500">
            {answered === total
              ? "Already on file — have a look and change anything that's out of date."
              : `${answered} of ${total}. Say it in one breath, or fill the boxes.`}
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

          {/* THE SAME BOXES, ALWAYS EDITABLE. What Nort fills lands here and what they type lands
              here; one place a value lives, so there is nothing to reconcile. */}
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
            <Button type="button" disabled={pending} onClick={toQuestions}>
              {pending ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Working on your questions…</>
              ) : (
                <>Next: your questions <ArrowRight className="h-4 w-4" /></>
              )}
            </Button>
            {err && <span className="text-sm text-rose-600">{err}</span>}
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h4 className="text-sm font-semibold text-slate-900">The questions you&rsquo;ll be asked on site</h4>
          {/* ONE AT A TIME, WITH NORT TALKING THROUGH EACH.
              Erik: "explain every little step of the why files as we go through it together because
              people aint gonna get it i guarantee it." Fifteen textareas in a column is a form, and
              a form about an idea somebody hasn't met yet teaches nothing. By the third or fourth
              the shape is obvious — which is the moment they can write their own, and the only
              definition of "taught" that matters here. */}
          {!needs?.length ? (
            /* A SPINNER IS NOT AN ERROR MESSAGE. draftMyPlaybook fails outright when the company has
               no walk-through sheet — the ordinary state for anybody who reached this card without a
               trade, because saveSetup only seeds one when a trade is set. `err` was being written
               and then rendered UNDERNEATH a spinner that kept turning forever, so an honest failure
               read as a slow one and people sat waiting on it. */
            err ? (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-rose-700">{err}</p>
                <p className="text-sm text-slate-500">
                  That usually means I never got your trade, so there are no questions to draft yet.
                  Take the walk-through again from the cap button and tell me your trade &mdash; or
                  write them yourself under Settings &rarr; Playbook.
                </p>
              </div>
            ) : (
              <p className="mt-3 flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Writing you a first draft…
              </p>
            )
          ) : (
            (() => {
              const n = needs[Math.min(whyAt, needs.length - 1)];
              const i = Math.min(whyAt, needs.length - 1);
              return (
                <>
                  {/* A COUNT, NEVER A BAR. A progress bar at 1/15 says "you are behind on your
                      homework", and homework is the exact thing that made Erik say "guaranteed this
                      aint going nowhere". One good line is a win; the rest keep. */}
                  <p className="mt-1 text-xs tabular-nums text-slate-400">
                    {needs.length} questions · {i} you&rsquo;ve been through
                  </p>

                  <p className="mt-3 text-sm leading-relaxed text-slate-600">{explainWhy(n, i, needs.length)}</p>

                  <div className="mt-4 rounded-lg border border-slate-200 p-3">
                    <Label className="mb-1">The question</Label>
                    <Input value={n.ask} onChange={(e) => editNeed(i, { ask: e.target.value })} />
                    <div className="mt-3">
                      <WhyField need={n} rows={3} onChange={(why) => editNeed(i, { why })} />
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button type="button" disabled={pending} onClick={() => (i + 1 < needs.length ? setWhyAt(i + 1) : toWhere())}>
                      {pending ? (
                        <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
                      ) : i + 1 < needs.length ? (
                        <>That one&rsquo;s right <ArrowRight className="h-4 w-4" /></>
                      ) : (
                        <>Save them all <ArrowRight className="h-4 w-4" /></>
                      )}
                    </Button>
                    {i > 0 && (
                      <button type="button" onClick={() => setWhyAt(i - 1)} className="text-sm text-slate-500 underline-offset-2 hover:underline">
                        Back
                      </button>
                    )}
                    <span className="flex-1" />
                    {/* STOPPING IS A FIRST-CLASS OUTCOME, not a grey escape hatch at the end of a
                        row. One line understood beats fifteen skimmed, and the rest are saved as
                        drafted — Settings → Playbook is where they live, and Nort will ask about
                        the others on real jobs where they actually cost something. */}
                    {i > 0 ? (
                      <Button type="button" variant="secondary" disabled={pending} onClick={toWhere}>
                        I&rsquo;ve got it — save the rest as drafted
                      </Button>
                    ) : (
                      <button type="button" disabled={pending} onClick={toWhere} className="text-sm text-slate-500 underline-offset-2 hover:underline">
                        Save Nort&rsquo;s drafts and read them later
                      </button>
                    )}
                  </div>
                </>
              );
            })()
          )}
          {err && <p className="mt-3 text-sm text-rose-600">{err}</p>}
        </>
      )}

      {step === 3 && (
        <>
          <h4 className="text-sm font-semibold text-slate-900">Where everything lives</h4>
          <p className="mt-0.5 text-sm text-slate-500">
            Four places. That&rsquo;s the whole app.
          </p>

          <ul className="mt-4 space-y-3 text-sm">
            <li className="flex gap-3">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              <span>
                <strong className="font-medium text-slate-900">Just tell Nort</strong> — on a walk-through, say the whole job
                the way you&rsquo;d say it to a person. The boxes fill in. Check them before you price it; Nort won&rsquo;t work out a
                measurement you didn&rsquo;t say.
              </span>
            </li>
            <li className="flex gap-3">
              <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              <span>
                <strong className="font-medium text-slate-900">Your questions</strong> live in{" "}
                <Link href="/settings?tab=playbook" className="underline underline-offset-2">Settings &rarr; Playbook</Link>. Add,
                cut and reorder them, and change a why any time your mind changes.
              </span>
            </li>
            <li className="flex gap-3">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              <span>
                {/* SAY WHERE THE BUTTON IS, not just where the page is. Erik: "ive been asked
                    multiple times where settings is located." A link takes you there once; knowing
                    it's behind your own initials takes you there forever. */}
                <strong className="font-medium text-slate-900">Everything else about the business</strong> is in{" "}
                <Link href="/settings" className="underline underline-offset-2">Settings</Link> — money, scheduling, your
                website, integrations. You get there from{" "}
                <strong className="font-medium text-slate-900">your initials, top right</strong> — that&rsquo;s the door, on
                every screen.
              </span>
            </li>
            <li className="flex gap-3">
              <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              <span>
                <strong className="font-medium text-slate-900">This walk-through</strong> stays in the top bar. Take it again
                whenever you want — nothing here is one-time.
              </span>
            </li>
          </ul>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button type="button" disabled={pending} onClick={done}>
              {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> …</> : <><Check className="h-4 w-4" /> Got it</>}
            </Button>
            <button type="button" onClick={() => setStep(1)} className="text-sm text-slate-500 underline-offset-2 hover:underline">
              Start over
            </button>
            {err && <span className="text-sm text-rose-600">{err}</span>}
            {msg && !err && <span className="text-sm font-medium text-emerald-700">{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}
