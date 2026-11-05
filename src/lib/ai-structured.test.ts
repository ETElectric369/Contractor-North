import { describe, it, expect } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { answerText, readStructured } from "./ai-structured";
import { refusalWords, saidFailure } from "./ai-refusal";

/**
 * A SCHEMA'D ANSWER, READ ONE WAY (cn-v1142): refusal first, then the cut-off, then the schema —
 * never a thrown parse error at a door.
 */
const FORMAT = zodOutputFormat(z.object({ paper: z.enum(["bill", "other"]), what: z.string() }));
const msg = (stop_reason: string, content: unknown[]) => ({ stop_reason, content }) as never;
const text = (t: string) => ({ type: "text", text: t });

describe("readStructured", () => {
  it("reads a whole answer through its schema", () => {
    expect(readStructured(msg("end_turn", [text('{"paper":"bill","what":"a bill"}')]), FORMAT)).toEqual({ ok: true, value: { paper: "bill", what: "a bill" } });
  });

  it("a refusal is the one sentence, even with a partial that would parse", () => {
    const got = readStructured(msg("refusal", [text('{"paper":"bill","what":"a bill"}')]), FORMAT);
    expect(got).toEqual(saidFailure("refused"));
    expect(got.ok || got.error).toBe(refusalWords());
  });

  it("a cut-off is said as one, never parsed", () => {
    expect(readStructured(msg("max_tokens", [text('{"paper":"bi')]), FORMAT)).toEqual(saidFailure("cut_off"));
  });

  it("an answer outside its schema, or none at all, is unreadable — not a throw", () => {
    expect(readStructured(msg("end_turn", [text('{"paper":"lunch","what":"x"}')]), FORMAT)).toEqual(saidFailure("unreadable"));
    expect(readStructured(msg("end_turn", [text("not json")]), FORMAT)).toEqual(saidFailure("unreadable"));
    expect(readStructured(msg("end_turn", []), FORMAT)).toEqual(saidFailure("unreadable"));
  });
});

describe("answerText", () => {
  it("joins the text blocks after the last fallback switch point, and skips the rest", () => {
    const content = [text("declined words"), { type: "fallback", from: { model: "a" }, to: { model: "b" } }, { type: "thinking", thinking: "x" }, text('{"a":'), text("1}")];
    expect(answerText(content)).toBe('{"a":1}');
    expect(answerText([text("one"), text(" two")])).toBe("one two");
    expect(answerText(undefined)).toBe("");
  });
});
