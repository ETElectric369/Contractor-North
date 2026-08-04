"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight, Check, Loader2, Mic, Square, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { looseNumber } from "@/lib/inspection/capture";
import { TourSpotlight } from "./tour-spotlight";
import { useDictation } from "@/lib/use-dictation";
import { TOUR, sayOf, type TourCtx } from "@/lib/onboarding/tour";
import { SETUP_PLAYBOOK } from "@/lib/onboarding/setup-playbook";
import { speakSmart, stopSpeaking, unlockAudio } from "@/lib/tts";
import { saveSetup, talkSetup } from "@/app/(app)/setup-actions";
import type { Answers } from "@/lib/playbook/types";

/**
 * THE TOUR, RUNNING — Nort talks, points, listens, and fills as you answer.
 *
 * Erik: "a real conversation because people need to know how Nort works first and foremost … not
 * just a sheet in front of me with a fill in the holes nort button."
 *
 * SO THE FIRST THING THAT HAPPENS IS NORT TALKING AND ASKING. Speech is the medium, the boxes are
 * the receipt. Every step is spoken aloud through the SAME voice the assistant uses (speakSmart →
 * neural, browser fallback) rather than a second sound nobody recognises — there is one Nort.
 *
 * IT SURVIVES NAVIGATION. The step index lives in sessionStorage and the driver is mounted in the
 * shell, so walking somebody to Settings doesn't end the lesson. That is the difference between a
 * tour and a modal with pictures of the app in it.
 *
 * NOTHING IS A GATE. Mute it, skip a question, type instead of talking, or leave — and the answers
 * given so far are still saved. A tour you cannot escape is a tour people learn to dread.
 */

const KEY = "cn.tour.step";
const MUTE = "cn.tour.muted";

