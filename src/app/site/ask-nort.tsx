"use client";

import { useEffect, useRef, useState } from "react";
import { MessageCircle, X, Send, Loader2 } from "lucide-react";

type Msg = { role: "user" | "assistant"; content: string };

/** Floating public "Ask Nort" chat on an org's marketing site. Talks to the hardened, read-only
 *  /api/site-chat endpoint (scoped to this org's handle) — preliminary estimates + Q&A + it quietly
 *  captures the conversation as a lead when the visitor shares contact info. */
export function AskNort({ handle, orgName, brand }: { handle: string; orgName: string; brand: string }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "assistant", content: `Hi! I'm Nort, ${orgName}'s estimate assistant. Tell me about your project and I'll give you a quick ballpark — or ask me anything.` },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy, open]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const next = [...msgs, { role: "user" as const, content: text }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/site-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, messages: next.slice(-24) }),
      });
      const data = await res.json().catch(() => ({}));
      setMsgs((m) => [...m, { role: "assistant", content: data?.reply || data?.error || "Sorry — please try again, or use the contact form below." }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "Connection hiccup — please try again or use the form below." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Launcher */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full text-white shadow-lg transition hover:scale-105"
        style={{ backgroundColor: brand }}
        aria-label={open ? "Close chat" : "Ask for an estimate"}
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
      </button>

      {open && (
        <div className="fixed bottom-24 right-5 z-50 flex h-[70vh] max-h-[560px] w-[92vw] max-w-[380px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ backgroundColor: brand }}>
            <MessageCircle className="h-5 w-5" />
            <div className="text-sm font-semibold">Ask {orgName}</div>
            <span className="ml-auto text-xs text-white/80">Instant estimate</span>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-3">
            {msgs.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.role === "user" ? "text-white" : "border border-slate-200 bg-white text-slate-700"}`}
                  style={m.role === "user" ? { backgroundColor: brand } : undefined}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); send(); }}
            className="flex items-center gap-2 border-t border-slate-200 bg-white p-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe your project…"
              maxLength={4000}
              className="flex-1 rounded-full border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2"
              style={{ ["--tw-ring-color" as string]: brand } as React.CSSProperties}
            />
            <button type="submit" disabled={busy || !input.trim()} className="flex h-9 w-9 items-center justify-center rounded-full text-white disabled:opacity-40" style={{ backgroundColor: brand }} aria-label="Send">
              <Send className="h-4 w-4" />
            </button>
          </form>
          <p className="pb-2 text-center text-[10px] text-slate-400">Preliminary estimates · powered by Contractor North</p>
        </div>
      )}
    </>
  );
}
