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
  /**
   * THE SHEET THE PERSON IS LOOKING AT — passed from the client, and it has to be.
   *
   * This was dead on every fresh inspection. The inspector auto-selects the org's sheet in CLIENT
   * state, but `appointments.inspection_template_id` is not written until an answer saves — so the
   * very first press of "Fill it in", which is the whole designed first action, came back "Pick a
   * walk-through first." The one escape was to hand-tap an answer and wait out the 900ms debounce:
   * exactly the work the feature exists to replace.
   *
   * Passing an id is not the same as passing a playbook. RLS confines the lookup to this org and
   * the is_inspection check bounds it to a walk-through, so the worst a crafted id can name is one
   * of this org's own sheets — which is what the picker offers anyway.
   */
  templateId: string | null,
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

  // What he's looking at wins; the stored column is the fallback for anything that calls without one.
  const useId = templateId || (appt as { inspection_template_id?: string | null }).inspection_template_id;
  if (!useId) return { ok: false, error: "Pick a walk-through first." };
  const { data: form } = await supabase
    .from("forms")
    .select("schema, playbook, is_inspection")
    .eq("id", useId)
    .maybeSingle();
  if (!form) return { ok: false, error: "That walk-through no longer exists." };
  // Same bound saveInspectionAnswersInner applies: an id must name a WALK-THROUGH, not any old form.
  if (!(form as { is_inspection?: boolean }).is_inspection)
    return { ok: false, error: "That form isn't a walk-through." };

  return runHear(playbookForForm(form as { schema?: unknown; playbook?: unknown }), answers, transcript);
}
