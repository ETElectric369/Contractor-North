import { describe, it, expect } from "vitest";
import { micBlockedLine, NO_VOICE_LINE, oncePerTurn, TRY_AGAIN_LINE, voiceFailureExtra } from "@/lib/voice-failure";

/**
 * Nort's voice loop failed on Erik's phone for a week (09-16 to 09-23) and left no trace: the
 * status lines named a mic button the panel does not have, and nothing reported. These pin the
 * copy to the controls that exist and the report to a shape the ops sink will actually keep.
 */

const EM_DASH = "—";

describe("the lines a failed voice turn shows", () => {
  it("names the Nort button and the text box, never a mic button the panel lacks", () => {
    expect(TRY_AGAIN_LINE).toContain("Nort button");
    expect(TRY_AGAIN_LINE).toContain("type below");
    expect(TRY_AGAIN_LINE.toLowerCase()).not.toContain("tap the mic");
    expect(NO_VOICE_LINE).toContain("Type below");
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
