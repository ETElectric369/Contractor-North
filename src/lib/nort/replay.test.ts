import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createReplayCapture, markCacheTail, runReplayRound, stripThinkingBlocks } from "./replay";

/**
 * The 2026-09-23 Nort 400 ("each thinking block must contain thinking"), rebuilt against the REAL
 * SDK stream accumulator: a fake fetch serves round one as server-sent events (a thinking block,
 * a sentence, a tool call), runReplayRound — the same function the chat route calls for every
 * round — reassembles the assistant turn, and round two's request body is read back off the wire
 * and checked the way the API checks it.
 */

type Ev = Record<string, unknown>;

const sse = (events: Ev[]) =>
  events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const start = (index: number, content_block: Ev): Ev => ({ type: "content_block_start", index, content_block });
const delta = (index: number, d: Ev): Ev => ({ type: "content_block_delta", index, delta: d });
const stop = (index: number): Ev => ({ type: "content_block_stop", index });

function message(blocks: Ev[], stopReason: string): Ev[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    ...blocks,
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 } },
    { type: "message_stop" },
  ];
}

const SIGNATURE = "EqQBCkgIBRABGAIiQMockSignatureBytes==";

/** Round one as the API streamed it on the night: think, say a sentence, look the job up. */
const ROUND_ONE = message(
  [
    start(0, { type: "thinking", thinking: "", signature: "" }),
    delta(0, { type: "thinking_delta", thinking: "Find the Schaefer job " }),
    delta(0, { type: "thinking_delta", thinking: "before moving it." }),
    delta(0, { type: "signature_delta", signature: SIGNATURE }),
    stop(0),
    start(1, { type: "text", text: "" }),
    delta(1, { type: "text_delta", text: "Let me find that job." }),
    stop(1),
    start(2, { type: "tool_use", id: "toolu_1", name: "list_jobs", input: {} }),
    delta(2, { type: "input_json_delta", partial_json: '{"search":' }),
    delta(2, { type: "input_json_delta", partial_json: '"Schaefer"}' }),
    stop(2),
  ],
  "tool_use",
);

const ROUND_TWO = message(
  [start(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "Moved." }), stop(0)],
  "end_turn",
);

/** An API error response, as the API sends one. */
type Refusal = { status: number; message: string };
const refusal = (status: number, message: string): Refusal => ({ status, message });

