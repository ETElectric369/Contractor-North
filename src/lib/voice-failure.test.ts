import { describe, it, expect } from "vitest";
import { micBlockedLine, NO_VOICE_LINE, noVoiceLine, oncePerTurn, SPOKEN_SENTENCE_MIN_WORDS, spokenRequestFailure, TRY_AGAIN_LINE, tryAgainLine, voiceFailureExtra, voiceRequestRefusal } from "@/lib/voice-failure";
import { dict, translator } from "@/lib/i18n";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Nort's voice loop failed on Erik's phone for a week (09-16 to 09-23) and left no trace: the
 * status lines named a mic button the panel does not have, and nothing reported. These pin the
 * copy to the controls that exist and the report to a shape the ops sink will actually keep.
 */

const EM_DASH = "—";

describe("the lines a failed voice turn shows", () => {
  it("names Talk to Nort and the text box, never a mic button the panel lacks", () => {
    // The top bar's Nort button is gone (W1-09): the voice starts from Talk to Nort, the first row
    // under Search or Ask, so that is the control a try-again line names.
    expect(TRY_AGAIN_LINE).toContain("Talk to Nort");
    expect(TRY_AGAIN_LINE).not.toContain("Nort button");
    expect(TRY_AGAIN_LINE).toContain("type below");
    expect(TRY_AGAIN_LINE.toLowerCase()).not.toContain("tap the mic");
    expect(NO_VOICE_LINE).toContain("Type below");
  });

  it("reads the catalog in the person's language (cn-v1138, nt_): the constants are the English, byte for byte", () => {
    expect(tryAgainLine("en")).toBe(TRY_AGAIN_LINE);
    expect(noVoiceLine("en")).toBe(NO_VOICE_LINE);
    expect(TRY_AGAIN_LINE).toBe(dict("en").nt_tryAgainLine);
    expect(tryAgainLine("es")).toBe("Toca Hablar con Nort para intentarlo de nuevo, o escribe abajo.");
    expect(noVoiceLine("es")).toBe("La voz no está disponible aquí. Escribe abajo.");
    expect(tryAgainLine(null)).toBe(TRY_AGAIN_LINE);
  });

  it("fits one status line on a 375px phone (about 48 characters)", () => {
    expect(TRY_AGAIN_LINE.length).toBeLessThanOrEqual(48);
  });

  it("sends a shell user to the North app's mic switch, and a browser user to Safari's", () => {
    expect(micBlockedLine(true)).toContain("Settings → North → Microphone");
    expect(micBlockedLine(true)).not.toContain("Safari");
    expect(micBlockedLine(false)).toContain("Settings → Safari");
    for (const native of [true, false]) expect(micBlockedLine(native)).toContain("type below");
  });

  it("carries no em-dashes", () => {
    for (const s of [TRY_AGAIN_LINE, NO_VOICE_LINE, micBlockedLine(true), micBlockedLine(false)]) {
      expect(s).not.toContain(EM_DASH);
    }
  });
});

describe("the report a failed voice turn files", () => {
  const base = {
    mimeType: "audio/mp4",
    track: { readyState: "live", muted: true },
    audioCtxState: "suspended",
    status: "Heard sound but no words. Try speaking a bit louder.",
    detail: "5321 bytes",
    native: true,
    retry: 1,
  };

  it("fits what reportClientError keeps: at most eight short, well-named string fields", () => {
    const extra = voiceFailureExtra(base);
    const keys = Object.keys(extra);
    // safeExtra (report-client-error.ts) keeps the first eight keys matching this and drops the
    // rest without a word, so a ninth field would be a field that silently never arrives.
    expect(keys.length).toBeLessThanOrEqual(8);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]{1,40}$/i);
    for (const v of Object.values(extra)) expect(typeof v).toBe("string");
  });

  it("says what the branches turn on: format, track, context, the line on screen, shell or web", () => {
    expect(voiceFailureExtra(base)).toEqual({
      mimeType: "audio/mp4",
      trackState: "live",
      trackMuted: "true",
      audioCtx: "suspended",
      status: base.status,
      detail: "5321 bytes",
      shell: "native",
      retry: "1",
    });
  });

  it("says 'none' before the mic was ever granted, rather than dropping the field", () => {
    const extra = voiceFailureExtra({ ...base, mimeType: "", track: null, audioCtxState: null, detail: undefined, native: false, retry: 0 });
    expect(extra).toMatchObject({ mimeType: "(browser default)", trackState: "none", trackMuted: "n/a", audioCtx: "none", detail: "", shell: "web", retry: "0" });
  });

  it("keeps the status and detail short", () => {
    const extra = voiceFailureExtra({ ...base, status: "x".repeat(900), detail: "y".repeat(900) });
    expect(extra.status.length).toBe(200);
    expect(extra.detail.length).toBe(200);
  });
});

