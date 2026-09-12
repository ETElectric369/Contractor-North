"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Sparkles, Loader2, Mic, Check, Square, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { speakSmart, unlockAudio, stopSpeaking, splitSentences, SpeakQueue, startBargeInMonitor } from "@/lib/tts";
import { classifyConfirmReply } from "@/lib/confirm-parse";
import { subtotalTaxTotal } from "@/lib/invoice-math";
import * as speech from "@/lib/voice";
import {
  CONFIRM_MARKER, OPEN_MARKER, PICK_MARKER, STATUS_OPEN, STATUS_CLOSE, DRAFT_OPEN, DRAFT_CLOSE, HUD_OPEN, HUD_CLOSE,
  type AgentConfirm, type AgentOpen, type AgentPick, type AgentDraft, type AgentHudCard,
} from "@/lib/assistant-protocol";
import { confirmAgentAction, saveQuoteFromDraft, loadConversation, saveConversation, clearConversation, recoverTurn, type PickerContact } from "./actions";
import { ContactPicker } from "./contact-picker";
import { DriverCard } from "@/components/driver-card";
import { estimatorStore } from "@/lib/estimator-store";

const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

/** Pull the visible text + the latest live quote draft + the transient tool-status out of the raw
 *  stream so far. */
function parseStream(full: string): { text: string; draft: AgentDraft | null; card: AgentHudCard | null; status: string | null } {
  let draft: AgentDraft | null = null;
  const dre = new RegExp(DRAFT_OPEN + "([\\s\\S]*?)" + DRAFT_CLOSE, "g");
  const blocks = [...full.matchAll(dre)];
  if (blocks.length) {
    try { draft = JSON.parse(blocks[blocks.length - 1][1]); } catch {}
  }
  // The driver HUD card — same extract rule as DRAFT: keep the LAST complete block.
  let card: AgentHudCard | null = null;
  const hre = new RegExp(HUD_OPEN + "([\\s\\S]*?)" + HUD_CLOSE, "g");
  const hblocks = [...full.matchAll(hre)];
  if (hblocks.length) {
    try { card = JSON.parse(hblocks[hblocks.length - 1][1]); } catch {}
  }
  // Transient tool-status ("Searching…"): show ONLY when it's the most recent thing in the stream
  // (nothing meaningful streamed after it yet), so it appears during the silent tool call and clears
  // the moment the agent's reply resumes.
  let status: string | null = null;
  const lastClose = full.lastIndexOf(STATUS_CLOSE);
  if (lastClose >= 0) {
    const after = full.slice(lastClose + STATUS_CLOSE.length).replace(dre, "").replace(hre, "").trim();
    if (!after) {
      const sb = [...full.matchAll(new RegExp(STATUS_OPEN + "([\\s\\S]*?)" + STATUS_CLOSE, "g"))];
      try { status = JSON.parse(sb[sb.length - 1][1]).label ?? null; } catch {}
    }
  }
  let text = full.replace(dre, "").replace(hre, "").replace(new RegExp(STATUS_OPEN + "([\\s\\S]*?)" + STATUS_CLOSE, "g"), "");
  // Drop a half-arrived draft/card/status block at the tail so raw JSON never flashes on screen.
  for (const m of [DRAFT_OPEN, HUD_OPEN, STATUS_OPEN]) {
    const p = text.indexOf(m);
    if (p >= 0) text = text.slice(0, p);
  }
  text = text.split(CONFIRM_MARKER)[0].split(OPEN_MARKER)[0].split(PICK_MARKER)[0];
  return { text, draft, card, status };
}

/** The Estimator — the live estimate building in front of you (the assistant's preview box). */
function LiveQuote({ draft, onSave, onDismiss, saving }: { draft: AgentDraft; onSave: () => void; onDismiss: () => void; saving: boolean }) {
  // Defensive: a streaming/partial draft can briefly arrive with items as a non-array or with
  // a null entry — never let that crash the Estimator render (it would blank the whole page).
  const items = (Array.isArray(draft.items) ? draft.items : []).filter((i) => i && typeof i === "object");
  // Totals via the shared subtotalTaxTotal (pure, client-safe) — the SAME rounding the
  // save path uses, so the preview matches the saved quote to the cent.
  const { subtotal, tax, total } = subtotalTaxTotal(
    items.map((i) => (Number(i.quantity) || 0) * (Number(i.unit_price) || 0)),
    Number(draft.tax_rate) || 0,
  );
  const ready = draft.status === "ready";
  return (
    <div className="mx-2 mb-2 overflow-hidden rounded-xl border border-white/40 bg-white/70 shadow-sm backdrop-blur">
      <div className="flex items-center gap-2 border-b border-slate-200/70 px-3 py-2 text-xs font-semibold text-slate-700">
        <FileText className="h-3.5 w-3.5 text-brand" />
        <span className="text-[10px] font-bold uppercase tracking-wide text-brand">Estimator</span>
        <span className="min-w-0 truncate font-normal text-slate-500">· {draft.title || "New estimate"}</span>
        {draft.customer_name ? <span className="truncate font-normal text-slate-400">· {draft.customer_name}</span> : null}
        {/* Always give the user a way to clear the preview off the screen — an
            already-saved or abandoned estimate should never be stuck here. */}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Clear the estimate preview"
          title="Clear this estimate off the screen"
          className="ml-auto shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700"
        >
          <X className="h-3.5 w-3.5" />
        </button>
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
  /** "reload" — the line names a door: the answer may exist on the server and a reload shows it. */
  hint?: "reload";
}

// ── The turn in flight, kept outside React ─────────────────────────────────────────────────
// Inside the iOS shell a WKWebView that goes to the background loses its socket ("Load failed")
// and a jettisoned WebContent process comes back as a cold page load — while the chat route,
// which never noticed, finishes the turn and persists the reply. This marker is how the screen
// finds that reply again: the question and when it was sent. Written before the fetch; a marker
// that outlives its page is a reload mid-turn. It is forgotten only once the reply is IN HAND
// (streamed to the end, or recovered), the server refused the turn (nothing to recover), the
// user moves on (a new question writes its own; New chat wipes it), or the server's turn is
// provably over with nothing to show. Never on a residual "Reload to check" line — the marker
// is the only thing that makes a reload check, so clearing it there made that door a dead one.
const PENDING_KEY = "cn:nort:pending";
const PENDING_MAX_AGE_MS = 15 * 60_000;
type PendingTurn = { content: string; at: string; voice: boolean };
function readPendingTurn(): PendingTurn | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingTurn>;
    if (!p?.content || !p?.at || Date.now() - Date.parse(p.at) > PENDING_MAX_AGE_MS) {
      localStorage.removeItem(PENDING_KEY);
      return null;
    }
    return { content: p.content, at: p.at, voice: !!p.voice };
  } catch {
    return null;
  }
}
function writePendingTurn(p: PendingTurn | null) {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage can be unavailable (private mode) — recovery then has no marker, nothing else changes */
  }
}
/** Forget the marker — but only if it is still THIS turn's. A newer question may have written its
 *  own while an older turn's catch-up was still out; that one must survive. */
