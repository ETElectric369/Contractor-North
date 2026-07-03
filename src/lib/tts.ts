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

export function bestVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const en = voices.filter((v) => (v.lang || "").toLowerCase().startsWith("en"));
  const pool = en.length ? en : voices;
  return [...pool].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export function tuneUtterance(u: SpeechSynthesisUtterance): SpeechSynthesisUtterance {
  const v = bestVoice();
  if (v) u.voice = v;
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
  try { window.speechSynthesis?.cancel(); } catch {}
  try {
    if (audioEl) {
      audioEl.onended = null;
      audioEl.pause();
      audioEl.currentTime = 0;
    }
  } catch {}
}

function browserSpeak(text: string, fire: () => void) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) { fire(); return; }
    synth.cancel();
    const u = tuneUtterance(new SpeechSynthesisUtterance(text));
    u.onend = fire;
    u.onerror = fire;
    synth.speak(u);
  } catch {
    fire();
  }
}


/**
 * SPEAKABLE TEXT — the voice was reading contractor shorthand raw ("E-009" as
 * "E dash zero zero nine", "10/3" as "ten slash three", "$5,550.00" digit by
 * digit). Translate app/trade notation into spoken English JUST for the voice —
 * the screen keeps the compact text. Applied at the speakSmart choke point so
 * every speak path (assistant, geofence, alerts) inherits it.
 */
