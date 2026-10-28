import { trace } from "@/lib/nort/trace";
import { nativePlaybackOn, playNative, stopPlaybackNative } from "@/lib/native-audio";
import { asLang, localeOf, type Lang } from "@/lib/locale";

/** A clip began to play ON THE ELEMENT. voice-stream listens (cn:nort-play): in the shell the
 *  recorder's fast wake ends here, because WebKit's playback at the slow tick is the proven-clean
 *  condition. The native player never says so — it is not WebKit's, and the page still needs waking
 *  between the sentences it fetches; the next turn's listen slows the tick. */
function clipPlaying() {
  try {
    window.dispatchEvent(new Event("cn:nort-play"));
  } catch {
    /* no window */
  }
}
// Speak with a real, intelligence-grade NEURAL voice (ElevenLabs / OpenAI via /api/tts),
// not the OS's robotic speech synthesis. The browser voice is only a last-ditch fallback
// when no neural provider is configured or audio playback is blocked.

function score(v: SpeechSynthesisVoice): number {
  const n = (v.name || "").toLowerCase();
  let s = 0;
  if (/neural|natural|enhanced|premium/.test(n)) s += 6;
  if (/siri/.test(n)) s += 5;
  if (/google/.test(n)) s += 4;
  if (/samantha|ava|allison|joelle|nicky|aaron|evan|nathan|zoe/.test(n)) s += 2;
  if (!v.localService) s += 2;
  if (/compact|eloquence|fred|albert|zarvox|trinoids|ralph|bahh|bells|boing|jester|organ|cellos|wobble|whisper|bad news|good news|deranged|hysterical|bubbles|pipe/.test(n)) s -= 8;
  return s;
}

/** THE LANGUAGE THE VOICE SPEAKS (cn-v1138): the page's own, which the LangProvider writes on the
 *  document from profiles.language — so every speak path (the assistant, the geofence, an alert)
 *  inherits it with no plumbing, and a caller that knows better passes its own. Outside a document
 *  (a test, the server) it is English. */
export function voiceLang(): Lang {
  // A document with no element (a test's stub of visibilityState) is a document that says nothing.
  const el = typeof document !== "undefined" ? document.documentElement : undefined;
  return asLang((el?.lang || "").toLowerCase().slice(0, 2));
}

/** The browser voice for a language: an es-* voice for Spanish, an en-* voice otherwise — the best
 *  of them by score, and any voice at all only when the device has none in that language. */
export function bestVoice(lang: Lang = voiceLang()): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const mine = voices.filter((v) => (v.lang || "").toLowerCase().startsWith(lang));
  const pool = mine.length ? mine : voices;
  return [...pool].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export function tuneUtterance(u: SpeechSynthesisUtterance, lang: Lang = voiceLang()): SpeechSynthesisUtterance {
  const v = bestVoice(lang);
  if (v) u.voice = v;
  u.lang = localeOf(lang);
  u.rate = 1.0;
  u.pitch = 1.0;
  return u;
}

// ── Neural voice ───────────────────────────────────────────────────────────────────
let audioEl: HTMLAudioElement | null = null;
let neuralDisabled = false; // flip true once we learn no provider is configured (503)

function getAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!audioEl) audioEl = new Audio();
  return audioEl;
}

// A 44-byte silent WAV — playing it inside a user gesture "unlocks" the element so we can
// play neural audio later (iOS only lets a gesture-touched element play programmatically).
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/**
 * A "NOW PLAYING" CARD ON THE LOCK SCREEN (Erik's phone, 2026-09-24): titled with the page ("Team
 * login") and still there after signing out. iOS treats an <audio> element that has played as music
 * and keeps its card until the element lets go of its media, so the element is emptied after every
 * clip and on every stop. (cn-v976 also played the shell's clips through Web Audio to chase a
 * crackle. That was not the cause, and a clip still decoding when Nort was cut off could start
 * after the stop, so the element is the only player again. The crackle was the app's own audio
 * session refusing to mix with WebKit's: see NorthBridgeViewController.shareTheSpeaker.)
 */
function releaseElement(a: HTMLAudioElement | null) {
  if (!a) return;
  try {
    a.removeAttribute("src");
    a.load();
  } catch {}
  try {
    const ms = (navigator as any).mediaSession;
    if (ms) {
      ms.metadata = null;
      ms.playbackState = "none";
    }
  } catch {}
}

/**
 * THE BROWSER VOICE LIVES IN THE APP'S PROCESS (research, 2026-09-24). In a WKWebView, speechSynthesis
 * is an AVSpeechSynthesizer in the HOST app, on the app's own audio session, while the neural voice
 * plays in WebKit's process. Every speechSynthesis call can switch the app's session on, and a
 * cancel() ran before EVERY sentence of every reply "just in case": a small fight over the speaker at
 * each sentence boundary, heard as a crackle in the app and never in Safari (which owns both sides).
 * So cancel only when that voice is actually speaking or has something queued.
 */
