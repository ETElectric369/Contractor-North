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

// ── End-of-speech detection ──────────────────────────────────────────────────────────────
// 2026-09-11, Erik on a job site inside the iOS shell: "Nord is not responding". The panel read
// "Hearing you…" the whole time. The gate was ONE fixed number (rms > 0.01 = speech) and the mic
// runs with autoGainControl, which pumps a quiet job site up to exactly that level — so ambient
// noise fluttered across the line every second, every flutter reset the 2.4 s silence window,
// and the turn never closed. He asked again into the same recording, gave up, and the 45 s cap
// finally shipped BOTH questions as one message (the "doubled dictation" in the transcript).
// The barge-in monitor (tts.ts) learned this lesson already: measure the room, then gate above
// it. Same here — an ambient FLOOR learned from the first quiet moments and tracked slowly after,
// speech = well above the floor, quiet = back near it (hysteresis, so the in-between band neither
// counts as a pause nor cancels one), on a smoothed level so a single loud frame can't reset.
const SPEAK_MIN_GATE = 0.012; // never call anything quieter than this "speech" (the old 0.01 gate + a hair)
const QUIET_MIN_GATE = 0.008; // …and never count anything louder than this as a pause on a silent floor
const FLOOR_CAP = 0.04; // the floor may not learn a shout as "the room" (AGC speech sits ~0.1–0.3)
const FLOOR_LEARN_MS = 250; // the opening window that seeds the floor before the user speaks
const PAUSE_MS = 2400; // ~2.4 s of quiet after speech = end of the utterance (see the history below)
const STILL_LISTENING_MS = 12000; // after this long in one turn, say how to end it
const TURN_CAP_MS = 45000; // never run a single turn forever (45 s holds a whole dictated scope)
const NO_SPEECH_CAP_MS = 9000; // give up a turn with no speech at all

function beginTurn() {
  if (!wantStream || !stream || !analyser) return;
  // A turn is already recording — the Talk button re-tapped mid-turn, or a re-arm raced the
  // previous turn. Replacing the live recorder here used to leak: the old recorder's final
  // ondataavailable landed in the NEW turn's chunk list and its onstop shipped that audio as a
  // turn of its own, while the new recorder kept rolling under the next turn — the same words
  // transcribed twice. Listening is listening; there is nothing to restart.
  if (active && recorder && recorder.state === "recording") return;
  try {
    if (recorder && recorder.state !== "inactive") {
      // Detach before stopping so a stale recorder can never feed or finish the next turn.
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
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
  let saidStillListening = false;
  const startedAt = Date.now();
  let smooth = 0; // ~50 ms exponential average of the RMS — one loud frame is not a word
  let floor = 0; // the room: seeded in the opening window, then drifts slowly toward the quiet level
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
    smooth += (rms - smooth) * 0.3;
    const elapsed = now - startedAt;
    // Learn the room. Opening window: the loudest quiet moment before anyone speaks (capped so a
    // turn that starts mid-sentence can't seed the floor at speech level). After that the floor
    // falls fast to any quieter reading and climbs only slowly — a truck idling up mid-turn is
    // learned in a few seconds; a spoken sentence barely nudges it.
    if (elapsed < FLOOR_LEARN_MS) floor = Math.min(FLOOR_CAP, Math.max(floor, smooth));
    else if (smooth < floor) floor = smooth;
    else floor = Math.min(FLOOR_CAP, floor + (smooth - floor) * 0.003);
    const speakGate = Math.max(SPEAK_MIN_GATE, floor * 2.2 + 0.006);
    const quietGate = Math.max(QUIET_MIN_GATE, floor * 1.5 + 0.003);
    if (muted) {
      silenceStart = 0;
    } else if (smooth > speakGate) {
      if (!spoke) status("Hearing you…");
      spoke = true;
      silenceStart = 0;
    } else if (spoke && smooth < quietGate) {
      if (!silenceStart) silenceStart = now;
      else if (now - silenceStart > PAUSE_MS) {
        // ~2.4s of quiet after speech → end of the utterance. Was 1300 — a contractor pausing
        // to think mid-scope got CUT OFF and the tail of the sentence was never heard (Erik:
        // "cuts us off mid sentence… isnt catching everything").
        stopTurn();
        return;
      }
    }
    // (between the gates: neither a word nor a pause — the running silence window stands.)
    // A long turn says how it ends, instead of "Hearing you…" for a minute (nothing silent).
    if (spoke && !saidStillListening && elapsed > STILL_LISTENING_MS) {
      saidStillListening = true;
      status("Still listening — pause for a couple of seconds when you're done");
    }
    // Safety caps: never run a single turn forever; give up a turn with no speech at all.
    // 18s truncated a real dictated scope — 45s holds a whole thought; Whisper is fine with it.
    if (elapsed > TURN_CAP_MS || (!spoke && elapsed > NO_SPEECH_CAP_MS)) {
      if (spoke) status("Sending what I heard — the mic never caught a pause…");
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

/**
 * STOP. The in-page mic tap ("I'm done talking") stops the turn and the audio still ships — that
 * is how a turn is ended by hand. `discard: true` is the other stop — the topbar STOP, End
 * conversation, New chat, close — where the recorder's final onstop used to transcribe and SEND
 * whatever it had anyway, so Nort answered a question after the user had said stop. Detach the
 * recorder before stopping it and nothing of that turn goes anywhere.
 */
export function stopListening(opts?: { discard?: boolean }) {
  wantStream = false;
  active = false;
  cancelAnimationFrame(rafId);
  try {
    if (recorder && opts?.discard) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
    }
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