function clearPendingTurn(at: string) {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (raw && (JSON.parse(raw) as Partial<PendingTurn>)?.at === at) localStorage.removeItem(PENDING_KEY);
  } catch {
    /* same as above: no storage, no marker */
  }
}
/** A wait that ends the moment `signal` fires — STOP ends a recovery loop now, not after its sleep. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    if (signal?.aborted) { res(); return; }
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      res();
    }
  });
}
/** The phone says it has no network at all. `onLine === false` is the one reliable direction of
 *  that flag (true only means "some interface is up"), so this never claims to be online. */
function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}
/** How many recovery probes a drop earns. Bytes arrived = the server HAS the turn and is very
 *  likely still finishing it, so the transcript is worth waiting on. Not one byte = the question
 *  most likely never reached the route (the fetch died on the way out); two quick looks cover the
 *  case where it did, and the phone is not held ~19 s staring at "catching up" for nothing. */
const RECOVERY_TRIES_FULL = 8;
const RECOVERY_TRIES_NO_BYTE = 2;
/** Ask the server for the reply it may have finished without us — a few times, because the
 *  route's turn can still be RUNNING (the phone dropped; the server did not) and its transcript
 *  lands only in the route's finally. ~19 s at the full budget; never throws. Returns null the
 *  instant the phone reports itself OFFLINE — every probe would fail the same way, and the caller
 *  has a truer sentence to show than a wait — or the instant `signal` fires (STOP): the caller
 *  checks the signal and says nothing, rather than landing a line the user just refused. */
async function fetchRecoveredReply(content: string, at: string, tries = RECOVERY_TRIES_FULL, signal?: AbortSignal): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    if (signal?.aborted || isOffline()) return null;
    try {
      const r = await recoverTurn(content, at);
      if (r.reply) return r.reply;
    } catch {
      /* the probe itself failed — the next try may not */
    }
    // No sleep after the last miss: the answer is "not there", and waiting on changes nothing.
    if (i < tries - 1) await sleep(i === 0 ? 800 : 3000, signal);
  }
  return null;
}
/** Past this age a marker's turn is provably finished on the server: the chat route's
 *  `maxDuration` is 120 s (its transcript write is inside that), plus the 30 s of clock slack
 *  recoverTurn already allows. One probe then tells the whole truth — the reply is there, or it
 *  never will be — and "Reload to check" would be a door onto nothing. */
const TURN_MAX_MS = 150_000;
/** No bytes for this long mid-reply = the socket is dead but WebKit hasn't said so. Well past the
 *  longest silent tool round (a web search) so a slow answer is never mistaken for a lost one. */
const STREAM_STALL_MS = 90_000;
const DROPPED_SENTENCE = "The connection dropped before Nort's answer arrived — Reload to check for it, or ask again.";
/** Offline is a different fact from "dropped": nothing can be checked right now, and saying so at
 *  once beats a probe that cannot succeed. Reload is still the door — the server keeps the turn. */
const OFFLINE_SENTENCE = "You're offline — Nort may still have answered. Reload when you have bars to check, or ask again.";
/** The reload-time versions. The question text is deliberately not echoed by any of them: the
 *  marker is per-device, the reply lookup is per-user — only a found reply proves the question was
 *  this user's. Offline, the lookup never ran, so "didn't get an answer" would be a guess. */
const RELOAD_OFFLINE_SENTENCE = "You're offline — couldn't check whether your last question got an answer. Reload when you have bars, or ask it again.";
/** Young marker, nothing on the server yet: the route's turn may still be running (a web search
 *  round is silent for a while), so Reload stays a live door. */
const RELOAD_PENDING_SENTENCE = "No answer to your last question yet — Nort may still be working on it. Reload in a moment to check, or ask it again.";
/** The server's turn is over and there is nothing: the only honest door left is asking again. */
const RELOAD_UNANSWERED_SENTENCE = "Your last question didn't get an answer before the app reloaded — ask it again.";
/** Every residual line the recovery paths can leave. A restored transcript loses the `hint`
 *  (saveConversation keeps role + content only), so content is how a residual line is recognised
 *  again after a reload — it is REPLACED by the next attempt's line, never stacked under it. */
const RESIDUAL_SENTENCES = new Set([DROPPED_SENTENCE, OFFLINE_SENTENCE, RELOAD_OFFLINE_SENTENCE, RELOAD_PENDING_SENTENCE, RELOAD_UNANSWERED_SENTENCE]);
function dropResidualTail(list: Msg[]): Msg[] {
  const last = list[list.length - 1];
  return last?.role === "assistant" && RESIDUAL_SENTENCES.has(last.content.trim()) ? list.slice(0, -1) : list;
}
/** One residual line at the tail — replacing the previous attempt's, so a second reload never
 *  reads as a second failure. */
function withResidual(list: Msg[], line: Msg): Msg[] {
  return [...dropResidualTail(list), line];
}

const SUGGESTIONS = [
  "Start an estimate — I'll tell you what's on it.",
  "What's on the schedule this week?",
  "Which invoices are still unpaid?",
  "Show me my open estimates and their totals.",
];

/** The door a dropped-connection line names: the shell has no address bar and no pull-to-refresh,
 *  so "Reload" has to be a thing you can tap. */
function ReloadDoor() {
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="ml-1.5 inline-flex items-center rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-brand hover:bg-brand-light/40"
    >
      Reload
    </button>
  );
}

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

