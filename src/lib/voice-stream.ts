/**
 * Hands-free voice input via getUserMedia + server transcription — the RELIABLE path on iOS PWAs,
 * where webkitSpeechRecognition cannot do a multi-turn conversation (it ends after one utterance and
 * iOS refuses to restart it off a user gesture, so the answer after the assistant's question is lost).
 *
 * Here, the mic is granted ONCE inside the Talk tap (getUserMedia); the MediaStream then stays alive,
 * so every later turn records straight from it with NO new tap. Each turn: record → detect end-of-speech
 * (a stretch of silence after the user spoke) → POST the audio to /api/transcribe (Whisper) → deliver the
 * transcript. Exposes the SAME surface as lib/speech.ts, so the assistant swaps backends via the import.
 */

type ResultCb = (text: string) => void;
type StateCb = (listening: boolean) => void;

let stream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let recorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let rafId = 0;
let active = false; // a turn is recording/listening right now
let wantStream = false; // we intend to hold the mic open across turns
let muted = false;
let mimeType = "";
let handler: ResultCb | null = null;
const stateSubs = new Set<StateCb>();

// Diagnostics so the user (and we) can SEE what the mic is doing — the only way to debug a device
// I can't run: a live input LEVEL (is the mic actually hearing sound?) and a step STATUS string.
let level = 0;
let statusCb: ((s: string) => void) | null = null;
export function currentLevel(): number {
  return level;
}

/**
 * BARGE-IN support. The mic MediaStream + AudioContext + AnalyserNode are held alive across turns
 * (they're only torn down in stopListening). During TTS playback the MediaRecorder is stopped and the
 * turn is muted, but the analyser is still wired to the live stream — so we can read a coarse input RMS
 * off it WITHOUT a fresh getUserMedia (which iOS would reject off-gesture). Returns null when there's
 * no live analyser to read (the caller must then default to NOT interrupting). Never throws.
 */
export function analyserRms(): number | null {
  if (!analyser) return null;
  try {
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  } catch {
    return null;
  }
}
export function onStatus(cb: ((s: string) => void) | null) {
  statusCb = cb;
}
function status(s: string) {
  try {
    statusCb?.(s);
  } catch {
    /* ignore */
  }
}

// Voice resilience: a silent turn (the 9s no-speech cap, an empty blob, a no-words transcription,
// a transcribe error) used to end the conversation MUTE — the mic stayed granted but nothing ever
// re-armed it. Retry a bounded number of CONSECUTIVE silent turns while the stream is still wanted,
// then hand control back with a clear "tap the mic" status instead of dying silently.
const MAX_SILENT_RETRIES = 2;
let silentTurns = 0;
function retryOrGiveUp(detail: string) {
  if (wantStream && silentTurns < MAX_SILENT_RETRIES) {
    silentTurns++;
    status(detail);
    beginTurn();
    return;
  }
  status(wantStream ? `${detail} Tap the mic when you're ready.` : detail);
}

export function speechSupported(): boolean {
  if (typeof window === "undefined") return false;
  const ac = (window as any).AudioContext || (window as any).webkitAudioContext;
  return !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined" && !!ac;
}

export function isListening(): boolean {
  return active;
}

export function onListeningState(cb: StateCb): () => void {
  stateSubs.add(cb);
  return () => {
    stateSubs.delete(cb);
  };
}

function emit() {
  stateSubs.forEach((f) => {
    try {
      f(active);
    } catch {
      /* ignore */
    }
  });
}

export function setResultHandler(cb: ResultCb | null) {
  handler = cb;
}

/** Pause capture while the assistant speaks (so its TTS isn't recorded). Turns are chat-triggered
 *  AFTER the reply, so this is mostly a safety net. */
export function setMuted(b: boolean) {
  muted = b;
}

function pickMime(): string {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/mpeg"]) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return "";
}

/**
 * START. The FIRST call must run inside a user gesture (the mic-permission prompt). It kicks off
 * getUserMedia (async) and returns true; once the stream is live, recording turns no longer need a
 * gesture. A later call with the stream already alive just records the next turn.
 */
