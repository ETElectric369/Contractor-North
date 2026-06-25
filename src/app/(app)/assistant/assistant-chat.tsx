"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, Loader2, Mic, MicOff, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { speakSmart, unlockAudio } from "@/lib/tts";
import { CONFIRM_MARKER, OPEN_MARKER, type AgentConfirm, type AgentOpen } from "@/lib/assistant-protocol";
import { confirmAgentAction } from "./actions";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "Start a quote — I'll tell you what's on it.",
  "What's on the schedule this week?",
  "Which invoices are still unpaid?",
  "Show me my open quotes and their totals.",
];

export function AssistantChat({ autoStart = false }: { autoStart?: boolean } = {}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false); // is the mic available
  const scrollRef = useRef<HTMLDivElement>(null);
  const recogRef = useRef<any>(null);
  // True while we're in a spoken back-and-forth: each reply is read aloud and the mic
  // re-opens for the next turn. Tapping the mic off, or typing, leaves voice mode.
  const voiceModeRef = useRef(false);
  // A confirm-gated action the agent proposed; nothing runs until the user says yes (card
  // tap or a spoken "yes"). The ref mirrors it so the voice yes/no closure reads it fresh.
  const [pendingConfirm, setPendingConfirm] = useState<AgentConfirm | null>(null);
  const confirmRef = useRef<AgentConfirm | null>(null);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setVoiceOn(Boolean(SR));
  }, []);

  // Voice-first: when the assistant is opened by the mic launcher, start listening right
  // away (it already unlocked audio in the tap), so it's tap → talk, not tap → tap-mic.
  useEffect(() => {
    if (!autoStart) return;
    voiceModeRef.current = true;
    startMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  function scrollToBottom() {
    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }),
    );
  }

  async function send(text: string, viaVoice = false) {
    const content = text.trim();
    if (!content || streaming) return;
    if (!viaVoice) voiceModeRef.current = false; // typing leaves voice mode

    const next: Msg[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setStreaming(true);
    scrollToBottom();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "Request failed.");
        setMessages((m) => [...m, { role: "assistant", content: errText }]);
        setStreaming(false);
        return;
      }

      // Append an empty assistant message we fill as chunks arrive.
      setMessages((m) => [...m, { role: "assistant", content: "" }]);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let full = ""; // the whole reply, which may END with a CONFIRM proposal
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        const visible = full.split(CONFIRM_MARKER)[0].split(OPEN_MARKER)[0]; // never show a marker/payload
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: visible };
          return copy;
        });
        scrollToBottom();
      }

      // Directive markers (confirm / open-maps) come at the very end of the stream.
      const visibleText = full.split(CONFIRM_MARKER)[0].split(OPEN_MARKER)[0];
      let proposal: AgentConfirm | null = null;
      if (full.includes(CONFIRM_MARKER)) {
        try { proposal = JSON.parse(full.split(CONFIRM_MARKER)[1]); } catch {}
      }
      let openDir: AgentOpen | null = null;
      if (full.includes(OPEN_MARKER)) {
        try { openDir = JSON.parse(full.split(OPEN_MARKER)[1]); } catch {}
      }

      if (openDir?.url) {
        // Hands-free navigation: say it, then open Maps (keep the app if the browser lets us).
        if (viaVoice) speakSmart(`Opening maps for ${openDir.label}.`, () => { if (voiceModeRef.current) startMic(); });
        try {
          const w = window.open(openDir.url, "_blank");
          if (!w) window.location.href = openDir.url;
        } catch {
          window.location.href = openDir.url;
        }
      } else if (proposal) {
        confirmRef.current = proposal;
        setPendingConfirm(proposal);
        if (!visibleText.trim()) {
          setMessages((m) => {
            const c = [...m];
            c[c.length - 1] = { role: "assistant", content: proposal!.prompt };
            return c;
          });
        }
        // Voice: read the proposal and listen for yes/no. Card shows either way.
        if (viaVoice) speakSmart(proposal.prompt, () => { if (voiceModeRef.current) confirmListen(); });
      } else if (viaVoice) {
        // No directive — read the whole reply aloud, then re-open the mic for the next turn.
        const clean = visibleText.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
        if (clean) speakSmart(clean, () => { if (voiceModeRef.current) startMic(); });
      }
    } catch (e: any) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `Error: ${e?.message ?? "unknown"}` },
      ]);
    } finally {
      setStreaming(false);
      scrollToBottom();
    }
  }

  // Open the recognizer; the final transcript is sent as a spoken turn.
  function startMic() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    try {
      const r = new SR();
      r.continuous = false;
      r.interimResults = false;
      r.lang = "en-US";
      r.onresult = (e: any) => {
        let text = "";
        for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
        text = text.trim();
        if (text) send(text, true);
      };
      r.onerror = () => setListening(false);
      r.onend = () => setListening(false);
      r.start();
      recogRef.current = r;
      setListening(true);
    } catch {
      setListening(false);
    }
  }

  function toggleMic() {
    if (listening) {
      voiceModeRef.current = false; // tapping off ends the spoken conversation
      try { recogRef.current?.stop(); } catch {}
      setListening(false);
      return;
    }
    // Prime iOS audio INSIDE this tap so the reply can be spoken after the round-trip.
    try {
      const synth = window.speechSynthesis;
      if (synth) { const w = new SpeechSynthesisUtterance(" "); w.volume = 0; synth.speak(w); }
    } catch {}
    unlockAudio();
    voiceModeRef.current = true;
    if (confirmRef.current) confirmListen(); // a proposal is waiting → hear yes/no
    else startMic();
  }

  // Listen for a spoken yes/no on a pending confirm proposal.
  function confirmListen() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    try {
      const r = new SR();
      r.continuous = false;
      r.interimResults = false;
      r.lang = "en-US";
      r.onresult = (e: any) => {
        let t = "";
        for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
        t = t.trim().toLowerCase();
        // Fail safe: an explicit no/cancel wins (checked first).
        if (/\b(no|nope|cancel|stop|never ?mind|don'?t|do not|wrong|negative)\b/.test(t)) resolveConfirm(false);
        else if (/\b(yes|yeah|yep|yup|confirm|do it|go ahead|sure|okay|ok|save it|sounds good)\b/.test(t)) resolveConfirm(true);
        else speakSmart("Say yes or no.", () => { if (voiceModeRef.current && confirmRef.current) confirmListen(); });
      };
      r.onerror = () => setListening(false);
      r.onend = () => setListening(false);
      r.start();
      recogRef.current = r;
      setListening(true);
    } catch {
      setListening(false);
    }
  }

  // Resolve a pending confirm: run it (yes) or drop it (no). Nothing wrote until here.
  async function resolveConfirm(yes: boolean) {
    const c = confirmRef.current;
    confirmRef.current = null;
    setPendingConfirm(null);
    try { recogRef.current?.stop(); } catch {}
    setListening(false);
    if (!c) return;
    if (!yes) {
      setMessages((m) => [...m, { role: "assistant", content: "Okay — skipped that." }]);
      if (voiceModeRef.current) speakSmart("Okay, skipped that.", () => { if (voiceModeRef.current) startMic(); });
      return;
    }
    setStreaming(true);
    try {
      const res = await confirmAgentAction(c.name, c.input);
      const msg = res.message || (res.ok ? "Done." : "That didn't work.");
      setMessages((m) => [...m, { role: "assistant", content: (res.ok ? "✓ " : "") + msg }]);
      if (voiceModeRef.current) speakSmart(msg, () => { if (voiceModeRef.current) startMic(); });
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "That didn't work." }]);
    } finally {
      setStreaming(false);
      scrollToBottom();
    }
  }

  // When opened with ?q= (e.g. "Ask the assistant" from the command bar),
  // auto-send that query once, then strip the param so a refresh won't resend.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    const q = new URLSearchParams(window.location.search).get("q");
    if (q && q.trim()) {
      send(q.trim());
      window.history.replaceState(null, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-light">
              <Sparkles className="h-6 w-6 text-brand" />
            </div>
            <h3 className="text-sm font-semibold text-slate-900">
              How can I help?
            </h3>
            <p className="mt-1 max-w-sm text-sm text-slate-500">
              I can pull up your jobs, quotes, invoices, schedule, and who&apos;s
              clocked in, draft quotes &amp; take-offs, and help with scopes and code.
              {voiceOn && " Tap the mic and just talk — I'll read replies back."}
            </p>
            <div className="mt-5 grid w-full max-w-lg gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-left text-xs text-slate-600 hover:border-brand hover:bg-brand-light/40"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
            >
              <div
                className={
                  m.role === "user"
                    ? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand px-4 py-2.5 text-sm text-white"
                    : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-2.5 text-sm text-slate-800"
                }
              >
                {m.content || (
                  <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {pendingConfirm && (
        <div className="border-t border-amber-200 bg-amber-50 p-3">
          <div className="mb-1.5 text-sm font-medium text-amber-900">{pendingConfirm.prompt}</div>
          {/* Show EVERY field that will be written, so what you approve == what runs. */}
          <ul className="mb-2 space-y-0.5 text-xs text-amber-800">
            {Object.entries(pendingConfirm.input)
              .filter(([k, v]) => v != null && v !== "" && !["status", "bill_number", "lunch_minutes"].includes(k))
              .map(([k, v]) => (
                <li key={k}>
                  <span className="font-medium capitalize">{k.replace(/_/g, " ")}:</span>{" "}
                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </li>
              ))}
          </ul>
          <div className="flex gap-2">
            <Button onClick={() => resolveConfirm(true)} className="flex-1 bg-green-600 hover:bg-green-500">
              <Check className="h-4 w-4" /> Yes, do it
            </Button>
            <Button variant="outline" onClick={() => resolveConfirm(false)} className="flex-1">
              Cancel
            </Button>
          </div>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-slate-100 p-3"
      >
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder="Ask the assistant…  (Enter to send, Shift+Enter for newline)"
            className="max-h-40 min-h-[44px] flex-1 resize-none"
          />
          {voiceOn && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={toggleMic}
              disabled={streaming}
              aria-label={listening ? "Stop listening" : "Talk to the assistant"}
              title={listening ? "Listening… tap to stop" : "Tap and talk"}
              className={listening ? "animate-pulse text-red-600" : "text-slate-500"}
            >
              {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
          )}
          <Button type="submit" size="icon" disabled={streaming || !input.trim() || !!pendingConfirm}>
            {streaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
