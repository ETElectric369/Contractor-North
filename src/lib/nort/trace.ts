import { isNativeShell } from "@/lib/native-shell";
import { reportClientError } from "@/app/report-client-error";

/**
 * THE SHELL'S TRACE (2026-10-15, the first native night). Erik, screen locked: "my statement was
 * recorded but no response back while locked; the moment I unlocked, there was the text from what
 * I said and he responded right away." The recorder (native) worked dark; something in the page
 * after it did not — the transcribe request, the chat stream, or the reply's playback (iOS WebKit
 * will not START media playback while the page is hidden; playback already running is allowed).
 * Every stage of a voice turn says its name and the clock. Shell only: the web console stays as it was.
 *
 * TWO READERS. The console over the cable (the bridge log) — but a phone reopened by hand detaches
 * it, which is how the 00:52 test went unread. So the lines of a turn are also kept, and the moment
 * the screen comes back after any of them ran hidden, the whole turn goes to the ops sink as ONE
 * row (client:nort-voice, title "trace turn N"): no audio, no words, only stage names and clocks.
 *
 * EVERY ROW HAS ITS OWN TITLE. The sink dedupes on the title and a repeat REPLACES the payload, and
 * the turn counter restarts with every page load — and one turn can flush twice (the screen coming
 * back, then the next turn) — so "trace turn 1" alone let a later row overwrite an unread earlier
 * one before the daily read. The title also carries this page load's id and the flush's number.
 */
const lines: string[] = [];
/* THE SCREEN'S OWN LINES ARE NOT NEWS (sweep 2026-10-26). "screen hidden" is written while the page
 * is hidden, so it carried the (hidden) mark and made every lock-and-unlock of the phone a row in
 * the ops sink — thirty-two "trace turn 0" rows holding nothing but "screen hidden / screen
 * visible", twenty-three in one evening of the app simply being in a pocket. Only a stage of a
 * turn (or the fence) that ran dark makes the batch worth a row. */
const SCREEN_LINES = new Set(["screen hidden", "screen visible"]);
let hiddenSeen = false;
let turnNo = 0;
let installed = false;
// This page load's own mark: the ms it began plus two random characters (two loads in the same ms).
const loadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
let flushNo = 0;

function clock(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", () => {
    const visible = document.visibilityState === "visible";
    trace(visible ? "screen visible" : "screen hidden");
    if (visible) flushTrace("screen back");
  });
}

export function trace(stage: string, extra?: string) {
  if (!isNativeShell()) return;
  install();
  const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
  if (stage === "turn") {
    flushTrace("next turn"); // the previous turn's lines, if any ran hidden
    turnNo++;
  }
  const line = `${clock()} ${stage}${extra ? ` ${extra}` : ""}${hidden ? " (hidden)" : ""}`;
  if (hidden && !SCREEN_LINES.has(stage)) hiddenSeen = true;
  lines.push(line);
  if (lines.length > 40) lines.shift();
  try {
    console.log(`[nort-trace] ${line}`);
  } catch {
    /* a console that is gone */
  }
}

/** Ship the turn's lines to the ops sink if any of them ran with the screen dark; otherwise drop
 *  them (a foreground turn is not news). */
export function flushTrace(why: string) {
  if (!lines.length) return;
  const mine = lines.splice(0, lines.length);
  const wasHidden = hiddenSeen;
  hiddenSeen = false;
  if (!wasHidden || !isNativeShell()) return;
  try {
    void reportClientError("nort-voice", `trace turn ${turnNo} (load ${loadId}, flush ${++flushNo})`, { why, at: clock(), lines: mine.join("\n") }).catch(() => {});
  } catch {
    /* reporting must never break the loop */
  }
}
