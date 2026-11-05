import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { markCacheTail, runReplayRound, stripThinkingBlocks, toolUsesToAnswer } from "./replay";

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

/** A client whose fetch serves the scripted rounds in order and records every request body + headers. */
function scriptedClient(rounds: Array<Ev[] | Refusal>) {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }>; fallbacks?: unknown }> = [];
  const headers: Headers[] = [];
  let n = 0;
  const fetch = async (_url: unknown, init?: { body?: unknown; headers?: HeadersInit }) => {
    bodies.push(JSON.parse(String(init?.body)));
    headers.push(new Headers(init?.headers));
    const next = rounds[Math.min(n++, rounds.length - 1)];
    if (!Array.isArray(next)) {
      const body = { type: "error", error: { type: "invalid_request_error", message: next.message } };
      return new Response(JSON.stringify(body), { status: next.status, headers: { "content-type": "application/json" } });
    }
    return new Response(sse(next), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const client = new Anthropic({ apiKey: "test-key", fetch: fetch as never, maxRetries: 0 });
  return { client, bodies, headers };
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
    const convo: Anthropic.MessageParam[] = [{ role: "user", content: "Find Honeysuckle" }];
    await runRound(client, convo);
    convo.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "J-011" }] });
    await runRound(client, convo);

    const replayed = bodies[1].messages[1].content as Ev[];
    assertReplayValid(replayed);
    expect(replayed).toEqual([{ type: "tool_use", id: "toolu_3", name: "list_jobs", input: {} }]);
  });

  it("carries redacted thinking whole and a web search's query and result, straight off the wire", async () => {
    const { client, bodies } = scriptedClient([
      message(
        [
          start(0, { type: "redacted_thinking", data: "opaque-bytes" }),
          stop(0),
          start(1, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }),
          delta(1, { type: "input_json_delta", partial_json: '{"query":"12/2 ' }),
          delta(1, { type: "input_json_delta", partial_json: 'romex price"}' }),
          stop(1),
          start(2, { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] }),
          stop(2),
          start(3, { type: "tool_use", id: "toolu_4", name: "list_jobs", input: {} }),
          stop(3),
        ],
        "tool_use",
      ),
      ROUND_TWO,
    ]);
    const convo: Anthropic.MessageParam[] = [{ role: "user", content: "What does 12/2 run at Snowbell Supply?" }];
    await runRound(client, convo);
    convo.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_4", content: "[]" }] });
    await runRound(client, convo);

    const replayed = bodies[1].messages[1].content as Ev[];
    assertReplayValid(replayed);
    expect(replayed).toEqual([
      { type: "redacted_thinking", data: "opaque-bytes" },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "12/2 romex price" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
      { type: "tool_use", id: "toolu_4", name: "list_jobs", input: {} },
    ]);
  });
});

/** The fallback block as the API streams it: an ordinary content_block_start, no deltas. */
const FALLBACK_BLOCK: Ev = {
  type: "fallback",
  from: { model: "claude-opus-5-5" },
  to: { model: "claude-opus-4-8" },
  trigger: { type: "refusal", category: "cyber" },
};

