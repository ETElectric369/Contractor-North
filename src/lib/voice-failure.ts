/**
 * WHAT A FAILED NORT VOICE TURN SAYS: to the person holding the phone, and to ops.
 *
 * From 2026-09-16 to the 09-23 sweep, Nort never reached the server from Erik's phone, and
 * nothing anywhere said why. Every failure branch in voice-stream either set a status line or,
 * in two places, nothing at all, and none of them reported. The one attempt with evidence had
 * to be pieced together from a rate-limit row. Now each branch reports itself by NAME with the
 * few facts that tell the branches apart. Never audio, never transcript text.
 *
 * Pure (no browser, no server) so the copy and the payload shape are tested, not assumed.
 */

/** The glass panel's controls: the Nort button in the topbar (the panel has no mic of its own)
 *  and the text box under the status line. Every "what to do now" line names those two and
 *  nothing else. */
export const TRY_AGAIN_LINE = "Tap the Nort button up top to try again, or type below.";

/** Shown when the browser has no way to record at all, so trying again cannot help. */
export const NO_VOICE_LINE = "Voice isn't available here. Type below.";

/** Mic permission denied. Inside the iOS shell the app grants WebKit's own capture prompt
 *  (Capacitor's WKUIDelegate), so a denial comes from the OS switch for the North app, not from
 *  Safari. Sending a shell user to Safari's settings sends them to the wrong screen. */
export function micBlockedLine(native: boolean): string {
  return native
    ? "Mic blocked. Turn it on in Settings → North → Microphone, or type below."
    : "Mic blocked. Allow it in Settings → Safari, or type below.";
}

/** Every way a voice turn ends without words reaching Nort. The name IS the error_events
 *  message, so each branch is its own row and its count is how often it happens. */
export type VoiceBranch =
  | "getusermedia-rejected"
  | "getusermedia-hung"
  | "recorder-construct-failed"
  | "recorder-start-failed"
  | "no-speech-cap"
  | "blob-too-small"
  | "transcribe-error"
  | "transcribe-unreachable"
  | "empty-transcript"
  | "no-handler"
  // Not a lost turn: the mic came back interrupted after a spoken reply (iOS mutes capture while
  // audio plays) and was recovered. The detail says how, so the row shows which fix iOS needs.
  | "capture-interrupted";

export type VoiceSnapshot = {
  mimeType: string;
  /** The stream's first audio track, or null before the mic was ever granted. */
  track: { readyState?: string; muted?: boolean } | null | undefined;
  audioCtxState: string | null | undefined;
  /** The status line the panel is showing for this failure. */
  status: string;
  /** One short fact for this branch: an error name, a byte count, an HTTP status, a peak level. */
  detail?: string;
  native: boolean;
  /** How many silent retries this turn had already used. */
  retry: number;
};

/**
 * The extra payload for reportClientError. EIGHT keys at most, because safeExtra keeps the first
 * eight and drops the rest without a word. Every value is a short string, and nothing here can
 * carry what was said: the status lines are the panel's own copy.
 */
export function voiceFailureExtra(s: VoiceSnapshot): Record<string, string> {
  return {
    mimeType: s.mimeType || "(browser default)",
    trackState: s.track ? String(s.track.readyState ?? "unknown") : "none",
    trackMuted: s.track ? String(!!s.track.muted) : "n/a",
    audioCtx: s.audioCtxState ? String(s.audioCtxState) : "none",
    status: String(s.status ?? "").slice(0, 200),
    detail: String(s.detail ?? "").slice(0, 200),
    shell: s.native ? "native" : "web",
    retry: String(s.retry),
  };
}

/** One report per branch per turn. A turn retries itself when it hears nothing, and the same
 *  empty transcript three times over is one row's worth of news, not three. */
export function oncePerTurn() {
  const seen = new Set<VoiceBranch>();
  return {
    first(branch: VoiceBranch): boolean {
      if (seen.has(branch)) return false;
      seen.add(branch);
      return true;
    },
    reset(): void {
      seen.clear();
    },
  };
}
