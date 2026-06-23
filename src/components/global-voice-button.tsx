"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, MicOff, Loader2, Sparkles } from "lucide-react";
import { runVoiceCommand, confirmVoiceAction, type VoiceConfirm } from "@/app/(app)/voice/actions";

/**
 * Floating mic with two modes:
 *  • Dictate — if a text field is focused, speech is typed into it.
 *  • Command — otherwise, speech is sent to the AI to act on ("add a task to
 *    call the inspector", "open the scheduler", "new appointment tomorrow at 9").
 * Drag to reposition. Uses the Web Speech API.
 */
export function GlobalVoiceButton({ lang, placement = "fab" }: { lang?: string; placement?: "fab" | "topbar" }) {
  const router = useRouter();
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // A field action waiting for a spoken "yes" before it runs.
  const [pendingConfirm, setPendingConfirm] = useState<VoiceConfirm | null>(null);
  const [confirmMsg, setConfirmMsg] = useState("");
  const [pos, setPos] = useState({ x: 20, y: 104 }); // clears the floating glass bottom nav (+ safe area)
  const modeRef = useRef<"dictate" | "command">("command");
  const lastField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const recog = useRef<any>(null);
  const drag = useRef<{ sx: number; sy: number; bx: number; by: number; moved: boolean } | null>(null);
  // The pending confirm lives in a ref too, so the speak→listen callback chain reads
  // the CURRENT value (state alone would be stale inside those closures).
  const pendingRef = useRef<VoiceConfirm | null>(null);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSupported(Boolean(SR));
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement;
      if (!t) return;
      if (t.tagName === "TEXTAREA") lastField.current = t as HTMLTextAreaElement;
      else if (t.tagName === "INPUT") {
        const type = (t as HTMLInputElement).type;
        if (["text", "search", "email", "tel", "url", ""].includes(type)) lastField.current = t as HTMLInputElement;
      }
    };
    document.addEventListener("focusin", onFocus);
    try {
      const saved = localStorage.getItem("cn_voice_pos");
      if (saved) setPos(JSON.parse(saved));
    } catch {}
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  function flash(msg: string, ms = 3500) {
    setStatus(msg);
    window.setTimeout(() => setStatus((s) => (s === msg ? null : s)), ms);
  }

  // Read the result aloud so a driver never has to look at the screen — the
  // server already returns a driver-friendly sentence.
  function speak(msg: string, onEnd?: () => void) {
    try {
      const synth = window.speechSynthesis;
      if (!synth || !msg) { onEnd?.(); return; }
      synth.cancel();
      const u = new SpeechSynthesisUtterance(msg);
      if (onEnd) u.onend = () => onEnd();
      synth.speak(u);
    } catch {
      onEnd?.(); /* TTS unsupported — the toast still shows */
    }
  }

  // Generic listen: start the recognizer and hand the final transcript to `handler`.
  function startListen(handler: (text: string) => void, statusMsg: string) {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.continuous = false;
    r.interimResults = false;
    r.lang = lang === "es" ? "es-US" : "en-US";
    r.onresult = (e: any) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
      text = text.trim();
      if (text) handler(text);
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    r.start();
    recog.current = r;
    setListening(true);
    setStatus(statusMsg);
  }

  // After a field action is parsed, read it back and wait for a spoken yes/no (or a
  // tap on the Yes/Cancel buttons) before anything is written.
  function handleConfirmReply(text: string) {
    const t = text.toLowerCase();
    if (/\b(yes|yeah|yep|yup|confirm|do it|go ahead|sure|correct|right|ok|okay)\b/.test(t)) resolveConfirm(true);
    else if (/\b(no|nope|cancel|stop|never ?mind|don'?t|do not|wrong)\b/.test(t)) resolveConfirm(false);
    else speak("Say yes or no.", () => startListen(handleConfirmReply, "Say yes or no…"));
  }

  async function resolveConfirm(yes: boolean) {
    const c = pendingRef.current;
    pendingRef.current = null;
    setPendingConfirm(null);
    setConfirmMsg("");
    if (!c) return;
    if (!yes) {
      flash("Okay, cancelled.");
      speak("Okay, cancelled.");
      buzz(20);
      return;
    }
    setWorking(true);
    setStatus("Working…");
    try {
      const res = await confirmVoiceAction(c.name, c.input);
      const msg = res.ok ? c.speakDone : res.message;
      flash(msg);
      speak(msg);
      buzz(res.ok ? 30 : [40, 40, 40]);
      if (res.ok && res.navigate) router.push(res.navigate);
      router.refresh();
    } catch {
      flash("That didn't work.");
      speak("That didn't work.");
    } finally {
      setWorking(false);
    }
  }
  function buzz(pattern: number | number[]) {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* no haptics — ignore */
    }
  }

  function insert(text: string) {
    const el = lastField.current;
    if (!el) return;
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    setter?.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    const caret = start + text.length;
    try {
      el.focus();
      el.setSelectionRange?.(caret, caret);
    } catch {}
  }

  async function handleCommand(transcript: string) {
    setWorking(true);
    setStatus("Working…");
    try {
      const res = await runVoiceCommand(transcript);
      // A field action needs a spoken "yes" first — read it back + listen for yes/no.
      if (res.confirm) {
        setWorking(false);
        pendingRef.current = res.confirm;
        setPendingConfirm(res.confirm);
        setConfirmMsg(res.message);
        flash(res.message);
        buzz(20);
        speak(res.message, () => startListen(handleConfirmReply, "Say yes or no…"));
        return;
      }
      flash(res.message);
      speak(res.message);
      buzz(30); // short confirm pulse
      if (res.navigate) router.push(res.navigate);
      router.refresh();
    } catch {
      const err = "Sorry — that didn't work.";
      flash(err);
      speak(err);
      buzz([40, 40, 40]); // error pattern
    } finally {
      setWorking(false);
    }
  }

  function isTextFieldFocused(): boolean {
    const a = document.activeElement as HTMLElement | null;
    if (!a) return false;
    if (a.tagName === "TEXTAREA") return true;
    if (a.tagName === "INPUT") {
      const type = (a as HTMLInputElement).type;
      return ["text", "search", "email", "tel", "url", ""].includes(type);
    }
    return false;
  }

  function handleTap() {
    if (listening) {
      recog.current?.stop();
      setListening(false);
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const mode: "dictate" | "command" = isTextFieldFocused() ? "dictate" : "command";
    modeRef.current = mode;
    const r = new SR();
    r.continuous = false;
    r.interimResults = false;
    r.lang = lang === "es" ? "es-US" : "en-US";
    r.onresult = (e: any) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
      text = text.trim();
      if (modeRef.current === "dictate") insert(text + " ");
      else if (text) handleCommand(text);
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    r.start();
    recog.current = r;
    setListening(true);
    if (mode === "command") setStatus("Listening for a command…");
  }

  if (!supported) return null;

  const commandMode = !listening || modeRef.current === "command";
  const icon = working ? (
    <Loader2 className="h-5 w-5 animate-spin" />
  ) : listening ? (
    <MicOff className="h-5 w-5" />
  ) : commandMode ? (
    <Sparkles className="h-5 w-5" />
  ) : (
    <Mic className="h-5 w-5" />
  );

  // The spoken-confirm card: shows the read-back + Yes/Cancel (a tap fallback to the
  // spoken "yes"/"no"). Fixed to the viewport, so it works in both placements.
  const confirmOverlay = pendingConfirm ? (
    <div className="fixed left-1/2 top-[4.5rem] z-[97] w-[290px] -translate-x-1/2 rounded-2xl bg-slate-900/95 p-3 text-white shadow-xl">
      <div className="mb-2 text-center text-sm">{confirmMsg}</div>
      <div className="flex gap-2">
        <button onClick={() => resolveConfirm(true)} className="flex-1 rounded-lg bg-green-600 py-2.5 text-sm font-semibold hover:bg-green-500">Yes</button>
        <button onClick={() => resolveConfirm(false)} className="flex-1 rounded-lg bg-slate-700 py-2.5 text-sm font-semibold hover:bg-slate-600">Cancel</button>
      </div>
    </div>
  ) : null;

  // Top-bar variant: a fixed, bigger "Assistant" voice-star button (no drag).
  if (placement === "topbar") {
    return (
      <>
        {confirmOverlay}
        {status && !pendingConfirm && (
          <div className="fixed left-1/2 top-[4.5rem] z-[95] max-w-[260px] -translate-x-1/2 rounded-xl bg-slate-900/90 px-3 py-2 text-center text-xs font-medium text-white shadow-lg">
            {status}
          </div>
        )}
        <button
          onClick={handleTap}
          title="Tap to give a voice command, or dictate into a focused field"
          aria-label="Assistant voice command"
          className={`btn-gloss inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-white shadow-sm transition-colors ${
            working ? "bg-brand" : listening ? "animate-pulse bg-red-600" : "bg-brand hover:bg-brand-dark"
          }`}
        >
          {icon}
          <span className="hidden text-sm font-medium sm:inline">{listening ? "Listening…" : "Assistant"}</span>
        </button>
      </>
    );
  }

  return (
    <>
      {confirmOverlay}
      {status && !pendingConfirm && (
        <div
          style={{ right: pos.x, bottom: pos.y + 60 }}
          className="fixed z-40 max-w-[240px] rounded-xl bg-slate-900/90 px-3 py-2 text-xs font-medium text-white shadow-lg"
        >
          {status}
        </div>
      )}
      <button
        onPointerDown={(e) => {
          drag.current = { sx: e.clientX, sy: e.clientY, bx: pos.x, by: pos.y, moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.sx;
          const dy = e.clientY - drag.current.sy;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.current.moved = true;
          setPos({ x: Math.max(8, drag.current.bx - dx), y: Math.max(8, drag.current.by - dy) });
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) handleTap();
          else if (d) {
            try {
              localStorage.setItem("cn_voice_pos", JSON.stringify(pos));
            } catch {}
          }
        }}
        style={{ right: pos.x, bottom: pos.y }}
        title="Tap to give a voice command (or dictate into a focused field); drag to move"
        className={`fixed z-40 flex h-12 w-12 touch-none items-center justify-center rounded-full text-white shadow-lg ${
          working ? "bg-brand" : listening ? "animate-pulse bg-red-600" : "bg-brand hover:bg-brand-dark"
        }`}
      >
        {working ? <Loader2 className="h-5 w-5 animate-spin" /> : listening ? <MicOff className="h-5 w-5" /> : commandMode ? <Sparkles className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </button>
    </>
  );
}
