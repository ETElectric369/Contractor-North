import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { aiCreate } from "./ai-call";
import { FALLBACK_BETA, fallbacksFor } from "./ai-cost";

/**
 * THE ONE NON-STREAMING CALL (ai-call aiCreate), against fake clients: a request carrying the
 * fallback fields rides client.beta.messages (the surface that types `betas` + `fallbacks` and
 * sends the header), every other request rides the stable client.messages with neither field, and
 * whatever the API answered comes back untouched.
 */

const ANSWER = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text: "{}" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 2 },
};

function fakeClient() {
  const stable = vi.fn(async (..._args: unknown[]) => ANSWER);
  const beta = vi.fn(async (..._args: unknown[]) => ANSWER);
  const client = { messages: { create: stable }, beta: { messages: { create: beta } } } as unknown as Anthropic;
  return { client, stable, beta };
}

const BASE = { max_tokens: 2000, messages: [{ role: "user" as const, content: "hi" }] };

describe("aiCreate", () => {
  it("betas present → the beta surface, with betas and fallbacks sent, and a null output_config dropped", async () => {
    const { client, stable, beta } = fakeClient();
    await aiCreate(client, { model: "claude-opus-5-5", ...fallbacksFor("claude-opus-5-5"), ...BASE, output_config: null as never });
    expect(stable).not.toHaveBeenCalled();
    expect(beta).toHaveBeenCalledTimes(1);
    const sent = beta.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.betas).toEqual([FALLBACK_BETA]);
    expect(sent.fallbacks).toBe("default");
    expect(sent).not.toHaveProperty("output_config");
    expect(sent.model).toBe("claude-opus-5-5");
  });

  it("betas present with a real output_config → it rides along", async () => {
    const { client, beta } = fakeClient();
    await aiCreate(client, { model: "claude-sonnet-5-5", ...fallbacksFor("claude-sonnet-5-5"), ...BASE, output_config: { effort: "medium" } });
    expect((beta.mock.calls[0][0] as Record<string, unknown>).output_config).toEqual({ effort: "medium" });
  });

  it("no betas → the stable surface, with betas and fallbacks stripped", async () => {
    const { client, stable, beta } = fakeClient();
    await aiCreate(client, { model: "claude-test", ...BASE, betas: undefined, fallbacks: undefined });
    expect(beta).not.toHaveBeenCalled();
    expect(stable).toHaveBeenCalledTimes(1);
    const sent = stable.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("betas");
    expect(sent).not.toHaveProperty("fallbacks");
    expect(sent.max_tokens).toBe(2000);
  });

  it("a Haiku model's fallbacksFor spread is empty, so it rides the stable surface with neither field", async () => {
    expect(fallbacksFor("claude-haiku-5-5")).toEqual({});
    const { client, stable, beta } = fakeClient();
    await aiCreate(client, { model: "claude-haiku-5-5", ...fallbacksFor("claude-haiku-5-5"), ...BASE });
    expect(beta).not.toHaveBeenCalled();
    const sent = stable.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("betas");
    expect(sent).not.toHaveProperty("fallbacks");
  });

  it("the per-request options reach whichever surface runs", async () => {
    const opts = { timeout: 30_000, maxRetries: 0 };
    const a = fakeClient();
    await aiCreate(a.client, { model: "claude-opus-5-5", ...fallbacksFor("claude-opus-5-5"), ...BASE }, opts);
    expect(a.beta.mock.calls[0][1]).toEqual(opts);
    const b = fakeClient();
    await aiCreate(b.client, { model: "claude-haiku-5-5", ...BASE }, opts);
    expect(b.stable.mock.calls[0][1]).toEqual(opts);
  });

  it("the message comes back as-is, on both surfaces", async () => {
    const a = fakeClient();
    expect(await aiCreate(a.client, { model: "claude-opus-5-5", ...fallbacksFor("claude-opus-5-5"), ...BASE })).toBe(ANSWER);
    const b = fakeClient();
    expect(await aiCreate(b.client, { model: "claude-haiku-5-5", ...BASE })).toBe(ANSWER);
  });
});
