import Anthropic from "@anthropic-ai/sdk";

/**
 * REPLAYING AN ASSISTANT TURN — what Nort's tool loop sends back to the API after each round.
 *
 * The chat route streams every round and pushes `finalMessage().content` back into the
 * conversation so the next round can see its own tool calls. That snapshot is built by the SDK's
 * stream accumulator, and @anthropic-ai/sdk 0.36.3 predates extended thinking: its accumulator
 * handles text_delta, citations_delta and input_json_delta (for `tool_use` only) and silently
 * ignores everything else. So a `thinking` block is left exactly as its content_block_start
 * announced it — `thinking: ""`, `signature: ""` — with the reasoning and the signature that
 * followed in thinking_delta / signature_delta thrown away. Replaying that block is a 400:
 *
 *   messages.3.content.0.thinking: each thinking block must contain thinking
 *
 * (error_events, 2026-09-23 23:16 PT: Erik asked Nort to move the Schaefer job, round one looked
 * the job up, round two died, and all he got was "Something went wrong on my end".)
 *
 * The rule from the API docs: pass a thinking block back EXACTLY as received — text and
 * signature, even when the text is empty — and never edit or rebuild one. This module rebuilds
 * nothing: it records the raw stream events itself and reassembles each block from what the wire
 * actually carried, independent of what the SDK's accumulator did with it. A thinking block whose
 * signature never arrived cannot be proven intact, so it is dropped rather than sent broken.
 * `server_tool_use` (web search) gets the same treatment for its input, which the old accumulator
 * also leaves at `{}`.
 *
 * Model changes are not a concern here: the thinking blocks only ever live inside ONE request's
 * tool loop (the client sends plain text history), and one request runs on one model.
 */

type Json = Record<string, unknown>;

/** The stream events this module reads, typed loosely: the SDK's own types know no thinking. */
type RawStreamEvent = {
  type?: string;
  index?: number;
  content_block?: Json;
  delta?: { type?: string; thinking?: string; signature?: string; partial_json?: string };
};

type BlockParts = { start: Json; thinking: string; signature: string; json: string };

export type ReplayCapture = {
  /** Wire this to `stream.on("streamEvent", …)`. */
  onEvent: (event: unknown) => void;
  /** The content to push back as the assistant turn: every block replay-valid, or left out. */
  replayContent: (content: readonly unknown[]) => Anthropic.ContentBlockParam[];
};

export function createReplayCapture(): ReplayCapture {
  const parts = new Map<number, BlockParts>();

  const onEvent = (event: unknown) => {
    const ev = event as RawStreamEvent | null;
    if (!ev || typeof ev.index !== "number") return;
    if (ev.type === "content_block_start" && ev.content_block) {
      // A copy: the SDK pushes this same object into its snapshot and may mutate it.
      parts.set(ev.index, { start: { ...ev.content_block }, thinking: "", signature: "", json: "" });
      return;
    }
    if (ev.type !== "content_block_delta" || !ev.delta) return;
    const p = parts.get(ev.index);
    if (!p) return;
    if (ev.delta.type === "thinking_delta" && typeof ev.delta.thinking === "string") p.thinking += ev.delta.thinking;
    else if (ev.delta.type === "signature_delta" && typeof ev.delta.signature === "string") p.signature += ev.delta.signature;
    else if (ev.delta.type === "input_json_delta" && typeof ev.delta.partial_json === "string") p.json += ev.delta.partial_json;
  };

  const replayContent = (content: readonly unknown[]): Anthropic.ContentBlockParam[] => {
    const out: unknown[] = [];
    content.forEach((raw, i) => {
      const block = raw as Json;
      const p = parts.get(i);
      if (block?.type === "thinking") {
        // Reassembled from the wire: the start block's own text/signature (normally "") plus the
        // deltas. The SDK's copy is ignored on purpose, so a future SDK that DOES accumulate
        // cannot double the text.
        const startThinking = typeof p?.start.thinking === "string" ? p.start.thinking : "";
        const startSig = typeof p?.start.signature === "string" ? p.start.signature : "";
        const thinking = p ? startThinking + p.thinking : typeof block.thinking === "string" ? block.thinking : "";
        const signature = p ? startSig + p.signature : typeof block.signature === "string" ? block.signature : "";
        if (signature) out.push({ type: "thinking", thinking, signature });
        return;
      }
      if (block?.type === "redacted_thinking") {
        // Arrives whole in content_block_start (no deltas); only a missing payload is unsafe.
        if (typeof block.data === "string" && block.data) out.push({ type: "redacted_thinking", data: block.data });
        return;
      }
      if (block?.type === "server_tool_use" && p?.json) {
        try {
          out.push({ ...block, input: JSON.parse(p.json) });
          return;
        } catch {
          /* a truncated input: keep the SDK's copy as it stands */
        }
      }
      out.push(block);
    });
    return out as Anthropic.ContentBlockParam[];
  };

  return { onEvent, replayContent };
}

