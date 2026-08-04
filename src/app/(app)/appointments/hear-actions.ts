"use server";

import { createClient } from "@/lib/supabase/server";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { playbookForForm } from "@/lib/playbook/parse";
import { coerceByPlaybook } from "@/lib/playbook/answers";
import { clearInapplicable } from "@/lib/playbook/resolve";
import { applyHeard, hearRequest, parseHeard, HEAR_SYSTEM } from "@/lib/playbook/hear";
import type { Answers } from "@/lib/playbook/types";

export type HearResult =
  | { ok: true; answers: Answers; filled: string[]; note: string }
  | { ok: false; error: string };

/**
 * WHAT HE SAID → WHAT THE PLAYBOOK KNOWS.
 *
 * The one model call in the inspector, and the only place in it where a model is required at all:
 * unstructured in, structure out. Everything downstream stays arithmetic.
 *
 * FILLING IS NOT EXECUTING. This writes into boxes he could have typed into himself and returns
 * them for him to look at. It sends nothing, prices nothing, commits nothing — so it needs no
 * confirmation gate and no allowlist. The save button is still his.
 *
 * THE PLAYBOOK IS LOADED SERVER-SIDE, never taken from the client. A caller could otherwise hand
 * over a playbook of its own invention and have the model write keys this org never declared —
 * and coerceByPlaybook at the end drops anything not declared anyway, so a fabricated key dies
 * twice.
 */
export async function hearIntoPlaybook(
  appointmentId: string,
  answers: Answers,
  transcript: string,
): Promise<HearResult> {
  const said = String(transcript ?? "").trim();
  if (!said) return { ok: false, error: "Nothing to go on yet." };
  // A transcript is one person talking about one job. A megabyte of it is somebody else's idea.
  if (said.length > 12000) return { ok: false, error: "That's too long — break it up a bit." };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: "Nort isn't switched on here yet." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  // RLS scopes both reads to the caller's org — an appointment id from another tenant simply
  // doesn't resolve, so the playbook we fill against is always one this org owns.
  const { data: appt } = await supabase
    .from("appointments")
    .select("id, inspection_template_id")
    .eq("id", appointmentId)
    .maybeSingle();
  if (!appt) return { ok: false, error: "That inspection no longer exists." };

  const templateId = (appt as { inspection_template_id?: string | null }).inspection_template_id;
  if (!templateId) return { ok: false, error: "Pick a walk-through first." };
  const { data: form } = await supabase
    .from("forms")
    .select("schema, playbook")
    .eq("id", templateId)
    .maybeSingle();
  if (!form) return { ok: false, error: "That walk-through no longer exists." };

  const pb = playbookForForm(form as { schema?: unknown; playbook?: unknown });
  if (!pb.needs.length) return { ok: false, error: "That walk-through has no questions in it yet." };
  // Coerce what the client thinks it has BEFORE reasoning about it, so a tampered payload can't
  // pass off an unanswered need as answered (which would suppress a question) or vice versa.
  const known = coerceByPlaybook(pb, answers);

  let text = "";
  try {
    const resp = await getAnthropic().messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1500,
      // The instruction never changes; the job does. Caching it keeps the cost of a fill to the
      // paragraph itself, which matters when he does this on every visit.
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
  // Coerce, THEN clear — in that order, and it matters. applyFills honours the provenance gate but
  // the VALUE still has to satisfy the slot (an option outside the list, a number that isn't one),
  // and coercing can null the very answer a downstream gate was resolved against. Clearing last
  // means what comes back is consistent with itself: same contract as a tap, same order as the
  // save path.
  return {
    ok: true,
    answers: clearInapplicable(pb, coerceByPlaybook(pb, applied.answers)),
    filled: applied.filled,
    note: applied.note,
  };
}
