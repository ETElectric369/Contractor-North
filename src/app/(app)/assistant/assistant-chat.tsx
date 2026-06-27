"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Sparkles, Loader2, Mic, Check, Square, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { speakSmart, unlockAudio, stopSpeaking } from "@/lib/tts";
import {
  CONFIRM_MARKER, OPEN_MARKER, DRAFT_OPEN, DRAFT_CLOSE,
  type AgentConfirm, type AgentOpen, type AgentDraft,
} from "@/lib/assistant-protocol";
import { confirmAgentAction, saveQuoteFromDraft, loadConversation, saveConversation, clearConversation } from "./actions";

const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

/** Pull the visible text + the latest live quote draft out of the raw stream so far. */
function parseStream(full: string): { text: string; draft: AgentDraft | null } {
  let draft: AgentDraft | null = null;
  const re = new RegExp(DRAFT_OPEN + "([\\s\\S]*?)" + DRAFT_CLOSE, "g");
  const blocks = [...full.matchAll(re)];
  if (blocks.length) {
    try { draft = JSON.parse(blocks[blocks.length - 1][1]); } catch {}
  }
  let text = full.replace(re, "");
  // Drop a half-arrived draft block at the tail so its JSON never flashes on screen.
  const partial = text.indexOf(DRAFT_OPEN);
  if (partial >= 0) text = text.slice(0, partial);
  text = text.split(CONFIRM_MARKER)[0].split(OPEN_MARKER)[0];
  return { text, draft };
}

/** The Estimator — the live estimate building in front of you (the assistant's preview box). */
function LiveQuote({ draft, onSave, saving }: { draft: AgentDraft; onSave: () => void; saving: boolean }) {
  // Defensive: a streaming/partial draft can briefly arrive with items as a non-array or with
  // a null entry — never let that crash the Estimator render (it would blank the whole page).
  const items = (Array.isArray(draft.items) ? draft.items : []).filter((i) => i && typeof i === "object");
  const subtotal = items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0);
  const tax = subtotal * (Number(draft.tax_rate) || 0);
  const total = subtotal + tax;
  const ready = draft.status === "ready";
  return (
    <div className="mx-2 mb-2 overflow-hidden rounded-xl border border-white/40 bg-white/70 shadow-sm backdrop-blur">
      <div className="flex items-center gap-2 border-b border-slate-200/70 px-3 py-2 text-xs font-semibold text-slate-700">
        <FileText className="h-3.5 w-3.5 text-brand" />
        <span className="text-[10px] font-bold uppercase tracking-wide text-brand">Estimator</span>
        <span className="min-w-0 truncate font-normal text-slate-500">· {draft.title || "New estimate"}</span>
        {draft.customer_name ? <span className="truncate font-normal text-slate-400">· {draft.customer_name}</span> : null}
      </div>
      <ul className="max-h-40 divide-y divide-slate-100 overflow-y-auto px-3 text-xs">
        {items.length === 0 ? (
          <li className="py-2 text-slate-400">Building…</li>
        ) : (
          items.map((it, i) => (
            <li key={i} className="flex items-baseline justify-between gap-2 py-1.5">
              <span className="min-w-0 truncate text-slate-700">
                {it.description}
                <span className="text-slate-400"> · {Number(it.quantity) || 1} {it.unit || "ea"} × {money(Number(it.unit_price) || 0)}</span>
              </span>
              <span className="shrink-0 font-medium text-slate-800">{money((Number(it.quantity) || 0) * (Number(it.unit_price) || 0))}</span>
            </li>
          ))
        )}
      </ul>
      <div className="space-y-0.5 border-t border-slate-200/70 px-3 py-2 text-xs">
        <div className="flex justify-between text-slate-500"><span>Subtotal</span><span>{money(subtotal)}</span></div>
        {draft.tax_rate ? <div className="flex justify-between text-slate-500"><span>Tax</span><span>{money(tax)}</span></div> : null}
        <div className="flex justify-between text-sm font-semibold text-slate-900"><span>Total</span><span>{money(total)}</span></div>
      </div>
      <div className="p-2">
        <Button onClick={onSave} disabled={saving || items.length === 0} className={`w-full ${ready ? "bg-green-600 hover:bg-green-500" : ""}`}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : ready ? "Save estimate →" : "Save draft →"}
        </Button>
      </div>
    </div>
  );
}

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "Start an estimate — I'll tell you what's on it.",
  "What's on the schedule this week?",
  "Which invoices are still unpaid?",
  "Show me my open estimates and their totals.",
];

