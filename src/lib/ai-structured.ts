import type Anthropic from "@anthropic-ai/sdk";
import { refused, saidFailure, type SaidFailure } from "@/lib/ai-refusal";
import type { Lang } from "@/lib/locale";

/**
 * A SCHEMA'D ANSWER, READ ONE WAY AT EVERY DOOR (cn-v1142, the SDK half).
 *
 * A door that knows the shape of its answer asks for it with structured outputs: the request's
 * `output_config.format` carries a JSON schema (the SDK's zodOutputFormat builds it from a zod
 * schema and adds a `parse` that validates the text against the same schema), and the API
 * constrains the reply to it. That retires the hand parse (find the braces, JSON.parse, maybe a
 * repair round trip) at every door that had a schema.
 *
 * WHY NOT client.messages.parse: parse runs the schema over the text INSIDE the call and throws
 * when it does not match — and a refusal (stop_reason "refusal") or a cut-off (max_tokens) is
 * exactly a reply that may not match. The rule is to branch on the stop reason BEFORE reading
 * content, so these doors send the format through aiCreate (which also carries the fallbacks
 * beta on the big and middle models) and read the answer here, in this order:
 *   1. refused            → saidFailure("refused")   (never a parse error, never a throw)
 *   2. ran past max_tokens → saidFailure("cut_off")
 *   3. the format's own parse over the answer's text; a throw → saidFailure("unreadable").
 *
 * THE ANSWER'S TEXT: the text blocks after the last `fallback` block (a server-side fallback
 * marks its switch point with one; a non-streaming decline leaves its partial out anyway), joined.
 */

/** What zodOutputFormat returns, as far as this reader needs it: the parse it attaches. */
export type ParsingFormat<T> = { parse(content: string): T };

export type StructuredRead<T> = { ok: true; value: T } | SaidFailure;

/** The answer's text: every text block after the last fallback switch point, joined. */
export function answerText(content: ReadonlyArray<{ type: string }> | null | undefined): string {
  const blocks = Array.isArray(content) ? content : [];
  let from = 0;
  blocks.forEach((b, i) => {
    if (b?.type === "fallback") from = i + 1;
  });
  return blocks
    .slice(from)
    .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("");
}

/** Read a structured-output answer: refusal first, then the cut-off, then the schema. */
export function readStructured<T>(
  msg: Pick<Anthropic.Message, "stop_reason" | "content"> | null | undefined,
  format: ParsingFormat<T>,
  lang: Lang = "en",
): StructuredRead<T> {
  if (refused(msg)) return saidFailure("refused", lang);
  if (msg?.stop_reason === "max_tokens") return saidFailure("cut_off", lang);
  const text = answerText(msg?.content as ReadonlyArray<{ type: string }> | undefined);
  if (!text.trim()) return saidFailure("unreadable", lang);
  try {
    return { ok: true, value: format.parse(text) };
  } catch {
    return saidFailure("unreadable", lang);
  }
}
