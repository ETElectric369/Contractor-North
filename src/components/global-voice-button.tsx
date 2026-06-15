"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, MicOff, Loader2, Sparkles } from "lucide-react";
import { runVoiceCommand } from "@/app/(app)/voice/actions";

/**
 * Floating mic with two modes:
 *  • Dictate — if a text field is focused, speech is typed into it.
 *  • Command — otherwise, speech is sent to the AI to act on ("add a task to
 *    call the inspector", "open the scheduler", "new appointment tomorrow at 9").
 * Drag to reposition. Uses the Web Speech API.
 */
export function GlobalVoiceButton({ lang }: { lang?: string }) {
  const router = useRouter();
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: 20, y: 104 }); // clears the floating glass bottom nav (+ safe area)
  const modeRef = useRef<"dictate" | "command">("command");
  const lastField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const recog = useRef<any>(null);
  const drag = useRef<{ sx: number; sy: number; bx: number; by: number; moved: boolean } | null>(null);

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
      flash(res.message);
      if (res.navigate) router.push(res.navigate);
      router.refresh();
    } catch {
      flash("Sorry — that didn't work.");
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

  return (
    <>
      {status && (
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