/** True for a block the API binds with a signature (thinking or redacted_thinking). */
export function isThinkingBlock(block: unknown): boolean {
  const t = (block as Json | null)?.type;
  return t === "thinking" || t === "redacted_thinking";
}

/**
 * The last-resort recovery: take every thinking block out of the conversation, in place, and
 * drop an assistant message the removal leaves empty. Returns how many blocks it removed (0 =
 * nothing to retry with). Stripping is NOT the normal path — the docs warn it can itself trip
 * ordering checks — it is the one retry after the API has already refused the replay.
 */
export function stripThinkingBlocks(msgs: Anthropic.MessageParam[]): number {
  let removed = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const kept = m.content.filter((b) => !isThinkingBlock(b));
    removed += m.content.length - kept.length;
    if (kept.length === m.content.length) continue;
    if (kept.length) m.content = kept;
    else msgs.splice(i, 1);
  }
  return removed;
}

/**
 * True only for the failure the one retry exists for: the API refused a replayed thinking block
 * (a 400 whose message names thinking). Any other 400 — a prompt too long after web results, a
 * tool_use/tool_result mismatch — would fail the same way again, so it is not retried and the
 * valid thinking blocks are not thrown away over it.
 */
export function isThinkingRefusal(e: unknown): boolean {
  if (!(e instanceof Anthropic.BadRequestError)) return false;
  const body = e.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  const apiMessage = body?.error?.message ?? body?.message;
  const text = typeof apiMessage === "string" ? apiMessage : e.message;
  return /thinking/i.test(text ?? "");
}

/**
 * The prompt-cache tail marker: strip every old marker (the API allows 4 breakpoints) and put
 * one on the last block of the last message. Never on a thinking block (the API refuses
 * cache_control there): the marker goes on the last block that can carry it. The tail is almost
 * always a user turn, but a pause_turn round leaves an assistant turn last. Mutates in place and
 * returns the same array.
 */
