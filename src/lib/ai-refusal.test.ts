import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { refusalWords, refused, saidFailure, type SaidFailure } from "./ai-refusal";

/**
 * The refusal helper, pinned: a declined request is an HTTP 200 whose stop_reason says so, and
 * the one check every door makes is on that field alone. The words are one sentence in each
 * language, and the JSON doors' envelope is the shape they already return.
 */
describe("refused: the one check before reading content", () => {
  it("is true for stop_reason refusal and nothing else", () => {
    expect(refused({ stop_reason: "refusal" })).toBe(true);
    for (const r of ["end_turn", "tool_use", "max_tokens", "pause_turn", "stop_sequence", null, undefined]) {
      expect(refused({ stop_reason: r })).toBe(false);
    }
    expect(refused(null)).toBe(false);
    expect(refused(undefined)).toBe(false);
    expect(refused({})).toBe(false);
  });

  it("takes the SDK's Message as it is (the stream's finalMessage too)", () => {
    const declined = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: "refusal",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    } as unknown as Anthropic.Message;
    expect(refused(declined)).toBe(true);
    // stop_details is informational and may be null on a refusal: the check never reads it.
    const withDetails = { ...declined, stop_details: { type: "refusal", category: "cyber", explanation: null } };
    expect(refused(withDetails)).toBe(true);
  });
});

describe("refusalWords: one sentence, in the asker's language", () => {
  it("says it in English by default and in Spanish for es", () => {
    expect(refusalWords()).toBe("Nort can't help with that one.");
    expect(refusalWords("en")).toBe("Nort can't help with that one.");
    expect(refusalWords("es")).toBe("Nort no puede ayudar con eso.");
  });
});

describe("saidFailure: the JSON doors' envelope", () => {
  it("is { ok: false, error } — the shape organize, the panel reads and the list read return today", () => {
    const f = saidFailure("refused");
    // Assignable to the envelope every reader's callers already handle.
    const envelope: { ok: false; error: string } = f;
    expect(envelope).toEqual({ ok: false, error: "Nort can't help with that one.", reason: "refused" });
    expect(f.ok).toBe(false);
  });

  it("names what the model did, in both languages, one action each", () => {
    const kinds: SaidFailure["reason"][] = ["refused", "cut_off", "unreadable"];
    for (const k of kinds) {
      const en = saidFailure(k, "en");
      const es = saidFailure(k, "es");
      expect(en.reason).toBe(k);
      expect(es.reason).toBe(k);
      expect(en.error.length).toBeGreaterThan(10);
      expect(es.error).not.toBe(en.error);
    }
    expect(saidFailure("refused").error).toBe(refusalWords("en"));
    expect(saidFailure("refused", "es").error).toBe(refusalWords("es"));
    expect(saidFailure("cut_off").error).toBe("The answer ran past what one read can hold. Try a smaller piece.");
    expect(saidFailure("unreadable").error).toBe("Nort answered, but not in a form the app could read. Try again.");
  });
});