export function speakable(input: string): string {
  let t = String(input ?? "");
  // Wire gauge FIRST — "#10 AWG" → "number 10" (the markdown strip below would eat the #).
  t = t.replace(/#(\d+)\s*(AWG\b)?/gi, "number $1 ");
  // Markdown + symbols that read as noise.
  t = t.replace(/[*_`#]+/g, "").replace(/\u2026|\.{3}/g, ",").replace(/[–—]/g, ", ");
  // Doc numbers: E-009 → "estimate 9", INV-00012 → "invoice 12", J-018 → "job 18".
  const DOC: Record<string, string> = { E: "estimate", Q: "quote", J: "job", INV: "invoice", WO: "work order", CO: "change order", PO: "purchase order" };
  t = t.replace(/\b(E|Q|J|INV|WO|CO|PO)-0*(\d+)\b/g, (_, l: string, n: string) => `${DOC[l]} ${n}`);
  // Wire sizes — the trade reads these as words: 4/0 → "four aught"; 10/3 → "ten three".
  const AUGHT: Record<string, string> = { "1": "one aught", "2": "two aught", "3": "three aught", "4": "four aught" };
  t = t.replace(/\b([1-4])\/0\b/g, (_, n: string) => AUGHT[n]);
  t = t.replace(/\b(\d{1,2})\/(\d)\b/g, "$1 $2"); // 10/3, 12/2, 14/2 → "ten three" …
  // Units & electrical notation.
  t = t.replace(/\b(\d[\d,\.]*)\s*A\b/g, "$1 amp").replace(/\b(\d[\d,\.]*)\s*V\b/g, "$1 volt");
  t = t.replace(/\b(\d[\d,\.]*)\s*kWh\b/gi, "$1 kilowatt hours").replace(/\b(\d[\d,\.]*)\s*kW\b/gi, "$1 kilowatts");
  t = t.replace(/(\d)\s*'\s*/g, "$1 feet ").replace(/(\d)\s*"\s*/g, "$1 inches ");
  t = t.replace(/\b(\d[\d,\.]*)\s*ft\b/gi, "$1 feet").replace(/\b(\d[\d,\.]*)\s*(hrs?|hours?)\b/gi, "$1 hours");
  t = t.replace(/\b(\d+)\s*ea\b/gi, "$1 each").replace(/\bsq\s*ft\b/gi, "square feet");
  t = t.replace(/\b4S\b/g, "four S").replace(/\bT&M\b/gi, "time and materials");
  t = t.replace(/\s*×\s*/g, " by ").replace(/(\d)\s*x\s*(\d)/gi, "$1 by $2");
  // Money: strip trailing .00; "$5,550" → "5,550 dollars"; cents spoken plainly.
  t = t.replace(/\$(\d[\d,]*)\.(\d{2})\b/g, (_, d: string, c: string) => (c === "00" ? `${d} dollars` : `${d} dollars and ${c} cents`));
  t = t.replace(/\$(\d[\d,]*)\b/g, "$1 dollars");
  t = t.replace(/%/g, " percent").replace(/&/g, " and ");
  return t.replace(/\s{2,}/g, " ").trim();
}

/** Speak `text` with the neural voice; fall back to the browser voice only if there's no
 *  provider or playback is blocked. onEnd always fires exactly once. */
export function speakSmart(text: string, onEnd?: () => void) {
  let fired = false;
  const fire = () => { if (fired) return; fired = true; onEnd?.(); };
  const t = speakable((text || "").trim());
  if (!t) { fire(); return; }
  if (neuralDisabled) { browserSpeak(t, fire); return; }

  fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) })
    .then(async (r) => {
      if (r.status === 503) { neuralDisabled = true; throw new Error("no provider"); }
      if (!r.ok) throw new Error("tts " + r.status);
      const buf = await r.arrayBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
      const a = getAudio();
      if (!a) { URL.revokeObjectURL(url); browserSpeak(t, fire); return; }
      try { window.speechSynthesis?.cancel(); } catch {}
      a.onended = () => { URL.revokeObjectURL(url); fire(); };
      a.src = url;
      a.play().catch(() => { a.onended = null; URL.revokeObjectURL(url); browserSpeak(t, fire); });
    })
    .catch(() => browserSpeak(t, fire));
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

/** Synthesize ONE already-speakable clip → an <audio>-playable object URL. Resolves to null when the
 *  neural provider is unavailable/errored (caller then browser-speaks the text). Never rejects. */
function synthClip(speakableText: string): Promise<string | null> {
  if (neuralDisabled) return Promise.resolve(null);
  return fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: speakableText }) })
    .then(async (r) => {
      if (r.status === 503) { neuralDisabled = true; return null; }
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      return URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
    })
    .catch(() => null);
}

/** Play one object-URL clip on the shared audio element; resolves when it ends, fails, OR is paused
 *  (a stopSpeaking() during a barge-in/Stop pauses the element — resolving on pause keeps the speak
 *  queue's pump from hanging on a clip that will never fire `ended`). Idempotent: resolves once. */
function playClipUrl(url: string): Promise<void> {
  return new Promise((resolve) => {
    const a = getAudio();
    if (!a) { URL.revokeObjectURL(url); resolve(); return; }
    let done = false;
    const onPause = () => finish();
    const finish = () => {
      if (done) return;
      done = true;
      a.onended = null;
      a.onerror = null;
      try { a.removeEventListener("pause", onPause); } catch {}
      try { URL.revokeObjectURL(url); } catch {}
      resolve();
    };
    try { window.speechSynthesis?.cancel(); } catch {}
    a.onended = finish;
    a.onerror = finish;
    a.src = url;
    // Attach the pause listener only AFTER playback actually starts, so setting src on an
    // already-stopped element can't spuriously resolve us before this clip has played.
    a.play().then(() => { if (!done) a.addEventListener("pause", onPause); }).catch(() => finish());
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
  private items: { speakable: string; clip: Promise<string | null> }[] = [];
  private playing = false;
  private producerDone = false;
  private stopped = false;
  private fired = false;
  private onDone?: () => void;
  // Resolved by stop() so an in-flight clip's await can't outlive a teardown (no hung pump).
  private stopResolve!: () => void;
  private stopped$: Promise<void> = new Promise((r) => { this.stopResolve = r; });

  constructor(onDone?: () => void) { this.onDone = onDone; }

  /** Queue a chunk of text to speak. It's synthesized immediately (fetch fires now) but played in order. */
  push(text: string) {
    if (this.stopped) return;
    const t = speakable((text || "").trim());
    if (!t) return;
    this.items.push({ speakable: t, clip: synthClip(t) });
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
      let url: string | null = null;
      // Race synth (and playback below) against stop() so a teardown never leaves the pump hung.
      try { url = await Promise.race([item.clip, this.stopped$.then(() => null)]); } catch { url = null; }
      if (this.stopped) break;
      if (url) {
        await Promise.race([playClipUrl(url), this.stopped$]);
      } else {
        // Neural failed for this clip — speak it with the browser voice, still in order.
        await Promise.race([new Promise<void>((res) => browserSpeak(item.speakable, res)), this.stopped$]);
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