export function quietBrowserVoice() {
  try {
    const synth = window.speechSynthesis;
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
  } catch {}
}

/** ONE CLIP FROM THE NEURAL VOICE, as a blob (null when there is no provider or it failed): the
 *  greeting keeps these on the phone (lib/nort/greeting-player) so a greeting never waits on a
 *  synthesis round trip at open. */
export async function fetchClip(text: string, lang: Lang = voiceLang()): Promise<Blob | null> {
  const t = speakable((text || "").trim(), lang);
  if (!t || neuralDisabled) return null;
  try {
    const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t, lang }) });
    if (r.status === 503) { neuralDisabled = true; return null; }
    if (!r.ok) return null;
    // Only audio is a clip: a redirected page or a truncated body must never be kept and replayed.
    if (!(r.headers.get("content-type") || "").toLowerCase().startsWith("audio/")) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024) return null;
    return new Blob([buf], { type: "audio/mpeg" });
  } catch {
    return null;
  }
}

/** PLAY A CLIP on the shared element (the one unlockAudio primed in the tap, so it plays off-gesture
 *  on iOS). `done` settles when the clip ends OR `stop()` cuts it (a barge-in); the element is
 *  released either way (the lock-screen card rule above). Falls back to the browser voice, speaking
 *  `fallbackText`, when the element will not play. */
export type ClipOutcome = "ended" | "stopped" | "failed";
export function playClip(blob: Blob, fallbackText: string): { done: Promise<ClipOutcome>; playing: Promise<void>; stop: () => void } {
  let fired = false;
  let resolveDone: (o: ClipOutcome) => void = () => {};
  const done = new Promise<ClipOutcome>((res) => { resolveDone = res; });
  let resolvePlaying: () => void = () => {};
  const playing = new Promise<void>((res) => { resolvePlaying = res; });
  const fire = (o: ClipOutcome) => { if (fired) return; fired = true; resolvePlaying(); resolveDone(o); };
  // THE SHELL PLAYS NATIVELY while a conversation is live (native-audio.ts): WebKit would not
  // reliably begin a clip with the screen dark. Same contract: done once, the fallback voice only
  // when the plugin would not play it.
  if (nativePlaybackOn()) {
    quietBrowserVoice();
    const np = playNative(blob);
    np.started.then((sent) => { if (sent) trace("play started", `${blob.size}b native`); resolvePlaying(); }, (e: unknown) => {
      trace("play refused", `native ${String((e as { message?: unknown } | null)?.message ?? e)}`);
    });
    void np.done.then((o) => {
      if (fired) return;
      trace("clip done", o);
      // Refused = the plugin would not start it: the one fallback voice. Failed = it broke after
      // starting: reported as such (a cached greeting is dropped), never spoken a second time.
      if (o === "refused") { resolvePlaying(); browserSpeak(speakable(fallbackText, voiceLang()), () => fire("ended")); return; }
      fire(o);
    });
    return { done, playing, stop: () => { stopSpeaking(); fire("stopped"); } };
  }
  const a = getAudio();
  if (!a) {
    resolvePlaying();
    browserSpeak(speakable(fallbackText, voiceLang()), () => fire("ended"));
    return { done, playing, stop: () => { stopSpeaking(); fire("stopped"); } };
  }
  const url = URL.createObjectURL(blob);
  quietBrowserVoice();
  const onPause = () => finish("stopped"); // stopSpeaking() pauses; a pause mid-clip is a stop
  const finish = (o: ClipOutcome) => {
    if (fired) return;
    trace("clip done", o);
    a.onended = null;
    a.onerror = null;
    try { a.removeEventListener("pause", onPause); } catch {}
    try { URL.revokeObjectURL(url); } catch {}
    releaseElement(a);
    fire(o);
  };
  a.onended = () => finish("ended");
  a.onerror = () => finish("failed");
  a.src = url;
  // The pause listener only AFTER playback actually starts (playQueuedClip's rule), so setting src on
  // a stopped element cannot settle us before the clip has played.
  a.play()
    .then(() => { trace("play started", `${blob.size}b`); clipPlaying(); resolvePlaying(); if (!fired) a.addEventListener("pause", onPause); })
    .catch((e: unknown) => {
      trace("play refused", String((e as { name?: unknown } | null)?.name ?? e));
      // The element would not play (not a decode failure — those fire onerror and are done): ONE
      // fallback voice, never a second one over a clip that already ended or failed.
      if (fired) return;
      a.onended = null;
      a.onerror = null;
      try { URL.revokeObjectURL(url); } catch {}
      releaseElement(a);
      resolvePlaying();
      browserSpeak(speakable(fallbackText, voiceLang()), () => fire("ended"));
    });
  return {
    done,
    playing,
    stop: () => { try { a.pause(); } catch {} finish("stopped"); },
  };
}

