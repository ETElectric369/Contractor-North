"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Mic, Square, RotateCcw, Check, ArrowRight, Heart, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { extForMime, FREE_RECORD, TARGET_SECONDS, type VoicePrompt } from "@/lib/voice-script";
import { saveConsent, uploadClip, completeRecording } from "./actions";

type Step = "welcome" | "consent" | "record" | "free" | "done";
const BRAND = "#1b9488";

const CANDIDATE_MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return CANDIDATE_MIMES.find((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  }) ?? "";
}

export function VoiceRecorder({
  token,
  inviteeName,
  purpose,
  alreadyConsented,
  alreadyCompleted,
  consentText,
  prompts,
}: {
  token: string;
  inviteeName: string;
  purpose: string;
  alreadyConsented: boolean;
  alreadyCompleted: boolean;
  consentText: string[];
  prompts: VoicePrompt[];
}) {
  const firstName = inviteeName.trim().split(/\s+/)[0] || "there";
  const [step, setStep] = useState<Step>(
    alreadyCompleted ? "done" : alreadyConsented ? "record" : "welcome",
  );
  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // ── recording state ──
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<"idle" | "recording" | "review">("idle");
  const [seconds, setSeconds] = useState(0);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set());
  const [extraCount, setExtraCount] = useState(0);
  const [totalSeconds, setTotalSeconds] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const prompt = prompts[idx];

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
      if (clipUrl) URL.revokeObjectURL(clipUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function agree() {
    setError(null);
    if (signature.trim().length < 2) {
      setError("Please type your name to agree.");
      return;
    }
    start(async () => {
      const res = await saveConsent(token, signature.trim());
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setStep("record");
    });
  }

  async function ensureStream(): Promise<MediaStream | null> {
    if (streamRef.current) return streamRef.current;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = s;
      return s;
    } catch {
      setError("We couldn't reach your microphone. Please allow mic access in your browser and try again.");
      return null;
    }
  }

  async function startRecording() {
    setError(null);
    if (typeof MediaRecorder === "undefined") {
      setError("This browser can't record audio. Please try Chrome or Safari.");
      return;
    }
    const stream = await ensureStream();
    if (!stream) return;
    const mimeType = pickMime();
    let rec: MediaRecorder;
    try {
      rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      rec = new MediaRecorder(stream);
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const type = rec.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      blobRef.current = blob;
      if (clipUrl) URL.revokeObjectURL(clipUrl);
      setClipUrl(URL.createObjectURL(blob));
      setPhase("review");
    };
    recorderRef.current = rec;
    rec.start();
    setPhase("recording");
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  }

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    try {
      recorderRef.current?.stop();
    } catch {
      /* ignore */
    }
  }

  function resetTake() {
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    setClipUrl(null);
    blobRef.current = null;
    setPhase("idle");
  }

  // Upload the current take under `key`, add its length to the running total, then run `then`.
  function uploadThen(key: string, then: () => void) {
    const blob = blobRef.current;
    if (!blob) return;
    setError(null);
    const took = seconds;
    start(async () => {
      const fd = new FormData();
      fd.append("token", token);
      fd.append("promptKey", key);
      fd.append("file", blob, `${key}.${extForMime(blob.type)}`);
      const res = await uploadClip(fd);
      if (!res.ok) {
        setError(res.error ?? "Upload failed — please try again.");
        return;
      }
      setTotalSeconds((s) => s + took);
      then();
    });
  }

  function acceptFixed() {
    uploadThen(prompt.key, () => advance(true));
  }
  function acceptFree() {
    uploadThen(`extra-${extraCount + 1}`, () => {
      setExtraCount((n) => n + 1);
      resetTake();
    });
  }

  function advance(markDone: boolean) {
    if (markDone) setDoneKeys((prev) => new Set(prev).add(prompt.key));
    resetTake();
    if (idx < prompts.length - 1) setIdx(idx + 1);
    else setStep("free"); // guided prompts done → open "keep going" step
  }

  function finish() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const count = doneKeys.size + extraCount;
    start(async () => {
      await completeRecording(token, count);
      setStep("done");
    });
  }

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const totalMin = Math.round(totalSeconds / 60);
  const pct = Math.min(100, Math.round((totalSeconds / TARGET_SECONDS) * 100));

  // Shared record controls (idle → recording → review). `onAccept` differs per step.
  function recorder(onAccept: () => void) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        {phase === "idle" && (
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={startRecording}
              disabled={pending}
              className="flex h-20 w-20 items-center justify-center rounded-full text-white shadow-lg transition active:scale-95"
              style={{ backgroundColor: BRAND }}
              aria-label="Start recording"
            >
              <Mic className="h-8 w-8" />
            </button>
            <span className="text-sm text-slate-500">Tap to record</span>
          </div>
        )}
        {phase === "recording" && (
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={stopRecording}
              className="flex h-20 w-20 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition active:scale-95"
              aria-label="Stop recording"
            >
              <Square className="h-7 w-7" fill="white" />
            </button>
            <span className="flex items-center gap-2 text-sm font-medium text-red-600">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> Recording… {mmss}
            </span>
          </div>
        )}
        {phase === "review" && clipUrl && (
          <div className="space-y-4">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio src={clipUrl} controls className="w-full" />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={resetTake} disabled={pending}>
                <RotateCcw className="h-4 w-4" /> Re-record
              </Button>
              <Button onClick={onAccept} disabled={pending}>
                {pending ? "Saving…" : (
                  <>
                    <Check className="h-4 w-4" /> Sounds good — save
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white text-slate-900">
      <div className="mx-auto max-w-2xl px-5 py-10 sm:py-14">
        <div className="mb-8 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl text-white" style={{ backgroundColor: BRAND }}>
            <Mic className="h-5 w-5" />
          </span>
          <span className="text-sm font-semibold tracking-wide text-slate-500">A voice for Nort</span>
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* ── WELCOME ── (Erik: edit this copy with your genuine story) */}
        {step === "welcome" && (
          <div className="space-y-6">
            <h1 className="text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
              {firstName}, thank you for being here.
            </h1>
            <div className="space-y-4 text-[15px] leading-relaxed text-slate-600">
              <p>
                My name is Erik Taylor — an electrical contractor in the Reno/Tahoe area, and a
                survivor. In May of 2025, on a sure path to the grave, my family stepped in and sent
                me to sit through an Iboga ceremony. It saved my life.
              </p>
              <p>
                You&apos;re my hero. You&apos;re doing God&apos;s work, and it&apos;s a joy to listen to you speak. I&apos;m
                building an app called Contractor North, with an assistant named <strong>Nort</strong> — my North
                Star, my guiding light — and I would be honored beyond words for your voice to be that
                guiding light for contractors everywhere.
              </p>
              <p>
                We&apos;re the people who build everything for everyone — the ones listening to you while we
                drive endlessly — and we carry a lot of dark weight. I couldn&apos;t think of a better voice,
                or a better chance to help others heal the way I was helped. Thank you for being here.
              </p>
              <p>
                Here&apos;s all it takes: read a few short things out loud, then just talk naturally for a little while.
                Everything stays private, and you can change your mind at any time.
              </p>
            </div>
            {purpose && <p className="text-sm text-slate-500">{purpose}</p>}
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
              <div className="mb-1 flex items-center gap-2 font-semibold text-slate-800">
                <ShieldCheck className="h-4 w-4" style={{ color: BRAND }} /> A quick note on your choice
              </div>
              You&apos;re in control. Nothing is used unless you agree on the next screen, and you can withdraw your
              permission anytime just by reaching out.
            </div>
            <Button onClick={() => { setError(null); setStep("consent"); }} className="w-full sm:w-auto">
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        )}

        {/* ── CONSENT ── */}
        {step === "consent" && (
          <div className="space-y-6">
            <h1 className="text-2xl font-bold tracking-tight">Your permission</h1>
            <p className="text-[15px] text-slate-600">
              Please read this and, if you agree, type your name to sign. Plain English — no fine print.
            </p>
            <ul className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
              {consentText.map((line, i) => (
                <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-slate-700">
                  <Check className="mt-1 h-4 w-4 shrink-0" style={{ color: BRAND }} />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <div>
              <label htmlFor="sig" className="mb-1 block text-sm font-medium text-slate-700">
                Type your full name to agree
              </label>
              <input
                id="sig"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                placeholder="Your full name"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base outline-none focus:border-slate-400"
                autoComplete="name"
              />
            </div>
            <Button onClick={agree} disabled={pending} className="w-full sm:w-auto">
              {pending ? "Saving…" : "I agree and give my permission"} <Heart className="h-4 w-4" />
            </Button>
          </div>
        )}

        {/* ── RECORD (guided prompts) ── */}
        {step === "record" && prompt && (
          <div className="space-y-6">
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>Step {idx + 1} of {prompts.length}</span>
              <span className="flex items-center gap-1.5">
                {prompts.map((p, i) => (
                  <span
                    key={p.key}
                    className="h-1.5 w-5 rounded-full"
                    style={{ backgroundColor: doneKeys.has(p.key) ? BRAND : i === idx ? "#94a3b8" : "#e2e8f0" }}
                  />
                ))}
              </span>
            </div>

            <div>
              <h2 className="text-xl font-bold tracking-tight">{prompt.label}</h2>
              <p className="mt-1 text-sm text-slate-500">{prompt.instruction}</p>
            </div>

            {prompt.text && (
              <blockquote
                className="rounded-xl border-l-4 bg-white p-5 text-lg leading-relaxed text-slate-800 shadow-sm"
                style={{ borderColor: BRAND }}
              >
                {prompt.text}
              </blockquote>
            )}

            {recorder(acceptFixed)}

            {phase === "idle" && prompt.kind === "natural" && (
              <button onClick={() => advance(false)} disabled={pending} className="text-sm text-slate-400 underline hover:text-slate-600">
                Skip this one
              </button>
            )}
          </div>
        )}

        {/* ── FREE (keep going as long as you like) ── */}
        {step === "free" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold tracking-tight">{FREE_RECORD.heading}</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{FREE_RECORD.blurb}</p>
            </div>

            {/* running total + gentle target */}
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-slate-700">
                  Recorded so far: ~{totalMin} min{extraCount > 0 ? ` · ${extraCount} extra take${extraCount === 1 ? "" : "s"}` : ""}
                </span>
                <span className="text-slate-400">a good clone loves ~20 min</span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: BRAND }} />
              </div>
            </div>

            <ul className="flex flex-wrap gap-2">
              {FREE_RECORD.ideas.map((idea) => (
                <li key={idea} className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500">
                  {idea}
                </li>
              ))}
            </ul>

            {recorder(acceptFree)}

            {phase === "idle" && (
              <div className="flex items-center gap-3">
                <Button onClick={finish} disabled={pending}>
                  {pending ? "Finishing…" : (
                    <>
                      <Check className="h-4 w-4" /> I&apos;m all done
                    </>
                  )}
                </Button>
                <span className="text-sm text-slate-400">…or tap the mic to add another</span>
              </div>
            )}
          </div>
        )}

        {/* ── DONE ── */}
        {step === "done" && (
          <div className="space-y-6 py-8 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full" style={{ backgroundColor: `${BRAND}1a` }}>
              <Heart className="h-8 w-8" style={{ color: BRAND }} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Thank you, {firstName}.</h1>
            <p className="mx-auto max-w-md text-[15px] leading-relaxed text-slate-600">
              That&apos;s everything. Your recordings and your permission are saved. It genuinely means a lot — your
              voice is going to help a lot of people get through their workday.
            </p>
            <p className="text-sm text-slate-400">You can close this page. If you&apos;d ever like to add more or change your mind, just reach out.</p>
          </div>
        )}
      </div>
    </div>
  );
}
