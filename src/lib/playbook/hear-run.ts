import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { coerceByPlaybook } from "./answers";
import { applyHeard, hearRequest, parseHeard, HEAR_SYSTEM } from "./hear";
import { clearInapplicable } from "./resolve";
import type { Answers, Playbook } from "./types";

/**
 * THE ONE MODEL CALL, for any playbook.
 *
 * Server-only (it holds the API key) and deliberately NOT a server action, so both the inspector's
 * action and the setup card's action can share it. That sharing is the point: [[fill-vs-execute]]
 * says a surface contributes a TARGET and a PROJECTION, never an assistant of its own. Walking a
 * job and setting a company up are the same shape — needs, a resolver, a sentence — so they had
 * better not be two extraction engines that drift apart.
 */

export type HearRun =
  | { ok: true; answers: Answers; filled: string[]; note: string }
  | { ok: false; error: string };

export async function runHear(pb: Playbook, answers: Answers, transcript: string): Promise<HearRun> {
  const said = String(transcript ?? "").trim();
  if (!said) return { ok: false, error: "Nothing to go on yet." };
  // One person talking about one job. A megabyte of it is somebody else's idea.
  if (said.length > 12000) return { ok: false, error: "That's too long — break it up a bit." };
  if (!pb.needs.length) return { ok: false, error: "There are no questions to fill in yet." };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: "Nort isn't switched on here yet." };

  // Coerce what the caller thinks it has BEFORE reasoning about it, so a tampered payload can't
  // pass off an unanswered need as answered (suppressing a question) or the reverse.
  const known = coerceByPlaybook(pb, answers);

  let text = "";
  try {
    const resp = await getAnthropic().messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 2000,
      // The instruction never changes; the job does. Caching it keeps the cost of a fill down to
      // the paragraph itself, which matters when this runs on every visit.
      system: [{ type: "text", text: HEAR_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: hearRequest(pb, known, said) }],
    });
    text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
  } catch (e: unknown) {
    return { ok: false, error: (e as { message?: string })?.message ?? "Nort couldn't answer just now." };
  }

  const applied = applyHeard(pb, known, said, parseHeard(text));
  // Coerce, THEN clear — in that order. applyFills honours the provenance gate but the VALUE still
  // has to satisfy its slot, and coercing can null the very answer a downstream gate was resolved
  // against. Clearing last means what comes back is consistent with itself.
  return {
    ok: true,
    answers: clearInapplicable(pb, coerceByPlaybook(pb, applied.answers)),
    filled: applied.filled,
    note: applied.note,
  };
}
