import { z } from "zod";
import { addSafetyRecord } from "@/app/(app)/safety/actions";
import type { ActionDef } from "../types";

export const safetyActions: Record<string, ActionDef> = {
  "safety.log": {
    name: "safety.log",
    group: "safety",
    label: "Log safety record",
    description:
      "Log a SAFETY record by voice — a toolbox talk or an incident. kind is toolbox or incident; title required. For an incident add severity and whether it's OSHA-recordable. Optionally tie it to a job. A spoken record so a field event doesn't go unlogged.",
    input: z.object({
      kind: z.enum(["incident", "toolbox"]).default("toolbox"),
      title: z.string().min(1),
      record_date: z.string().nullable().optional(),
      severity: z.string().nullable().optional(),
      recordable: z.boolean().optional(),
      description: z.string().nullable().optional(),
      job_id: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: (i) =>
      addSafetyRecord({
        kind: i.kind,
        title: i.title,
        record_date: i.record_date ?? null,
        severity: i.severity ?? null,
        recordable: i.recordable,
        description: i.description ?? null,
        job_id: i.job_id ?? null,
      }),
  },
};
