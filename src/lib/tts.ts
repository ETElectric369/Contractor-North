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

/** Speak `text` with the neural voice; fall back to the browser voice only if there's no
 *  provider or playback is blocked. onEnd always fires exactly once. */
export function speakSmart(text: string, onEnd?: () => void) {
  let fired = false;
  const fire = () => { if (fired) return; fired = true; onEnd?.(); };
  const t = (text || "").trim();
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
