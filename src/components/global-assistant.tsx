"use client";

import { useEffect, useState } from "react";
import { AudioLines, X, Square } from "lucide-react";
import { AssistantChat } from "@/app/(app)/assistant/assistant-chat";
import { unlockAudio, stopSpeaking } from "@/lib/tts";
import { useEstimator, draftTotal } from "@/lib/estimator-store";

const compactMoney = (n: number) => "$" + Math.round(n).toLocaleString();

/**
 * ONE assistant, everywhere. The topbar launcher opens the full conversational Claude (the
 * same one on the /assistant page) as a side drawer — voice + chat, your data, quotes, and
 * the safe actions — reachable from any screen. Replaces the old limited command mic.
 */
export function GlobalAssistant() {
  const [open, setOpen] = useState(false);
  const { draft, speaking, streaming } = useEstimator(); // the live estimate + assistant activity
  const items = draft?.items?.length ?? 0;
  const active = speaking || streaming; // CIB is working or talking → the button is a red STOP

  function launch() {
    // Prime audio + TTS INSIDE this tap (the gesture) so the spoken reply plays on iOS and
    // the mic can start listening the moment the panel opens — tap → talk, one motion.
    try {
      const synth = window.speechSynthesis;
      if (synth) {
        const w = new SpeechSynthesisUtterance(" ");
        w.volume = 0;
        synth.speak(w);
      }
    } catch {}
    unlockAudio();
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
  }, [open]);

  return (
    <>
      {active ? (
        // CIB is working or talking → the waveform flips to a red STOP (square in the circle). One
        // tap aborts the stream + cuts the voice. Tap the rest of the pill to see what's happening.
        <div className="btn-gloss inline-flex h-10 items-center gap-0.5 rounded-full bg-red-600 px-1 text-white shadow-sm">
          <button
            onClick={() => window.dispatchEvent(new Event("cn:assistant-stop"))}
            title="Stop"
            aria-label="Stop the assistant"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 transition-colors hover:bg-white/30"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
          {items > 0 && (
            <button onClick={launch} aria-label="Open the estimate" className="flex h-8 items-center rounded-full px-2 transition-colors hover:bg-white/10">
              <span className="text-sm font-semibold tabular-nums">{compactMoney(draftTotal(draft))}</span>
            </button>
          )}
        </div>
      ) : items > 0 && !open ? (
        // COMPACTED ESTIMATOR: estimate building + drawer closed → the Talk button hosts the running
        // total + item count. Tap to expand the full Estimator back open.
        <button
          onClick={launch}
          title="Open the estimate"
          aria-label="Open the estimate"
          className="btn-gloss inline-flex h-10 items-center gap-1.5 rounded-full bg-brand px-3 text-white shadow-sm transition-colors hover:bg-brand-dark"
        >
          <AudioLines className="h-4 w-4 shrink-0" />
          <span className="text-sm font-semibold tabular-nums">{compactMoney(draftTotal(draft))}</span>
          <span className="hidden text-[11px] text-white/70 sm:inline">{items} item{items === 1 ? "" : "s"}</span>
        </button>
      ) : (
        <button
          onClick={launch}
          title="Talk to the assistant"
          aria-label="Open the assistant"
          className="btn-gloss inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand text-white shadow-sm transition-colors hover:bg-brand-dark"
        >
          <AudioLines className="h-5 w-5" />
        </button>
      )}

      {open && (
        // A SLIM dropdown under the Talk button — sized to its content (it grows line-by-line as the
        // conversation/estimate fills in), NOT a screen-covering panel. No tap-away scrim, so the page
        // behind stays visible AND interactive while the assistant works alongside you; close with X.
        <div className="fixed left-2 top-[4.25rem] z-[120] flex max-h-[75vh] w-[min(24rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-white/50 bg-white/85 shadow-2xl backdrop-blur-xl sm:left-4">
          <div className="flex shrink-0 items-center justify-between border-b border-white/40 px-4 py-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <AudioLines className="h-4 w-4 text-brand" /> Assistant
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/60"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <AssistantChat autoStart glass />
        </div>
      )}
    </>
  );
}
