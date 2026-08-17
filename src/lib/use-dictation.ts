"use client";

import { useEffect, useRef, useState } from "react";

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
  // cancel() flips this so onstop releases the mic but SKIPS transcription — audio recorded on a
  // path that's leaving the screen must be discarded, not billed through Whisper into a callback
  // that can no longer land (audit 7: the lesson tour held the mic forever).
  const aborted = useRef(false);

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
        if (aborted.current) return; // cancelled — mic released above, audio discarded
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
      aborted.current = false;
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

  /** Stop AND discard: mic released, nothing transcribed. For any path that leaves the screen. */
  function cancel() {
    aborted.current = true;
    stop();
  }

  // THE HOOK OWNS THE STREAM, SO THE HOOK RELEASES IT (audit 7 — a driver-side cleanup fixes one
  // consumer; this fixes the mechanism for every present and future consumer). Unmounting any
  // component mid-recording kills the mic and discards the audio.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => () => cancelRef.current(), []);

  return { recording, transcribing, error, setError, start, stop, cancel };
}
