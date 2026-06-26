import { z } from "zod";
import { patchLienRecord } from "@/app/(app)/jobs/lien-actions";
import type { ActionDef } from "../types";

export const lienActions: Record<string, ActionDef> = {
  "lien.update": {
    name: "lien.update",
    group: "lien",
    label: "Update lien tracking",
    description:
      "Update a job's mechanic's-lien tracking — 'mark the prelim notice sent today on the Oak Ave job', 'record the completion date'. Resolve the job with list_jobs and pass job_id plus the date(s) to set: prelim_sent_at, lien_recorded_at, completion_date, first_furnished_date (YYYY-MM-DD). Only the fields you pass change. Protects lien rights — the costliest thing to forget.",
    input: z.object({
      job_id: z.string(),
      prelim_sent_at: z.string().nullable().optional(),
      lien_recorded_at: z.string().nullable().optional(),
      completion_date: z.string().nullable().optional(),
      first_furnished_date: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: (i) =>
      patchLienRecord(i.job_id, {
        prelim_sent_at: i.prelim_sent_at ?? undefined,
        lien_recorded_at: i.lien_recorded_at ?? undefined,
        completion_date: i.completion_date ?? undefined,
        first_furnished_date: i.first_furnished_date ?? undefined,
        notes: i.notes ?? undefined,
      }),
  },
};
