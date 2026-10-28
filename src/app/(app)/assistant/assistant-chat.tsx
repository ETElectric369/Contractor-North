"use client";

import { useEffect, useRef, useState } from "react";
import { trace } from "@/lib/nort/trace";
import { useRouter } from "next/navigation";
import { APP_VERSION } from "@/lib/version";
import { Send, Sparkles, Loader2, Mic, Check, Square, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { speakSmart, unlockAudio, stopSpeaking, splitSentences, SpeakQueue, startBargeInMonitor } from "@/lib/tts";
import { consumeGreeted, setNortHolding } from "@/lib/nort-holding";
import type { NortHolding } from "@/lib/nort/greeting";
import { isNativeShell } from "@/lib/native-shell";
import { standDownReaderForVoice } from "@/lib/native-tap";
import { classifyConfirmReply } from "@/lib/confirm-parse";
import { subtotalTaxTotal } from "@/lib/invoice-math";
import * as speech from "@/lib/voice";
import {
  CONFIRM_MARKER, OPEN_MARKER, PICK_MARKER, STATUS_OPEN, STATUS_CLOSE, DRAFT_OPEN, DRAFT_CLOSE, HUD_OPEN, HUD_CLOSE, HOLDING_OPEN, HOLDING_CLOSE,
  WROTE_OPEN, WROTE_CLOSE, SCREEN_OPEN, SCREEN_CLOSE, screenBlocks, directivePayload,
  type AgentConfirm, type AgentOpen, type AgentPick, type AgentDraft, type AgentHudCard, type AgentWrote, type AgentScreen,
} from "@/lib/assistant-protocol";
import { performScreen } from "@/lib/nort/screen-driver";
import { listNortDoors } from "@/lib/nort/doors";
import { SCREENS } from "@/lib/nort/screens";
import { confirmAgentAction, saveQuoteFromDraft, loadConversation, saveConversation, clearConversation, recoverTurn, type PickerContact } from "./actions";
import { ContactPicker } from "./contact-picker";
import { DriverCard } from "@/components/driver-card";
import { estimatorStore } from "@/lib/estimator-store";
import { useLang } from "@/components/lang-provider";
import { dict, fillText, localeOf, translator, type Lang } from "@/lib/i18n";
import { isStaffRole } from "@/lib/actions/perms";

const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

/** Pull the visible text + the latest live quote draft + the transient tool-status out of the raw
 *  stream so far. */
function parseStream(full: string): { text: string; draft: AgentDraft | null; card: AgentHudCard | null; status: string | null; holding: NortHolding | null; wrote: AgentWrote | null } {
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
  // What Nort still holds after this turn (0394) — the LAST complete block, like HUD.
  let holding: NortHolding | null = null;
  const nre = new RegExp(HOLDING_OPEN + "([\\s\\S]*?)" + HOLDING_CLOSE, "g");
  const nblocks = [...full.matchAll(nre)];
  if (nblocks.length) {
    try {
      const h = JSON.parse(nblocks[nblocks.length - 1][1]);
      if (h && typeof h.reports === "number" && Array.isArray(h.dailyReports)) holding = h;
    } catch {}
  }
  // What this turn wrote (the page re-reads on it) — the LAST complete block, like HUD.
  let wrote: AgentWrote | null = null;
  const wre = new RegExp(WROTE_OPEN + "([\\s\\S]*?)" + WROTE_CLOSE, "g");
  const wblocks = [...full.matchAll(wre)];
  if (wblocks.length) {
    try {
      const w = JSON.parse(wblocks[wblocks.length - 1][1]);
      if (w && Array.isArray(w.actions)) wrote = { actions: w.actions.filter((a: unknown) => typeof a === "string") };
    } catch {}
  }
  // Transient tool-status ("Searching…"): show ONLY when it's the most recent thing in the stream
  // (nothing meaningful streamed after it yet), so it appears during the silent tool call and clears
  // the moment the agent's reply resumes.
  // Screen moves (item 6) are performed by the stream loop (screenBlocks); here they are only
  // stripped from the words, like every other block.
  const sre = new RegExp(SCREEN_OPEN + "([\\s\\S]*?)" + SCREEN_CLOSE, "g");
  let status: string | null = null;
  const lastClose = full.lastIndexOf(STATUS_CLOSE);
  if (lastClose >= 0) {
    const after = full.slice(lastClose + STATUS_CLOSE.length).replace(dre, "").replace(hre, "").replace(nre, "").replace(wre, "").replace(sre, "").trim();
    if (!after) {
      const sb = [...full.matchAll(new RegExp(STATUS_OPEN + "([\\s\\S]*?)" + STATUS_CLOSE, "g"))];
      try { status = JSON.parse(sb[sb.length - 1][1]).label ?? null; } catch {}
    }
  }
  let text = full.replace(dre, "").replace(hre, "").replace(nre, "").replace(wre, "").replace(sre, "").replace(new RegExp(STATUS_OPEN + "([\\s\\S]*?)" + STATUS_CLOSE, "g"), "");
  // Drop a half-arrived draft/card/status/holding/wrote/screen block at the tail so raw JSON never flashes on screen.
  for (const m of [DRAFT_OPEN, HUD_OPEN, STATUS_OPEN, HOLDING_OPEN, WROTE_OPEN, SCREEN_OPEN]) {
    const p = text.indexOf(m);
    if (p >= 0) text = text.slice(0, p);
  }
  text = text.split(CONFIRM_MARKER)[0].split(OPEN_MARKER)[0].split(PICK_MARKER)[0];
  return { text, draft, card, status, holding, wrote };
}

/** The Estimator — the live estimate building in front of you (the assistant's preview box). */
function LiveQuote({ draft, onSave, onDismiss, saving, lang }: { draft: AgentDraft; onSave: () => void; onDismiss: () => void; saving: boolean; lang: Lang }) {
  const t = translator(lang);
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
        <span className="text-[10px] font-bold uppercase tracking-wide text-brand">{t("nt_estimator")}</span>
        <span className="min-w-0 truncate font-normal text-slate-500">· {draft.title || t("nt_newEstimate")}</span>
        {draft.customer_name ? <span className="truncate font-normal text-slate-400">· {draft.customer_name}</span> : null}
        {/* Always give the user a way to clear the preview off the screen — an
            already-saved or abandoned estimate should never be stuck here. */}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("nt_clearPreviewAria")}
          title={t("nt_clearPreviewTitle")}
          className="ml-auto shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="max-h-40 divide-y divide-slate-100 overflow-y-auto px-3 text-xs">
        {items.length === 0 ? (
          <li className="py-2 text-slate-400">{t("nt_building")}</li>
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
        <div className="flex justify-between text-slate-500"><span>{t("nt_subtotal")}</span><span>{money(subtotal)}</span></div>
        {draft.tax_rate ? <div className="flex justify-between text-slate-500"><span>{t("nt_tax")}</span><span>{money(tax)}</span></div> : null}
        <div className="flex justify-between text-sm font-semibold text-slate-900"><span>{t("nt_total")}</span><span>{money(total)}</span></div>
      </div>
      <div className="p-2">
        <Button onClick={onSave} disabled={saving || items.length === 0} className={`w-full ${ready ? "bg-green-600 hover:bg-green-500" : ""}`}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : ready ? t("nt_saveEstimate") : t("nt_saveDraft")}
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
/** `screen`: the turn could have carried screen steps (see screenStepsPossible). A marker written before
 *  this field existed has none, and counts as yes: the sentence is the safe side. */
type PendingTurn = { content: string; at: string; voice: boolean; screen?: boolean };
function readPendingTurn(): PendingTurn | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingTurn>;
    if (!p?.content || !p?.at || Date.now() - Date.parse(p.at) > PENDING_MAX_AGE_MS) {
      localStorage.removeItem(PENDING_KEY);
      return null;
    }
    return { content: p.content, at: p.at, voice: !!p.voice, screen: p.screen !== false };
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
// (cn-v1138) Each line is a catalog KEY (lib/words/nort) and is read through t() the moment it is
// shown, so a tech sees it in Spanish; the English stands in the catalog, byte for byte as it was.
const DROPPED_KEY = "nt_dropped";
/** Offline is a different fact from "dropped": nothing can be checked right now, and saying so at
 *  once beats a probe that cannot succeed. Reload is still the door — the server keeps the turn. */
const OFFLINE_KEY = "nt_offline";
/** The reload-time versions. The question text is deliberately not echoed by any of them: the
 *  marker is per-device, the reply lookup is per-user — only a found reply proves the question was
 *  this user's. Offline, the lookup never ran, so "didn't get an answer" would be a guess. */
const RELOAD_OFFLINE_KEY = "nt_reloadOffline";
/** Young marker, nothing on the server yet: the route's turn may still be running (a web search
 *  round is silent for a while), so Reload stays a live door. */
const RELOAD_PENDING_KEY = "nt_reloadPending";
/** The server's turn is over and there is nothing: the only honest door left is asking again. */
const RELOAD_UNANSWERED_KEY = "nt_reloadUnanswered";
/** HOW LONG A RECOVERED MONEY PROPOSAL MAY STILL BE ANSWERED. The confirm marker is the last
 *  thing in the stream, so a drop in that half-second used to lose the Yes/No card for good: the
 *  recovery path reads the persisted reply, and that text is marker-stripped. The route now
 *  persists the proposal WITH the turn, stamped with the moment it was made — and this is the
 *  window in which the card may come back. Ten minutes: long enough to cover a tunnel, a locked
 *  phone or a cold reload, short enough that a $340 bill can never resurface after the user has
 *  moved on and forgotten what they were approving. Deliberately inside the 15-minute pending-turn
 *  marker above, so a proposal can never outlive the turn that carries it. Past the window the
 *  proposal is NOT re-offered — the turn is shown and the user is told to ask again. */
const RECOVERED_CONFIRM_MAX_AGE_MS = 10 * 60_000;
const EXPIRED_CONFIRM_KEY = "nt_expiredConfirm";
/** A RECOVERED REPLY IS THE WORDS ONLY. The typing and pointing Nort did rode the stream as screen
 *  blocks (show_screen / fill_screen) and the route persists none of them, so after a drop the saved
 *  sentence ("Put that in the visit notes") can describe a box that was never typed into. Whether
 *  a block was lost is not knowable from here, so it is said as what it is — it may not have run —
 *  with the one thing to do about it. Written for the eyes and the ears alike (it is read out too). */
const SCREEN_STEPS_LOST_KEY = "nt_screenStepsLost";

/** COULD THIS TURN HAVE CARRIED SCREEN STEPS? Only then is the sentence above true to say: a plain
 *  question on a page Nort has no screen entry for (his own chat) typed nothing and pointed at
 *  nothing, and a line about a screen that was never touched, read aloud, is noise. It could when the
 *  page listed boxes Nort may type into (the `doors` the request carried), or when the page is one of
 *  the registry's screens (lib/nort/screens), where he can ring a spot. */
const SCREEN_ROOTS = new Set(SCREENS.map((s) => s.path.split("/")[1]));
export function screenStepsPossible(pathname: string, doorCount: number): boolean {
  return doorCount > 0 || SCREEN_ROOTS.has(pathname.split("/")[1] ?? "");
}

/** WHICH FILL MAY NOT RUN. A fill lands on the screen its boxes were listed from (skeptic #16, M1).
 *  Two ways that screen is gone: it already moved (the person's own tap, or a show_screen that
 *  committed), or THIS turn's earlier block just moved it — router.push has not committed when the
 *  next block in the same pass is read, so the pathname still says the old page and the old page's
 *  boxes are still mounted. Returns the line the next turn carries to the server (what did NOT
 *  happen), or null when the fill may run. A block that carries its own path moves first and waits
 *  for the page, so it is never refused here. */
export function refuseStaleFill(step: AgentScreen, pathNow: string, pathAtSend: string, movedThisTurn: boolean): string | null {
  const typing = step.fill ?? step.add;
  if (!typing || step.path) return null;
  if (pathNow !== pathAtSend) return `${typing.door}: NOT filled — the screen moved from ${pathAtSend} to ${pathNow} since its boxes were listed; use the next turn's list`;
  if (movedThisTurn) return `${typing.door}: NOT filled — this same turn moved the screen on from ${pathAtSend}, where its boxes were listed; use the next turn's list`;
  return null;
}

/** A box Nort named that is not on the screen: said under the chat in plain words. The door's NAME
 *  is never shown — it carries record ids (task-hours-<uuid>, need-q_xxx) — and one action is named. */
export const MISSING_BOX_KEY = "nt_missingBox";
/** The English line (what the tests pin); the screen reads the key through t(), in the person's language. */
export const MISSING_BOX_NOTE = dict("en")[MISSING_BOX_KEY];

/** A spot Nort pointed at that never showed. The anchor name is for the page, not the person: with
 *  no label from the model it is "that spot", never the raw name. */
export function spotMissNote(label?: string | null, lang: Lang = "en"): string {
  const t = translator(lang);
  return fillText(t("nt_spotMiss"), { spot: label?.trim() || t("nt_thatSpot") });
}

/** A recovered turn arrives as the persisted reply, which may END with the confirm envelope the
 *  dropped stream never delivered. Split it: the text the user reads, and the proposal to put back
 *  on screen. Nothing here RUNS anything — the card's Yes still goes through confirmAgentAction,
 *  which re-checks the allow-list, the role gate and the action's own schema server-side. An
 *  envelope we cannot read counts as stale — a proposal nobody can answer, said out loud rather
 *  than left as a question on screen with no buttons under it. */
function splitRecovered(reply: string): { text: string; confirm: AgentConfirm | null; stale: boolean } {
  const cut = reply.indexOf(CONFIRM_MARKER);
  if (cut < 0) return { text: reply, confirm: null, stale: false };
  const text = reply.slice(0, cut);
  const parsed = directivePayload<Partial<AgentConfirm> & { at?: string }>(reply, CONFIRM_MARKER);
  const ok = !!parsed && typeof parsed.name === "string" && !!parsed.name
    && typeof parsed.prompt === "string" && !!parsed.prompt
    && !!parsed.input && typeof parsed.input === "object";
  if (!ok) return { text, confirm: null, stale: true };
  const at = Date.parse(parsed!.at ?? "");
  // An envelope with no usable stamp is treated as stale: an unanswerable age is not a young age.
  const stale = !Number.isFinite(at) || Date.now() - at > RECOVERED_CONFIRM_MAX_AGE_MS;
  return {
    text,
    confirm: stale ? null : { name: parsed!.name!, input: parsed!.input as Record<string, unknown>, prompt: parsed!.prompt! },
    stale,
  };
}

/** The assistant line(s) a recovered turn becomes. A turn that only PROPOSED has no sentence of
 *  its own, so the read-back is the line — exactly what the live path shows when the reply is the
 *  proposal. An expired proposal says so on its own line: nothing silent. */
export function recoveredLines(r: { text: string; confirm: AgentConfirm | null; stale: boolean }, screen = true, lang: Lang = "en"): Msg[] {
  const t = translator(lang);
  const expired = t(EXPIRED_CONFIRM_KEY);
  const body = r.text.trim();
  const head = body || r.confirm?.prompt || expired;
  const lines: Msg[] = [{ role: "assistant", content: head }];
  if (r.stale && head !== expired) lines.push({ role: "assistant", content: expired });
  // A recovered reply is a stream that did not finish: the screen steps in it, if it could have carried
  // any (`screen`: screenStepsPossible, asked when the turn left), are not known to have run.
  if (screen) lines.push({ role: "assistant", content: t(SCREEN_STEPS_LOST_KEY) });
  return lines;
}

/** Every residual line the recovery paths can leave. A restored transcript loses the `hint`
 *  (saveConversation keeps role + content only), so content is how a residual line is recognised
 *  again after a reload — it is REPLACED by the next attempt's line, never stacked under it. */
const RESIDUAL_KEYS = [DROPPED_KEY, OFFLINE_KEY, RELOAD_OFFLINE_KEY, RELOAD_PENDING_KEY, RELOAD_UNANSWERED_KEY];
// In both languages: a restored transcript may hold a line written under the other one.
const RESIDUAL_SENTENCES = new Set(RESIDUAL_KEYS.flatMap((k) => [dict("en")[k], dict("es")[k]]));
function dropResidualTail(list: Msg[]): Msg[] {
  const last = list[list.length - 1];
  return last?.role === "assistant" && RESIDUAL_SENTENCES.has(last.content.trim()) ? list.slice(0, -1) : list;
}
/** One residual line at the tail — replacing the previous attempt's, so a second reload never
 *  reads as a second failure. */
function withResidual(list: Msg[], line: Msg): Msg[] {
  return [...dropResidualTail(list), line];
}

/** THE FIRST QUESTIONS OFFERED on an empty chat (cn-v1138): a tech's are a tech's — clock in, the
 *  day's list, the materials list — and the office keeps its money ones; both in the person's
 *  language. An unknown role is shown the tech's: nothing about invoices to someone the page
 *  could not place. */
export function suggestionsFor(role: string | null | undefined, lang: Lang): string[] {
  const t = translator(lang);
  return isStaffRole(role)
    ? [t("nt_sugOffice1"), t("nt_sugOffice2"), t("nt_sugOffice3"), t("nt_sugOffice4")]
    : [t("nt_sugTech1"), t("nt_sugTech2"), t("nt_sugTech3"), t("nt_sugTech4")];
}

/** The door a dropped-connection line names: the shell has no address bar and no pull-to-refresh,
 *  so "Reload" has to be a thing you can tap. */
function ReloadDoor({ lang }: { lang: Lang }) {
  const t = translator(lang);
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="ml-1.5 inline-flex items-center rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-brand hover:bg-brand-light/40"
    >
      {t("nt_reload")}
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

export function AssistantChat({
  autoStart = false,
  glass = false,
  initialQuery,
  role = null,
}: {
  autoStart?: boolean;
  glass?: boolean;
  initialQuery?: string;
  /** profiles.role, from the shell (topbar → GlobalAssistant): the first suggestions are a tech's or the office's by it (cn-v1138). */
  role?: string | null;
} = {}) {
  // THE PERSON'S LANGUAGE (cn-v1138): every word this panel shows or says comes through t() and the
  // nt_ catalog; the mic is started with it (voice-stream's hint; the profile wins server-side).
  const lang = useLang();
  const t = translator(lang);
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

  // Publish the live estimate + speaking state to the shared store, so what lives outside this
  // drawer (the top bar's Stop Nort, the collapsed ESTIMATOR summary) sees it even while it's closed.
  useEffect(() => { estimatorStore.setDraft(draft); }, [draft]);
  useEffect(() => { estimatorStore.setCard(card); }, [card]);
  useEffect(() => { estimatorStore.setSpeaking(speaking); }, [speaking]);
  useEffect(() => { estimatorStore.setStreaming(streaming); }, [streaming]);
  // Publish listening too, so Search Or Ask turns into the red Stop Nort whenever the mic is hot
  // (not just while thinking/talking) — the bar's one voice control while Nort works.
  useEffect(() => { estimatorStore.setListening(listening); }, [listening]);
  // Tear the voice session down on unmount (close), so a live recognizer + any in-flight speech
  // (streaming queue / barge-in monitor) never outlive the panel.
  useEffect(() => () => {
    trace("panel unmounted", typeof window !== "undefined" ? window.location.pathname : ""); // the unlock-stop hunt (2026-10-15)
    speech.stopListening({ discard: true }); // the panel is gone — a half-recorded turn goes nowhere
    speech.setResultHandler(null);
    try { bargeStopRef.current?.(); } catch {}
    try { speakQueueRef.current?.stop(); } catch {}
    stopSpeaking();
    estimatorStore.setListening(false);
    estimatorStore.setSpeaking(false);
    estimatorStore.setStreaming(false);
  }, []);
  // Stop Nort in the top bar (and Close / Collapse, which dispatch this) fully ends the turn: abort the
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

  // Talk To Nort (the first row under Search Or Ask) is the ONLY way the voice starts now (no in-panel
  // mic). When the panel is already open, its tap ALREADY (re)started the mic in-gesture (cn:nort-talk →
  // launch → speech.startListening) — here we just enter voice mode + point the next transcript at a
  // normal spoken turn.
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
  // THE PAGE FOLLOWS A WRITE, with RefreshOnVisible's guards (skeptic #29, 2026-10-19). A refresh
  // whose fetch fails is a FULL navigation in Next (fetch-server-response → mpaNavigation), which
  // unmounts the chat and ends a voice session — the one thing a punch made from a locked screen
  // must never cause. So: never offline; never under an open sheet (its back gesture breaks, the
  // same rule RefreshOnVisible follows); and while the screen is dark, once, the moment it comes
  // back. The fence it mounts waits that long — before this it waited for the next navigation.
  const refreshWhenVisibleRef = useRef(false);
  const refreshIfClear = () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (document.body.classList.contains("modal-open")) return;
    router.refresh();
  };
  const followWrite = () => {
    if (document.visibilityState !== "visible") { refreshWhenVisibleRef.current = true; return; }
    refreshIfClear();
  };
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !refreshWhenVisibleRef.current) return;
      refreshWhenVisibleRef.current = false;
      refreshIfClear();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);
  // Screen moves performed so far THIS turn (item 6): every complete block is performed exactly
  // once, in order, as it lands — the count resets with the stream.
  const screenDoneRef = useRef(0);
  // A spot Nort pointed at that never showed (item 6): said under the chat for a few seconds, and
  // the box comes back from the bar so the words are seen — never a silent miss.
  const [missNote, setMissNote] = useState<string | null>(null);
  const missTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whatever Nort parked the box for, this needs eyes on the box: bring it back. */
  const openBox = () => window.dispatchEvent(new CustomEvent("cn:assistant-box", { detail: { box: "open" } }));
  const lastCardRef = useRef<string>("");
  // WHAT LANDED (rung 2): each fill's own word — landed, refused, no such box — kept until the next
  // turn carries it to the server as context, so Nort answers a refusal and never types a note twice.
  const seenRef = useRef<string[]>([]);
  /** The screen the turn's door list was read on: a fill lands only there (skeptic #16, M1). */
  const turnPathRef = useRef<string>("");
  /** A line under the chat for a few seconds (a miss, a refusal), and the box back so it is seen. */
  const noteUnder = (text: string) => {
    setMissNote(text);
    if (missTimerRef.current) clearTimeout(missTimerRef.current);
    missTimerRef.current = setTimeout(() => setMissNote(null), 8000);
    openBox();
  };

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
        setSaved((sv) => [...sv, { id: res.id!, title: draft.title || t("nt_estimate"), total, customer: draft.customer_name ?? undefined }]);
        setDraft(null);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: res.error ? fillText(t("nt_couldntSaveWhy"), { why: res.error }) : t("nt_couldntSaveQuote") }]);
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
  // Held in refs so the Stop Nort / stopVoice paths can tear them down deterministically.
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
  function say(text: string, after?: (heard: boolean) => void) {
    setSpeaking(true);
    speech.setMuted(true);
    speakSmart(text, (heard) => {
      setSpeaking(false);
      speech.setMuted(false);
      after?.(heard);
    });
  }

  /** The confirm question was said — or could not be (a lost clip with the screen dark, 2026-10-15):
   *  listen for the yes only when it was HEARD. A question nobody heard must not gate a write on a
   *  stray word. Unheard, the card waits on screen and the question is asked again the moment the
   *  screen comes back, while it is still the one pending. */
  function confirmAfterSaid(heard: boolean) {
    if (!voiceModeRef.current || !confirmRef.current) return;
    if (heard) { confirmListen(); return; }
    trace("confirm unheard");
    const pending = confirmRef.current;
    const again = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", again);
      if (confirmRef.current !== pending || !voiceModeRef.current) return;
      say(pending.prompt, (h) => { if (h && confirmRef.current === pending) confirmAfterSaid(true); });
    };
    document.addEventListener("visibilitychange", again);
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

  // Voice-first: the Talk To Nort tap ALREADY started the mic in-gesture (cn:nort-talk → global-assistant
  // launch → speech.startListening) — iOS only honors a start inside the gesture. So here we just enter
  // voice mode (do NOT start the mic from this post-commit effect; iOS would reject it).
  useEffect(() => {
    if (!autoStart) return;
    setVoiceMode(true);
    // The mic was started in-gesture by the Talk To Nort tap. If it took, mirror "listening". The stream
    // backend narrates its own start ("Connecting to the mic…", then ready, blocked, or not
    // answering), and onStatus replays the line it is on, so writing over it here is what left
    // "Tap the mic to answer" on screen in a panel that has no mic button. Only the fallback
    // backend, which says nothing, gets a line from here.
    if (speech.isListening()) setListening(true);
    else if (!speech.usingStreamBackend()) setStatus(speech.speechSupported() ? t("nt_tryAgainLine") : t("nt_noVoiceLine"));
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
    setStatus(t("nt_catchingUp"));
    const reply = await fetchRecoveredReply(p.content, p.at, turnOver ? 1 : 3, ctrl.signal);
    if (ctrl.signal.aborted) return; // STOP / Close / a new question owns the screen now — say nothing
    catchUpAbortRef.current = null;
    setStatus(null);
    if (reply) {
      clearPendingTurn(p.at);
      const q = p.content.trim();
      // THE PROPOSAL THE TAIL BYTES NEVER DELIVERED. A confirm-gated turn ends with the marker,
      // so a drop in that half-second left a money read-back on screen with no Yes and no No.
      // The route persists the proposal with the turn, so it comes back here: the card is put
      // back, still gated — nothing runs until the user says yes, and the yes still goes through
      // the server-side gate.
      const rec = splitRecovered(reply);
      const lines = recoveredLines(rec, p.screen !== false, lang);
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
          return [...cur.slice(0, ui + 1), ...lines];
        }
        // The question never reached the transcript (the reload came before the stream ended, or
        // the drawer opened fresh): the pair is appended — over any residual line a prior attempt left.
        return [...dropResidualTail(cur), { role: "user", content: p.content }, ...lines];
      });
      // A recovered proposal is re-ARMED, never re-run: this only puts the card back on screen.
      if (rec.confirm) {
        confirmRef.current = rec.confirm;
        setPendingConfirm(rec.confirm);
      }
      // Opened by Talk To Nort: the turn is read out, as it would have been. With a proposal
      // waiting, what gets read is the read-back — and the mic re-opens for yes or no, the same
      // explicit human answer the live path waits for.
      if (autoStart) {
        const spoken = lines.map((l) => l.content).join(" ").replace(/\s*\[[^\]]*\]\s*$/, "");
        // DROP THE MIC BEFORE SPEAKING, as the live paths do (the cn-v980 crackle fix). Talk To Nort
        // opened the mic in its tap, so it can still be recording a turn when this missed reply
        // lands — and say() only drops a mic that is BETWEEN turns (voice-stream setMuted), so on
        // iOS 27 this one reply played through a live capture and crackled. A live reply never
        // meets that (its turn already ended), and resolveConfirm stops listening first; so does
        // this. The re-arm after the reply (startMic / confirmListen) opens the mic again.
        speech.stopListening({ discard: true });
        setListening(false);
        if (rec.confirm) say(rec.confirm.prompt, confirmAfterSaid);
        else say(spoken, () => { if (voiceModeRef.current) startMic(); });
      }
    } else {
      const offline = isOffline();
      // Online, and the server's turn is provably over with nothing there: the marker would only
      // re-ask on every open for the rest of its 15 minutes and find the same nothing. Offline, or
      // with the turn possibly still running, it stays — Reload is a live door in both.
      if (!offline && turnOver) clearPendingTurn(p.at);
      const line: Msg = offline
        ? { role: "assistant", content: t(RELOAD_OFFLINE_KEY), hint: "reload" }
        : turnOver
          ? { role: "assistant", content: t(RELOAD_UNANSWERED_KEY) }
          : { role: "assistant", content: t(RELOAD_PENDING_KEY), hint: "reload" };
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
    // The controller Stop Nort reaches during a drop-recovery loop. The fetch's own is
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
      trace("chat dropped", why);
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
    // Asked as the turn leaves: a drop later recovers the words only, and the sentence about lost screen
    // steps is said only for a turn that could have had any (the marker carries it across a reload).
    const screenTurn = screenStepsPossible(window.location.pathname, listNortDoors().length);
    writePendingTurn({ content, at: sentAt, voice: viaVoice, screen: screenTurn });
    trace("chat sent", viaVoice ? "voice" : "typed");
    const seenNow = seenRef.current.slice();
    turnPathRef.current = window.location.pathname;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: abortRef.current.signal,
        headers: { "Content-Type": "application/json" },
        // Round-trip the LIVE draft (restored or in-progress) so resuming an estimate CONTINUES
        // from what's on screen instead of restarting it, + the current page so "this job"/"this
        // invoice" resolves. The route injects both at the cache-safe message tail.
        // greeted: the spoken greeting named what Nort holds and asked "want them now?" — this
        // message is the answer, so the server must not ask again (0394).
        // version: the build THIS bundle carries — whats_new tells the person whether the phone is behind.
        // doors + seen (rung 2): the boxes on this screen Nort may type into, and what his last
        // fills came to — both from the page's own registry, read at send time. The seen lines are
        // cleared only once the server has them (a refused turn keeps them for the next).
        body: JSON.stringify({ messages: next, voice: viaVoice, draft, path: window.location.pathname, greeted: consumeGreeted(), version: APP_VERSION, doors: listNortDoors(), seen: seenNow }),
      });

      trace("chat answered", `HTTP ${res.status}`);
      if (res.ok) seenRef.current = seenRef.current.slice(seenNow.length);
      if (!res.ok || !res.body) {
        turnSettled = true; // the route refused the turn — there is no reply to come back for
        const errText = await res.text().catch(() => t("nt_requestFailed"));
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
      screenDoneRef.current = 0;
      // Did an earlier block of THIS turn move the screen? Its push has not committed when the next
      // block is read (the location still says the old page), so the guard below needs to be told.
      let movedThisTurn = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastByteAt = Date.now();
        full += decoder.decode(value, { stream: true });
        const { text: visible, draft: liveDraft, card: liveCard, status: liveStatus, holding: liveHolding } = parseStream(full);
        // NORT DRIVES THE SCREEN (item 6): perform each new block once, in order, the moment it is
        // complete — the chat stays mounted across the push (it lives in the app layout), so the
        // stream and the voice carry on while the page changes under them.
        const moves = screenBlocks(full);
        while (screenDoneRef.current < moves.length) {
          const step = moves[screenDoneRef.current++];
          // A FILL LANDS ON THE SCREEN ITS BOXES WERE LISTED FROM. If the screen moved since the turn
          // was sent (the person's own tap, a show_screen that committed, or one earlier in THIS
          // turn whose push has not committed yet), the door names Nort holds belong to the page that
          // is leaving — refused and said, never typed into the wrong visit; the next turn lists the
          // new screen's boxes (skeptic #16, M1).
          const stale = refuseStaleFill(step, window.location.pathname, turnPathRef.current, movedThisTurn);
          if (stale) {
            seenRef.current.push(stale);
            noteUnder(t("nt_screenChanged"));
            if (viaVoice) say(t("nt_screenChangedSay"));
            continue;
          }
          try {
            const did = performScreen(
              step,
              { here: () => window.location.pathname + window.location.search, push: (p) => router.push(p) },
              window,
              {
                onMiss: (s) => {
                  setMissNote(spotMissNote(s.label, lang));
                  if (missTimerRef.current) clearTimeout(missTimerRef.current);
                  missTimerRef.current = setTimeout(() => setMissNote(null), 8000);
                  openBox();
                  seenRef.current.push(`${s.anchor ?? "a spot"}: not on this screen`);
                },
                // A fill's word (rung 2): landed = the rung box says it; refused or missing = said
                // here AND spoken by voice, since the reply may already have claimed it (skeptic #16, M7).
                onDoor: (o) => {
                  if (o.result.ok) seenRef.current.push(`${o.door}: landed — ${o.result.landed}`);
                  else {
                    seenRef.current.push(`${o.door}: NOT filled — ${o.result.why}`);
                    const words = "missing" in o.result ? t(MISSING_BOX_KEY) : fillText(t("nt_couldntPutIn"), { why: o.result.why });
                    noteUnder(words);
                    if (viaVoice) say("missing" in o.result ? t("nt_missingBoxSay") : fillText(t("nt_didntGoIn"), { why: o.result.why }));
                  }
                },
              },
            );
            if (did.moved) movedThisTurn = true;
          } catch {
            /* a point not made is not a broken turn */
          }
        }
        // The server's own count of what Nort still holds: the ring and the next greeting take it now.
        if (liveHolding) setNortHolding(liveHolding);
        // `cleared` = the agent just saved the estimate → wipe the preview so it stops
        // anchoring the conversation. Otherwise the quote fills in live as blocks arrive.
        if (liveDraft) setDraft((liveDraft as { cleared?: boolean }).cleared ? null : liveDraft);
        // The driver HUD card fills the glass as its block arrives; cleared:true clears it.
        if (liveCard) setCard(liveCard.cleared ? null : liveCard);
        // A NEW card is for the eyes: a box Nort parked as a bar comes back for it (item 6).
        if (liveCard && !liveCard.cleared) {
          const key = JSON.stringify(liveCard);
          if (key !== lastCardRef.current) {
            lastCardRef.current = key;
            openBox();
          }
        }
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

      const settled = parseStream(full);
      // THE PAGE FOLLOWS A WRITE (2026-10-19): a punch Nort made changes what the layout mounts (the
      // site fence reads the open entry) and what the clock screens show, and neither followed until
      // the next navigation. The server names what ran and said ok (WROTE); the page re-reads once,
      // under followWrite's guards. The chat lives in the app layout and stays mounted, so the reply
      // and the voice carry on.
      if (settled.wrote?.actions.length) followWrite();
      // Directive markers (confirm / open-maps / contact-pick) come at the very end of the stream.
      const visibleText = settled.text;
      // Each envelope is read up to the next block (directivePayload): the holding count rides at
      // the end of every turn, and reading the envelope "to the end of the stream" swallowed it —
      // no card, no spoken question, a plain-turn mic, and a "frozen" Nort on the lock screen.
      const proposal = directivePayload<AgentConfirm>(full, CONFIRM_MARKER);
      const openDir = directivePayload<AgentOpen>(full, OPEN_MARKER);
      const pickDir = directivePayload<AgentPick>(full, PICK_MARKER);

      // A directive at the tail changes what we SAY (a specific phrase, not the streamed body). If we
      // opened a streamed speaker for the body, cut it now so we don't double-speak, then say the
      // directive phrase. A plain reply instead flushes its remainder and finishes the stream in order.
      const hasDirective = !!(pickDir || openDir?.url || proposal);
      if (viaVoice && hasDirective) killSpeech();
      // A picker or a money confirm card must be SEEN: a box Nort parked as a bar comes back (item 6).
      if (pickDir || proposal) openBox();

      if (pickDir) {
        // The assistant asked the user to pick a contact on screen — pop the picker; their choice
        // comes back as the next message (handled by onPickContact below).
        setPendingPick(pickDir);
        if (viaVoice) say(t("nt_pickContactSay"));
      } else if (openDir?.url) {
        // Hands-free navigation: say it, then open Maps (keep the app if the browser lets us).
        if (viaVoice) say(fillText(t("nt_openingMaps"), { label: openDir.label }), () => { if (voiceModeRef.current) startMic(); });
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
        if (viaVoice) say(proposal.prompt, confirmAfterSaid);
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
        abortRef.current = recoverAbort; // what Stop Nort aborts from here on
        if (!recoveredEarly && !isOffline()) setStatus(t("nt_droppedCatchingUp"));
        const reply = recoveredEarly ?? (await fetchRecoveredReply(content, sentAt, tries, recoverAbort.signal));
        if (recoverAbort.signal.aborted) {
          // STOP mid-catch-up: no line lands after the user said stop. Same as a stop mid-stream —
          // what streamed stays, an empty placeholder goes, the marker stays.
          dropEmptyTail();
        } else {
          setStatus(null);
          if (reply) {
            turnSettled = true;
            // A confirm-gated turn puts the proposal in the LAST bytes of the stream — exactly the
            // bytes a drop eats. The route persists it with the turn, so it comes back with the
            // reply and the Yes/No card goes back on screen instead of a money read-back nobody
            // can answer. Re-armed, never re-run: the yes still runs the server-side gate.
            const rec = splitRecovered(reply);
            const lines = recoveredLines(rec, screenTurn, lang);
            const head = lines[0].content;
            setAssistantTail(head);
            if (lines.length > 1) setMessages((m) => [...m, ...lines.slice(1)]);
            if (rec.confirm) {
              confirmRef.current = rec.confirm;
              setPendingConfirm(rec.confirm);
            }
            if (viaVoice) {
              // With a proposal waiting, read the read-back and listen for yes or no — the same
              // explicit human answer the live path waits for, never an automatic one.
              if (rec.confirm) say(rec.confirm.prompt, confirmAfterSaid);
              else {
                const unspoken = stripTrailingTag(partial && head.startsWith(partial) ? head.slice(spokenLen) : head).trim();
                // The rest of the recovered lines are read out too (the screen steps that may not have
                // run), so a reply that sounds like a deed is never the last thing heard after a drop.
                const tail = lines.slice(1).map((l) => l.content).join(" ");
                const toSay = [unspoken, tail].filter(Boolean).join(" ");
                if (toSay) say(toSay, () => { if (voiceModeRef.current) startMic(); });
                else if (voiceModeRef.current) startMic();
              }
            }
          } else {
            // Nothing on the server (yet) — or no way to ask it. The residual sentence names the
            // true state (offline vs dropped) and both doors. The marker stays (turnSettled is
            // still false): the Reload it names only checks while the marker exists.
            const offline = isOffline();
            const sentence = t(offline ? OFFLINE_KEY : DROPPED_KEY);
            if (partial.trim()) setMessages((m) => [...m, { role: "assistant", content: sentence, hint: "reload" }]);
            else setAssistantTail(sentence, "reload");
            if (viaVoice) {
              say(t(offline ? "nt_offlineSay" : "nt_droppedSay"), () => { if (voiceModeRef.current) startMic(); });
            }
          }
        }
      }
    } finally {
      trace("chat finished", `${turnSettled ? "settled" : "unsettled"}${dropReason ? ` after ${dropReason}` : ""}${recoveredEarly ? " recovered" : ""}`);
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
      // A TURN may have handed over what Nort was holding (read_my_updates runs in /api/chat, not
      // in a confirm): the Bell re-reads once the turn has settled, so his ring and the next
      // greeting stop saying "holding" (0394; audit v1120, class 7).
      if (turnSettled) { try { window.dispatchEvent(new Event("cn:bell-refresh")); } catch {} }
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
    if (!speech.startListening(localeOf(lang))) setStatus(speech.speechSupported() ? t("nt_tryAgainLine") : t("nt_noVoiceLine"));
  }

  // Enter voice mode from the text composer's Talk button. (Leaving is the Stop button →
  // stopVoice.)
  function startVoice() {
    if (voiceModeRef.current) { stopVoice(); return; }
    // Prime iOS audio INSIDE this tap so the reply can be spoken after the round-trip.
    try {
      const synth = window.speechSynthesis;
      // Not in the app: priming the in-process browser voice fights WebKit for the speaker (see tts quietBrowserVoice).
      if (synth && !isNativeShell()) { const w = new SpeechSynthesisUtterance(" "); w.volume = 0; synth.speak(w); }
    } catch {}
    unlockAudio();
    void standDownReaderForVoice(); // the Tap to Pay reader and Nort's voice don't share the phone (native-tap)
    setVoiceMode(true);
    if (confirmRef.current) confirmListen(); // a proposal is waiting → hear yes/no
    else startMic();
  }

  // Listen for a spoken reply to a pending confirm proposal (the service routes the transcript here).
  // Handles corrections, not just yes/no — see classifyConfirmReply.
  function confirmListen() {
    speech.setResultHandler((heard) => {
      const intent = classifyConfirmReply(heard);
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
        void send(heard, true);
      } else {
        // Unclear — re-prompt, then listen again (only while a proposal is still pending).
        say(t("nt_sayYesOrNo"), confirmAfterSaid);
      }
    });
    if (!speech.startListening(localeOf(lang))) setStatus(speech.speechSupported() ? t("nt_tryAgainLine") : t("nt_noVoiceLine"));
  }

  // Resolve a pending confirm: run it (yes) or drop it (no). Nothing wrote until here.
  async function resolveConfirm(yes: boolean) {
    const c = confirmRef.current;
    confirmRef.current = null;
    setPendingConfirm(null);
    // The yes/no is decided: the half-turn goes nowhere, but the CONVERSATION stays — a stop tore
    // down the native session the screen-off design lives on (audit v1120, class 4), so the reply
    // after a spoken yes played through the page and the next turn needed a tap. dropTurn keeps
    // the session (and the web's live stream) for say() and startMic.
    speech.dropTurn();
    setListening(false);
    if (!c) return;
    if (!yes) {
      setMessages((m) => [...m, { role: "assistant", content: t("nt_skippedThat") }]);
      if (voiceModeRef.current) say(t("nt_skippedThatSay"), () => { if (voiceModeRef.current) startMic(); });
      return;
    }
    setStreaming(true);
    try {
      const res = await confirmAgentAction(c.name, c.input);
      // A confirmed action is always a write: the page re-reads (a closed punch stands the fence down).
      if (res.ok) followWrite();
      const msg = res.message || (res.ok ? t("nt_done") : t("nt_didntWork"));
      setMessages((m) => [...m, { role: "assistant", content: (res.ok ? "✓ " : "") + msg }]);
      if (voiceModeRef.current) say(msg, () => { if (voiceModeRef.current) startMic(); });
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: t("nt_didntWork") }]);
    } finally {
      setStreaming(false);
      scrollToBottom();
      // A turn may have handed over what Nort was holding (read_my_updates): the Bell re-reads now,
      // so his ring and the next greeting do not keep saying "holding" for up to a minute (0394).
      try { window.dispatchEvent(new Event("cn:bell-refresh")); } catch {}
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
  // A spot Nort could not find reads here (item 6), under a live tool status, over the idle words.
  const statusText = status ?? missNote ?? (streaming ? (tokens > 2 ? t("nt_responding") : t("nt_thinking")) : listening ? t("nt_listening") : speaking ? t("nt_talking") : null);
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
          a one-line text box, then one line per conversation turn expanding down. No header/footer
          chrome; Talk To Nort (under Search Or Ask) starts the voice and the top bar's Stop Nort
          ends it, and the panel handle moves/collapses it. */}
      {glass && (
        <div className="flex min-h-0 flex-1 flex-col">
          {draft && (
            <div className="shrink-0">
              <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
                <FileText className="h-4 w-4 shrink-0 text-brand" />
                <span className="truncate text-sm">
                  <span className="font-semibold text-brand">{t("nt_estimatorCaps")}</span>
                  {draft.title ? <span className="text-slate-700"> · {draft.title}</span> : null}
                  {draft.customer_name ? <span className="text-slate-400"> · {draft.customer_name}</span> : null}
                </span>
              </div>
              {(draft.items ?? []).length > 0 && (
                <>
                  <div className="max-h-[22vh] space-y-0.5 overflow-y-auto px-3 pb-1.5">
                    {(draft.items ?? []).map((it, i) => (
                      <div key={i} className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate text-slate-500">{it.description || t("nt_item")}</span>
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
                      {savingDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : draft.status === "ready" ? t("nt_saveEstimate") : t("nt_saveDraft")}
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
              {/* Wraps when it isn't a live reply (review of the 09-23 wave): at 375px one truncated
                  line holds about 48 characters, which cut the try-again line (then "Tap the Nort
                  button up top…", now "Tap Talk To Nort to try again, or type below.") off every
                  mic failure line. The streaming readout stays one line. */}
              <span className={`text-sm text-slate-500 ${streaming ? "truncate" : "line-clamp-3 break-words"}`}>
                {streaming ? fillText(t("nt_streamLine"), { elapsed: elapsedStr, tokens: String(tokens), status: statusText }) : statusText}
              </span>
            </div>
          ) : !draft && messages.length === 0 && !voiceMode ? (
            <div className="px-3 py-2.5 text-sm text-slate-400">{t("nt_whatCanIHelp")}</div>
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
          {/* THE TEXT BOX. Voice was this panel's only input, so a mic that failed made Nort
              unreachable from it (Erik's phone, 09-16 to 09-23, with nothing on screen saying
              why). Typed questions go through the same send() as spoken ones. It sits right
              under the status line, which is what "or type below" points at, and high in a
              panel docked under the topbar, where the keyboard cannot cover it. Hidden while a
              proposal waits on Yes or Cancel, the same as the full-page composer. */}
          {!pendingConfirm && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!input.trim() || streaming) return;
                stopVoice(); // typing leaves voice mode: a half-heard spoken turn must not land after this one
                setStatus(null); // a leftover mic line ("Mic blocked…") is not this turn's status
                void send(input);
              }}
              className="flex shrink-0 items-center gap-2 px-3 pb-2"
            >
              <Input
                value={input}
                // Typing leaves voice mode AT ONCE, not only on Send: with the mic still live, a
                // spoken (or truck-noise) turn could land mid-sentence, wipe the typed text and send
                // itself instead (review of the 09-23 wave).
                onChange={(e) => {
                  if (voiceModeRef.current) stopVoice();
                  setInput(e.target.value);
                }}
                placeholder={t("nt_typeQuestion")}
                aria-label={t("nt_typeQuestionAria")}
                enterKeyHint="send"
                autoComplete="off"
                className="h-11 min-w-0 flex-1 bg-white/80"
              />
              <Button type="submit" disabled={streaming || !input.trim()} className="shrink-0">
                {t("nt_send")}
              </Button>
            </form>
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
                    {m.hint === "reload" ? <ReloadDoor lang={lang} /> : null}
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
              <button onClick={newChat} className="text-xs font-medium text-slate-400 hover:text-brand">{t("nt_newChat")}</button>
            </div>
          )}
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
            {messages.length === 0 ? (
              glass ? null : (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-light">
                    <Sparkles className="h-6 w-6 text-brand" />
                  </div>
                  <h3 className="text-sm font-semibold text-slate-900">{t("nt_howCanIHelp")}</h3>
                  <p className="mt-1 max-w-sm text-sm text-slate-500">
                    {t(isStaffRole(role) ? "nt_introOffice" : "nt_introTech")}
                    {voiceOn && t("nt_introVoice")}
                  </p>
                  <div className="mt-5 grid w-full max-w-lg gap-2 sm:grid-cols-2">
                    {suggestionsFor(role, lang).map((s) => (
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
                    {m.hint === "reload" ? <ReloadDoor lang={lang} /> : null}
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
          {t("nt_notSaving")}
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
      {draft && !glass ? <LiveQuote draft={draft} onSave={saveDraft} onDismiss={() => setDraft(null)} saving={savingDraft} lang={lang} /> : null}

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
              <span className="shrink-0 text-xs font-medium text-brand">{t("nt_view")}</span>
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
              // A record id is not a detail a person checks (Erik, 2026-10-16: the card read id,
              // starts_at and "null" while the address sat in the sentence behind it).
              .filter(([k, v]) => v != null && v !== "" && k !== "id" && !k.endsWith("_id") && !["status", "bill_number", "lunch_minutes"].includes(k))
              .map(([k, v]) => (
                <li key={k}>
                  <span className="font-medium capitalize">{k.replace(/_/g, " ")}:</span>{" "}
                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </li>
              ))}
          </ul>
          <div className="flex gap-2">
            <Button onClick={() => resolveConfirm(true)} className="flex-1 bg-green-600 hover:bg-green-500">
              <Check className="h-4 w-4" /> {t("nt_yesDoIt")}
            </Button>
            <Button variant="outline" onClick={() => resolveConfirm(false)} className="flex-1">
              {t("nt_cancel")}
            </Button>
          </div>
        </div>
      ) : glass ? null : voiceMode ? (
          // Voice mode (full page only) — chat-style. It listens / thinks / talks; the big mic is
          // "your turn". In the glass drawer the voice starts from Talk To Nort (under Search Or Ask)
          // and stops at the top bar's Stop Nort.
          <div className="flex flex-col items-center gap-2 border-t border-slate-100 p-4">
            <VoiceWave active={listening || speaking} />
            <div className="text-sm font-medium text-slate-600">
              {streaming ? t("nt_thinkingCap") : listening ? t("nt_listeningCap") : speaking ? t("nt_talkingCap") : t("nt_yourTurn")}
            </div>
            <button
              type="button"
              onClick={voiceTap}
              aria-label={listening ? t("nt_stopListeningAria") : t("nt_talkAria")}
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
              <Square className="h-3 w-3" fill="currentColor" /> {t("nt_endConversation")}
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
              placeholder={t("nt_askPlaceholder")}
              className="max-h-40 min-h-[44px] flex-1 resize-none"
            />
            {voiceOn && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={startVoice}
                disabled={streaming}
                aria-label={t("nt_talkToAssistantAria")}
                title={t("nt_tapAndTalk")}
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
