import { isNativeShell } from "@/lib/native-shell";

/**
 * THE SHELL'S TRACE (2026-10-15, the first native night). Erik, screen locked: "my statement was
 * recorded but no response back while locked; the moment I unlocked, there was the text from what
 * I said and he responded right away." The recorder (native) worked dark; something in the page
 * after it did not — the transcribe request, the chat stream, or the reply's playback (iOS WebKit
 * will not START media playback while the page is hidden; playback already running is allowed).
 * The bridge log over the cable is the only way to read a locked phone, so every stage of a voice
 * turn says its name and the clock here. Shell only: the web console stays as it was.
 */
export function trace(stage: string, extra?: string) {
  if (!isNativeShell()) return;
  try {
    const d = new Date();
    const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
    console.log(`[nort-trace] ${t} ${stage}${extra ? ` ${extra}` : ""}${hidden ? " (hidden)" : ""}`);
  } catch {
    /* a console that is gone */
  }
}
