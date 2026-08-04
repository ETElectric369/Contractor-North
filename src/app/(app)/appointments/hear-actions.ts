"use server";

import { createClient } from "@/lib/supabase/server";
import { playbookForForm } from "@/lib/playbook/parse";
import { runHear, type HearRun } from "@/lib/playbook/hear-run";
import type { Answers } from "@/lib/playbook/types";

/**
 * WHAT HE SAID → WHAT THE PLAYBOOK KNOWS.
 *
 * FILLING IS NOT EXECUTING. This writes into boxes he could have typed into himself and returns
 * them for him to look at. It sends nothing, prices nothing, commits nothing — so it needs no
 * confirmation gate and no allowlist. The save button is still his.
 *
 * THE PLAYBOOK IS LOADED SERVER-SIDE, never taken from the client. A caller could otherwise hand
 * over a playbook of its own invention and have the model write keys this org never declared — and
 * coerceByPlaybook inside runHear drops anything undeclared anyway, so a fabricated key dies twice.
 */
export async function hearIntoPlaybook(
  appointmentId: string,
  answers: Answers,
  transcript: string,
): Promise<HearRun> {
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
  const { data: form } = await supabase.from("forms").select("schema, playbook").eq("id", templateId).maybeSingle();
  if (!form) return { ok: false, error: "That walk-through no longer exists." };

  return runHear(playbookForForm(form as { schema?: unknown; playbook?: unknown }), answers, transcript);
}