/** Call from a user gesture (the mic tap) so neural audio can play afterward on iOS. */
export function unlockAudio() {
  const a = getAudio();
  if (!a) return;
  try {
    a.src = SILENT;
    a.play().then(() => { a.pause(); a.currentTime = 0; }).catch(() => {});
  } catch {}
}

/** Stop any in-flight speech immediately (neural audio + browser voice). Used by the
 *  voice-mode Stop button so the user can cut Claude off mid-sentence, like chat. */
export function stopSpeaking() {
  sayEpoch++; // a phrase still fetching its clip is cut too (clipTwice / speakSmart)
  quietBrowserVoice();
  if (nativePlaybackOn()) void stopPlaybackNative();
  try {
    if (audioEl) {
      audioEl.onended = null;
      audioEl.pause();
      audioEl.currentTime = 0;
      releaseElement(audioEl);
    }
  } catch {}
}

function browserSpeak(text: string, fire: () => void, onStart?: () => void, lang: Lang = voiceLang()) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) { fire(); return; }
    synth.cancel();
    const u = tuneUtterance(new SpeechSynthesisUtterance(text), lang);
    if (onStart) u.onstart = () => onStart();
    u.onend = fire;
    u.onerror = fire;
    synth.speak(u);
  } catch {
    fire();
  }
}


/**
 * Is this line an itemized COST line — a bullet with a dollar amount that reads as
 * process, not a highlight? ("- Labor — Owner: 24 hr × $150 = $3,600".) Totals /
 * balances / deposits are highlights and are deliberately NOT matched (they get spoken).
 */
function isCostBreakdownLine(line: string): boolean {
  const s = line.trim();
  if (!/^[-*•–]\s+/.test(s)) return false; // must be a bullet
  if (!/\$\s?\d/.test(s)) return false; // must carry a dollar amount
  if (/\b(total|balance|due|deposit|owes?|owed|subtotal|remaining)\b/i.test(s)) return false; // keep money highlights
  // Looks like an itemization: has math (× x =), a "label: $amount" shape, or a qty unit.
  return /[×x=]/.test(s) || /:\s*\$?\d/.test(s) || /\d\s*(hrs?|hours?|ea|each)\b/i.test(s);
}

/**
 * VOICE-ONLY: collapse a cost breakdown so speech gives HIGHLIGHTS + TOTAL, not the
 * per-line arithmetic Erik kept hearing ("24 hours by 150 dollars equals 3,600 dollars",
 * twice, then the total). When there are 2+ itemized cost bullets AND a Total is present,
 * drop the itemized bullets from the SPOKEN string — the screen still shows every line;
 * the driver hears the lead-in prose and the total. No Total to anchor on → leave the lines
 * alone (never silently swallow the only numbers).
 */
function collapseCostBreakdown(text: string): string {
  if (!/\btotal\b/i.test(text)) return text;
  const lines = text.split(/\r?\n/);
  if (lines.filter(isCostBreakdownLine).length < 2) return text;
  return lines.filter((ln) => !isCostBreakdownLine(ln)).join("\n");
}

/** The spoken forms of the trade's notation, one table per language: the English the voice has
 *  always used, and the Spanish beside it (cn-v1138). The rules are ONE function below; only the
 *  words differ. Street suffixes are a proper name's and expand the same way in both. */
type SpokenWords = {
  number: string; // "#10 AWG"
  doc: Record<string, string>; // E / Q / J / INV / WO / CO / PO
  aught: Record<string, string>; // 1/0 … 4/0
  amp: string;
  volt: string;
  kwh: string;
  kw: string;
  feet: string;
  inches: string;
  hours: string;
  each: string;
  sqft: string;
  fourS: string;
  tm: string;
  equals: string;
  by: string;
  dollars: string;
  and: string; // "82 dollars AND 50 cents" / "82 dólares CON 50 centavos"
  cents: string;
  percent: string;
  ampersand: string;
};
const SPOKEN: Record<Lang, SpokenWords> = {
  en: {
    number: "number",
    doc: { E: "estimate", Q: "quote", J: "job", INV: "invoice", WO: "work order", CO: "change order", PO: "purchase order" },
    aught: { "1": "one aught", "2": "two aught", "3": "three aught", "4": "four aught" },
    amp: "amp",
    volt: "volt",
    kwh: "kilowatt hours",
    kw: "kilowatts",
    feet: "feet",
    inches: "inches",
    hours: "hours",
    each: "each",
    sqft: "square feet",
    fourS: "four S",
    tm: "time and materials",
    equals: "equals",
    by: "by",
    dollars: "dollars",
    and: "and",
    cents: "cents",
    percent: "percent",
    ampersand: "and",
  },
  es: {
    number: "número",
    doc: { E: "presupuesto", Q: "cotización", J: "trabajo", INV: "factura", WO: "orden de trabajo", CO: "orden de cambio", PO: "orden de compra" },
    aught: { "1": "un cero", "2": "dos cero", "3": "tres cero", "4": "cuatro cero" },
    amp: "amperios",
    volt: "voltios",
    kwh: "kilovatios hora",
    kw: "kilovatios",
    feet: "pies",
    inches: "pulgadas",
    hours: "horas",
    each: "cada uno",
    sqft: "pies cuadrados",
    fourS: "cuatro S",
    tm: "tiempo y materiales",
    equals: "igual a",
    by: "por",
    dollars: "dólares",
    and: "con",
    cents: "centavos",
    percent: "por ciento",
    ampersand: "y",
  },
};