/** The chat-style "voice mode" waveform — bars that bounce while it's live. */
function VoiceWave({ active }: { active?: boolean }) {
  return (
    <div className="flex h-10 items-center justify-center gap-1.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="w-1.5 rounded-full bg-brand"
          style={{
            height: active ? undefined : 10,
            animation: active ? `cnwave 0.9s ease-in-out ${i * 0.12}s infinite` : "none",
          }}
        />
      ))}
      <style>{`@keyframes cnwave{0%,100%{height:10px}50%{height:34px}}`}</style>
    </div>
  );
}

export function AssistantChat({ autoStart = false, glass = false }: { autoStart?: boolean; glass?: boolean } = {}) {
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
  const [voiceMode, setVoiceModeState] = useState(false); // in a spoken conversation (drives the UI)
  const [speaking, setSpeaking] = useState(false); // Claude's reply is currently playing
  const [draft, setDraft] = useState<AgentDraft | null>(null); // the live quote being built
  const [savingDraft, setSavingDraft] = useState(false);
  const router = useRouter();

  // Finalize the live draft → real quote, then flip to the actual quote page (filled out).
  async function saveDraft() {
    if (!draft) return;
    setSavingDraft(true);
    try {
      const res = await saveQuoteFromDraft(draft);
      if (res.ok && res.id) {
        setDraft(null);
        stopVoice();
        router.push(`/quotes/${res.id}`);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: res.error ? `Couldn't save: ${res.error}` : "Couldn't save the quote." }]);
      }
    } finally {
      setSavingDraft(false);
    }
  }

  // Enter/leave voice mode — keep the ref (read by the async re-listen closures) and the UI
  // state in lockstep.
  function setVoiceMode(on: boolean) {
    voiceModeRef.current = on;
    setVoiceModeState(on);
  }

  // Speak a reply, tracking the speaking state, then run `after` (usually re-open the mic).
  function say(text: string, after?: () => void) {
    setSpeaking(true);
    speakSmart(text, () => {
      setSpeaking(false);
      after?.();
    });
  }

  // The big mic button in voice mode: cut off any speech, end a listening turn, or start one.
  function voiceTap() {
    if (listening) {
      try { recogRef.current?.stop(); } catch {}
      return;
    }
    stopSpeaking();
    setSpeaking(false);
    startMic();
  }

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setVoiceOn(Boolean(SR));
  }, []);

  // Voice-first: when the assistant is opened by the mic launcher, start listening right
  // away (it already unlocked audio in the tap), so it's tap → talk, not tap → tap-mic.
  useEffect(() => {
    if (!autoStart) return;
    setVoiceMode(true);
    startMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  // MEMORY: restore the saved conversation + draft on open (pick up where you left off).
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadConversation()
      .then(({ messages: m, draft: d }) => {
        if (m && m.length) setMessages(m as Msg[]);
        if (d) setDraft(d);
      })
      .catch(() => {});
  }, []);

  // ...and auto-persist (debounced) so nothing is ever lost.
  useEffect(() => {
    if (messages.length === 0 && !draft) return;
    const t = setTimeout(() => { saveConversation(messages, draft).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [messages, draft]);

  function newChat() {
    stopVoice();
    setMessages([]);
    setDraft(null);
    setInput("");
    clearConversation().catch(() => {});
  }

  // Stop the whole voice conversation at any time (like chat): stop listening, cut off any
  // speech mid-sentence, and leave voice mode.
  function stopVoice() {
    setVoiceMode(false);
    try { recogRef.current?.stop(); } catch {}
    stopSpeaking();
    setListening(false);
  }

  function scrollToBottom() {
    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }),
    );
  }

  async function send(text: string, viaVoice = false) {
    const content = text.trim();
    if (!content || streaming) return;
    if (!viaVoice) setVoiceMode(false); // typing leaves voice mode

    const next: Msg[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setStreaming(true);
    scrollToBottom();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, voice: viaVoice }),
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
        const { text: visible, draft: liveDraft } = parseStream(full);
        if (liveDraft) setDraft(liveDraft); // the quote fills in live as blocks arrive
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: visible };
          return copy;
        });
        scrollToBottom();
      }

      // Directive markers (confirm / open-maps) come at the very end of the stream.
      const visibleText = parseStream(full).text;
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
        if (viaVoice) say(`Opening maps for ${openDir.label}.`, () => { if (voiceModeRef.current) startMic(); });
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
        if (viaVoice) say(proposal.prompt, () => { if (voiceModeRef.current) confirmListen(); });
      } else if (viaVoice) {
        // No directive — read the whole reply aloud, then re-open the mic for the next turn.
        const clean = visibleText.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
        if (clean) say(clean, () => { if (voiceModeRef.current) startMic(); });
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

  // Enter voice mode from the text composer's Talk button. (Leaving is the Stop button →
  // stopVoice.)
  function startVoice() {
    if (voiceModeRef.current) { stopVoice(); return; }
    // Prime iOS audio INSIDE this tap so the reply can be spoken after the round-trip.
    try {
      const synth = window.speechSynthesis;
      if (synth) { const w = new SpeechSynthesisUtterance(" "); w.volume = 0; synth.speak(w); }
    } catch {}
    unlockAudio();
    setVoiceMode(true);
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
        else say("Say yes or no.", () => { if (voiceModeRef.current && confirmRef.current) confirmListen(); });
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
      if (voiceModeRef.current) say("Okay, skipped that.", () => { if (voiceModeRef.current) startMic(); });
      return;
    }
    setStreaming(true);
    try {
      const res = await confirmAgentAction(c.name, c.input);
      const msg = res.message || (res.ok ? "Done." : "That didn't work.");
      setMessages((m) => [...m, { role: "assistant", content: (res.ok ? "✓ " : "") + msg }]);
      if (voiceModeRef.current) say(msg, () => { if (voiceModeRef.current) startMic(); });
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
    <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${glass ? "bg-transparent" : "rounded-xl border border-slate-200 bg-white"}`}>
      {messages.length > 0 && (
        <div className="flex shrink-0 justify-end px-3 pt-1">
          <button onClick={newChat} className="text-xs font-medium text-slate-400 hover:text-brand">+ New chat</button>
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
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

      {draft ? <LiveQuote draft={draft} onSave={saveDraft} saving={savingDraft} /> : null}

      {pendingConfirm ? (
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
      ) : voiceMode ? (
        // Voice mode — chat-style. It listens / thinks / talks; the big mic is "your turn"
        // (auto-reopens on desktop, one tap on iPhone), and End closes the conversation.
        <div className="flex flex-col items-center gap-2 border-t border-slate-100 p-4">
          <VoiceWave active={listening || speaking} />
          <div className="text-sm font-medium text-slate-600">
            {streaming ? "Thinking…" : listening ? "Listening…" : speaking ? "Talking…" : "Your turn — tap the mic"}
          </div>
          <button
            type="button"
            onClick={voiceTap}
            aria-label={listening ? "Stop listening" : "Talk"}
            className={`mt-1 flex h-16 w-16 items-center justify-center rounded-full text-white shadow-lg transition active:scale-95 ${
              listening ? "animate-pulse bg-red-600" : "bg-brand hover:bg-brand-dark"
            }`}
          >
            <Mic className="h-7 w-7" />
          </button>
          <button
            type="button"
            onClick={stopVoice}
            className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-red-600"
          >
            <Square className="h-3 w-3" fill="currentColor" /> End conversation
          </button>
        </div>
      ) : (
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
              placeholder="Ask, or tap Talk to speak…"
              className="max-h-40 min-h-[44px] flex-1 resize-none"
            />
            {voiceOn && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={startVoice}
                disabled={streaming}
                aria-label="Talk to the assistant"
                title="Tap and talk"
                className="text-brand"
              >
                <Mic className="h-4 w-4" />
              </Button>
            )}
            <Button type="submit" size="icon" disabled={streaming || !input.trim()}>
              {streaming ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
