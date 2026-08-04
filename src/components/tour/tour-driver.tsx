"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight, Check, Loader2, Mic, Square, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TourSpotlight } from "./tour-spotlight";
import { useDictation } from "@/lib/use-dictation";
import { TOUR } from "@/lib/onboarding/tour";
import { SETUP_PLAYBOOK } from "@/lib/onboarding/setup-playbook";
import { speakSmart, stopSpeaking, unlockAudio } from "@/lib/tts";
import { hearSetup, saveSetup } from "@/app/(app)/setup-actions";
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
  onClose,
}: {
  initial: Answers;
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
  const savedRef = useRef(false);

  const step = TOUR[i];
  const need = step.ask ? SETUP_PLAYBOOK.needs.find((n) => n.key === step.ask) : undefined;
  const known = step.ask ? answers[step.ask] : undefined;
  const answered = known !== null && known !== undefined && String(known).trim() !== "";

  useEffect(() => {
    sessionStorage.setItem(KEY, String(i));
  }, [i]);

  // Walk them to the right screen before pointing at something on it.
  useEffect(() => {
    if (step.route && pathname !== step.route) router.push(step.route);
  }, [step.route, pathname, router]);

  // SPEAK THE STEP. Re-speaks whenever the step changes; stops the moment it doesn't.
  useEffect(() => {
    if (muted) return;
    stopSpeaking();
    speakSmart(step.say);
    return () => stopSpeaking();
  }, [i, muted, step.say]);

  useEffect(() => () => stopSpeaking(), []);

  const fill = useCallback(
    async (said: string) => {
      if (!said.trim()) return;
      setBusy(true);
      setNote(null);
      const r = await hearSetup(answers, said);
      setBusy(false);
      if (!r.ok) return setNote(r.error);
      setAnswers(r.answers);
      setTyped("");
      setNote(r.filled.length ? `Got it — ${r.filled.join(", ")}.` : "Didn't catch anything I could use. Try again, or type it.");
    },
    [answers],
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
      <p className="text-sm leading-relaxed text-slate-600">{step.say}</p>

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
            <p className="mb-2 flex items-center gap-1.5 text-sm text-emerald-700">
              <Check className="h-4 w-4 shrink-0" />
              <span>
                <span className="font-medium">{need.label}:</span> {String(known)}
                <span className="text-slate-400"> — say it again to change it</span>
              </span>
            </p>
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
              speakSmart(step.say);
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
