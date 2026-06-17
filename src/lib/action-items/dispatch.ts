"use server";

import { revalidatePath } from "next/cache";
import { toggleTask, updateTask, deleteTask } from "@/app/(app)/tasks/actions";
import { setJobScheduleRanges, setJobAssignee } from "@/app/(app)/schedule/actions";
import { markInquiryContacted, deleteInquiry, convertInquiry } from "@/app/(app)/leads/actions";
import { setAppointmentStatus } from "@/app/(app)/appointments/actions";
import { archiveItem } from "@/app/(app)/organize/actions";
import type { ActionKind, Affordance } from "./types";

type ConvertTarget = "customer" | "quote" | "estimate" | "job";

type Result = { ok: boolean; error?: string };

/**
 * The ONE dispatch point. A canonical verb + the item's kind routes to an
 * already-existing server action — no business logic lives here, it's a
 * switchboard. The same path is used by the inbox buttons and (later) voice.
 */
export async function dispatchAction(input: {
  kind: ActionKind;
  id: string;
  verb: Affordance;
  payload?: { date?: string; assignee?: string; target?: ConvertTarget };
}): Promise<Result> {
  const { kind, id, verb, payload } = input;
  const date = payload?.date;
  let res: Result = { ok: false, error: "That action isn't available here." };

  if (verb === "do") {
    if (kind === "task" || kind === "work_order") res = await toggleTask(id, true);
    else if (kind === "inquiry") res = await markInquiryContacted(id);
    else if (kind === "appointment") res = await setAppointmentStatus(id, "completed");
  } else if (verb === "schedule" || verb === "snooze") {
    if (!date) return { ok: false, error: "Pick a date." };
    // Route through the canonical writer: a single picked day becomes a one-day
    // range (timezone-correct, advances status, never wipes multi-range data).
    if (kind === "job_to_schedule") res = await setJobScheduleRanges(id, [{ start: date, end: date }]);
    else if (kind === "task" || kind === "work_order") res = await updateTask(id, { due_date: date });
    else if (kind === "inquiry") res = await markInquiryContacted(id, date);
  } else if (verb === "assign") {
    const assignee = payload?.assignee || null;
    if (kind === "task" || kind === "work_order") res = await updateTask(id, { assigned_to: assignee });
    else if (kind === "job_to_schedule") res = await setJobAssignee(id, assignee ?? "");
  } else if (verb === "convert") {
    if (kind === "inquiry") res = await convertInquiry(id, (payload?.target as ConvertTarget) || "estimate");
  } else if (verb === "dismiss") {
    if (kind === "task" || kind === "work_order") res = await deleteTask(id);
    else if (kind === "inquiry") res = await deleteInquiry(id);
    else if (kind === "appointment") res = await setAppointmentStatus(id, "cancelled");
    else if (kind === "organize") res = await archiveItem(id);
  }

  if (res.ok) revalidatePath("/planner");
  return res;
}
