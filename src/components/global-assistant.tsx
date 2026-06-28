"use client";

import { useEffect, useState } from "react";
import { AudioLines, X, Square } from "lucide-react";
import { AssistantChat } from "@/app/(app)/assistant/assistant-chat";
import { unlockAudio, stopSpeaking } from "@/lib/tts";
import { useEstimator } from "@/lib/estimator-store";

/**
 * ONE assistant, everywhere. The topbar launcher opens the full conversational Claude (the
 * same one on the /assistant page) as a side drawer — voice + chat, your data, quotes, and
 * the safe actions — reachable from any screen. Replaces the old limited command mic.
 */
export function GlobalAssistant() {
  const [open, setOpen] = useState(false);
  const { speaking, streaming } = useEstimator(); // assistant activity
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
        // CIB is working or talking → a red STOP. One tap aborts the stream + cuts the voice. No data
        // on the button — the live status + estimate summary are the two lines in the dropdown.
        <button
          onClick={() => window.dispatchEvent(new Event("cn:assistant-stop"))}
          title="Stop"
          aria-label="Stop the assistant"
          className="btn-gloss inline-flex h-10 w-10 items-center justify-center rounded-full bg-red-600 text-white shadow-sm transition-colors hover:bg-red-700"
        >
          <Square className="h-4 w-4 fill-current" />
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
