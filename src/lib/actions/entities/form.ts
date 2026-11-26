import { z } from "zod";
import { submitForm } from "@/app/(app)/forms/actions";
import type { ActionDef } from "../types";

export const formActions: Record<string, ActionDef> = {
  "form.submit": {
    name: "form.submit",
    group: "form",
    label: "Submit a form",
    description:
      "Fill and submit a FORM / checklist — 'fill the daily safety form for the Miller job, all yes'. Get the form's id + fields from list_forms first, then pass form_id, an optional job_id, and data keyed by each field's label.",
    input: z.object({
      form_id: z.string(),
      job_id: z.string().nullable().optional(),
      // zod 4 takes a record's key type too. A record of any value makes no issue per entry, so
      // an oversized one is not the over-long-list problem a bound guards against: no bound.
      data: z.record(z.string(), z.any()).default({}),
    }),
    auth: "any",
    effect: "write",
    handler: (i) => submitForm({ form_id: i.form_id, job_id: i.job_id ?? null, data: i.data ?? {} }),
  },
};
