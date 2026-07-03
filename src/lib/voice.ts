/**
 * THE voice-input backend the assistant uses. Prefers getUserMedia + server transcription
 * (lib/voice-stream) — the only thing that does a hands-free multi-turn conversation on an iOS PWA —
 * and falls back to webkitSpeechRecognition (lib/speech) on browsers without it. Both expose the same
 * surface, so the assistant imports THIS and never knows which is live. The choice is deterministic
 * (a capability check), so a session never mixes backends mid-conversation.
 */
import * as streamBackend from "@/lib/voice-stream";
import * as recogBackend from "@/lib/speech";

function backend() {
  return streamBackend.speechSupported() ? streamBackend : recogBackend;
}

export function speechSupported(): boolean {
  return streamBackend.speechSupported() || recogBackend.speechSupported();
}
export function startListening(lang = "en-US"): boolean {
  return backend().startListening(lang);
}
export function setResultHandler(cb: ((text: string) => void) | null) {
  backend().setResultHandler(cb);
}
export function onListeningState(cb: (listening: boolean) => void): () => void {
  return backend().onListeningState(cb);
}
export function isListening(): boolean {
  return backend().isListening();
}
export function stopListening() {
  backend().stopListening();
}
export function setMuted(b: boolean) {
  // Both expose setMuted; call the active one (calling both is harmless).
  backend().setMuted?.(b);
}

/** Diagnostics — only the getUserMedia backend exposes them (the webkit one has no audio level). */
export function onStatus(cb: ((s: string) => void) | null) {
  (streamBackend as any).onStatus?.(cb);
}
export function currentLevel(): number {
  return (streamBackend as any).currentLevel?.() ?? 0;
}
/** Coarse live input RMS off the always-on analyser (for barge-in during playback). Only the
 *  getUserMedia backend has an analyser; returns null otherwise so the caller defaults to NOT
 *  interrupting. */
export function analyserRms(): number | null {
  return (streamBackend as any).analyserRms?.() ?? null;
}
export function usingStreamBackend(): boolean {
  return streamBackend.speechSupported();
}