/** A client whose fetch serves the scripted rounds in order and records every request body. */
function scriptedClient(rounds: Array<Ev[] | Refusal>) {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let n = 0;
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = rounds[Math.min(n++, rounds.length - 1)];
    if (!Array.isArray(next)) {
      const body = { type: "error", error: { type: "invalid_request_error", message: next.message } };
      return new Response(JSON.stringify(body), { status: next.status, headers: { "content-type": "application/json" } });
    }
    return new Response(sse(next), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const client = new Anthropic({ apiKey: "test-key", fetch: fetch as never, maxRetries: 0 });
  return { client, bodies };
}

/** What the API enforces on a replayed thinking block: both fields strings, a signature present. */
function assertReplayValid(content: unknown) {
  expect(Array.isArray(content)).toBe(true);
  expect((content as unknown[]).length).toBeGreaterThan(0);
  for (const b of content as Ev[]) {
    if (b.type === "thinking") {
      expect(typeof b.thinking).toBe("string");
      expect(typeof b.signature).toBe("string");
      expect((b.signature as string).length).toBeGreaterThan(0);
    }
    if (b.type === "redacted_thinking") expect(typeof b.data === "string" && b.data.length > 0).toBe(true);
  }
}

/** One round exactly as the chat route runs it: runReplayRound with the route's cache marker. */
async function runRound(
  client: Anthropic,
  convo: Anthropic.MessageParam[],
  extra: Partial<Parameters<typeof runReplayRound>[0]> = {},
) {
  const texts: string[] = [];
  const final = await runReplayRound({
    client,
    convo,
    prepare: markCacheTail,
    params: { model: "claude-opus-4-8", max_tokens: 2048 },
    onText: (t) => texts.push(t),
    ...extra,
  });
  return { final, texts };
}

describe("Nort replays an assistant turn that thought", () => {
  it("sends the thinking block back exactly as the wire carried it, text and signature", async () => {
    const { client, bodies } = scriptedClient([ROUND_ONE, ROUND_TWO]);
    const convo: Anthropic.MessageParam[] = [
      { role: "user", content: "The 10244 Schaefer job got moved to the week of October 12th" },
    ];

    const { final: first } = await runRound(client, convo);
    expect(first.stop_reason).toBe("tool_use");
    convo.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "J-012 Schaefer" }] });
    await runRound(client, convo);

    // Round two's request, as it left for the API.
    const replayed = bodies[1].messages[1];
    expect(replayed.role).toBe("assistant");
    assertReplayValid(replayed.content);
    expect(replayed.content).toEqual([
      { type: "thinking", thinking: "Find the Schaefer job before moving it.", signature: SIGNATURE },
      { type: "text", text: "Let me find that job." },
      { type: "tool_use", id: "toolu_1", name: "list_jobs", input: { search: "Schaefer" } },
    ]);
    // The cache marker rode the tail (the tool_result), never a thinking block.
    const tail = bodies[1].messages[2].content as Ev[];
    expect(tail[tail.length - 1].cache_control).toEqual({ type: "ephemeral" });
    expect((replayed.content as unknown as Ev[]).some((b) => "cache_control" in b)).toBe(false);
  });

  it("keeps a signed block whose text is empty (display: omitted) exactly as received", async () => {
    const { client, bodies } = scriptedClient([
      message(
        [
          start(0, { type: "thinking", thinking: "", signature: "" }),
          delta(0, { type: "signature_delta", signature: SIGNATURE }),
          stop(0),
          start(1, { type: "tool_use", id: "toolu_2", name: "list_team", input: {} }),
          stop(1),
        ],
        "tool_use",
      ),
      ROUND_TWO,
    ]);
    const convo: Anthropic.MessageParam[] = [{ role: "user", content: "Add Brian" }];
    await runRound(client, convo);
    convo.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "[]" }] });
    await runRound(client, convo);

    const replayed = bodies[1].messages[1].content as Ev[];
    assertReplayValid(replayed);
    expect(replayed[0]).toEqual({ type: "thinking", thinking: "", signature: SIGNATURE });
  });

  it("drops a thinking block whose signature never arrived instead of sending it broken", async () => {
    const { client, bodies } = scriptedClient([
      message(
        [
          start(0, { type: "thinking", thinking: "", signature: "" }),
          delta(0, { type: "thinking_delta", thinking: "half a thought" }),
          stop(0),
          start(1, { type: "tool_use", id: "toolu_3", name: "list_jobs", input: {} }),
          stop(1),
        ],
        "tool_use",
      ),
      ROUND_TWO,
    ]);
    const convo: Anthropic.MessageParam[] = [{ role: "user", content: "Find Herringbone" }];
    await runRound(client, convo);
    convo.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "J-011" }] });
    await runRound(client, convo);

    const replayed = bodies[1].messages[1].content as Ev[];
    assertReplayValid(replayed);
    expect(replayed).toEqual([{ type: "tool_use", id: "toolu_3", name: "list_jobs", input: {} }]);
  });

  it("carries redacted thinking whole and restores a web search's query", () => {
    const capture = createReplayCapture();
    const events: Ev[] = [
      start(0, { type: "redacted_thinking", data: "opaque-bytes" }),
      stop(0),
      start(1, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }),
      delta(1, { type: "input_json_delta", partial_json: '{"query":"12/2 romex price"}' }),
      stop(1),
    ];
    events.forEach(capture.onEvent);
    // What the old accumulator leaves behind: the start blocks, deltas unapplied.
    const snapshot = [
      { type: "redacted_thinking", data: "opaque-bytes" },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
    ];
    expect(capture.replayContent(snapshot)).toEqual([
      { type: "redacted_thinking", data: "opaque-bytes" },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "12/2 romex price" } },
    ]);
  });
});

describe("stripThinkingBlocks (the one retry after a refused replay)", () => {
  it("removes every thinking block, keeps the rest, and drops a turn left empty", () => {
    const convo = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "" },
          { type: "tool_use", id: "t1", name: "list_jobs", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "z" }] },
    ] as unknown as Anthropic.MessageParam[];

    expect(stripThinkingBlocks(convo)).toBe(2);
    expect(convo).toHaveLength(3);
    expect(convo[1].content).toEqual([{ type: "tool_use", id: "t1", name: "list_jobs", input: {} }]);
    expect(stripThinkingBlocks(convo)).toBe(0);
  });
});

const REFUSED = "messages.1.content.0.thinking: each thinking block must contain thinking";

/** A conversation whose last assistant turn holds a thinking block the API is about to refuse. */
function convoWithThinking(): Anthropic.MessageParam[] {
  return [
    { role: "user", content: "Move the Schaefer job" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: SIGNATURE },
        { type: "tool_use", id: "toolu_9", name: "list_jobs", input: {} },
      ],
    } as unknown as Anthropic.MessageParam,
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "J-012" }] },
  ];
}

