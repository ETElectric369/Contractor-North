import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A MISSED REPLY IS READ OUT WITH THE MIC DOWN (bug-report triage, 2026-09-27).
 *
 * catchUp reads out a reply the phone missed (a reload mid-turn) when the panel was opened by Talk
 * To Nort — which opened the mic in its own tap. say() only drops a mic that is BETWEEN turns
 * (voice-stream setMuted: `if (b && !active …)`), so this one reply played through a live capture:
 * on iOS 27 that is the speaker crackle cn-v980 fixed on the live paths. The live reply never meets
 * it (its turn has ended by the time it speaks) and resolveConfirm stops listening before its say();
 * catchUp must too, before either of its say() calls.
 */
/** The chat's code with its comments taken out, so the order checked is the order of the CALLS. */
const chat = readFileSync(join(process.cwd(), "src/app/(app)/assistant/assistant-chat.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
const body = (start: string, end: string) => chat.slice(chat.indexOf(start), chat.indexOf(end, chat.indexOf(start)));

describe("catchUp drops the mic before it speaks", () => {
  const catchUp = body("async function catchUp(", "function dropEmptyTail(");
  const readOut = catchUp.slice(catchUp.indexOf("if (autoStart) {"));

  it("stops listening (discarding the half-turn) before the first say()", () => {
    const stop = readOut.indexOf("speech.stopListening({ discard: true });");
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(readOut.indexOf("say("));
    // And the panel stops showing "listening".
    expect(readOut.indexOf("setListening(false);")).toBeLessThan(readOut.indexOf("say("));
  });

  it("still re-opens the mic after the reply, for a normal turn or for the yes/no", () => {
    expect(readOut).toContain("confirmListen();");
    expect(readOut).toContain("startMic();");
  });

  it("is the same order resolveConfirm keeps: stop listening, then speak", () => {
    const confirm = body("async function resolveConfirm(", "// When opened with ?q=");
    expect(confirm.indexOf("speech.stopListening({ discard: true });")).toBeLessThan(confirm.indexOf("say("));
  });
});