export function AssistantChat({ autoStart = false, glass = false, initialQuery }: { autoStart?: boolean; glass?: boolean; initialQuery?: string } = {}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null); // transient "Searching…" tool-status
  // audit v921: the autosave used to swallow every failure under a promise that "nothing is ever
  // lost" — an expired session ate the estimate draft the restore path exists for, silently.
  const [saveFailed, setSaveFailed] = useState(false);
  const [pendingPick, setPendingPick] = useState<AgentPick | null>(null); // on-screen contact picker
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false); // is the mic available
  const scrollRef = useRef<HTMLDivElement>(null);
  // The voice backend (voice-stream: record-a-turn → POST /api/transcribe → transcript) holds the live
  // MediaStream at module level; we just hand it the latest `send` via a ref, so the module-level
  // result handler never goes stale on `messages`.
  const sendRef = useRef<((t: string, viaVoice?: boolean) => void) | null>(null);
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
  const [card, setCard] = useState<AgentHudCard | null>(null); // the driver HUD card filling the glass
  const [savingDraft, setSavingDraft] = useState(false);
  // Estimates saved THIS session — each collapses the live numbers into a clickable line that
  // links to the quote (the permanent log in /quotes).
  const [saved, setSaved] = useState<{ id: string; title: string; total: number; customer?: string }[]>([]);

  // Publish the live estimate + speaking state to the shared store so the COMPACTED Estimator
  // (total + stop) can live on the topbar Talk button even when this drawer is closed.
  useEffect(() => { estimatorStore.setDraft(draft); }, [draft]);
  useEffect(() => { estimatorStore.setCard(card); }, [card]);
  useEffect(() => { estimatorStore.setSpeaking(speaking); }, [speaking]);
  useEffect(() => { estimatorStore.setStreaming(streaming); }, [streaming]);
  // Publish listening too, so the topbar button can show a real red STOP whenever the mic is hot
  // (not just while thinking/talking) — it's the only voice control now.
  useEffect(() => { estimatorStore.setListening(listening); }, [listening]);
  // Tear the voice session down on unmount (close), so a live recognizer + any in-flight speech
  // (streaming queue / barge-in monitor) never outlive the panel.
  useEffect(() => () => {
    speech.stopListening({ discard: true }); // the panel is gone — a half-recorded turn goes nowhere
    speech.setResultHandler(null);
    try { bargeStopRef.current?.(); } catch {}
    try { speakQueueRef.current?.stop(); } catch {}
    stopSpeaking();
    estimatorStore.setListening(false);
    estimatorStore.setSpeaking(false);
    estimatorStore.setStreaming(false);
  }, []);
  // The topbar STOP (and Close / Collapse, which dispatch this) fully ends the turn: abort the
  // in-flight stream, cut TTS, AND stop the mic + leave voice mode — so "stop" deterministically
  // means stop (no orphaned recognizer, no auto-re-listen loop left armed).
  const abortRef = useRef<AbortController | null>(null);
  // The turn in flight, read synchronously. `streaming` is render-time state: two transcripts
  // landing in one tick (a re-armed mic racing a late transcription) both saw it false and both
  // sent — the second one a repeat of the first. A ref answers before React re-renders.
  const inFlightRef = useRef(false);
  // The reload-time catch-up in flight (see catchUp). STOP / Close / a new question abort it, so
  // it can never land its line after the screen has moved on.
  const catchUpAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const stop = () => {
      // abortRef points at the live fetch — or, during a drop-recovery loop, at that loop's own
      // controller (the fetch's is already spent by then). Either way STOP reaches what is running.
      try { abortRef.current?.abort(); } catch {}
      try { catchUpAbortRef.current?.abort(); } catch {}
      catchUpAbortRef.current = null;
      // Free the screen NOW, not when the stopped probe returns: a question typed in that gap hit
      // `inFlightRef` still true and returned silently. send()'s finally resets the shared flags
      // only while it still owns the screen, so a newer turn is safe from the old one's cleanup.
      inFlightRef.current = false;
      // discard: the recorder's final onstop used to transcribe and SEND the half-turn anyway, so
      // Nort answered a question after the user had said stop. STOP means stop.
      speech.stopListening({ discard: true });
      killSpeech(); // tears down the streaming speak queue + barge-in monitor, then cuts TTS
      setStreaming(false);
      setSpeaking(false);
      setStatus(null);
      setListening(false);
      setVoiceMode(false);
    };
    window.addEventListener("cn:assistant-stop", stop);
    return () => window.removeEventListener("cn:assistant-stop", stop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The topbar Talk button is the ONLY voice control now (no in-panel mic). When the panel is already
  // open, the tap ALREADY (re)started the mic in-gesture (launch → speech.startListening) — here we just
  // enter voice mode + point the next transcript at a normal spoken turn.
  useEffect(() => {
    const talk = () => {
      setVoiceMode(true);
      speech.setResultHandler((t) => sendRef.current?.(t, true));
      setListening(speech.isListening());
    };
    window.addEventListener("cn:assistant-talk", talk);
    return () => window.removeEventListener("cn:assistant-talk", talk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Glass compact view: live elapsed/token readout for the status line (like Claude's).
  const [elapsedMs, setElapsedMs] = useState(0);
  const [tokens, setTokens] = useState(0);
  const turnStartRef = useRef(0);
  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setElapsedMs(Date.now() - turnStartRef.current), 400);
    return () => clearInterval(id);
  }, [streaming]);
  const router = useRouter();

  // Put text into the LAST assistant line (the placeholder a turn appends, possibly half-filled),
  // or append one if the tail isn't an assistant line.
  function setAssistantTail(content: string, hint?: Msg["hint"]) {
    setMessages((m) => {
      const c = [...m];
      const last = c[c.length - 1];
      const line: Msg = hint ? { role: "assistant", content, hint } : { role: "assistant", content };
      if (last?.role === "assistant") c[c.length - 1] = line;
      else c.push(line);
      return c;
    });
  }

  // Finalize the live draft → real quote, then flip to the actual quote page (filled out).
  async function saveDraft() {
    if (!draft) return;
    setSavingDraft(true);
    try {
      const res = await saveQuoteFromDraft(draft);
      if (res.ok && res.id) {
        // Collapse the live numbers to a compact, clickable "saved" line that stays in the chat
        // and links to the quote (the permanent log in /quotes) — instead of wiping it and yanking
        // you out to the quote page. You keep talking; the estimate is logged + one tap away.
        const items = (Array.isArray(draft.items) ? draft.items : []).filter((i) => i && typeof i === "object");
        // Same rollup as the save path (subtotalTaxTotal — subtotal/tax rounded separately),
        // so the "saved" line's total equals the quote actually persisted, to the cent.
        const { total } = subtotalTaxTotal(
          items.map((i) => (Number(i.quantity) || 0) * (Number(i.unit_price) || 0)),
          Number(draft.tax_rate) || 0,
        );
        setSaved((sv) => [...sv, { id: res.id!, title: draft.title || "Estimate", total, customer: draft.customer_name ?? undefined }]);
        setDraft(null);
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

  // The active streaming speak queue for the current reply, and the barge-in monitor teardown.
  // Held in refs so the topbar Stop / stopVoice paths can tear them down deterministically.
  const speakQueueRef = useRef<SpeakQueue | null>(null);
  const bargeStopRef = useRef<(() => void) | null>(null);

  // Tear down any in-flight speech (streaming queue + barge-in monitor) and cut audio. Idempotent —
  // safe to call from Stop, barge-in, a new turn, or teardown. Does NOT re-arm; callers decide that.
  function killSpeech() {
    try { bargeStopRef.current?.(); } catch {}
    bargeStopRef.current = null;
    const q = speakQueueRef.current;
    speakQueueRef.current = null;
    // stop() fires the queue's onDone, but its re-arm is guarded on this ref being current — since we
    // already cleared it, that path no-ops and we avoid a double re-arm.
    try { q?.stop(); } catch {}
    stopSpeaking();
  }

  // Speak a SHORT phrase (directive lead-ins: "opening maps…", the confirm prompt, "say yes or no").
  // Tracks speaking state, mutes the live mic so Nort's own TTS isn't transcribed back, then runs
  // `after` (usually re-open the mic). Unchanged conversational contract; used for the non-streamed bits.
  function say(text: string, after?: () => void) {
    setSpeaking(true);
    speech.setMuted(true);
    speakSmart(text, () => {
      setSpeaking(false);
      speech.setMuted(false);
      after?.();
    });
  }

  // Speak a reply as it STREAMS: `feed` pushes completed-sentence chunks (played in order, first one
  // starts the instant it's synthesized — killing the old 3-6s dead air), `finish()` signals no more
  // are coming. `after` runs once the LAST chunk finishes (or a barge-in cuts in). While playing, a
  // barge-in monitor watches the live analyser; a sustained talk-over stops playback and runs `after`
  // EARLY (which re-arms the mic to capture what the user is saying). onEnd fires exactly once.
  function makeSpeakStream(after?: () => void): { feed: (chunk: string) => void; finish: () => void } {
    setSpeaking(true);
    speech.setMuted(true);
    const q = new SpeakQueue(() => {
      // Runs once: natural end (last clip done) OR a stop() (barge-in / Stop). Re-arm only if this is
      // still the current queue (killSpeech clears the ref first to suppress a double re-arm).
      try { bargeStopRef.current?.(); } catch {}
      bargeStopRef.current = null;
      const wasCurrent = speakQueueRef.current === q;
      if (wasCurrent) speakQueueRef.current = null;
      setSpeaking(false);
      speech.setMuted(false);
      if (wasCurrent) after?.();
    });
    speakQueueRef.current = q;
    // Barge-in: reuse the always-on analyser (never a fresh getUserMedia). On a sustained talk-over,
    // stop the queue → its onDone re-arms the mic so we capture the interruption.
    bargeStopRef.current = startBargeInMonitor(
      () => speech.analyserRms(),
      () => { q.stop(); },
    );
    return { feed: (chunk) => q.push(chunk), finish: () => q.done() };
  }

  // The big mic button in voice mode: cut off any speech, end a listening turn, or start one.
  function voiceTap() {
    if (listening) {
      speech.stopListening();
      return;
    }
    // Cut any in-flight speech — the streaming queue + barge-in monitor too — before we manually
    // re-open the mic, so the queue's own onDone can't ALSO fire a second startMic.
    killSpeech();
    speech.setMuted(false);
    setSpeaking(false);
    startMic();
  }

  // Wire the shared speech service: detect support, route each transcript to the LATEST send (via the
  // ref, so it never captures stale messages), and mirror the listening state.
  useEffect(() => {
    setVoiceOn(speech.speechSupported());
    speech.setResultHandler((t) => sendRef.current?.(t, true));
    const unsub = speech.onListeningState(setListening);
    speech.onStatus?.((s) => setStatus(s)); // show each voice step so a failure is visible, not silent
    setListening(speech.isListening()); // catch an in-gesture start that already happened (first open)
    return () => {
      speech.setResultHandler(null);
      speech.onStatus?.(null);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live mic-input level (0..1) while in voice mode — the diagnostic that proves whether the mic is
  // actually hearing sound (a flat bar = the stream is "on" but capturing nothing).
  const [micLevel, setMicLevel] = useState(0);
  useEffect(() => {
    if (!voiceMode) { setMicLevel(0); return; }
    let raf = 0;
    const loop = () => {
      setMicLevel(speech.currentLevel?.() ?? 0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [voiceMode]);

  // Voice-first: the topbar tap ALREADY started the mic in-gesture (global-assistant launch →
  // speech.startListening) — iOS only honors a start inside the gesture. So here we just enter voice
  // mode (do NOT start the mic from this post-commit effect; iOS would reject it).
  useEffect(() => {
    if (!autoStart) return;
    setVoiceMode(true);
    // The mic was started in-gesture by the topbar tap. If it took, mirror "listening"; if it didn't
    // (no mic, or iOS rejected even the in-gesture start), nudge to tap Talk rather than sit silent.
    if (speech.isListening()) setListening(true);
    else setStatus("Tap the mic to answer");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  // MEMORY: restore the saved conversation + draft on open (pick up where you left off).
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadConversation()
      .then(({ messages: m, draft: d }) => {
        // The preview drawer (glass) opens FRESH — last session's chatter isn't shown again (CIB
        // keeps what matters as memory facts; an OPEN draft is still restored so an estimate-in-
        // progress comes back). The full /assistant page keeps the scroll-back history.
        const restored = m && m.length && !glass ? (m as Msg[]) : [];
        // A turn can already be streaming when this lands (the drawer hands its typed question
        // straight in; the page's ?q=): its user line + placeholder are on screen. History goes
        // BEFORE them — replacing the list wholesale dropped the question and let the stream
        // overwrite the last line of history instead of its own placeholder.
        if (restored.length) setMessages((cur) => (cur.length ? [...restored, ...cur] : restored));
        if (d) setDraft(d);
        // That in-flight turn wrote the marker itself — it is live, not orphaned: nothing to catch up.
        if (inFlightRef.current) return;
        const p = readPendingTurn();
        if (p) void catchUp(p);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A RELOAD MID-TURN (the shell's WebContent process was jettisoned, or the user reloaded while
  // Nort was answering): the marker outlived its page. The answer is very likely on the server —
  // show it, rather than opening on nothing as if the question was never asked. The marker is
  // forgotten only once the reply is in hand (or provably never coming): the residual line names
  // Reload as the door, and the marker is the one thing that makes a reload check.
  async function catchUp(p: PendingTurn) {
    const ctrl = new AbortController();
    catchUpAbortRef.current = ctrl;
    // Past the route's maxDuration the server's turn is over: one look is the whole truth, and the
    // phone is not held on "catching up" for a reply that cannot still be on its way.
    const turnOver = Date.now() - Date.parse(p.at) > TURN_MAX_MS;
    setStatus("Catching up with Nort…");
    const reply = await fetchRecoveredReply(p.content, p.at, turnOver ? 1 : 3, ctrl.signal);
    if (ctrl.signal.aborted) return; // STOP / Close / a new question owns the screen now — say nothing
    catchUpAbortRef.current = null;
    setStatus(null);
    if (reply) {
      clearPendingTurn(p.at);
      const q = p.content.trim();
      setMessages((cur) => {
        // While the marker stood, whatever the stored transcript holds after this question is at
        // best a half-streamed reply or a residual "didn't get an answer" line — never the answer
        // (a finished turn clears the marker in the same breath it persists). The recovered reply
        // REPLACES that tail: the turn never gets a second bubble.
        let ui = -1;
        for (let i = cur.length - 1; i >= 0; i--) {
          if (cur[i].role === "user" && cur[i].content.trim() === q) { ui = i; break; }
        }
        if (ui >= 0 && cur.slice(ui + 1).every((x) => x.role === "assistant")) {
          return [...cur.slice(0, ui + 1), { role: "assistant", content: reply }];
        }
        // The question never reached the transcript (the reload came before the stream ended, or
        // the drawer opened fresh): the pair is appended — over any residual line a prior attempt left.
        return [...dropResidualTail(cur), { role: "user", content: p.content }, { role: "assistant", content: reply }];
      });
      // Opened by the Talk button: the reply is read out, as it would have been.
      if (autoStart) say(reply.replace(/\s*\[[^\]]*\]\s*$/, ""), () => { if (voiceModeRef.current) startMic(); });
    } else {
      const offline = isOffline();
      // Online, and the server's turn is provably over with nothing there: the marker would only
      // re-ask on every open for the rest of its 15 minutes and find the same nothing. Offline, or
      // with the turn possibly still running, it stays — Reload is a live door in both.
      if (!offline && turnOver) clearPendingTurn(p.at);
      const line: Msg = offline
        ? { role: "assistant", content: RELOAD_OFFLINE_SENTENCE, hint: "reload" }
        : turnOver
          ? { role: "assistant", content: RELOAD_UNANSWERED_SENTENCE }
          : { role: "assistant", content: RELOAD_PENDING_SENTENCE, hint: "reload" };
      setMessages((cur) => withResidual(cur, line));
    }
    scrollToBottom();
  }

  // The empty assistant placeholder a turn appends before its first byte: after STOP it would sit
  // there spinning as if a reply were still coming. What did stream is left as it is.
  function dropEmptyTail() {
    setMessages((m) => (m[m.length - 1]?.role === "assistant" && !m[m.length - 1].content ? m.slice(0, -1) : m));
  }

  // ...and auto-persist (debounced) so nothing is ever lost.
  useEffect(() => {
    if (messages.length === 0 && !draft) return;
    // Not while a reply is streaming: a half-arrived tail saved here read, after a reload, as the
    // answer — and the catch-up (which trusts the stored transcript) skipped the turn. The save
    // runs when the stream ends: `streaming` flips and this effect re-fires with the whole turn.
    if (streaming) return;
    // A failed save is SAID, not swallowed (audit v921): a zero-row write and a rejected promise
    // both mean the draft on screen is the only copy there is.
    const t = setTimeout(() => {
      saveConversation(messages, draft)
        .then((r) => setSaveFailed(!r?.ok))
        .catch(() => setSaveFailed(true));
    }, 800);
    return () => clearTimeout(t);
  }, [messages, draft, streaming]);

  function newChat() {
    stopVoice();
    // Starting fresh is the user moving on from any turn still owed an answer: the catch-up (if
    // one is probing) is dropped and the marker goes with the conversation.
    try { catchUpAbortRef.current?.abort(); } catch {}
    catchUpAbortRef.current = null;
    writePendingTurn(null);
    setStatus(null);
    setMessages([]);
    setDraft(null);
    setCard(null);
    setInput("");
    clearConversation().catch(() => {});
  }

  // Stop the whole voice conversation at any time (like chat): stop listening, cut off any
  // speech mid-sentence (streaming queue + barge-in monitor included), and leave voice mode.
  function stopVoice() {
    setVoiceMode(false);
    speech.stopListening({ discard: true }); // End conversation: the half-turn is dropped, not sent
    killSpeech();
    setSpeaking(false);
    setListening(false);
  }

  function scrollToBottom() {
    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }),
    );
  }

  async function send(text: string, viaVoice = false) {
    const content = text.trim();
    if (!content || streaming || inFlightRef.current) return;
    inFlightRef.current = true;
    // A new question is the user moving on: a reload-time catch-up still probing for the last one
    // would otherwise land its line under THIS question, and its marker is replaced below anyway.
    if (catchUpAbortRef.current) {
      try { catchUpAbortRef.current.abort(); } catch {}
      catchUpAbortRef.current = null;
      setStatus(null);
    }
    if (!viaVoice) setVoiceMode(false); // typing leaves voice mode
    // Mute the (still-live) MediaStream while we process this turn so background noise / the user
    // thinking out loud during the reply isn't captured as the next turn. The active backend RECORDS
    // ONE TURN AT A TIME off a stream that's held open across turns (it is NOT a continuously-running
    // recognizer); the re-arm after the reply (startMic → beginTurn) records the next turn from the
    // SAME stream — we never call a fresh getUserMedia mid-conversation (iOS rejects it off-gesture).
    if (viaVoice) speech.setMuted(true);

    const next: Msg[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setStreaming(true);
    turnStartRef.current = Date.now();
    setElapsedMs(0);
    setTokens(0);
    scrollToBottom();

    // Hoisted out of the try: the catch block reads them to finish a dropped turn (what was on
    // screen already, and how much of it the speak queue had).
    let full = ""; // the whole reply so far, which may END with a CONFIRM proposal
    let spokenLen = 0; // how much of the visible text has been handed to the speak queue
    const stripTrailingTag = (s: string) => s.replace(/\s*\[[^\]]*\]\s*$/, "");
    const myAbort = new AbortController();
    abortRef.current = myAbort;
    // Whether the marker written below may be forgotten in `finally`: true once the reply is in
    // hand (streamed to the end, or recovered) or the server refused the turn (nothing to recover).
    // A dropped turn whose recovery came up empty KEEPS it — the residual line names Reload as the
    // door, and the marker is what makes a reload check. So does a STOP: it ends the stream, not
    // the question; the server still finishes, and the next open shows what it said.
    let turnSettled = false;
    // The controller the topbar STOP reaches during a drop-recovery loop. The fetch's own is
    // already spent by then (dropStream fired it), so the loop needs a live one of its own.
    let recoverAbort: AbortController | null = null;
    // WHEN THE PHONE LOSES THE STREAM. Three ways the shell drops a reply the server still
    // finishes: WebKit rejects the read ("Load failed") after a stint in the background; the
    // socket dies silently and the read just never resolves; or the page reloads cold (the marker
    // above). `dropReason` tells the catch block a stop was OURS (recover) and not the user's
    // (leave the partial alone); `recoveredEarly` carries a reply the foreground probe found.
    const sentAt = new Date().toISOString();
    let lastByteAt = Date.now();
    let dropReason: "stalled" | "found" | null = null;
    let recoveredEarly: string | null = null;
    const dropStream = (why: "stalled" | "found") => {
      dropReason = why;
      try { myAbort.abort(); } catch {}
    };
    const stallWatch = setInterval(() => {
      if (Date.now() - lastByteAt > STREAM_STALL_MS) dropStream("stalled");
    }, 5_000);
    // Back on screen after the background, with the stream quiet for a while: iOS may have cut the
    // socket without a word. Ask the server whether the answer is already there; if it is, the
    // dead read is abandoned and the reply rendered — no waiting for a timeout that may never come.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastByteAt < 8_000) return;
      void recoverTurn(content, sentAt)
        .then((r) => {
          if (r.reply && abortRef.current === myAbort && !myAbort.signal.aborted) {
            recoveredEarly = r.reply;
            dropStream("found");
          }
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    writePendingTurn({ content, at: sentAt, voice: viaVoice });
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: abortRef.current.signal,
        headers: { "Content-Type": "application/json" },
        // Round-trip the LIVE draft (restored or in-progress) so resuming an estimate CONTINUES
        // from what's on screen instead of restarting it, + the current page so "this job"/"this
        // invoice" resolves. The route injects both at the cache-safe message tail.
        body: JSON.stringify({ messages: next, voice: viaVoice, draft, path: window.location.pathname }),
      });

      if (!res.ok || !res.body) {
        turnSettled = true; // the route refused the turn — there is no reply to come back for
        const errText = await res.text().catch(() => "Request failed.");
        setMessages((m) => [...m, { role: "assistant", content: errText }]);
        setStreaming(false);
        return;
      }

      // Append an empty assistant message we fill as chunks arrive.
      setMessages((m) => [...m, { role: "assistant", content: "" }]);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      // CHANGE 1 — streaming voice. In voice mode, speak each COMPLETED sentence the moment it's ready
      // instead of waiting for the whole reply. `stream` is created lazily on the first finished
      // sentence (so a directive-only / empty reply never opens a speaker). `spokenLen` tracks how much
      // of the visible text we've already handed to the queue. `noStream` disables streamed speech for
      // this turn if anything goes wrong, so we fall back to speaking the whole reply once at the end.
      let stream: { feed: (c: string) => void; finish: () => void } | null = null;
      spokenLen = 0;
      let noStream = false;
      const feedSentences = (visible: string, final: boolean) => {
        if (!viaVoice || noStream) return;
        try {
          const pending = visible.slice(spokenLen);
          const { sentences, rest } = splitSentences(pending);
          for (const s of sentences) {
            const clean = s.trim();
            if (clean) {
              if (!stream) stream = makeSpeakStream(() => { if (voiceModeRef.current) startMic(); });
              stream.feed(clean);
            }
          }
          // Consume everything up to the trailing remainder (kept for the next tick / the flush).
          spokenLen += pending.length - rest.length;
          if (final) {
            const tail = stripTrailingTag(visible.slice(spokenLen)).trim();
            if (tail) {
              if (!stream) stream = makeSpeakStream(() => { if (voiceModeRef.current) startMic(); });
              stream.feed(tail);
            }
          }
        } catch {
          // Any parse/queue trouble → abandon streamed speech; the end-of-turn path speaks it all once.
          noStream = true;
        }
      };

      full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastByteAt = Date.now();
        full += decoder.decode(value, { stream: true });
        const { text: visible, draft: liveDraft, card: liveCard, status: liveStatus } = parseStream(full);
        // `cleared` = the agent just saved the estimate → wipe the preview so it stops
        // anchoring the conversation. Otherwise the quote fills in live as blocks arrive.
        if (liveDraft) setDraft((liveDraft as { cleared?: boolean }).cleared ? null : liveDraft);
        // The driver HUD card fills the glass as its block arrives; cleared:true clears it.
        if (liveCard) setCard(liveCard.cleared ? null : liveCard);
        setStatus(liveStatus); // transient "Searching…" pill while a tool runs
        setTokens(Math.max(1, Math.round(visible.length / 4))); // rough live token count for the status line
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: visible };
          return copy;
        });
        // Speak completed sentences as they land (voice mode only). Only starts a speaker once a
        // directive marker CAN'T retroactively appear inside already-spoken text: parseStream strips
        // the markers, so `visible` is exactly the spoken body. If a directive turns up at the tail,
        // the end-of-turn handler cuts the streamed speech and speaks the directive phrase instead.
        feedSentences(visible, false);
        scrollToBottom();
      }
      turnSettled = true; // every byte arrived — the marker has done its job
      setStatus(null);

      // Directive markers (confirm / open-maps / contact-pick) come at the very end of the stream.
      const visibleText = parseStream(full).text;
      let proposal: AgentConfirm | null = null;
      if (full.includes(CONFIRM_MARKER)) {
        try { proposal = JSON.parse(full.split(CONFIRM_MARKER)[1]); } catch {}
      }
      let openDir: AgentOpen | null = null;
      if (full.includes(OPEN_MARKER)) {
        try { openDir = JSON.parse(full.split(OPEN_MARKER)[1]); } catch {}
      }
      let pickDir: AgentPick | null = null;
      if (full.includes(PICK_MARKER)) {
        try { pickDir = JSON.parse(full.split(PICK_MARKER)[1]); } catch {}
      }

      // A directive at the tail changes what we SAY (a specific phrase, not the streamed body). If we
      // opened a streamed speaker for the body, cut it now so we don't double-speak, then say the
      // directive phrase. A plain reply instead flushes its remainder and finishes the stream in order.
      const hasDirective = !!(pickDir || openDir?.url || proposal);
      if (viaVoice && hasDirective) killSpeech();

      if (pickDir) {
        // The assistant asked the user to pick a contact on screen — pop the picker; their choice
        // comes back as the next message (handled by onPickContact below).
        setPendingPick(pickDir);
        if (viaVoice) say("Go ahead and pick the contact on screen.");
      } else if (openDir?.url) {
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
        // No directive — finish the streamed read, then re-open the mic (the queue's onDone re-arms
        // after the LAST sentence). If streaming was disabled or nothing streamed, fall back to
        // speaking the whole reply once (today's behavior) so the reply is never dropped.
        const clean = stripTrailingTag(visibleText).trim();
        if (stream && !noStream) {
          feedSentences(visibleText, true); // flush the trailing fragment as a final chunk
          (stream as { finish: () => void }).finish(); // re-arms on the last clip's end
        } else if (clean) {
          say(clean, () => { if (voiceModeRef.current) startMic(); });
        }
        // A reply with nothing to read (action-only) still has to unmute + re-listen, or the
        // session sits muted and the next answer is silently dropped.
        else if (voiceModeRef.current) startMic();
      }
    } catch (e: any) {
      // A user-initiated stop (abort) is not an error — leave the partial reply as-is (an empty
      // placeholder is not a reply; it goes, or it spins forever).
      const userStop = e?.name === "AbortError" && !dropReason;
      if (userStop) {
        dropEmptyTail();
      } else {
        // Cut any streamed speech first so its queue can't also re-arm (double startMic).
        killSpeech();
        speech.setMuted(false);
        setSpeaking(false);
        // THE REPLY THE SCREEN MISSED. The server finishes the turn and persists it whether or
        // not this phone was still listening — so a dead socket is not "Error: Load failed" and
        // a lost answer; it is a short wait for the transcript, then the answer itself. Whatever
        // streamed before the drop is on screen already; only the rest is spoken.
        const partial = parseStream(full).text;
        // `full` is every byte the route sent; empty = nothing ever arrived, so the short budget.
        const tries = full.length ? RECOVERY_TRIES_FULL : RECOVERY_TRIES_NO_BYTE;
        recoverAbort = new AbortController();
        abortRef.current = recoverAbort; // what the topbar STOP aborts from here on
        if (!recoveredEarly && !isOffline()) setStatus("The connection dropped — catching up with Nort…");
        const reply = recoveredEarly ?? (await fetchRecoveredReply(content, sentAt, tries, recoverAbort.signal));
        if (recoverAbort.signal.aborted) {
          // STOP mid-catch-up: no line lands after the user said stop. Same as a stop mid-stream —
          // what streamed stays, an empty placeholder goes, the marker stays.
          dropEmptyTail();
        } else {
          setStatus(null);
          if (reply) {
            turnSettled = true;
            setAssistantTail(reply);
            if (viaVoice) {
              const unspoken = stripTrailingTag(partial && reply.startsWith(partial) ? reply.slice(spokenLen) : reply).trim();
              if (unspoken) say(unspoken, () => { if (voiceModeRef.current) startMic(); });
              else if (voiceModeRef.current) startMic();
            }
          } else {
            // Nothing on the server (yet) — or no way to ask it. The residual sentence names the
            // true state (offline vs dropped) and both doors. The marker stays (turnSettled is
            // still false): the Reload it names only checks while the marker exists.
            const offline = isOffline();
            const sentence = offline ? OFFLINE_SENTENCE : DROPPED_SENTENCE;
            if (partial.trim()) setMessages((m) => [...m, { role: "assistant", content: sentence, hint: "reload" }]);
            else setAssistantTail(sentence, "reload");
            if (viaVoice) {
              say(
                offline ? "You're offline — ask me again when you have bars." : "The connection dropped before I could answer — ask me again.",
                () => { if (voiceModeRef.current) startMic(); },
              );
            }
          }
        }
      }
    } finally {
      clearInterval(stallWatch);
      document.removeEventListener("visibilitychange", onVisible);
      if (turnSettled) clearPendingTurn(sentAt);
      // STOP frees the screen at once (its handler clears inFlightRef), so a NEWER turn may own it
      // by the time a stopped probe returns: only the turn still holding abortRef resets the shared
      // flags — otherwise this cleanup would cut the newer reply off mid-stream.
      const owns = abortRef.current === myAbort || (recoverAbort !== null && abortRef.current === recoverAbort);
      if (owns) {
        inFlightRef.current = false;
        setStreaming(false);
        setStatus(null);
      }
      scrollToBottom();
    }
  }

  // Open the mic for a normal spoken turn (transcript → send). On the active stream backend this just
  // records the next turn off the already-live MediaStream (no gesture needed), so mid-conversation
  // re-arms from a speak-queue/TTS-end callback succeed. If start() returns false — the webkit fallback
  // backend rejecting an off-gesture restart, or no mic — fall back to a "tap Talk" nudge, never dying
  // silently.
  function startMic() {
    speech.setResultHandler((t) => sendRef.current?.(t, true)); // normal mode (confirmListen may have changed it)
    if (!speech.startListening()) setStatus("Tap the mic to answer");
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

  // Listen for a spoken reply to a pending confirm proposal (the service routes the transcript here).
  // Handles corrections, not just yes/no — see classifyConfirmReply.
  function confirmListen() {
    speech.setResultHandler((t) => {
      const intent = classifyConfirmReply(t);
      if (intent === "yes") resolveConfirm(true);
      else if (intent === "no") resolveConfirm(false);
      else if (intent === "correction") {
        // The user is amending the proposal by voice ("actually make it the second one", "change it to
        // 3", a name…). Drop the stale confirm card and re-send the whole utterance as a normal voice
        // turn — the proposal is still in the conversation history, so Nort amends and re-proposes. The
        // confirm-gate is intact: nothing writes until a fresh explicit yes.
        // NOTE: do NOT stopListening() here — that tears down the live iOS stream; a re-arm from this
        // (off-gesture) transcription callback would need a fresh getUserMedia that iOS rejects. send()
        // mutes the live session and re-arms it at the end of the turn, exactly like a normal voice turn.
        confirmRef.current = null;
        setPendingConfirm(null);
        void send(t, true);
      } else {
        // Unclear — re-prompt, then listen again (only while a proposal is still pending).
        say("Say yes or no.", () => { if (voiceModeRef.current && confirmRef.current) confirmListen(); });
      }
    });
    if (!speech.startListening()) setStatus("Tap the mic to answer");
  }

  // Resolve a pending confirm: run it (yes) or drop it (no). Nothing wrote until here.
  async function resolveConfirm(yes: boolean) {
    const c = confirmRef.current;
    confirmRef.current = null;
    setPendingConfirm(null);
    speech.stopListening({ discard: true }); // the yes/no is already decided — nothing else to send
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
    // The drawer passes the typed question straight in (initialQuery); the legacy page used ?q=.
    const urlQ = new URLSearchParams(window.location.search).get("q");
    const q = (initialQuery ?? urlQ ?? "").trim();
    if (q) {
      send(q);
      if (urlQ) window.history.replaceState(null, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the speech service pointed at THIS render's send (so a transcript never uses stale messages).
  sendRef.current = send;

  const elapsedStr = (() => { const s = Math.floor(elapsedMs / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; })();
  const statusText = status ?? (streaming ? (tokens > 2 ? "responding…" : "thinking…") : listening ? "listening…" : speaking ? "talking…" : null);
  return (
    <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${glass ? "bg-transparent" : "rounded-xl border border-slate-200 bg-white"}`}>
      {/* THE WINDSHIELD — pinned at the TOP so the driver card is the hero: the chat log
          scrolls BELOW it, so incoming text never pushes it off-screen. shrink-0 = fixed
          height; it's the "driver screen," the conversation is secondary context under it. */}
      {card ? (
        <div className="shrink-0">
          <DriverCard card={card} onDismiss={() => setCard(null)} />
        </div>
      ) : null}
      {/* GLASS: a clean command box — the ESTIMATOR summary + its line items, the live status line,
          then one line per conversation turn expanding down. No header/footer chrome; the topbar
          waveform button is the only control (voice + stop), the panel handle moves/collapses it. */}
      {glass && (
        <div className="flex min-h-0 flex-1 flex-col">
          {draft && (
            <div className="shrink-0">
              <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
                <FileText className="h-4 w-4 shrink-0 text-brand" />
                <span className="truncate text-sm">
                  <span className="font-semibold text-brand">ESTIMATOR</span>
                  {draft.title ? <span className="text-slate-700"> · {draft.title}</span> : null}
                  {draft.customer_name ? <span className="text-slate-400"> · {draft.customer_name}</span> : null}
                </span>
              </div>
              {(draft.items ?? []).length > 0 && (
                <>
                  <div className="max-h-[22vh] space-y-0.5 overflow-y-auto px-3 pb-1.5">
                    {(draft.items ?? []).map((it, i) => (
                      <div key={i} className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate text-slate-500">{it.description || "item"}</span>
                        <span className="shrink-0 tabular-nums text-slate-400">
                          {Number(it.quantity) || 1}×${Math.round(Number(it.unit_price) || 0)}
                        </span>
                      </div>
                    ))}
                  </div>
                  {/* Save right here in the drawer — on save the numbers collapse to a clickable line below. */}
                  <div className="px-3 pb-2">
                    <Button
                      onClick={saveDraft}
                      disabled={savingDraft}
                      size="sm"
                      className={`w-full ${draft.status === "ready" ? "bg-green-600 hover:bg-green-500" : ""}`}
                    >
                      {savingDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : draft.status === "ready" ? "Save estimate →" : "Save draft →"}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          {statusText ? (
            <div className="flex shrink-0 items-center gap-2 px-3 py-2">
              <Sparkles className="h-4 w-4 shrink-0 animate-pulse text-orange-500" />
              {/* The elapsed/token readout belongs to a reply in progress; while the mic is the
                  thing working, "0s · 0 tokens · Hearing you…" (Erik's 2026-09-11 screenshot)
                  reads as a reply that isn't coming. */}
              <span className="truncate text-sm text-slate-500">{streaming ? `${elapsedStr} · ${tokens} tokens · ${statusText}` : statusText}</span>
            </div>
          ) : !draft && messages.length === 0 && !voiceMode ? (
            <div className="px-3 py-2.5 text-sm text-slate-400">What can I help you with?</div>
          ) : null}
          {voiceMode && (
            // Live mic-input meter — if this bar stays flat while you talk, the mic isn't reaching
            // the app (the iOS silent-PWA case); if it moves, capture is working and any failure is
            // downstream (transcription). The single clue that tells us where it breaks.
            <div className="flex shrink-0 items-center gap-2 px-3 pb-2" aria-hidden>
              <Mic className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: `${Math.min(100, Math.round((micLevel || 0) * 600))}%` }}
                />
              </div>
            </div>
          )}
          {messages.length > 0 && (
            // overscroll-contain: on iOS, scrolling past the end of this list used to carry on
            // into the page behind the floating panel.
            <div ref={scrollRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-3 pb-2 pt-0.5">
              {messages.map((m, i) => (
                <div key={i} className="flex items-baseline gap-1.5 text-xs leading-snug">
                  <span className={`shrink-0 font-semibold ${m.role === "user" ? "text-brand" : "text-slate-300"}`}>
                    {m.role === "user" ? "›" : "↳"}
                  </span>
                  <span className="whitespace-pre-wrap break-words text-slate-600">
                    {m.content || "…"}
                    {m.hint === "reload" ? <ReloadDoor /> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* The full-page (non-glass) conversation — bubbles + welcome. The glass drawer uses the
          compact command-line render above instead. */}
      {!glass && (
        <>
          {messages.length > 0 && (
            <div className="flex shrink-0 justify-end px-3 pt-1">
              <button onClick={newChat} className="text-xs font-medium text-slate-400 hover:text-brand">+ New chat</button>
            </div>
          )}
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
            {messages.length === 0 ? (
              glass ? null : (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-light">
                    <Sparkles className="h-6 w-6 text-brand" />
                  </div>
                  <h3 className="text-sm font-semibold text-slate-900">How can I help?</h3>
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
              )
            ) : (
              messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={
                      m.role === "user"
                        ? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand px-4 py-2.5 text-sm text-white"
                        : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-2.5 text-sm text-slate-800"
                    }
                  >
                    {m.content || <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
                    {m.hint === "reload" ? <ReloadDoor /> : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* NOT SAVING — the autosave is failing (expired session, no network), so this conversation
          and the draft on screen exist only here until it comes back. Shown in both skins; the one
          thing worse than losing it is losing it quietly. */}
      {saveFailed ? (
        <div className="mx-2 mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          Not saving — this conversation isn&apos;t being kept. Reconnect or sign in again, then keep going.
        </div>
      ) : null}

      {/* non-glass status pill (the glass drawer shows the status LINE above instead) */}
      {status && streaming && !glass ? (
        <div className="border-t border-slate-100 px-4 py-1.5">
          <span className="inline-flex items-center gap-1.5 text-xs italic text-slate-400">
            <Loader2 className="h-3 w-3 animate-spin" /> {status}
          </span>
        </div>
      ) : null}

      {/* The full estimate card — non-glass only; the glass drawer shows the ESTIMATOR line + items. */}
      {draft && !glass ? <LiveQuote draft={draft} onSave={saveDraft} onDismiss={() => setDraft(null)} saving={savingDraft} /> : null}

      {/* Saved-this-session estimates: the live numbers collapse to ONE clickable line each, linking to
          the quote in /quotes (the permanent log). Newest first. */}
      {saved.length > 0 && (
        <div className="mx-2 mb-2 space-y-1.5">
          {[...saved].reverse().map((s) => (
            <a
              key={s.id}
              href={`/quotes/${s.id}`}
              className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-sm hover:bg-emerald-50"
            >
              <Check className="h-4 w-4 shrink-0 text-emerald-600" />
              <span className="min-w-0 flex-1 truncate font-medium text-slate-800">
                {s.title}
                {s.customer ? <span className="font-normal text-slate-400"> · {s.customer}</span> : null}
              </span>
              <span className="shrink-0 font-semibold text-slate-900">{money(s.total)}</span>
              <span className="shrink-0 text-xs font-medium text-brand">View →</span>
            </a>
          ))}
        </div>
      )}

      {pendingPick ? (
        <ContactPicker
          pick={pendingPick}
          onSelect={(c) => {
            setPendingPick(null);
            void send(`Selected contact: ${c.name}${c.company ? ` (${c.company})` : ""} — customer_id ${c.id}`, voiceMode);
          }}
          onCancel={() => setPendingPick(null)}
        />
      ) : null}

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
      ) : glass ? null : voiceMode ? (
          // Voice mode (full page only) — chat-style. It listens / thinks / talks; the big mic is
          // "your turn". In the glass drawer the topbar waveform button is the only voice control.
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
