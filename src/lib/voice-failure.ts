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

import { translator, type Lang } from "./i18n";

/** The glass panel's controls: Talk to Nort (the first row under Search or Ask; the panel has no
 *  mic of its own) and the text box under the status line. Every "what to do now" line names
 *  those two and nothing else. It fits the status line on a 375px phone (48 characters) whole.
 *  The words live in the catalog (nt_tryAgainLine, cn-v1138): the panel reads them in the person's
 *  language through tryAgainLine(lang); the constant is the English for the stream's own status
 *  lines, which are still English. */
export function tryAgainLine(lang?: Lang | null): string {
  return translator(lang)("nt_tryAgainLine");
}
export const TRY_AGAIN_LINE = tryAgainLine("en");

/** SPOKEN, not shown: the one line Nort says before the mic closes on the no-speech budget (a driver
 *  cannot read the status line), and the one he says when a voice turn's request did not go through. */
export function closingMicLine(lang?: Lang | null): string {
  return translator(lang)("nt_closingMicLine");
}
export function voiceRequestFailedLine(lang?: Lang | null): string {
  return translator(lang)("nt_voiceRequestFailedLine");
}

/** WHAT NORT SAYS WHEN A VOICE TURN'S REQUEST WAS REFUSED: the route's own sentence when it sent one
 *  (a usage limit, Nort switched off), so a driver hears the real reason and its one action; the
 *  fallback when the body is not a sentence a person should hear (markup, JSON, a wall of text).
 *  A STATUS WORD IS NOT A SENTENCE: the route answers a programming refusal with its label
 *  ("Unauthorized", "Bad request", "No messages"; api/chat), and Nort used to say that label out loud
 *  (skeptic #60). A sentence worth hearing has at least FOUR words; anything shorter is the fallback. */
export const SPOKEN_SENTENCE_MIN_WORDS = 4;
export function spokenRequestFailure(serverText: string | null | undefined, fallback: string): string {
  const s = String(serverText ?? "").replace(/\s+/g, " ").trim();
  if (!s || s.length > 220) return fallback;
  if (/^[<{[]/.test(s) || /<\/?[a-z][^>]*>/i.test(s)) return fallback;
  if (s.split(" ").filter((w) => /\p{L}/u.test(w)).length < SPOKEN_SENTENCE_MIN_WORDS) return fallback;
  return s;
}

/**
 * A REFUSED VOICE TURN: what Nort says, and whether the mic listens again after it.
 *
 * Most refusals pass: a limiter that needs a minute, a server that is briefly down. The line is said
 * and the mic re-arms the way a spoken reply re-arms it. TWO DO NOT PASS, and asking again cannot
 * help: 401, nobody is signed in (the route's body is the bare label, so Nort says the signed-out
 * line), and 403, the door is shut for this person (Nort is switched off for the company; the route
 * says so in a sentence, which is what is spoken). After either the mic is NOT re-armed: every
 * further turn would be refused the same way, a driver would be talking to a loop, and "Say it
 * again" over a mic that then closes is the spoke-into-a-closed-mic defect again. The line is said
 * once and the voice session ends. Pure: the caller hands in its own words, in the person's language.
 */
export function voiceRequestRefusal(
  status: number,
  serverText: string | null | undefined,
  words: { failed: string; signedOut: string; closing: string },
): { line: string; rearm: boolean } {
  if (status === 401) return { line: spokenRequestFailure(serverText, words.signedOut), rearm: false };
  if (status === 403) return { line: spokenRequestFailure(serverText, words.closing), rearm: false };
  return { line: spokenRequestFailure(serverText, words.failed), rearm: true };
}

/** Shown when the browser has no way to record at all, so trying again cannot help. */
export function noVoiceLine(lang?: Lang | null): string {
  return translator(lang)("nt_noVoiceLine");
}
export const NO_VOICE_LINE = noVoiceLine("en");

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
