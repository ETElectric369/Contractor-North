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
