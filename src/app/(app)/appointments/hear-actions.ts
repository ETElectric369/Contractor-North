"use server";

import { createClient } from "@/lib/supabase/server";
import { playbookForForm } from "@/lib/playbook/parse";
import { runHear, type HearRun } from "@/lib/playbook/hear-run";
import { readViaView } from "@/lib/inspection/inspection-access";
import type { Answers } from "@/lib/playbook/types";
import { translator } from "@/lib/i18n";
import { callerLang } from "@/lib/lang-of";
import { fillSlots } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";

/**
 * THE CALLER'S OWN WORDS (the visit-page-in-Spanish wave): every refusal this file answers comes from
 * lib/words/visit-page (vp_) in the caller's language — profiles.language through lib/lang-of
 * callerLang, read ONCE per call and only when an answer needs words (appointments/actions wordsOf,
 * the same shape); English when nobody is signed in or the read fails, byte for byte what this file
 * always said. Not exported: a "use server" file exports only async functions.
 */
type Said = { lang: () => Promise<Lang>; say: (key: string, vars?: Record<string, string | number>) => Promise<string> };
function wordsOf(supabase: Awaited<ReturnType<typeof createClient>>, userId?: string | null): Said {
  let read: Promise<Lang> | null = null;
  const lang = () => (read ??= callerLang(supabase as unknown as Parameters<typeof callerLang>[0], userId));
  return { lang, say: async (key, vars) => fillSlots(translator(await lang())(key), vars) };
}

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
   * very first press of "Fill it in", which is the whole designed first action, came back "Pick an
   * inspection first." The one escape was to hand-tap an answer and wait out the 900ms debounce:
   * exactly the work the feature exists to replace.
   *
   * Passing an id is not the same as passing a playbook. RLS confines the lookup to this org and
   * the is_inspection check bounds it to an inspection, so the worst a crafted id can name is one
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
  if (!user) return { ok: false, error: await wordsOf(supabase).say("vp_signInFirst") };
  const ws = wordsOf(supabase, user.id);

  // RLS scopes both reads to the caller's org — an appointment id from another tenant simply
  // doesn't resolve, so the playbook we fill against is always one this org owns.
  const { data: appt } = await supabase
    .from("appointments")
    .select("id, org_id, inspection_template_id")
    .eq("id", appointmentId)
    .maybeSingle();
  if (!appt) return { ok: false, error: await ws.say("vp_inspectionNoLongerExists") };

  // What he's looking at wins; the stored column is the fallback for anything that calls without one.
  const useId = templateId || (appt as { inspection_template_id?: string | null }).inspection_template_id;
  if (!useId) return { ok: false, error: await ws.say("vp_pickAnInspectionFirst") };
  // Through form_playbooks (0366): a crew lead can't read a playbook sheet from forms itself any more,
  // and gets its questions without the owner's notes or dollar figures (which filling never needs).
  // A failed read is said, never "no sheet".
  const { data: form, error: formErr } = await readViaView<{ schema?: unknown; playbook?: unknown; is_inspection?: boolean }>(
    supabase,
    "sheets",
    (from) => from.select("schema, playbook, is_inspection").eq("id", useId).maybeSingle(),
  );
  if (formErr) return { ok: false, error: await ws.say("vp_couldntReadInspection") };
  if (!form) return { ok: false, error: await ws.say("vp_inspectionNoLongerExists") };
  // Same bound saveInspectionAnswersInner applies: an id must name an INSPECTION, not any old form.
  if (!(form as { is_inspection?: boolean }).is_inspection)
    return { ok: false, error: await ws.say("vp_formIsntAnInspection") };

  return runHear(playbookForForm(form as { schema?: unknown; playbook?: unknown }), answers, transcript, {
    orgId: (appt as { org_id?: string } | null)?.org_id ?? null,
    surface: "playbook:hear",
  });
}
