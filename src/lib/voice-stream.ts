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
import { reportClientError } from "@/app/report-client-error";
import { isNativeShell } from "@/lib/native-shell";
import {
  micBlockedLine,
  oncePerTurn,
  TRY_AGAIN_LINE,
  voiceFailureExtra,
  type VoiceBranch,
} from "@/lib/voice-failure";

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
/** Bumped by every stopListening. A transcription still in flight when Nort closed comes back to a
 *  session that has ended: it is discarded, with no status line (the next panel would replay it)
 *  and no report (it is not a defect; review of the 09-23 wave reproduced a false 'no-handler'). */
let session = 0;
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
// The line the mic is on right now. The Nort button starts the mic inside its tap, BEFORE the
// panel mounts and subscribes, so the first lines ("Connecting to the mic…", or a fast "Mic
// blocked") went to no one and the panel guessed instead. A new subscriber is told where things
// stand; stopListening clears it so a closed session never replays into the next one.
let lastStatus = "";
export function onStatus(cb: ((s: string) => void) | null) {
  statusCb = cb;
  if (cb && lastStatus) status(lastStatus);
}
function status(s: string) {
  lastStatus = s;
  try {
    statusCb?.(s);
  } catch {
    /* ignore */
  }
}

// NOTHING SILENT, for ops too (the 09-23 sweep: a week of Nort failing on the phone left no
// trace). Each terminal branch reports once per turn under its own name, with the facts that
// tell the branches apart: the recorder's format, whether the mic track is live or muted, the
// AudioContext's state, the line on screen, shell or web. No audio and no transcript, ever.
const reported = oncePerTurn();
function report(branch: VoiceBranch, shown: string, detail?: string) {
  if (!reported.first(branch)) return;
  try {
    const extra = voiceFailureExtra({
      mimeType,
      track: stream?.getAudioTracks?.()[0] ?? null,
      audioCtxState: audioCtx?.state,
      status: shown,
      detail,
      native: isNativeShell(),
      retry: silentTurns,
    });
    void reportClientError("nort-voice", branch, extra).catch(() => {});
  } catch {
    /* reporting must never break the mic */
  }
}

// Voice resilience: a silent turn (the 9s no-speech cap, an empty blob, a no-words transcription,
// a transcribe error) used to end the conversation MUTE — the mic stayed granted but nothing ever
// re-armed it. Retry a bounded number of CONSECUTIVE silent turns while the stream is still wanted,
// then hand control back with a status that names the controls the panel actually has.
const MAX_SILENT_RETRIES = 2;
let silentTurns = 0;
function retryOrGiveUp(detail: string, branch: VoiceBranch, fact?: string) {
  const retrying = wantStream && silentTurns < MAX_SILENT_RETRIES;
  const line = retrying || !wantStream ? detail : `${detail} ${TRY_AGAIN_LINE}`;
  status(line);
  report(branch, line, fact);
  if (retrying) {
    silentTurns++;
    nextTurn();
  }
}

// A turn that cannot record at all (the recorder will not build or will not start). The stream
// is dropped so "try again" means what it says: the next tap asks for the mic fresh, inside the
// gesture, instead of handing the same stream to the same recorder that just refused it.
function cannotRecord(branch: VoiceBranch, err: unknown) {
  const line = `The mic came on but can't record here. ${TRY_AGAIN_LINE}`;
  report(branch, line, errName(err)); // before the teardown: the track and context are the evidence
  stopListening({ discard: true });
  status(line);
}

