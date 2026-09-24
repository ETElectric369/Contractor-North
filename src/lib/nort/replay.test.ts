import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createReplayCapture, stripThinkingBlocks } from "./replay";

/**
 * The 2026-09-23 Nort 400 ("each thinking block must contain thinking"), rebuilt against the REAL
 * SDK stream accumulator: a fake fetch serves round one as server-sent events (a thinking block,
 * a sentence, a tool call), the chat route's capture reassembles the assistant turn, and round
 * two's request body is read back off the wire and checked the way the API checks it.
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

/** A client whose fetch serves the scripted rounds in order and records every request body. */
function scriptedClient(rounds: Ev[][]) {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let n = 0;
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    const events = rounds[Math.min(n++, rounds.length - 1)];
    return new Response(sse(events), { status: 200, headers: { "content-type": "text/event-stream" } });
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

/** One round of the chat route's loop: stream, capture, push the replay-valid turn. */
async function runRound(client: Anthropic, convo: Anthropic.MessageParam[]) {
  const capture = createReplayCapture();
  const turn = client.messages.stream({ model: "claude-opus-4-8", max_tokens: 2048, messages: convo });
  turn.on("streamEvent", capture.onEvent);
  const final = await turn.finalMessage();
  const replay = capture.replayContent(final.content);
  if (replay.length) convo.push({ role: "assistant", content: replay });
  return final;
}

describe("Nort replays an assistant turn that thought", () => {
  it("sends the thinking block back exactly as the wire carried it, text and signature", async () => {
    const { client, bodies } = scriptedClient([ROUND_ONE, ROUND_TWO]);
    const convo: Anthropic.MessageParam[] = [
      { role: "user", content: "The 10244 Schaefer job got moved to the week of October 12th" },
    ];

    const first = await runRound(client, convo);
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