export function TourDriver({
  initial,
  returning = false,
  onClose,
}: {
  initial: Answers;
  /** They've finished before — this is a revisit, not an introduction. */
  returning?: boolean;
  /** `completed` distinguishes reaching the end from bailing out — the caller hands a finisher
   *  straight to the why-line draft the tour just promised, and hands a quitter nothing. */
  onClose: (completed: boolean) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [i, setI] = useState(() => {
    if (typeof window === "undefined") return 0;
    const n = Number(sessionStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 && n < TOUR.length ? n : 0;
  });
  const [answers, setAnswers] = useState<Answers>(initial);
  const [typed, setTyped] = useState("");
  const [muted, setMuted] = useState(() => typeof window !== "undefined" && sessionStorage.getItem(MUTE) === "1");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // What Nort just SAID back — shown as speech, not as a status line.
  const [reply, setReply] = useState<string | null>(null);
  const savedRef = useRef(false);
  // The auto-advance fires from inside a callback that closed over an older render, so it reads
  // the step and the mute flag from refs rather than from a stale closure.
  const iRef = useRef(0);
  const mutedRef = useRef(false);
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);

  // WHO NORT IS TALKING TO, rebuilt from what he currently knows — so the moment somebody says
  // their name, every later line is already using it.
  const str = (k: string) => (typeof answers[k] === "string" ? (answers[k] as string).trim() : "");
  const ctx: TourCtx = {
    first: str("full_name").split(/\s+/)[0] ?? "",
    trade: str("trade"),
    city: str("city"),
    rate: typeof answers.labor_rate === "number" && answers.labor_rate > 0 ? `$${answers.labor_rate}` : "",
    returning,
  };

  const step = TOUR[i];
  const line = sayOf(step.say, ctx);
  const need = step.ask ? SETUP_PLAYBOOK.needs.find((n) => n.key === step.ask) : undefined;
  const known = step.ask ? answers[step.ask] : undefined;
  const answered = known !== null && known !== undefined && String(known).trim() !== "";

  useEffect(() => {
    sessionStorage.setItem(KEY, String(i));
    iRef.current = i;
  }, [i]);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);
  // A pending advance must never fire into a tour that has been closed or stepped past by hand.
  useEffect(() => () => { if (advance.current) clearTimeout(advance.current); }, []);

  // Walk them to the right screen before pointing at something on it. Compare on the PATH only —
  // usePathname() drops the query, so testing against "/settings?tab=playbook" is never equal and
  // would push on every render, forever.
  useEffect(() => {
    if (step.route && pathname !== step.route.split("?")[0]) router.push(step.route);
  }, [step.route, pathname, router]);

  // SPEAK THE STEP. Re-speaks whenever the step changes; stops the moment it doesn't.
  useEffect(() => {
    if (muted) return;
    stopSpeaking();
    speakSmart(line);
    return () => stopSpeaking();
    // Deliberately keyed on the STEP, not on `line` — `line` changes the instant an answer lands,
    // and re-speaking the whole card over somebody who just finished talking is the opposite of a
    // conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, muted]);

  useEffect(() => () => stopSpeaking(), []);

  const fill = useCallback(
    async (said: string) => {
      if (!said.trim()) return;
      setBusy(true);
      setNote(null);
      // A TURN OF CONVERSATION, not a parse. Erik said "Hello. That works. What's next?" and was
      // told his words couldn't be turned into an answer — correct as extraction, wrong as
      // behaviour, because what is being taught in that moment is that Nort is somebody you can
      // talk to. talkSetup replies to what was actually said AND fills what it can, through the
      // same gate as ever.
      const r = await talkSetup(step.ask ?? null, answers, said);
      setBusy(false);
      if (!r.ok) return setNote(r.error);
      setAnswers(r.answers);
      setTyped("");
      setReply(r.say);
      if (!mutedRef.current && r.say) speakSmart(r.say);

      // MOVE ON ONLY WHEN THIS QUESTION IS ACTUALLY ANSWERED. Advancing on any reply would carry
      // somebody past a question they only chatted about; staying put after they answered is the
      // wall. Nothing filled = Nort has just asked again, in smaller words, and we wait.
      const landed = step.ask ? r.answers[step.ask] : null;
      const ok = landed !== null && landed !== undefined && String(landed).trim() !== "";
      if (ok) {
        const words = r.say.length;
        advance.current = setTimeout(() => void go(iRef.current + 1), Math.min(9000, 1800 + words * 55));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [answers, step.ask],
  );

  const dictation = useDictation(fill);

  // The company facts are committed ONCE, when the questions are behind them — not per keystroke.
  // Saying things changed nothing; this is the write. (fill-vs-execute)
  const commit = useCallback(async () => {
    if (savedRef.current) return;
    savedRef.current = true;
    await saveSetup(answers);
    router.refresh();
  }, [answers, router]);

  const go = async (to: number) => {
    if (advance.current) clearTimeout(advance.current);
    advance.current = null;
    stopSpeaking();
    if (to >= TOUR.length) {
      setBusy(true);
      await commit();
      setBusy(false);
      sessionStorage.removeItem(KEY);
      router.refresh();
      // NOT finishOnboarding() — "shown" means shown the why lines too, and those are the next
      // screen. The draft step records it when they're actually done. (0180)
      return onClose(true);
    }
    // Leaving the last question → save what was said.
    if (TOUR[i].ask && !TOUR[to]?.ask) await commit();
    setNote(null);
    setReply(null);
    setI(Math.max(0, to));
  };

  const exit = () => {
    stopSpeaking();
    dictation.stop();
    void commit();
    onClose(false);
  };

  return (
    <TourSpotlight anchor={step.anchor} title={step.title} onExit={exit} step={i + 1} total={TOUR.length}>
      <p className="text-sm leading-relaxed text-slate-600">{line}</p>

      {need && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3">
          {/* THE TALK BUTTON IS ALWAYS HERE, answered or not.
              This hid it. Erik's profile already carries his name, his trade, his town and his
              rate — so every step showed a green tick and there was NO Talk button anywhere in the
              entire tour. He said: "i cant press the talk button anywhere to start saying my name."
              Which is the same mistake as the vanishing setup card, one layer in: I read "we
              already know this" as "there is nothing to do here", when the whole point of the step
              is MEETING NORT. Pressing Talk and hearing it come back is the lesson; the answer is
              a by-product. What is known shows above the mic, and saying it again replaces it. */}
          {answered && (
            <div className="mb-3">
              <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                <Check className="h-3.5 w-3.5 shrink-0" /> {need.label} — check the spelling
              </label>
              {/* EDITABLE, MIDSTREAM. Erik: "the availability to edit it midstream to make absolute
                  sure every bit of information is accurate, spelled correctly, understood
                  correctly." Speech-to-text mangles surnames and town names more than anything
                  else, and this exact string goes on every estimate this company ever sends. A
                  read-only tick would have made it somebody's job to notice later. */}
              {need.slot?.type === "number" ? (
                <div className="flex items-center gap-2">
                  <Input
                    inputMode="decimal"
                    value={typeof known === "number" ? String(known) : ""}
                    onChange={(e) => setAnswers((a) => ({ ...a, [step.ask!]: looseNumber(e.target.value) }))}
                  />
                  <span className="shrink-0 text-sm text-slate-500">{need.slot.unit}</span>
                </div>
              ) : (
                <Input
                  value={typeof known === "string" ? known : String(known ?? "")}
                  onChange={(e) => setAnswers((a) => ({ ...a, [step.ask!]: e.target.value }))}
                />
              )}
            </div>
          )}
          {
            <>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant={dictation.recording ? "destructive" : "secondary"}
                  disabled={dictation.transcribing || busy}
                  onClick={() => {
                    if (dictation.recording) return dictation.stop();
                    // Two things must happen inside this tap: iOS only grants the mic in a gesture,
                    // and it only unlocks audio playback in one. Stop talking first so Nort isn't
                    // transcribing itself.
                    stopSpeaking();
                    unlockAudio();
                    void dictation.start();
                  }}
                >
                  {dictation.transcribing ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Writing it down…</>
                  ) : dictation.recording ? (
                    <><Square className="h-4 w-4" /> Stop</>
                  ) : (
                    <><Mic className="h-4 w-4" /> Talk</>
                  )}
                </Button>
                {dictation.recording && <span className="text-xs text-rose-600">Listening…</span>}
              </div>
              <form
                className="mt-2 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void fill(typed);
                }}
              >
                <Input value={typed} placeholder="…or type it" onChange={(e) => setTyped(e.target.value)} />
                <Button type="submit" variant="secondary" disabled={!typed.trim() || busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Use it"}
                </Button>
              </form>
            </>
          }
          {reply && (
            <p className="mt-2 rounded-lg bg-brand-light px-3 py-2 text-sm leading-relaxed text-slate-700">
              {reply}
            </p>
          )}
          {(note || dictation.error) && (
            <p className={`mt-2 text-xs ${dictation.error ? "text-rose-600" : "text-slate-500"}`}>
              {dictation.error ?? note}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" disabled={busy} onClick={() => void go(i + 1)}>
          {busy ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> …</>
          ) : (
            <>{step.next ?? (answered || !need ? "Next" : "Skip this one")} <ArrowRight className="h-4 w-4" /></>
          )}
        </Button>
        {i > 0 && (
          <button type="button" onClick={() => void go(i - 1)} className="text-sm text-slate-500 underline-offset-2 hover:underline">
            Back
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            const next = !muted;
            setMuted(next);
            sessionStorage.setItem(MUTE, next ? "1" : "0");
            if (next) stopSpeaking();
            else {
              unlockAudio();
              speakSmart(line);
            }
          }}
          aria-label={muted ? "Let Nort speak" : "Mute Nort"}
          title={muted ? "Let Nort speak" : "Mute Nort"}
          className="rounded-md p-2 text-slate-400 hover:bg-slate-100"
        >
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      </div>
    </TourSpotlight>
  );
}
