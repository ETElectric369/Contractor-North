import Anthropic from "@anthropic-ai/sdk";

/**
 * REPLAYING AN ASSISTANT TURN — what Nort's tool loop sends back to the API after each round.
 *
 * The chat route streams every round and pushes `finalMessage().content` back into the
 * conversation so the next round can see its own tool calls. Since @anthropic-ai/sdk 1.5.0 (the
 * cn-v1142 bump) the SDK's own stream accumulator carries every block whole — a thinking block's
 * text and signature, a web search's input, the closing usage with its search count — which
 * replay.test.ts proves against a fake wire (GATE 2). The SDK before it (0.36.3) predated
 * extended thinking and left a thinking block exactly as its content_block_start announced it,
 * `thinking: ""`, `signature: ""`; replaying that was a 400:
 *
 *   messages.3.content.0.thinking: each thinking block must contain thinking
 *
 * (error_events, 2026-09-23 23:16 PT: Erik asked Nort to move a job, round one looked the job up,
 * round two died, and all he got was "Something went wrong on my end".) This module used to
 * record the raw stream events itself and rebuild each block from the wire; that capture went
 * with the bump. What stays is THE RULEBOOK for what may be sent back, applied to the SDK's
 * snapshot and proven on the wire:
 *
 *   - a thinking block goes back EXACTLY as received, text and signature, even when the text is
 *     empty — never edited, never rebuilt. One whose signature never arrived cannot be proven
 *     intact and is left out rather than sent broken;
 *   - redacted_thinking goes back whole (only a missing payload is unsafe);
 *   - AFTER A SERVER-SIDE FALLBACK (ai-cost fallbacksFor: a declined request re-run on another
 *     model mid-turn, marked by a `fallback` block) the API's echo rule applies to the declined
 *     model's blocks BEFORE the turn's last fallback block: its thinking, redacted thinking, tool
 *     calls, unfinished server-tool calls and anything unrecognised are left out; its text and
 *     its finished server-tool work (a server_tool_use with its result) echo normally; the
 *     fallback block stays where it was (moving it is rejected, dropping it is allowed — kept);
 *     everything after the boundary follows the normal rules. A tool_use left out is NEVER
 *     answered — the route runs toolUsesToAnswer(content), not every tool_use it can see.
 *
 * Model changes are not a concern here: the thinking blocks only ever live inside ONE request's
 * tool loop (the client sends plain text history), and one request runs on one model — or, after
 * a fallback, on the model the API chose, which read the blocks it kept.
 */

type Json = Record<string, unknown>;

const asBlock = (raw: unknown): Json | null => (raw && typeof raw === "object" ? (raw as Json) : null);

/** The index of the turn's last `fallback` block, or -1. Everything before it is the declined model's. */
function fallbackBoundary(content: readonly unknown[]): number {
  return content.findLastIndex((b) => asBlock(b)?.type === "fallback");
}

const isServerToolResult = (b: Json) => typeof b.type === "string" && b.type.endsWith("_tool_result") && typeof b.tool_use_id === "string";

/**
 * The content to push back as the assistant turn: every block replay-valid, or left out. Pure:
 * it reads the SDK's final snapshot and builds nothing — a kept block is the block as received.
 */
export function replayContent(content: readonly unknown[]): Anthropic.ContentBlockParam[] {
  const boundary = fallbackBoundary(content);
  // Server-tool work that finished: the ids of server_tool_use blocks, and of the results here.
  const uses = new Set<string>();
  const answered = new Set<string>();
  for (const raw of content) {
    const b = asBlock(raw);
    if (!b) continue;
    if (b.type === "server_tool_use" && typeof b.id === "string") uses.add(b.id);
    else if (isServerToolResult(b)) answered.add(b.tool_use_id as string);
  }
  const out: unknown[] = [];
  content.forEach((raw, i) => {
    const block = asBlock(raw);
    if (!block) return;
    const type = block.type;
    if (i < boundary) {
      // The declined model's work: its words, its finished server-tool work, the marker itself.
      if (type === "text" || type === "fallback") out.push(block);
      else if (type === "server_tool_use" && typeof block.id === "string" && answered.has(block.id)) out.push(block);
      else if (isServerToolResult(block) && uses.has(block.tool_use_id as string)) out.push(block);
      return;
    }
    if (type === "thinking") {
      if (typeof block.signature === "string" && block.signature) out.push(block);
      return;
    }
    if (type === "redacted_thinking") {
      if (typeof block.data === "string" && block.data) out.push(block);
      return;
    }
    out.push(block);
  });
  return out as Anthropic.ContentBlockParam[];
}

