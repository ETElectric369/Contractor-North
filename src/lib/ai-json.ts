import type Anthropic from "@anthropic-ai/sdk";
import { modelFor, recordAiUsage } from "@/lib/ai-cost";

/**
 * READING A JSON OBJECT OUT OF A MODEL'S REPLY, ONCE, FOR EVERYBODY.
 *
 * This lived inside organize/actions.ts, where the estimator could not reach it — so the single
 * most expensive operation in the product parsed its answer with a bare
 * `text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)` and a naked `JSON.parse`. Any wobble
 * and a whole take-off became "Estimator failed: Unexpected token", which correlates with the SIZE
 * of the take-off and therefore looks random from the outside.
 *
 * Two failure modes, both met on real documents:
 *   1. a code fence, or prose either side of the object;
 *   2. an UNESCAPED double-quote inside a value — inch marks, `6"` and `1/2"`, which is the whole
 *      vocabulary of this trade. That breaks the string and yields
 *      'Expected "," or "]" after array element'.
 *
 * A trailing-comma scrub handles the first cheaply; the second needs a model, so there is one
 * repair round trip on the cheap model — repairing JSON is mechanics, not domain knowledge.
 */
export function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in AI reply");
  return body.slice(start, end + 1).replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Direct parse, then ONE repair round trip. Throws if both fail — the caller decides what to say.
 *
 * DELIBERATELY NOT A SALVAGE. materials/actions.ts recovers what it can from a truncated array by
 * cutting back to the last complete object, which is right for a shopping list and wrong for a
 * priced take-off: a silently shorter estimate is a wrong PRICE presented as a finished one, and
 * nothing on screen would say a line went missing. A caller that can be truncated should check
 * `stop_reason === "max_tokens"` before it gets here and say so out loud.
 *
 * `orgId` METERS THE REPAIR. It is a real model call on a real invoice, and it fires precisely
 * when something has already gone wrong — the worst kind of spend to leave off the ledger, because
 * it is invisible in normal operation and arrives in bursts. hear.test's guard caught this the
 * moment the function moved into a file of its own; it was unmetered inside organize/actions.ts
 * too, hidden behind that file's other meters.
 */
export async function parseAiJson(client: Anthropic, raw: string, orgId?: string | null): Promise<unknown> {
  try {
    return JSON.parse(extractJsonObject(raw));
  } catch {
    /* fall through to one repair round-trip */
  }
  const model = modelFor("classify");
  const fix = await client.messages.create({
    model,
    max_tokens: 4096,
    system:
      "You repair malformed JSON. Output ONLY one valid, complete JSON object — no prose, no code fences. " +
      'Escape every double-quote that appears INSIDE a string value (inch marks: write 6\\" not 6"). ' +
      "If the input was cut off, close the open arrays and objects. Never invent or drop data.",
    messages: [{ role: "user", content: `Repair this into valid JSON:\n\n${raw}` }],
  });
  // METER THE MODEL THAT ACTUALLY RAN, never the constant — costOf() prices from this string, so
  // naming the wrong one overstates or understates the org's month.
  void recordAiUsage({ orgId, model, surface: "json-repair", usage: fix.usage as never });
  // A repair that ran out of tokens "closed the open arrays" mid-amputation — that is a
  // DIFFERENT document wearing valid syntax, worse than the parse error it replaced.
  if (fix.stop_reason === "max_tokens") throw new Error("The response was too large to repair.");
  const t = fix.content.find((b) => b.type === "text") as { text: string } | undefined;
  return JSON.parse(extractJsonObject(t?.text ?? ""));
}