/**
 * SPEAKABLE TEXT — the voice was reading contractor shorthand raw ("E-009" as
 * "E dash zero zero nine", "10/3" as "ten slash three", "$5,550.00" digit by
 * digit). Translate app/trade notation into spoken words JUST for the voice —
 * the screen keeps the compact text. Applied at the speakSmart choke point so
 * every speak path (assistant, geofence, alerts) inherits it. In the person's
 * language (cn-v1138): E-009 is "estimate 9" to one tech and "presupuesto 9" to
 * the next; the rules are the same, the words come from SPOKEN.
 */
export function speakable(input: string, lang: Lang = "en"): string {
  const w = SPOKEN[lang] ?? SPOKEN.en;
  let t = String(input ?? "");
  // Voice-only: drop itemized cost lines so speech jumps to highlights + total, not the math.
  t = collapseCostBreakdown(t);
  // Wire gauge FIRST — "#10 AWG" → "number 10" (the markdown strip below would eat the #).
  t = t.replace(/#(\d+)\s*(AWG\b)?/gi, `${w.number} $1 `);
  // Markdown + symbols that read as noise.
  t = t.replace(/[*_`#]+/g, "").replace(/\u2026|\.{3}/g, ",").replace(/[–—]/g, ", ");
  // Doc numbers: E-009 → "estimate 9", INV-00012 → "invoice 12", J-018 → "job 18".
  // Strip leading list bullets so a kept line never reads as "dash …" / "star …".
  t = t.replace(/^[ \t]*[-•]\s+/gm, "");
  t = t.replace(/\b(E|Q|J|INV|WO|CO|PO)-0*(\d+)\b/g, (_, l: string, n: string) => `${w.doc[l]} ${n}`);
  // Wire sizes — the trade reads these as words: 4/0 → "four aught"; 10/3 → "ten three".
  t = t.replace(/\b([1-4])\/0\b/g, (_, n: string) => w.aught[n]);
  t = t.replace(/\b(\d{1,2})\/(\d)\b/g, "$1 $2"); // 10/3, 12/2, 14/2 → "ten three" …
  // Units & electrical notation.
  t = t.replace(/\b(\d[\d,\.]*)\s*A\b/g, `$1 ${w.amp}`).replace(/\b(\d[\d,\.]*)\s*V\b/g, `$1 ${w.volt}`);
  t = t.replace(/\b(\d[\d,\.]*)\s*kWh\b/gi, `$1 ${w.kwh}`).replace(/\b(\d[\d,\.]*)\s*kW\b/gi, `$1 ${w.kw}`);
  t = t.replace(/(\d)\s*'\s*/g, `$1 ${w.feet} `).replace(/(\d)\s*"\s*/g, `$1 ${w.inches} `);
  t = t.replace(/\b(\d[\d,\.]*)\s*ft\b/gi, `$1 ${w.feet}`).replace(/\b(\d[\d,\.]*)\s*(hrs?|hours?)\b/gi, `$1 ${w.hours}`);
  t = t.replace(/\b(\d+)\s*ea\b/gi, `$1 ${w.each}`).replace(/\bsq\s*ft\b/gi, w.sqft);
  t = t.replace(/\b4S\b/g, w.fourS).replace(/\bT&M\b/gi, w.tm);
  // Street-suffix abbreviations (addresses) — capitalized only, so "3rd"/"have" can't trip.
  const SUFFIX: Record<string, string> = { Ct: "Court", Ave: "Avenue", Blvd: "Boulevard", Rd: "Road", Ln: "Lane", Hwy: "Highway", Ste: "Suite" };
  t = t.replace(/\b(Ct|Ave|Blvd|Rd|Ln|Hwy|Ste)\b\.?/g, (_, x: string) => SUFFIX[x]);
  t = t.replace(/\s*=\s*/g, ` ${w.equals} `); // any math that survives the breakdown collapse
  t = t.replace(/\s*×\s*/g, ` ${w.by} `).replace(/(\d)\s*x\s*(\d)/gi, `$1 ${w.by} $2`);
  // Money: strip trailing .00; "$5,550" → "5,550 dollars"; cents spoken plainly.
  t = t.replace(/\$(\d[\d,]*)\.(\d{2})\b/g, (_, d: string, c: string) => (c === "00" ? `${d} ${w.dollars}` : `${d} ${w.dollars} ${w.and} ${c} ${w.cents}`));
  t = t.replace(/\$(\d[\d,]*)\b/g, `$1 ${w.dollars}`);
  t = t.replace(/%/g, ` ${w.percent}`).replace(/&/g, ` ${w.ampersand} `);
  return t.replace(/\s{2,}/g, " ").trim();
}

/** The page cannot be heard while it is hidden: the browser voice and the element both fall silent in
 *  the dark (measured 2026-10-15). A clip that could not be had is not "spoken" there — the flow
 *  finishes (the mic re-arms, a card waits on screen) and the trace says why. */
function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** One clip from /api/tts, asked for TWICE before giving up. The confirm question of 2026-10-15
 *  ("Move this appointment to Monday at 9?", screen locked) lost its one request and fell to the
 *  browser voice, which is silent in the dark: Nort listened for a yes nobody had heard a question
 *  for. 503 = no provider at all: remembered, never retried. Every stage leaves a trace line. */
export const CLIP_RETRY_MS = 1500;
/** How long one request may take: a request that hangs with the phone locked must not hold the turn
 *  (and the mic) for ever. */
export const CLIP_WAIT_MS = 8000;
/** Bumped by stopSpeaking(): a clip still on its way for a phrase the person cut off is dropped when
 *  it lands, never played late ("never on a cut"), and its second try is not made. */
let sayEpoch = 0;
async function clipTwice(t: string, alive: () => boolean = () => true, lang: Lang = voiceLang()): Promise<{ blob: Blob } | { why: string }> {
  let why = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      await new Promise<void>((res) => setTimeout(res, CLIP_RETRY_MS));
      if (!alive()) return { why: "stopped" };
    }
    try {
      const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(CLIP_WAIT_MS) : undefined;
      const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t, lang }), ...(signal ? { signal } : {}) });
      if (!alive()) return { why: "stopped" };
      if (r.status === 503) { neuralDisabled = true; return { why: "no provider" }; }
      // Only audio is a clip: a redirected page (a sign-in, say) must never be handed to the player.
      // (The route always says audio/mpeg; an answer that names another type is not a clip.)
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (r.ok && (!ct || ct.startsWith("audio/"))) {
        const buf = await r.arrayBuffer();
        if (buf.byteLength >= 1024) return { blob: new Blob([buf], { type: "audio/mpeg" }) };
        why = "tts empty";
      } else {
        why = r.ok ? "tts not audio" : `tts ${r.status}`;
        // A refusal is not a hiccup: the same request a second later is refused the same way.
        if ([400, 401, 403, 404].includes(r.status)) return { why };
      }
    } catch {
      why = "tts unreachable";
    }
    if (!attempt) trace("clip retry", why);
  }
  return { why };
}

/** Speak `text` with the neural voice; fall back to the browser voice only if there's no
 *  provider or playback is blocked — and never while the page is dark (pageHidden). onEnd always
 *  fires exactly once. `onStart` fires once, only when a sound has actually begun (a clip still
 *  being fetched, or a fetch that never answers, has not started anything): a caller that treats
 *  the line as audible, or listens over it, waits for this and never assumes it. */
export function speakSmart(text: string, onEnd?: (heard: boolean) => void, onStart?: () => void, lang: Lang = voiceLang()) {
  let began = false;
  const begin = () => { if (began) return; began = true; onStart?.(); };
  let fired = false;
  // `heard`: false when nothing could be heard (the dark, no clip) — a caller that would listen for
  // an answer to a question must not listen for one nobody heard.
  const fire = (heard = true) => { if (fired) return; fired = true; onEnd?.(heard); };
  const t = speakable((text || "").trim(), lang);
  if (!t) { fire(); return; }
  const dark = () => nativePlaybackOn() && pageHidden();
  if (neuralDisabled) { if (dark()) fire(false); else browserSpeak(t, fire, begin, lang); return; }
  const mine = sayEpoch;
  const alive = () => sayEpoch === mine;
  trace("say sent", `${t.length} chars`);

  void clipTwice(t, alive, lang).then((got) => {
    if (!alive()) return; // cut while the clip was on its way: never late, never onEnd (a Stop re-arms by its own hand)
    if ("why" in got) {
      trace("say failed", got.why);
      if (dark()) { fire(false); return; } // nothing can be heard in the dark: the caller is told so
      browserSpeak(t, fire, begin, lang);
      return;
    }
    const blob = got.blob;
    if (nativePlaybackOn()) {
      quietBrowserVoice();
      trace("say clip", `${blob.size}b native`);
      // The element's contract: onEnd at the end (or a failure, so a caller waiting to re-arm
      // the mic is never left hanging), never on a cut — a Stop re-arms by its own hand.
      const np = playNative(blob);
      void np.started.then((sent) => { if (sent) begin(); }, () => {}); // a refusal is settled below, by `done`
      void np.done.then((o) => {
        trace("say done", o);
        // A clip that broke after it started, with the SCREEN ON: nothing would ask again (the re-ask
        // runs only when the screen comes back), so a hands-free person would wait on a card with no
        // voice. The browser voice says the line, and the caller is told whether THAT was heard. In the
        // dark the browser voice is silent, so the caller is told the line was not heard (below).
        if (o === "failed" && !dark()) { browserSpeak(t, fire, begin, lang); return; }
        // Only a clip that played to its end was HEARD: one that broke after it started was not,
        // and a caller that would listen for a yes must not open the mic for a question nobody
        // finished hearing (the confirm gate).
        if (o === "refused") { if (dark()) fire(false); else browserSpeak(t, fire, begin, lang); }
        else if (o !== "stopped") fire(o === "ended");
      });
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = getAudio();
    if (!a) { URL.revokeObjectURL(url); browserSpeak(t, fire, begin, lang); return; }
    quietBrowserVoice();
    a.onended = () => { URL.revokeObjectURL(url); releaseElement(a); fire(); };
    a.src = url;
    a.play().then(() => begin(), () => { a.onended = null; URL.revokeObjectURL(url); releaseElement(a); browserSpeak(t, fire, begin, lang); });
  });
}

// ── Streaming speech: sentence-chunking + an in-order FIFO speak queue ────────────────
// CHANGE 1: kill the dead air where Nort synthesizes the WHOLE reply before making a sound.
// A SpeakQueue plays sentence 1 the instant it's synthesized while later sentences are still
// arriving from the LLM. Each queued clip awaits the previous clip's audio-end before it plays,
// so speech stays in order and never overlaps. The queue's onDone fires only after the LAST clip.

/** Abbreviations whose trailing "." must NOT be treated as a sentence boundary. Lowercased, no dot. */
const ABBREV = new Set([
  "mr", "mrs", "ms", "dr", "st", "ave", "rd", "blvd", "apt", "no", "vs", "etc", "inc", "ltd", "co",
  "jr", "sr", "fig", "approx", "dept", "min", "max", "qty", "ea", "amp", "amps", "ft", "in", "hr",
  "hrs", "gal", "e.g", "i.e", "a.m", "p.m", "u.s",
]);

/**
 * Split streamed text into COMPLETED sentences plus a trailing remainder that isn't a full sentence
 * yet. A boundary is `. ! ?` (optionally followed by a closing quote/paren) that is NOT: part of a
 * decimal number (3.5), part of a known abbreviation (Mr., e.g.), or a mid-word dot. The remainder is
 * whatever comes after the last boundary — held back until more text arrives (or flushed at stream end).
 * Never throws; on any doubt it keeps text in the remainder (spoken later) rather than mis-splitting.
 */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const s = String(text ?? "");
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    // Consume a run of terminators + any trailing closing quotes/brackets: `?"`, `!)`, `...`
    let j = i;
    while (j + 1 < s.length && (s[j + 1] === "." || s[j + 1] === "!" || s[j + 1] === "?")) j++;
    let end = j;
    while (end + 1 < s.length && /["'”’)\]]/.test(s[end + 1])) end++;
    // Must be followed by whitespace or end-of-string to be a real boundary (not mid-token like "3.5").
    const after = s[end + 1];
    if (after !== undefined && !/\s/.test(after)) { i = j; continue; }
    // Decimal guard: a lone "." between two digits is not a boundary (3.5, $4.00 handled elsewhere).
    if (ch === "." && i === j) {
      const prev = s[i - 1];
      const nxt = s[i + 1];
      if (prev && /\d/.test(prev) && nxt && /\d/.test(nxt)) continue;
    }
    // Abbreviation guard: the word immediately before a single "." — if it's a known abbrev, skip.
    if (ch === "." && i === j) {
      const m = s.slice(start, i).match(/([A-Za-z.]+)$/);
      const word = (m ? m[1] : "").toLowerCase().replace(/\.+$/, "");
      if (word && ABBREV.has(word)) continue;
    }
    const piece = s.slice(start, end + 1).trim();
    if (piece) sentences.push(piece);
    start = end + 1;
    i = end;
  }
  return { sentences, rest: s.slice(start) };
}

/** Synthesize ONE already-speakable clip → its bytes. Resolves to null when the neural provider is
 *  unavailable/errored (caller then browser-speaks the text). Never rejects. */
function synthClip(speakableText: string, alive: () => boolean, lang: Lang): Promise<Blob | null> {
  if (neuralDisabled) return Promise.resolve(null);
  // The same two tries the directive phrase gets (clipTwice): a sentence lost to one failed request
  // was skipped or read by the silent browser voice in the dark. A stopped queue makes no second try.
  return clipTwice(speakableText, alive, lang).then((got) => {
    if ("blob" in got) return got.blob;
    trace("clip failed", got.why);
    return null;
  });
}

/** Play one queued clip: in the app process when the shell's conversation is live (native-audio.ts),
 *  else on the shared audio element. Resolves when it ends, fails, OR is stopped (a stopSpeaking()
 *  during a barge-in/Stop pauses the element — resolving on pause keeps the speak queue's pump from
 *  hanging on a clip that will never fire `ended`). Idempotent: resolves once. */
function playQueuedClip(blob: Blob): Promise<void> {
  if (nativePlaybackOn()) {
    quietBrowserVoice();
    const np = playNative(blob);
    np.started.then((sent) => { if (sent) trace("play started", `${blob.size}b native`); }, (e: unknown) => trace("play refused", `native ${String((e as { message?: unknown } | null)?.message ?? e)}`));
    return np.done.then((o) => { trace("clip done", o); });
  }
  const url = URL.createObjectURL(blob);
  return new Promise((resolve) => {
    const a = getAudio();
    if (!a) { URL.revokeObjectURL(url); resolve(); return; }
    let done = false;
    const onPause = () => finish();
    const finish = () => {
      if (done) return;
      done = true;
      trace("clip done", a.ended ? "ended" : a.error ? "error" : "paused");
      a.onended = null;
      a.onerror = null;
      try { a.removeEventListener("pause", onPause); } catch {}
      try { URL.revokeObjectURL(url); } catch {}
      resolve();
    };
    quietBrowserVoice();
    a.onended = finish;
    a.onerror = finish;
    a.src = url;
    // Attach the pause listener only AFTER playback actually starts, so setting src on an
    // already-stopped element can't spuriously resolve us before this clip has played.
    a.play()
      .then(() => { trace("play started"); clipPlaying(); if (!done) a.addEventListener("pause", onPause); })
      .catch((e: unknown) => { trace("play refused", String((e as { name?: unknown } | null)?.name ?? e)); finish(); });
  });
}

/**
 * An in-order speak queue for a SINGLE streaming reply. Push raw text chunks as sentences complete;
 * each is run through speakable() (the choke point) then synthesized. Clips PLAY in push order —
 * a clip waits for the previous clip's audio to END before it starts, so speech never overlaps and
 * stays ordered. Synthesis of clip N+1 overlaps playback of clip N (fetch is fired as soon as it's
 * pushed), so there's minimal gap between sentences. onDone fires exactly once after the last clip
 * finishes AND the producer has signalled done().
 *
 * GRACEFUL FALLBACK: if a clip's neural synth fails, that clip is spoken with the browser voice
 * (still in order). If neural is disabled entirely, everything browser-speaks. A stop() aborts the
 * whole queue immediately and fires onDone so the caller's re-arm path always runs.
 */
export class SpeakQueue {
  private items: { speakable: string; clip: Promise<Blob | null> }[] = [];
  private playing = false;
  private producerDone = false;
  private stopped = false;
  private fired = false;
  private onDone?: () => void;
  /** The language of this reply (cn-v1138): the page's unless the caller says otherwise. */
  private lang: Lang;
  // Resolved by stop() so an in-flight clip's await can't outlive a teardown (no hung pump).
  private stopResolve!: () => void;
  private stopped$: Promise<void> = new Promise((r) => { this.stopResolve = r; });

  constructor(onDone?: () => void, lang: Lang = voiceLang()) { this.onDone = onDone; this.lang = lang; }

  /** Queue a chunk of text to speak. It's synthesized immediately (fetch fires now) but played in order. */
  push(text: string) {
    if (this.stopped) return;
    const t = speakable((text || "").trim(), this.lang);
    if (!t) return;
    this.items.push({ speakable: t, clip: synthClip(t, () => !this.stopped, this.lang) });
    if (!this.playing) void this.pump();
  }

  /** No more chunks are coming. onDone fires once the queue drains. */
  done() {
    this.producerDone = true;
    if (!this.playing) this.maybeFinish();
  }

  /** Hard stop: drop everything and fire onDone so the caller re-arms the mic. */
  stop() {
    this.stopped = true;
    this.items = [];
    stopSpeaking();
    try { this.stopResolve(); } catch {} // unblock any in-flight clip await
    this.fire();
  }

  private fire() {
    if (this.fired) return;
    this.fired = true;
    // The lock-screen card clears once the whole reply is done. Emptying the element after EVERY
    // sentence made WebKit tear its playback down and set it up again between sentences.
    releaseElement(audioEl);
    try { this.onDone?.(); } catch {}
  }

  private maybeFinish() {
    if (this.stopped) { this.fire(); return; }
    if (this.producerDone && this.items.length === 0) this.fire();
  }

  private async pump() {
    if (this.playing) return;
    this.playing = true;
    while (!this.stopped && this.items.length) {
      const item = this.items.shift()!;
      let clip: Blob | null = null;
      // Race synth (and playback below) against stop() so a teardown never leaves the pump hung.
      trace("clip wait"); // the next sentence: its synthesis (a fetch) must settle while the page may be hidden
      try { clip = await Promise.race([item.clip, this.stopped$.then(() => null)]); } catch { clip = null; }
      if (this.stopped) break;
      trace(clip ? "clip ready" : "clip missing");
      if (clip) {
        await Promise.race([playQueuedClip(clip), this.stopped$]);
      } else if (nativePlaybackOn() && pageHidden()) {
        trace("clip skipped", "dark"); // the browser voice cannot be heard here (pageHidden); the next sentence follows
      } else {
        // Neural failed for this clip — speak it with the browser voice, still in order.
        await Promise.race([new Promise<void>((res) => browserSpeak(item.speakable, res, undefined, this.lang)), this.stopped$]);
      }
    }
    this.playing = false;
    this.maybeFinish();
  }
}

// ── CHANGE 2: barge-in — let the user cut Nort off by TALKING ────────────────────────
// While Nort speaks, the mic MediaStream + AnalyserNode stay alive (voice-stream holds them across
// turns) even though the MediaRecorder is stopped. We poll a coarse RMS off that already-live analyser
// (never a fresh getUserMedia) and, when input energy stays sustained above a threshold set clearly
// ABOVE the echo-cancelled TTS bleed, we treat it as the user interrupting: stop playback and let the
// caller re-arm the mic to capture what they're saying.
//
// TUNING — the gate is now ADAPTIVE so it works parked AND at 60mph. Erik reported (cn-v338 field
// test) that a fixed 0.14 gate never fired — his voice over the truck speaker didn't clear it. So
// instead of one absolute number: sample the ambient (engine + road + Nort's echo bleed) for the first
// moment of playback, then set the gate to ambient + BARGE_IN_MARGIN, never below BARGE_IN_FLOOR. A
// deliberate talk-over always sits clearly above the road noise; the road noise itself never trips it.
// If it STILL won't interrupt, lower BARGE_IN_FLOOR/MARGIN; if Nort cuts ITSELF off, raise them.
export const BARGE_IN_FLOOR = 0.085; // the gate never drops below this (quiet cab → still needs real voice)
export const BARGE_IN_MARGIN = 0.06; // how far ABOVE the measured ambient a talk-over must be
export const BARGE_IN_BASELINE_MS = 320; // sample ambient this long at the start of playback
const BARGE_IN_BASELINE_CAP = 0.13; // never let the learned ambient push the gate absurdly high
export const BARGE_IN_SUSTAIN_MS = 220; // must stay above the gate this long, continuously, to fire
const BARGE_IN_POLL_MS = 55; // how often we sample the analyser during playback

/**
 * Watch the live analyser for a sustained talk-over during playback. `rmsFn` returns the current input
 * RMS (0..1) or null when there's no live analyser (then we CANNOT judge → never interrupt). The gate
 * self-calibrates: for the first BASELINE_MS it learns the ambient floor, then fires when energy stays
 * MARGIN above that (but never below FLOOR) for SUSTAIN_MS continuously. onBargeIn fires at most once.
 * Returns a stop() to tear the watcher down. Never throws; any uncertainty defaults to NOT interrupting.
 */
export function startBargeInMonitor(rmsFn: () => number | null, onBargeIn: () => void): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let aboveSince = 0;
  let done = false;
  const startedAt = Date.now();
  let ambient = 0; // running max of the quiet baseline seen in the first window
  const teardown = () => {
    if (timer) { clearInterval(timer); timer = null; }
  };
  const tick = () => {
    if (done) return;
    let rms: number | null = null;
    try { rms = rmsFn(); } catch { rms = null; }
    // No analyser / read failed → we can't tell, so never interrupt (fall back to today's behavior).
    if (rms == null) { aboveSince = 0; return; }
    // Learn the ambient (engine/road/echo) during the opening window, then hold it.
    if (Date.now() - startedAt < BARGE_IN_BASELINE_MS) {
      if (rms > ambient) ambient = Math.min(rms, BARGE_IN_BASELINE_CAP);
      aboveSince = 0; // don't fire while still calibrating
      return;
    }
    const gate = Math.max(BARGE_IN_FLOOR, ambient + BARGE_IN_MARGIN);
    if (rms >= gate) {
      if (!aboveSince) aboveSince = Date.now();
      else if (Date.now() - aboveSince >= BARGE_IN_SUSTAIN_MS) {
        done = true;
        teardown();
        try { onBargeIn(); } catch {}
      }
    } else {
      aboveSince = 0; // dropped below the gate → the run must be continuous, so reset
    }
  };
  try { timer = setInterval(tick, BARGE_IN_POLL_MS); } catch { /* if timers are unavailable, simply never fire */ }
  return teardown;
}
