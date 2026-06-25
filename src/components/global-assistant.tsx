"use client";

import { useEffect, useState } from "react";
import { AudioLines, X } from "lucide-react";
import { AssistantChat } from "@/app/(app)/assistant/assistant-chat";
import { unlockAudio } from "@/lib/tts";

/**
 * ONE assistant, everywhere. The topbar launcher opens the full conversational Claude (the
 * same one on the /assistant page) as a side drawer — voice + chat, your data, quotes, and
 * the safe actions — reachable from any screen. Replaces the old limited command mic.
 */
export function GlobalAssistant() {
  const [open, setOpen] = useState(false);

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
      <button
        onClick={launch}
        title="Assistant — tap and talk"
        aria-label="Open the assistant"
        className="btn-gloss inline-flex h-10 items-center gap-1.5 rounded-full bg-brand px-3 text-white shadow-sm transition-colors hover:bg-brand-dark"
      >
        <AudioLines className="h-5 w-5" />
        <span className="hidden text-sm font-medium sm:inline">Talk</span>
      </button>

      {open && (
        <>
          {/* Tap away to close; the app stays visible behind the glass. */}
          <div className="fixed inset-0 z-[110]" onClick={() => setOpen(false)} />
          {/* A floating, semi-transparent glass window that drops under the top bar and grows
              with the conversation; its bottom half fills with the live quote as you talk. */}
          <div className="fixed right-2 top-[4.25rem] z-[120] flex max-h-[80vh] w-[min(26rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-white/50 bg-white/80 shadow-2xl backdrop-blur-xl sm:right-4">
            <div className="flex shrink-0 items-center justify-between border-b border-white/40 px-4 py-2.5">
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
        </>
      )}
    </>
  );
}