describe("one report per branch per turn", () => {
  it("files a branch once however many retries repeat it, and again on the next turn", () => {
    const gate = oncePerTurn();
    expect(gate.first("empty-transcript")).toBe(true);
    expect(gate.first("empty-transcript")).toBe(false);
    expect(gate.first("empty-transcript")).toBe(false);
    // A different failure in the same turn is its own news.
    expect(gate.first("blob-too-small")).toBe(true);
    gate.reset();
    expect(gate.first("empty-transcript")).toBe(true);
  });
});

describe("what Nort says when a voice turn's request is refused (cn-v1157)", () => {
  const FALLBACK = "That didn't go through. Say it again.";
  it("speaks the route's own sentence when it sent one", () => {
    expect(spokenRequestFailure("You've used this month's allowance. Add usage in Settings.", FALLBACK)).toBe("You've used this month's allowance. Add usage in Settings.");
    expect(spokenRequestFailure("  Sign in again,\n then ask me once more.  ", FALLBACK)).toBe("Sign in again, then ask me once more.");
  });
  it("falls back when the body is not a sentence to hear: empty, markup, JSON, a wall of text", () => {
    expect(spokenRequestFailure("", FALLBACK)).toBe(FALLBACK);
    expect(spokenRequestFailure(null, FALLBACK)).toBe(FALLBACK);
    expect(spokenRequestFailure("<!DOCTYPE html><html><body>504</body></html>", FALLBACK)).toBe(FALLBACK);
    expect(spokenRequestFailure("An error <b>occurred</b>", FALLBACK)).toBe(FALLBACK);
    expect(spokenRequestFailure('{"error":"FUNCTION_INVOCATION_TIMEOUT"}', FALLBACK)).toBe(FALLBACK);
    expect(spokenRequestFailure("[object Object]", FALLBACK)).toBe(FALLBACK);
    expect(spokenRequestFailure("x".repeat(221), FALLBACK)).toBe(FALLBACK);
  });

  it("a STATUS WORD is not a sentence: the route's bare labels are never said out loud (skeptic #60)", () => {
    // What api/chat answers a programming refusal with, and what the client says when the body will not read.
    for (const label of ["Unauthorized", "Bad request", "No messages", "Request failed.", "Forbidden", "Not Found", "Try again later."]) {
      expect(spokenRequestFailure(label, FALLBACK), label).toBe(FALLBACK);
    }
    // …and those three ARE what the route sends: the labels this rule exists for.
    const route = readFileSync(join(process.cwd(), "src/app/api/chat/route.ts"), "utf8");
    for (const body of ['new Response("Unauthorized", { status: 401 })', 'new Response("Bad request", { status: 400 })', 'new Response("No messages", { status: 400 })']) {
      expect(route, body).toContain(body);
    }
    // Four words is the line: three is a label, four is a sentence. Words are counted by their letters,
    // so a dash or a number alone does not make a label into a sentence.
    expect(SPOKEN_SENTENCE_MIN_WORDS).toBe(4);
    expect(spokenRequestFailure("Nort is off today", FALLBACK)).toBe("Nort is off today");
    expect(spokenRequestFailure("Nort is off", FALLBACK)).toBe(FALLBACK);
    expect(spokenRequestFailure("Error 500 — 12", FALLBACK)).toBe(FALLBACK);
    // The sentences the route really sends are all still spoken.
    for (const sentence of [
      "Nort is off for your company. You can turn it on in Settings, under Features.",
      "Nort is off for your company. Ask the owner to turn it on.",
      "Nort is catching up — give it a minute.",
      "Your team has hit today's assistant limit. It resets tomorrow.",
      "Nort isn't available right now. Try again later.",
    ]) {
      expect(route, sentence).toContain(sentence);
      expect(spokenRequestFailure(sentence, FALLBACK), sentence).toBe(sentence);
    }
  });
});

