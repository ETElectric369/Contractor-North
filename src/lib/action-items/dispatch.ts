"use server";

import { revalidatePath } from "next/cache";
import { executeAction } from "@/lib/actions/execute";
import { blocksCrewWipe } from "./assign-guard";
import { resolveRowVerb, type DispatchPayload } from "./dispatch-map";
import type { ActionKind, Affordance } from "./types";

type Result = { ok: boolean; error?: string; note?: string };

/**
 * The inbox switchboard, a THIN SHIM over the unified Action Registry. A (kind, verb) pair maps to a
 * canonical registry action name + input (dispatch-map.ts, the whole table, tested), and
 * executeAction() does the lookup / auth / validation / run. Its one caller is ActionList (Needs You's
 * rows); Nort runs registry actions itself.
 *
 * NOTHING SILENT: what the action said it did (a finished job's "drafted INV-081", or what isn't on a
 * bill yet) comes back as `note`, and the list says it.
 */
export async function dispatchAction(input: {
  kind: ActionKind;
  id: string;
  verb: Affordance;
  payload?: DispatchPayload;
  /** The record a verb writes when it isn't the row's own id: a won estimate's job. */
  target?: string | null;
  /** Which surface drove this — flows to the audit log + the confirm gate. */
  source?: "ui" | "voice" | "agent";
}): Promise<Result> {
  const { kind, id, verb, payload } = input;
  const source = input.source ?? "ui";
  if ((verb === "schedule" || verb === "snooze") && !payload?.date) {
    return { ok: false, error: "Pick a date." };
  }
  // Refuse to translate an unpicked assignee into job.assign's clear-the-whole-crew branch.
  // See blocksCrewWipe — the agent's explicit-clear contract is deliberately left intact.
  if (blocksCrewWipe(kind, verb, payload?.assignee, source)) {
    return { ok: false, error: "Pick a person." };
  }
  const mapped = resolveRowVerb(kind, verb, id, payload, input.target);
  if (!mapped) return { ok: false, error: "That action isn't available here." };

  const res = await executeAction(mapped.name, mapped.input, { source });
  if (res.ok) revalidatePath("/planner");
  const note = res.warning ?? res.speak ?? res.recorded;
  return { ok: res.ok, error: res.error, ...(res.ok && note ? { note } : {}) };
}