describe("runReplayRound's one retry", () => {
  it("strips thinking and asks again when the API refuses a replayed thinking block, then reports it recovered", async () => {
    const { client, bodies } = scriptedClient([refusal(400, REFUSED), ROUND_TWO]);
    const convo = convoWithThinking();
    const reports: Array<{ recovered: boolean; stripped: number }> = [];
    const { final, texts } = await runRound(client, convo, { report: (_e, info) => reports.push(info) });

    expect(final.stop_reason).toBe("end_turn");
    expect(bodies).toHaveLength(2);
    // The retry's request carries no thinking block at all.
    const retried = bodies[1].messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown as Ev[]) : []));
    expect(retried.some((b) => b.type === "thinking" || b.type === "redacted_thinking")).toBe(false);
    expect(retried.some((b) => b.type === "tool_use")).toBe(true);
    // Nothing was said twice, and the report says what actually happened.
    expect(texts.join("")).toBe("Moved.");
    expect(reports).toEqual([{ stripped: 1, recovered: true }]);
    expect(convo[convo.length - 1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Moved." }] });
  });

  it("does not retry a 400 that is not about thinking, and keeps the valid thinking blocks", async () => {
    const { client, bodies } = scriptedClient([refusal(400, "prompt is too long: 210000 tokens > 200000 maximum"), ROUND_TWO]);
    const convo = convoWithThinking();
    const reports: unknown[] = [];
    await expect(runRound(client, convo, { report: (_e, info) => reports.push(info) })).rejects.toBeInstanceOf(
      Anthropic.BadRequestError,
    );
    expect(bodies).toHaveLength(1);
    expect(reports).toEqual([]);
    expect((convo[1].content as unknown as Ev[])[0].type).toBe("thinking");
  });

  it("reports a retry that fails as NOT recovered and throws the retry's error", async () => {
    const { client, bodies } = scriptedClient([refusal(400, REFUSED), refusal(400, "messages: tool_use ids must be unique")]);
    const reports: Array<{ recovered: boolean; stripped: number; retryError?: unknown }> = [];
    const err = await runRound(client, convoWithThinking(), { report: (_e, info) => reports.push(info) }).catch((e) => e);

    expect(bodies).toHaveLength(2);
    expect(err).toBeInstanceOf(Anthropic.BadRequestError);
    expect(String(err.message)).toContain("tool_use ids must be unique");
    expect(reports).toHaveLength(1);
    expect(reports[0].recovered).toBe(false);
    expect(reports[0].retryError).toBe(err);
  });

  it("does not retry when no one is left to answer", async () => {
    const { client, bodies } = scriptedClient([refusal(400, REFUSED), ROUND_TWO]);
    await expect(runRound(client, convoWithThinking(), { mayRetry: () => false })).rejects.toBeInstanceOf(
      Anthropic.BadRequestError,
    );
    expect(bodies).toHaveLength(1);
  });
});

describe("markCacheTail", () => {
  it("never puts the marker on a thinking block, and keeps exactly one", () => {
    const convo = [
      { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching." },
          { type: "thinking", thinking: "x", signature: SIGNATURE },
        ],
      },
    ] as unknown as Anthropic.MessageParam[];
    markCacheTail(convo);
    expect((convo[0].content as unknown as Ev[])[0].cache_control).toBeUndefined();
    expect((convo[1].content as unknown as Ev[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect("cache_control" in (convo[1].content as unknown as Ev[])[1]).toBe(false);

    const onlyThinking = [
      { role: "assistant", content: [{ type: "redacted_thinking", data: "z" }] },
    ] as unknown as Anthropic.MessageParam[];
    markCacheTail(onlyThinking);
    expect("cache_control" in (onlyThinking[0].content as unknown as Ev[])[0]).toBe(false);
  });
});

describe("a streamed round that searched the web is metered with its searches", () => {
  it("takes server_tool_use and the input tokens from the closing message_delta, so costOf counts the searches", async () => {
    const { costOf, WEB_SEARCH_USD } = await import("@/lib/ai-cost");
    const searched: Ev[] = [
      ...ROUND_TWO.slice(0, -2),
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 5000, output_tokens: 42, server_tool_use: { web_search_requests: 3 } },
      },
      { type: "message_stop" },
    ];
    const { client } = scriptedClient([searched]);
    const { final } = await runRound(client, [{ role: "user", content: "Look up Acme Test Supply" }]);
    const u = final.usage as unknown as { input_tokens: number; output_tokens: number; server_tool_use?: { web_search_requests?: number } };
    expect(u.server_tool_use?.web_search_requests).toBe(3);
    expect(u.input_tokens).toBe(5000);
    expect(u.output_tokens).toBe(42);
    const without = costOf("claude-opus-4-8", { input_tokens: 5000, output_tokens: 42 });
    expect(costOf("claude-opus-4-8", u)).toBeCloseTo(without + 3 * WEB_SEARCH_USD, 6);
  });

  it("keeps the early usage when the closing one leaves a field out", async () => {
    const { client } = scriptedClient([ROUND_TWO]);
    const { final } = await runRound(client, [{ role: "user", content: "hi" }]);
    expect(final.usage.input_tokens).toBe(10);
    expect(final.usage.output_tokens).toBe(42);
  });
});