function errName(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null;
  return [e?.name, e?.message].filter((x) => typeof x === "string" && x).join(": ") || String(err ?? "");
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

// A getUserMedia that never settles leaves the panel on "Connecting to the mic…" forever and
// reports nothing, so after this long it says so. The request is left running: if the mic does
// come up late, the turn simply starts.
const MIC_HANG_MS = 10000;
let micAttempt = 0;

/**
 * START. The FIRST call must run inside a user gesture (the mic-permission prompt). It kicks off
 * getUserMedia (async) and returns true; once the stream is live, recording turns no longer need a
 * gesture. A later call with the stream already alive just records the next turn.
 */
export function startListening(_lang?: string): boolean {
  if (!speechSupported()) return false;
  muted = false;
  silentTurns = 0; // a fresh (user-initiated) start resets the silent-retry budget
  reported.reset(); // …and is a new turn for reporting
  if (stream && audioCtx && analyser) {
    nextTurn(); // stream alive (mid-conversation) → record the next answer, no gesture needed
    return true;
  }
  wantStream = true;
  status("Connecting to the mic…");
  const attempt = ++micAttempt;
  let settled = false;
  const hang = setTimeout(() => {
    if (settled || !wantStream || attempt !== micAttempt) return;
    const line = `The mic isn't answering. ${TRY_AGAIN_LINE}`;
    status(line);
    report("getusermedia-hung", line, `${MIC_HANG_MS / 1000}s`);
  }, MIC_HANG_MS);
  navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then((s) => {
      settled = true;
      clearTimeout(hang);
      // Superseded (a second tap while this one hung) or already holding a stream: stop this one.
      // Overwriting `stream` and `audioCtx` would leave the first mic and its context running.
      if (!wantStream || attempt !== micAttempt || stream) {
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
      status("Mic ready. Go ahead.");
      beginTurn();
    })
    .catch((err) => {
      settled = true;
      clearTimeout(hang);
      wantStream = false;
      active = false;
      const msg = String(err?.name || err || "");
      const line = /NotAllowed|Permission|Denied/i.test(msg)
        ? micBlockedLine(isNativeShell())
        : `Mic unavailable (${msg || "no audio"}). ${TRY_AGAIN_LINE}`;
      status(line);
      report("getusermedia-rejected", line, errName(err));
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
/**
 * THE SECOND TURN (Erik's phone, 2026-09-24, iOS 27). The first turn worked ("Hey, Nora" → "What's
 * up, Erik?"); the next one recorded nine seconds of nothing. Its row said why: trackMuted true,
 * audioCtx suspended, peak equal to the floor. Nort's spoken reply had played through the speaker,
 * iOS interrupted capture while it did, and the re-arm then recorded from a mic iOS had muted and
 * metered it on a context iOS had suspended. So a turn that reuses the stream checks first: give
 * the track a moment to come back and resume the context, and if it is still dead, drop it and
 * open the mic fresh. The shell grants the mic without a new tap (Capacitor's media-capture
 * delegate answers .grant), so the conversation carries on by itself.
 */
function captureInterrupted(): boolean {
  const track = stream?.getAudioTracks?.()[0];
  if (!track || !audioCtx) return true;
  return track.muted || track.readyState !== "live" || audioCtx.state !== "running";
}

function waitForUnmute(track: MediaStreamTrack, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (!track.muted) return resolve();
    const done = () => {
      clearTimeout(timer);
      track.removeEventListener("unmute", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    track.addEventListener("unmute", done);
  });
}

/** Tear down the capture but keep the conversation: wantStream, the handler and the session stay. */
function dropCapture() {
  try {
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
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
}

/** Record the next turn on the open stream, or get the mic back first if a reply interrupted it. */
function nextTurn() {
  if (!captureInterrupted()) {
    beginTurn();
    return;
  }
  void recoverCapture();
}

async function recoverCapture() {
  const mine = session;
  const track = stream?.getAudioTracks?.()[0];
  const was = `${track?.muted ? "muted" : "unmuted"} ${track?.readyState ?? "no track"}, context ${audioCtx?.state ?? "none"}`;
  status("Getting the mic back…");
  if (track) await waitForUnmute(track, 1500);
  try {
    await audioCtx?.resume();
  } catch {
    /* a context iOS still holds interrupted refuses; the fresh mic below is the answer */
  }
  if (mine !== session || !wantStream) return; // Nort was closed while this waited
  if (!captureInterrupted()) {
    report("capture-interrupted", "Listening. Go ahead.", `recovered in place (was ${was})`);
    beginTurn();
    return;
  }
  // Still dead. Say so with the evidence while it still exists, then start over on a fresh mic.
  report("capture-interrupted", "Getting the mic back…", `reopened the mic (was ${was}; now context ${audioCtx?.state ?? "none"})`);
  dropCapture();
  startListening();
}

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
  // These two used to be bare returns: no status, no report, the panel frozen on "Mic ready — go
  // ahead" over a flat meter while nothing listened.
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    try {
      recorder = new MediaRecorder(stream);
    } catch (err) {
      cannotRecord("recorder-construct-failed", err);
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
  } catch (err) {
    cannotRecord("recorder-start-failed", err);
    return;
  }
  active = true;
  emit();

  status("Listening. Go ahead.");
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let spoke = false;
  let silenceStart = 0;
  let saidStillListening = false;
  const startedAt = Date.now();
  let smooth = 0; // ~50 ms exponential average of the RMS — one loud frame is not a word
  let floor = 0; // the room: seeded in the opening window, then drifts slowly toward the quiet level
  let peak = 0; // the loudest smoothed level this turn: a no-speech report says if the mic heard anything
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
    if (smooth > peak) peak = smooth;
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
      status("Still listening. Pause for a couple of seconds when you're done.");
    }
    // Safety caps: never run a single turn forever; give up a turn with no speech at all.
    // 18s truncated a real dictated scope — 45s holds a whole thought; Whisper is fine with it.
    if (elapsed > TURN_CAP_MS || (!spoke && elapsed > NO_SPEECH_CAP_MS)) {
      if (spoke) status("Sending what I heard. The mic never caught a pause…");
      // A peak near zero is a mic that captured silence; a peak under the gate is a quiet room.
      else report("no-speech-cap", lastStatus, `peak ${peak.toFixed(4)} floor ${floor.toFixed(4)} gate ${speakGate.toFixed(4)}`);
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
  const mine = session;
  cancelAnimationFrame(rafId);
  level = 0;
  active = false;
  emit();
  const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
  chunks = [];
  if (blob.size < 1200) {
    // Nothing usable was recorded — almost always the silent-PWA mic (stream "on" but capturing
    // nothing) or a permission gap. Say so plainly, and re-arm the mic if the stream is still wanted.
    retryOrGiveUp(
      `No audio captured (${blob.size} bytes). If the level meter stayed flat, the mic isn't reaching the app.`,
      "blob-too-small",
      `${blob.size} bytes`,
    );
    return;
  }
  status(`Sending ${(blob.size / 1024) | 0}KB to transcribe…`);
  try {
    const fd = new FormData();
    const ext = mimeType.includes("mp4") || mimeType.includes("aac") ? "mp4" : mimeType.includes("mpeg") ? "mp3" : "webm";
    fd.append("audio", blob, `turn.${ext}`);
    const r = await fetch("/api/transcribe", { method: "POST", body: fd });
    const j = await r.json().catch(() => null);
    if (mine !== session) return; // Nort was closed while this was in flight: nobody is listening
    if (!r.ok) {
      retryOrGiveUp(`Transcribe error: ${j?.error ?? r.status}.`, "transcribe-error", `HTTP ${r.status}, ${blob.size} bytes`);
      return;
    }
    const text = String(j?.text ?? "").trim();
    if (text && handler) {
      silentTurns = 0; // real words made it through — reset the retry budget
      handler(text);
    } else
      retryOrGiveUp(
        "Heard sound but no words. Try speaking a bit louder.",
        // Words with nowhere to go (the panel let go of the handler) is a different bug from
        // silence; only the LENGTH is reported, never the words.
        text ? "no-handler" : "empty-transcript",
        text ? `${text.length} chars, ${blob.size} bytes` : `${blob.size} bytes`,
      );
  } catch (e: any) {
    if (mine !== session) return;
    retryOrGiveUp(`Couldn't reach transcription (${e?.message ?? "network"}).`, "transcribe-unreachable", errName(e));
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
  session++;
  wantStream = false;
  active = false;
  lastStatus = ""; // this session's line must not replay into the next panel
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
