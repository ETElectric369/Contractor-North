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
      data: z.record(z.any()).default({}),
    }),
    auth: "any",
    effect: "write",
    handler: (i) => submitForm({ form_id: i.form_id, job_id: i.job_id ?? null, data: i.data ?? {} }),
  },
};
