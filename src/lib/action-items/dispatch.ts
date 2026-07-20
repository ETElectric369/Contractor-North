"use server";

import { revalidatePath } from "next/cache";
import { executeAction } from "@/lib/actions/execute";
import { blocksCrewWipe } from "./assign-guard";
import type { ActionKind, Affordance } from "./types";

type ConvertTarget = "inspection" | "customer" | "quote" | "estimate" | "job";

type Result = { ok: boolean; error?: string };

/**
 * The inbox switchboard, now a THIN SHIM over the unified Action Registry. A
 * (kind, verb) pair maps to a canonical registry action name + input, and
 * executeAction() does the lookup / auth / validation / run. Same signature the
 * inbox buttons and voice act_on_item already call — they were not touched.
 */
function resolve(
  kind: ActionKind,
  verb: Affordance,
  id: string,
  payload?: { date?: string; assignee?: string; target?: ConvertTarget },
): { name: string; input: Record<string, unknown> } | null {
  const date = payload?.date;
  const isTask = kind === "task" || kind === "work_order";

  if (verb === "do") {
    if (isTask) return { name: "task.complete", input: { id, done: true } };
    if (kind === "inquiry") return { name: "inquiry.contact", input: { id } };
    if (kind === "appointment") return { name: "appointment.setStatus", input: { id, status: "completed" } };
  } else if (verb === "schedule" || verb === "snooze") {
    if (!date) return null;
    if (kind === "job_to_schedule") return { name: "job.scheduleDay", input: { id, date } };
    if (isTask) return { name: "task.setDue", input: { id, due_date: date } };
    if (kind === "inquiry") return { name: "inquiry.contact", input: { id, follow_up_date: date } };
  } else if (verb === "assign") {
    const assignee = payload?.assignee ?? null;
    if (isTask) return { name: "task.assign", input: { id, assigned_to: assignee } };
    if (kind === "job_to_schedule") return { name: "job.assign", input: { id, assignee: assignee ?? "" } };
  } else if (verb === "convert") {
    if (kind === "inquiry") return { name: "inquiry.convert", input: { id, target: payload?.target ?? "estimate" } };
  } else if (verb === "dismiss") {
    if (isTask) return { name: "task.delete", input: { id } };
    if (kind === "inquiry") return { name: "inquiry.delete", input: { id } };
    if (kind === "appointment") return { name: "appointment.setStatus", input: { id, status: "cancelled" } };
    if (kind === "organize") return { name: "organize.archive", input: { id } };
  }
  return null;
}

export async function dispatchAction(input: {
  kind: ActionKind;
  id: string;
  verb: Affordance;
  payload?: { date?: string; assignee?: string; target?: ConvertTarget };
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
  const mapped = resolve(kind, verb, id, payload);
  if (!mapped) return { ok: false, error: "That action isn't available here." };

  const res = await executeAction(mapped.name, mapped.input, { source });
  if (res.ok) revalidatePath("/planner");
  return { ok: res.ok, error: res.error };
}
