import { describe, expect, it } from "vitest";
import { splitSentences } from "@/lib/tts";

/**
 * CHANGE 1 — streaming voice. splitSentences pulls COMPLETED sentences off the growing stream so
 * sentence 1 can be spoken while the rest still generates. A completed sentence ends with . ! ? and
 * is NOT a decimal (3.5) or a known abbreviation (Mr., e.g.). The trailing remainder is held back
 * (spoken later / flushed at stream end), so we never speak half a sentence.
 */
describe("splitSentences — completed-sentence detection for streaming TTS", () => {
  it("splits on ., !, ? and keeps the trailing fragment as rest", () => {
    const r = splitSentences("First one. Second one! Third one? And a trailing bit");
    expect(r.sentences).toEqual(["First one.", "Second one!", "Third one?"]);
    expect(r.rest.trim()).toBe("And a trailing bit");
  });

  it("does NOT split a decimal number", () => {
    const r = splitSentences("It's 3.5 hours of work");
    expect(r.sentences).toEqual([]);
    expect(r.rest).toContain("3.5 hours");
  });

  it("does NOT split on known abbreviations", () => {
    const r = splitSentences("Call Mr. Smith about the panel");
    // "Mr." is not a boundary → the whole thing is still in-flight remainder.
    expect(r.sentences).toEqual([]);
    expect(r.rest).toContain("Mr. Smith");
  });

  it("splits after an abbreviation once a real terminator arrives", () => {
    const r = splitSentences("Call Mr. Smith today. Then head out.");
    expect(r.sentences).toEqual(["Call Mr. Smith today.", "Then head out."]);
    expect(r.rest.trim()).toBe("");
  });

  it("keeps an unterminated first sentence entirely in rest (nothing spoken yet)", () => {
    const r = splitSentences("This reply has not finished its first sentence yet");
    expect(r.sentences).toEqual([]);
    expect(r.rest).toContain("not finished");
  });

  it("handles a terminator followed by a closing quote/paren as one boundary", () => {
    const r = splitSentences('He said "go ahead." Then he left.');
    expect(r.sentences[0]).toBe('He said "go ahead."');
    expect(r.sentences[1]).toBe("Then he left.");
  });

  it("treats ellipsis / multiple terminators as a single boundary", () => {
    const r = splitSentences("Hold on... Okay done.");
    expect(r.sentences).toEqual(["Hold on...", "Okay done."]);
  });

  it("a terminator with no following whitespace mid-token is not a boundary", () => {
    // e.g. a URL-ish or code-ish token "v1.2beta" shouldn't split.
    const r = splitSentences("Version 1.2beta is out");
    expect(r.sentences).toEqual([]);
  });

  it("progressive streaming: feeding a growing buffer never double-emits a sentence", () => {
    // Simulate the reader loop: consume only up to the last boundary each tick.
    const full = "Sentence one. Sentence two. Sentence three.";
    let spokenLen = 0;
    const emitted: string[] = [];
    for (let i = 1; i <= full.length; i++) {
      const visible = full.slice(0, i);
      const { sentences, rest } = splitSentences(visible.slice(spokenLen));
      for (const s of sentences) emitted.push(s.trim());
      spokenLen += visible.slice(spokenLen).length - rest.length;
    }
    expect(emitted).toEqual(["Sentence one.", "Sentence two.", "Sentence three."]);
  });

  it("empty / whitespace input yields nothing", () => {
    expect(splitSentences("").sentences).toEqual([]);
    expect(splitSentences("   ").sentences).toEqual([]);
  });
});
