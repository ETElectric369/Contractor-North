"use client";

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
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
        <Sparkles className="h-5 w-5" />
        <span className="hidden text-sm font-medium sm:inline">Assistant</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-[120] flex items-stretch justify-end">
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => setOpen(false)} />
          <div className="relative z-10 flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Sparkles className="h-4 w-4 text-brand" /> Assistant
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex flex-1 flex-col overflow-hidden p-2">
              <AssistantChat />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