export function startListening(_lang?: string): boolean {
  if (!speechSupported()) return false;
  muted = false;
  silentTurns = 0; // a fresh (user-initiated) start resets the silent-retry budget
  if (stream && audioCtx && analyser) {
    beginTurn(); // stream alive (mid-conversation) → record the next answer, no gesture needed
    return true;
  }
  wantStream = true;
  status("Connecting to the mic…");
  navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then((s) => {
      if (!wantStream) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      audioCtx = new AC();
      void audioCtx!.resume?.(); // iOS suspends a fresh AudioContext until you resume it in-gesture
      const src = audioCtx!.createMediaStreamSource(s);
      analyser = audioCtx!.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      mimeType = pickMime();
      status("Mic ready — go ahead");
      beginTurn();
    })
    .catch((err) => {
      wantStream = false;
      active = false;
      const msg = String(err?.name || err || "");
      status(/NotAllowed|Permission|Denied/i.test(msg) ? "Mic blocked — allow it in Settings → Safari" : `Mic unavailable (${msg || "no audio"})`);
      emit();
    });
  return true;
}

function beginTurn() {
  if (!wantStream || !stream || !analyser) return;
  try {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  } catch {
    /* ignore */
  }
  chunks = [];
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    try {
      recorder = new MediaRecorder(stream);
    } catch {
      return;
    }
  }
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = () => {
    void finishTurn();
  };
  try {
    recorder.start();
  } catch {
    return;
  }
  active = true;
  emit();

  status("Listening — go ahead");
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let spoke = false;
  let silenceStart = 0;
  const startedAt = Date.now();
  const SPEAK = 0.01; // RMS that counts as speech (lowered — 0.018 may have been above a soft voice)
  const tick = () => {
    if (!active || !recorder || recorder.state === "inactive" || !analyser) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    level = rms; // live meter — proves whether the mic is hearing ANYTHING
    const now = Date.now();
    if (muted) {
      silenceStart = 0;
    } else if (rms > SPEAK) {
      if (!spoke) status("Hearing you…");
      spoke = true;
      silenceStart = 0;
    } else if (spoke) {
      if (!silenceStart) silenceStart = now;
      else if (now - silenceStart > 1300) {
        stopTurn(); // ~1.3s of quiet after speech → end of the utterance
        return;
      }
    }
    // Safety caps: never run a single turn forever; give up a turn with no speech at all.
    if (now - startedAt > 18000 || (!spoke && now - startedAt > 9000)) {
      stopTurn();
      return;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopTurn() {
  cancelAnimationFrame(rafId);
  try {
    if (recorder && recorder.state !== "inactive") recorder.stop(); // → onstop → finishTurn
  } catch {
    /* ignore */
  }
}

async function finishTurn() {
  cancelAnimationFrame(rafId);
  level = 0;
  active = false;
  emit();
  const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
  chunks = [];
  if (blob.size < 1200) {
    // Nothing usable was recorded — almost always the silent-PWA mic (stream "on" but capturing
    // nothing) or a permission gap. Say so plainly, and re-arm the mic if the stream is still wanted.
    retryOrGiveUp(`No audio captured (${blob.size} bytes). If the level meter stayed flat, the mic isn't reaching the app.`);
    return;
  }
  status(`Sending ${(blob.size / 1024) | 0}KB to transcribe…`);
  try {
    const fd = new FormData();
    const ext = mimeType.includes("mp4") || mimeType.includes("aac") ? "mp4" : mimeType.includes("mpeg") ? "mp3" : "webm";
    fd.append("audio", blob, `turn.${ext}`);
    const r = await fetch("/api/transcribe", { method: "POST", body: fd });
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      retryOrGiveUp(`Transcribe error: ${j?.error ?? r.status}.`);
      return;
    }
    const text = String(j?.text ?? "").trim();
    if (text && handler) {
      silentTurns = 0; // real words made it through — reset the retry budget
      handler(text);
    } else retryOrGiveUp("Heard sound but no words — try speaking a bit louder.");
  } catch (e: any) {
    retryOrGiveUp(`Couldn't reach transcription (${e?.message ?? "network"}).`);
  }
}

export function stopListening() {
  wantStream = false;
  active = false;
  cancelAnimationFrame(rafId);
  try {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  } catch {
    /* ignore */
  }
  try {
    stream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  try {
    void audioCtx?.close();
  } catch {
    /* ignore */
  }
  recorder = null;
  stream = null;
  analyser = null;
  audioCtx = null;
  chunks = [];
  emit();
}
