"use client";

import { useRef, useState, useTransition } from "react";
import { Loader2, Mic, Sparkles, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { hearIntoPlaybook } from "../hear-actions";
import type { Answers } from "@/lib/playbook/types";

/**
 * "TELL NORT" — say the job the way you'd say it to a person, and the boxes fill in.
 *
 * This is the other half of Erik's own instruction: "on screen everything needs to be single
 * source of truth so i can do it manually and nort fills in for me." Same boxes, two ways in.
 *
 * IT DOES NOT LISTEN AT YOU. Press to talk, press to stop — memory of every version of this: a
 * wake-word or an always-on mic on a job site is a liability and a battery drain, and press-to-
 * capture is what he asked for. The mic is granted inside the tap, so iOS is happy.
 *
 * THE TRANSCRIPT IS EDITABLE BEFORE IT IS USED, and that is deliberate. Speech-to-text on a job
 * site mishears numbers, and a number is the thing that turns into money. He sees the words, fixes
 * "forty" that came back as "fourteen", and only then does anything get filled. It also means the
 * whole feature works with the mic broken, in a basement, or with a dead battery: type it.
 *
 * NOTHING IS COMMITTED HERE. Fills land in the same fields he can edit, and the save button is
 * still his — see hear-actions.
 */
export function TellNort({
  appointmentId,
  answers,
  onFilled,
  hint,
}: {
  appointmentId: string;
  answers: Answers;
  onFilled: (next: Answers, filled: string[], note: string) => void;
  /** What the first question is, so the prompt says something true rather than "describe the job". */
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);

  async function startMic() {
    setErr(null);
    try {
      // Granted INSIDE the tap — iOS rejects getUserMedia off a gesture.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = async () => {
        // Release the mic the moment we're done — a live indicator on a phone in a crawlspace
        // reads as "this thing is recording me", and it would be right.
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: type || "audio/webm" });
        if (blob.size < 800) return;
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append("audio", blob, "turn.webm");
          const r = await fetch("/api/transcribe", { method: "POST", body: fd });
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error ?? "Couldn't hear that.");
          const heard = String(j?.text ?? "").trim();
          // APPEND, never replace: two passes at a wall shouldn't wipe the first one.
          if (heard) setText((t) => (t.trim() ? `${t.trim()} ${heard}` : heard));
          else setErr("Didn't catch anything.");
        } catch (e: unknown) {
          setErr((e as { message?: string })?.message ?? "Couldn't hear that.");
        } finally {
          setTranscribing(false);
        }
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch {
      setErr("No mic — type it instead.");
    }
  }

  function stopMic() {
    try {
      recRef.current?.stop();
    } catch {
      /* already stopped */
    }
    recRef.current = null;
    setRecording(false);
  }

  function fill() {
    const said = text.trim();
    if (!said) return;
    start(async () => {
      setErr(null);
      const r = await hearIntoPlaybook(appointmentId, answers, said);
      if (!r.ok) return setErr(r.error);
      onFilled(r.answers, r.filled, r.note);
      setText("");
      setOpen(false);
      // NAME WHAT IT FILLED. A count is a claim; a list is something he can check at a glance,
      // and one of them will occasionally be a reasonable-sounding read of his words that is
      // wrong. They're all editable below — but only if he knows to look.
      setSaid(
        r.filled.length
          ? `Filled in: ${r.filled.join(", ")}${r.note ? " · the rest is in your notes" : ""} — have a look before you price it.`
          : r.note
            ? "Nothing matched a question — it's in the notes, word for word."
            : "Couldn't place any of that.",
      );
    });
  }

  if (!open)
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setSaid(null);
          }}
          className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 text-sm font-medium text-slate-600 active:bg-slate-50"
        >
          <Sparkles className="h-4 w-4 text-brand" /> Just tell Nort
        </button>
        {said && <p className="mt-1.5 text-xs leading-snug text-emerald-700">{said}</p>}
      </div>
    );

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-xs text-slate-500">
          {hint ? `Say the whole thing — ${hint.replace(/\?$/, "")}, and anything else you'd tell somebody.` : "Say the whole thing, the way you'd say it to a person."}
        </p>
        <button type="button" onClick={() => { stopMic(); setOpen(false); }} className="shrink-0 rounded-md p-1 text-slate-400">
          <X className="h-4 w-4" />
        </button>
      </div>

      <Textarea
        rows={4}
        autoFocus
        value={text}
        placeholder="Two new circuits, one for lights one for outlets, finished room they're converting from storage…"
        onChange={(e) => setText(e.target.value)}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={recording ? "destructive" : "secondary"}
          disabled={transcribing || pending}
          onClick={() => (recording ? stopMic() : startMic())}
        >
          {transcribing ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Writing it down…</>
          ) : recording ? (
            <><Square className="h-4 w-4" /> Stop</>
          ) : (
            <><Mic className="h-4 w-4" /> Talk</>
          )}
        </Button>
        <Button type="button" disabled={!text.trim() || pending || recording} onClick={fill}>
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Filling…</> : "Fill it in"}
        </Button>
        {recording && <span className="text-xs text-rose-600">Listening — press Stop when you&rsquo;re done.</span>}
        {err && <span className="text-xs text-rose-600">{err}</span>}
      </div>

      {/* The one thing worth saying out loud about how this behaves, because it is the difference
          between a tool and a liability: it fills what you SAID and nothing else. */}
      <p className="mt-2 text-[11px] leading-snug text-slate-400">
        Check the words before you fill — Nort only uses what&rsquo;s written here, and it won&rsquo;t work out a
        measurement you didn&rsquo;t say. Anything it can&rsquo;t place goes in your notes as-is.
      </p>
    </div>
  );
}
