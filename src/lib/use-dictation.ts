"use client";

import { useRef, useState } from "react";

/**
 * PRESS TO TALK, PRESS TO STOP — one implementation, used by the inspector and by the tour.
 *
 * Deliberately NOT the module-level singletons in lib/speech or lib/voice-stream: those hold ONE
 * mic session for the global assistant's multi-turn conversation, and a second surface grabbing
 * them would fight it. This is a self-contained turn — open the mic inside the tap (iOS rejects
 * getUserMedia off a gesture), record, release, transcribe, hand back the words.
 *
 * IT HANDS BACK TEXT, NEVER AN ACTION. The caller shows the words and lets the person fix them
 * before anything happens with them — speech-to-text mishears numbers on a job site, and a number
 * is the thing that turns into money.
 */
export function useDictation(onText: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = async () => {
        // Release the mic the moment the turn ends. A live indicator that outlives the recording
        // reads as "this thing is listening to me" — and it would be right.
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: type || "audio/webm" });
        if (blob.size < 800) return;
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append("audio", blob, "turn.webm");
          const res = await fetch("/api/transcribe", { method: "POST", body: fd });
          const j = await res.json();
          if (!res.ok) throw new Error(j?.error ?? "Couldn't hear that.");
          const heard = String(j?.text ?? "").trim();
          if (heard) onText(heard);
          else setError("Didn't catch anything.");
        } catch (e: unknown) {
          setError((e as { message?: string })?.message ?? "Couldn't hear that.");
        } finally {
          setTranscribing(false);
        }
      };
      r.start();
      rec.current = r;
      setRecording(true);
    } catch {
      setError("No mic — type it instead.");
    }
  }

  function stop() {
    try {
      rec.current?.stop();
    } catch {
      /* already stopped */
    }
    rec.current = null;
    setRecording(false);
  }

  return { recording, transcribing, error, setError, start, stop };
}