export function markCacheTail(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  for (const m of msgs) {
    if (Array.isArray(m.content)) for (const b of m.content) delete (b as { cache_control?: unknown }).cache_control;
  }
  const last = msgs[msgs.length - 1];
  if (last) {
    if (typeof last.content === "string") {
      last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    } else if (Array.isArray(last.content) && last.content.length) {
      const idx = last.content.findLastIndex((b) => !isThinkingBlock(b));
      if (idx >= 0) (last.content[idx] as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
    }
  }
  return msgs;
}

export type ReplayRoundOptions = {
  client: Anthropic;
  /** The request minus `messages`, which always come from `convo` (through `prepare`). */
  params: Omit<Anthropic.MessageStreamParams, "messages">;
  /** The conversation. Mutated: the replay-valid assistant turn is pushed onto it. */
  convo: Anthropic.MessageParam[];
  /** Runs on `convo` before every attempt (the route's cache-tail marker). */
  prepare?: (convo: Anthropic.MessageParam[]) => Anthropic.MessageParam[];
  /** Every text delta, as the SDK's `text` event gives it. */
  onText: (text: string) => void;
  /** False once there is no one left to answer (the request aborted, the phone hung up). */
  mayRetry?: () => boolean;
  /** Called once per retry, AFTER the retry settles, so `recovered` is the truth. */
  report?: (e: unknown, info: { stripped: number; recovered: boolean; retryError?: unknown }) => void;
};

/**
 * ONE ROUND OF NORT'S TOOL LOOP, with its replay made safe: stream the request, record the raw
 * events, push the assistant turn back onto `convo` exactly as the wire carried it (see
 * createReplayCapture), and return the final message.
 *
 * The one retry is for one failure: the API refused a replayed thinking block, which it does
 * before a single token streams. Then every thinking block is stripped from `convo` and the
 * round is asked again — the alternative is Nort answering nothing (the 2026-09-23 incident,
 * where the lookup succeeded and Erik got only "Something went wrong"). No retry when text
 * already reached the screen (it would say it twice), when no one is left to answer, or when
 * there was nothing to strip.
 */
/**
 * THE CLOSING USAGE (vendor import, Phase 2 fix). The API reports a streamed message's usage twice:
 * once in message_start (before any server tool ran) and again, cumulatively, in message_delta at
 * the end. The pinned SDK (0.36) copies only output_tokens from the second, so a round that
 * searched the web came back with server_tool_use missing and the search results' input tokens
 * left out, and costOf metered those searches at $0. Every field the closing usage carries (input,
 * cache, server_tool_use) replaces the early one here; a field it leaves out or sends as null is kept.
 */
export function mergeClosingUsage(final: Anthropic.Message, closing: Record<string, unknown> | null): void {
  if (!closing || !final?.usage) return;
  const usage = final.usage as unknown as Record<string, unknown>;
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "server_tool_use"]) {
    const v = closing[k];
    if (v !== undefined && v !== null) usage[k] = v;
  }
}

export async function runReplayRound(opts: ReplayRoundOptions): Promise<Anthropic.Message> {
  const { client, params, convo, onText } = opts;
  const prepare = opts.prepare ?? ((m: Anthropic.MessageParam[]) => m);
  let emitted = false;
  const attempt = async () => {
    const capture = createReplayCapture();
    const turn = client.messages.stream({ ...params, messages: prepare(convo) });
    turn.on("text", (text) => {
      if (text) emitted = true;
      onText(text);
    });
    turn.on("streamEvent", capture.onEvent);
    // The closing usage rides on message_delta, which this SDK copies only output_tokens from.
    let closing: Record<string, unknown> | null = null;
    turn.on("streamEvent", (ev) => {
      const u = (ev as { type?: string; usage?: unknown }).type === "message_delta" ? (ev as { usage?: unknown }).usage : null;
      if (u && typeof u === "object") closing = u as Record<string, unknown>;
    });
    const final = await turn.finalMessage();
    mergeClosingUsage(final, closing);
    return { final, capture };
  };

  let result: Awaited<ReturnType<typeof attempt>>;
  try {
    result = await attempt();
  } catch (e) {
    if (!isThinkingRefusal(e) || emitted || (opts.mayRetry && !opts.mayRetry())) throw e;
    const stripped = stripThinkingBlocks(convo);
    if (!stripped) throw e;
    try {
      result = await attempt();
    } catch (retryError) {
      opts.report?.(e, { stripped, recovered: false, retryError });
      throw retryError;
    }
    opts.report?.(e, { stripped, recovered: true });
  }

  // Replay-valid content only: thinking blocks exactly as the wire carried them (text AND
  // signature), or left out when that can't be proven. An assistant turn with nothing left to
  // replay is not pushed (an empty content array is its own 400).
  const replay = result.capture.replayContent(result.final.content);
  if (replay.length) convo.push({ role: "assistant", content: replay });
  return result.final;
}
