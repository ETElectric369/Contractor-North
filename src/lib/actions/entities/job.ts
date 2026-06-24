import { z } from "zod";
import { setJobScheduleRanges, setJobAssignee } from "@/app/(app)/schedule/actions";
import type { ActionDef } from "../types";

export const jobActions: Record<string, ActionDef> = {
  "job.scheduleDay": {
    name: "job.scheduleDay",
    group: "job",
    label: "Schedule job on a day",
    description: "Schedule a job on a single date (YYYY-MM-DD) — a one-day work window.",
    input: z.object({ id: z.string(), date: z.string() }),
    auth: "staff", // jobs are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    handler: (i) => setJobScheduleRanges(i.id, [{ start: i.date, end: i.date }]),
  },
  "job.assign": {
    name: "job.assign",
    group: "job",
    label: "Assign job",
    description: "Assign a job to a single employee (profile id), or empty to clear.",
    input: z.object({ id: z.string(), assignee: z.string().nullable().default("") }),
    auth: "staff", // jobs are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    handler: (i) => setJobAssignee(i.id, i.assignee ?? ""),
  },
};