/**
 * The tool calls the route must run and answer: exactly those the replay keeps. A tool_use the
 * echo rule left out (the declined model's, before a fallback) has no place in the next request,
 * and a tool_result for it would be a 400 of its own.
 */
export function toolUsesToAnswer(content: readonly unknown[]): Anthropic.ToolUseBlockParam[] {
  return replayContent(content).filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use");
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
 * The prompt-cache message markers: strip every old marker, then put one on the TAIL (the last
 * block of the last user or assistant message) and, when the conversation carries a
 * mid-conversation system message (the chat's per-turn note: the clock, the app context), one on
 * the turn that note follows — the last real user turn, which is the one point whose bytes are
 * the same on the NEXT request, so the next turn reads the history from cache up to there. A
 * system message itself is never marked (its text changes every minute: a marker on it is a pure
 * write surcharge). With the chat's two system blocks marked that is at most FOUR breakpoints,
 * the API's limit; on round one the tail IS that user turn, so it is three. Never on a thinking
 * block (the API refuses cache_control there) and never on a fallback marker (an ignored audit
 * block): the marker goes on the last block that can carry it. The tail is almost always a user
 * turn, but a pause_turn round leaves an assistant turn last. Both markers are the default 5m
 * TTL, so they sit after any 1h system marker as the ordering rule requires. Mutates in place
 * and returns the same array.
 */
export function markCacheTail(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  for (const m of msgs) {
    if (Array.isArray(m.content)) for (const b of m.content) delete (b as { cache_control?: unknown }).cache_control;
  }
  const mark = (m: Anthropic.MessageParam | undefined) => {
    if (!m || m.role === "system") return;
    if (typeof m.content === "string") {
      m.content = [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }];
    } else if (Array.isArray(m.content) && m.content.length) {
      const idx = m.content.findLastIndex((b) => !isThinkingBlock(b) && asBlock(b)?.type !== "fallback");
      if (idx >= 0) (m.content[idx] as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
    }
  };
  const tail = msgs.findLastIndex((m) => m.role !== "system");
  if (tail >= 0) mark(msgs[tail]);
  const note = msgs.findLastIndex((m) => m.role === "system");
  if (note > 0 && note - 1 !== tail) mark(msgs[note - 1]);
  return msgs;
}

/**
 * The models that take a `role: "system"` message inside `messages` (no beta header; the stable
 * SDK types carry it, messages.d.ts SystemMessageParam). The skill's shared/prompt-caching.md
 * § Mid-conversation system messages names them: Claude Opus 5, Opus 5.5, Opus 4.8, Fable 5,
 * Fable 5.1, Mythos 5, Mythos 5.1 and Sonnet 5.5 — NOT Sonnet 5 (sources conflict; treat as
 * unsupported) and not Haiku. Any other name (an env override naming an older or unknown model)
 * gets the shape the chat had before: the per-turn note in the system array, the app context on
 * the user's message. An unsupported model answers a 400, so the list is closed, not a pattern.
 */
export function acceptsSystemMessage(model: string): boolean {
  const base = String(model ?? "").replace(/-\d{8}$/, "");
  return /^claude-(opus-5|opus-5-5|opus-4-8|fable-5|fable-5-1|mythos-5|mythos-5-1|sonnet-5-5)$/.test(base);
}

/**
 * The conversation window, trimmed in CHUNKS: at most `max` messages, and when the history runs
 * past it the oldest messages go `chunk` at a time (the excess rounded UP to a whole chunk). A
 * one-message slide moved the start of the history on every turn past the cap, so the cached
 * prefix never matched twice; a chunk keeps the same start for `chunk / 2` turns (each turn adds
 * a user and an assistant message). An even chunk keeps the history's first role in place.
 *   20 → 20 · 21 → 17 · 22 → 18 · 24 → 20 · 25 → 17 · 30 → 18.
 */
export function windowMessages<T>(list: readonly T[], max = 20, chunk = 4): T[] {
  const over = list.length - max;
  if (over <= 0) return [...list];
  return list.slice(Math.ceil(over / chunk) * chunk);
}

export type ReplayRoundOptions = {
  client: Anthropic;
  /**
   * The request minus `messages`, which always come from `convo` (through `prepare`). With
   * `betas` and/or `fallbacks` on it (ai-cost fallbacksFor) the round goes through
   * `client.beta.messages`, where the SDK types them and sends the header; otherwise the stable
   * `client.messages`.
   */
  params: Omit<Anthropic.MessageStreamParams, "messages"> & { betas?: Anthropic.AnthropicBeta[]; fallbacks?: "default" };
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

type ReplayBody = ReplayRoundOptions["params"] & { messages: Anthropic.MessageParam[] };
type OpenTurn = { onText: (fn: (text: string) => void) => void; finalMessage: () => Promise<Anthropic.Message> };

/**
 * The stream, on the surface the request needs. The closing usage (input tokens, cache counts,
 * the web-search count a round ran up) rides on message_delta, and since 1.5.0 the SDK's own
 * accumulator copies it onto the final message (replay.test.ts pins it) — nothing to merge here.
 */
function openTurn(client: Anthropic, body: ReplayBody): OpenTurn {
  if (body.betas?.length || body.fallbacks) {
    // The one shape the two surfaces disagree on: the stable types let output_config be null.
    const { output_config, ...rest } = body;
    const turn = client.beta.messages.stream({ ...rest, ...(output_config ? { output_config } : {}) });
    // The beta message is the same wire shape with more block kinds typed; the route reads
    // content, stop_reason, usage and model, which the two share.
    return { onText: (fn) => void turn.on("text", fn), finalMessage: () => turn.finalMessage() as Promise<Anthropic.Message> };
  }
  const { betas: _betas, fallbacks: _fallbacks, ...stable } = body;
  const turn = client.messages.stream(stable);
  return { onText: (fn) => void turn.on("text", fn), finalMessage: () => turn.finalMessage() };
}

/**
 * ONE ROUND OF NORT'S TOOL LOOP, with its replay made safe: stream the request, push the
 * replay-valid assistant turn back onto `convo` (see replayContent), and return the final message.
 *
 * The one retry is for one failure: the API refused a replayed thinking block, which it does
 * before a single token streams. Then every thinking block is stripped from `convo` and the
 * round is asked again — the alternative is Nort answering nothing (the 2026-09-23 incident,
 * where the lookup succeeded and Erik got only "Something went wrong"). No retry when text
 * already reached the screen (it would say it twice), when no one is left to answer, or when
 * there was nothing to strip.
 */
export async function runReplayRound(opts: ReplayRoundOptions): Promise<Anthropic.Message> {
  const { client, params, convo, onText } = opts;
  const prepare = opts.prepare ?? ((m: Anthropic.MessageParam[]) => m);
  let emitted = false;
  const attempt = async () => {
    const turn = openTurn(client, { ...params, messages: prepare(convo) });
    turn.onText((text) => {
      if (text) emitted = true;
      onText(text);
    });
    return turn.finalMessage();
  };

  let final: Anthropic.Message;
  try {
    final = await attempt();
  } catch (e) {
    if (!isThinkingRefusal(e) || emitted || (opts.mayRetry && !opts.mayRetry())) throw e;
    const stripped = stripThinkingBlocks(convo);
    if (!stripped) throw e;
    try {
      final = await attempt();
    } catch (retryError) {
      opts.report?.(e, { stripped, recovered: false, retryError });
      throw retryError;
    }
    opts.report?.(e, { stripped, recovered: true });
  }

  // Replay-valid content only: thinking blocks exactly as the wire carried them (text AND
  // signature), or left out when that can't be proven; the declined model's blocks left out after
  // a fallback. An assistant turn with nothing left to replay is not pushed (an empty content
  // array is its own 400).
  const replay = replayContent(final.content);
  if (replay.length) convo.push({ role: "assistant", content: replay });
  return final;
}
