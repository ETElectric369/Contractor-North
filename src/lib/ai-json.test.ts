import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/ai-cost", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordAiUsage: async () => {},
}));

import { extractJsonObject, parseAiJson } from "./ai-json";

describe("reading a JSON object out of a model's reply", () => {
  it("takes the object out of a ```json fence", () => {
    expect(JSON.parse(extractJsonObject('```json\n{"items":[]}\n```'))).toEqual({ items: [] });
  });

  it("takes it out of a bare fence too", () => {
    expect(JSON.parse(extractJsonObject('```\n{"a":1}\n```'))).toEqual({ a: 1 });
  });

  it("ignores prose either side — the old slice did this much and no more", () => {
    expect(JSON.parse(extractJsonObject('Here you go:\n{"a":1}\nHope that helps!'))).toEqual({ a: 1 });
  });

  it("scrubs a trailing comma, in an object and in an array", () => {
    expect(JSON.parse(extractJsonObject('{"items":[1,2,],}'))).toEqual({ items: [1, 2] });
  });

  it("throws rather than returning junk when there is no object at all", () => {
    expect(() => extractJsonObject("I could not price that.")).toThrow(/No JSON/);
  });

  it("keeps the LAST closing brace, so a nested object survives", () => {
    expect(JSON.parse(extractJsonObject('{"a":{"b":1},"c":2}'))).toEqual({ a: { b: 1 }, c: 2 });
  });

  it("an unescaped inch mark still fails HERE — that is what the repair round trip is for", () => {
    // The everyday vocabulary of this trade: 3/4" EMT, 1/2" drywall. A model that forgets to
    // escape one produces a broken string, extractJsonObject cannot mend it, and the caller must
    // fall through to the repair. Pinned so nobody "fixes" this by mangling quotes blindly.
    expect(() => JSON.parse(extractJsonObject('{"description":"3/4" EMT"}'))).toThrow();
  });
});

/**
 * THE REPAIR IS SIZED TO THE ANSWER IT IS REPAIRING.
 *
 * A repair has to re-emit the whole document, so a budget of 4,096 tokens — a receipt's — cannot hold a
 * statement transcription. The caller then got "The response was too large to repair.", which reads as
 * a LENGTH problem the paper may not have: one unescaped inch mark on line 90 of 100 landed on exactly
 * that sentence, and the scanned-statement lane printed it as "this statement is too long".
 */
describe("the one repair round trip", () => {
  const client = (reply: string, stop = "end_turn") => {
    const calls: any[] = [];
    return {
      calls,
      api: {
        messages: {
          create: async (args: unknown) => {
            calls.push(args);
            return { model: "model-test", stop_reason: stop, usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: "text", text: reply }] };
          },
        },
      } as never,
    };
  };

  it("a reply that parses costs nothing at all", async () => {
    const c = client("never asked");
    expect(await parseAiJson(c.api, '{"a":1}')).toEqual({ a: 1 });
    expect(c.calls).toEqual([]);
  });

  it("4,096 tokens by default, and a long-answer caller passes its own budget", async () => {
    const small = client('{"description":"3/4\\" EMT"}');
    await parseAiJson(small.api, '{"description":"3/4" EMT"}');
    expect(small.calls[0].max_tokens).toBe(4096);

    const big = client('{"description":"3/4\\" EMT"}');
    await parseAiJson(big.api, '{"description":"3/4" EMT"}', null, 16_000);
    expect(big.calls[0].max_tokens).toBe(16_000);
    // A budget smaller than the default is never honoured: it would only move the failure.
    const tiny = client('{"description":"3/4\\" EMT"}');
    await parseAiJson(tiny.api, '{"description":"3/4" EMT"}', null, 10);
    expect(tiny.calls[0].max_tokens).toBe(4096);
  });

  it("a repair that itself ran out of room still refuses rather than closing over an amputation", async () => {
    const c = client('{"a":1}', "max_tokens");
    await expect(parseAiJson(c.api, '{"description":"3/4" EMT"}')).rejects.toThrow(/too large to repair/);
  });
});
