import type Anthropic from "@anthropic-ai/sdk";

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