describe("a refused voice turn: the line, and whether the mic listens again (cn-v1157)", () => {
  const en = translator("en");
  const words = { failed: en("nt_voiceRequestFailedLine"), signedOut: en("nt_voiceSignedOutLine"), closing: en("nt_closingMicLine") };

  it("a refusal that passes (a limiter, a server briefly down) is said and the mic re-arms", () => {
    expect(voiceRequestRefusal(429, "Nort is catching up — give it a minute.", words)).toEqual({ line: "Nort is catching up — give it a minute.", rearm: true });
    expect(voiceRequestRefusal(503, "Nort isn't available right now. Try again later.", words)).toEqual({ line: "Nort isn't available right now. Try again later.", rearm: true });
    expect(voiceRequestRefusal(400, "Bad request", words)).toEqual({ line: "That didn't go through. Say it again.", rearm: true });
    expect(voiceRequestRefusal(500, "<html>500</html>", words)).toEqual({ line: "That didn't go through. Say it again.", rearm: true });
  });

  it("signed out (401): the signed-out line, once, and the mic is NOT re-armed", () => {
    const r = voiceRequestRefusal(401, "Unauthorized", words);
    expect(r).toEqual({ line: "You're signed out, so I'm closing the mic. Sign in again, then tap Talk.", rearm: false });
    // Never "Say it again" over a mic that is about to close: the spoke-into-a-closed-mic defect.
    expect(r.line).not.toMatch(/say it again/i);
    expect(r.line).not.toContain("Unauthorized");
  });

  it("refused for this person (403): the route's own sentence, once, no re-arm; with no sentence, the closing line", () => {
    const off = "Nort is off for your company. You can turn it on in Settings, under Features.";
    expect(voiceRequestRefusal(403, off, words)).toEqual({ line: off, rearm: false });
    expect(voiceRequestRefusal(403, "Forbidden", words)).toEqual({ line: "I'm closing the mic. Tap Talk when you need me.", rearm: false });
    expect(voiceRequestRefusal(403, "<html><body>blocked</body></html>", words).rearm).toBe(false);
  });

  it("the signed-out line exists in both languages (tú), and says the mic is closing and what to do", () => {
    expect(translator("es")("nt_voiceSignedOutLine")).toBe("Se cerró tu sesión, así que cierro el micrófono. Inicia sesión de nuevo y luego toca Hablar.");
    expect(dict("en").nt_voiceSignedOutLine).toContain("tap Talk");
    expect(dict("es").nt_voiceSignedOutLine).toContain("toca Hablar");
    for (const lang of ["en", "es"] as const) expect(dict(lang).nt_voiceSignedOutLine).not.toContain(EM_DASH);
  });

  it("the panel asks this rule, and a shut door ENDS the voice session (the mic is let go, not left muted)", () => {
    const chat = readFileSync(join(process.cwd(), "src/app/(app)/assistant/assistant-chat.tsx"), "utf8");
    expect(chat).toContain('const refusal = voiceRequestRefusal(res.status, errText, { failed: t("nt_voiceRequestFailedLine"), signedOut: t("nt_voiceSignedOutLine"), closing: t("nt_closingMicLine") });');
    expect(chat).toMatch(/say\(refusal\.line, \(\) => \{\s*if \(!refusal\.rearm\) stopVoice\(\);\s*else if \(voiceModeRef\.current\) startMic\(\);\s*\}\);/);
    // stopVoice is the whole ending: voice mode off, the stream stopped, any speech cut.
    expect(chat).toMatch(/function stopVoice\(\) \{\s*setVoiceMode\(false\);\s*speech\.stopListening\(\{ discard: true \}\);/);
    expect(chat).not.toContain("spokenRequestFailure("); // one rule, asked through voiceRequestRefusal
  });
});