describe("after a server-side fallback: the echo rule", () => {
  it("leaves the declined model's thinking, tool call and unfinished search out, keeps its words, its finished search and the marker in place, and everything after the boundary as normal", async () => {
    const { client, bodies } = scriptedClient([
      message(
        [
          // The requested model: thought, said a sentence, searched (finished), searched again
          // (never finished), called a tool (never answered) — then declined.
          start(0, { type: "thinking", thinking: "", signature: "" }),
          delta(0, { type: "thinking_delta", thinking: "Look at the Larkspur panel." }),
          delta(0, { type: "signature_delta", signature: SIGNATURE }),
          stop(0),
          start(1, { type: "text", text: "" }),
          delta(1, { type: "text_delta", text: "Checking the Larkspur panel. " }),
          stop(1),
          start(2, { type: "server_tool_use", id: "srvtoolu_a", name: "web_search", input: {} }),
          delta(2, { type: "input_json_delta", partial_json: '{"query":"200A panel price"}' }),
          stop(2),
          start(3, { type: "web_search_tool_result", tool_use_id: "srvtoolu_a", content: [] }),
          stop(3),
          start(4, { type: "server_tool_use", id: "srvtoolu_b", name: "web_search", input: {} }),
          delta(4, { type: "input_json_delta", partial_json: '{"query":"breaker price"}' }),
          stop(4),
          start(5, { type: "tool_use", id: "toolu_declined", name: "list_jobs", input: {} }),
          stop(5),
          start(6, FALLBACK_BLOCK),
          stop(6),
          // The fallback model: thought, said a sentence, called a tool.
          start(7, { type: "thinking", thinking: "", signature: "" }),
          delta(7, { type: "thinking_delta", thinking: "Find the job first." }),
          delta(7, { type: "signature_delta", signature: SIGNATURE }),
          stop(7),
          start(8, { type: "text", text: "" }),
          delta(8, { type: "text_delta", text: "Let me find that job." }),
          stop(8),
          start(9, { type: "tool_use", id: "toolu_9", name: "list_jobs", input: {} }),
          delta(9, { type: "input_json_delta", partial_json: '{"search":"Larkspur"}' }),
          stop(9),
        ],
        "tool_use",
      ),
      ROUND_TWO,
    ]);
    const convo: Anthropic.MessageParam[] = [{ role: "user", content: "Price the Larkspur panel swap" }];
    const { final } = await runRound(client, convo);

    // Only the fallback model's tool call is to be run and answered.
    expect(toolUsesToAnswer(final.content)).toEqual([{ type: "tool_use", id: "toolu_9", name: "list_jobs", input: { search: "Larkspur" } }]);
    convo.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "J-031 Larkspur" }] });
    await runRound(client, convo);

    const replayed = bodies[1].messages[1].content as Ev[];
    assertReplayValid(replayed);
    expect(replayed).toEqual([
      { type: "text", text: "Checking the Larkspur panel. " },
      { type: "server_tool_use", id: "srvtoolu_a", name: "web_search", input: { query: "200A panel price" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_a", content: [] },
      FALLBACK_BLOCK,
      { type: "thinking", thinking: "Find the job first.", signature: SIGNATURE },
      { type: "text", text: "Let me find that job." },
      { type: "tool_use", id: "toolu_9", name: "list_jobs", input: { search: "Larkspur" } },
    ]);
  });

  it("a pre-output fallback puts the marker first and changes nothing else", async () => {
    const { client, bodies } = scriptedClient([
      message(
        [
          start(0, FALLBACK_BLOCK),
          stop(0),
          start(1, { type: "thinking", thinking: "", signature: "" }),
          delta(1, { type: "signature_delta", signature: SIGNATURE }),
          stop(1),
          start(2, { type: "tool_use", id: "toolu_5", name: "list_team", input: {} }),
          stop(2),
        ],
        "tool_use",
      ),
      ROUND_TWO,
    ]);
    const convo: Anthropic.MessageParam[] = [{ role: "user", content: "Who is on the Thistlewood job?" }];
    const { final } = await runRound(client, convo);
    expect(toolUsesToAnswer(final.content)).toHaveLength(1);
    convo.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_5", content: "[]" }] });
    await runRound(client, convo);

    const replayed = bodies[1].messages[1].content as Ev[];
    assertReplayValid(replayed);
    expect(replayed).toEqual([FALLBACK_BLOCK, { type: "thinking", thinking: "", signature: SIGNATURE }, { type: "tool_use", id: "toolu_5", name: "list_team", input: {} }]);
  });

  it("a cache marker never lands on a fallback block", () => {
    const convo = [
      { role: "assistant", content: [{ type: "text", text: "Searching." }, FALLBACK_BLOCK] },
    ] as unknown as Anthropic.MessageParam[];
    markCacheTail(convo);
    const blocks = convo[0].content as unknown as Ev[];
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect("cache_control" in blocks[1]).toBe(false);
  });

  it("with fallbacksFor's fields on the params the round rides the beta surface: the body asks for the default fallback and the header names the beta; without them, neither", async () => {
    const { fallbacksFor } = await import("@/lib/ai-cost");
    const { client, bodies, headers } = scriptedClient([ROUND_TWO, ROUND_TWO]);
    await runRound(client, [{ role: "user", content: "hi" }], { params: { model: "claude-opus-5-5", max_tokens: 2048, ...fallbacksFor("claude-opus-5-5") } });
    expect(bodies[0].fallbacks).toBe("default");
    expect(headers[0].get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect("betas" in bodies[0]).toBe(false);

    await runRound(client, [{ role: "user", content: "hi" }], { params: { model: "claude-haiku-5-5", max_tokens: 2048, ...fallbacksFor("claude-haiku-5-5") } });
    expect("fallbacks" in bodies[1]).toBe(false);
    expect(headers[1].get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
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

describe("GATE 2 (the SDK bump): the stock accumulator carries what the capture used to rebuild", () => {
  it("finalMessage().content holds the thinking text, its signature, a redacted block and a web search's input, straight off the wire", async () => {
    const { client } = scriptedClient([
      message(
        [
          start(0, { type: "thinking", thinking: "", signature: "" }),
          delta(0, { type: "thinking_delta", thinking: "Find the Larkspur job " }),
          delta(0, { type: "thinking_delta", thinking: "before moving it." }),
          delta(0, { type: "signature_delta", signature: SIGNATURE }),
          stop(0),
          start(1, { type: "redacted_thinking", data: "opaque-bytes" }),
          stop(1),
          start(2, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }),
          delta(2, { type: "input_json_delta", partial_json: '{"query":"12/2 ' }),
          delta(2, { type: "input_json_delta", partial_json: 'romex price"}' }),
          stop(2),
          start(3, { type: "text", text: "" }),
          delta(3, { type: "text_delta", text: "Let me find that job." }),
          stop(3),
          start(4, { type: "tool_use", id: "toolu_1", name: "list_jobs", input: {} }),
          delta(4, { type: "input_json_delta", partial_json: '{"search":' }),
          delta(4, { type: "input_json_delta", partial_json: '"Larkspur"}' }),
          stop(4),
        ],
        "tool_use",
      ),
    ]);
    // No capture, no replay module: the SDK's own stream, its own final message.
    const final = await client.messages
      .stream({ model: "claude-opus-4-8", max_tokens: 2048, messages: [{ role: "user", content: "Move the Larkspur job" }] })
      .finalMessage();
    expect(final.content).toEqual([
      { type: "thinking", thinking: "Find the Larkspur job before moving it.", signature: SIGNATURE },
      { type: "redacted_thinking", data: "opaque-bytes" },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "12/2 romex price" } },
      { type: "text", text: "Let me find that job." },
      { type: "tool_use", id: "toolu_1", name: "list_jobs", input: { search: "Larkspur" } },
    ]);
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
