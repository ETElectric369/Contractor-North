import { z } from "zod";
import { createPermit } from "@/app/(app)/permits/actions";
import { createClient } from "@/lib/supabase/server";
import { resolveJobId } from "../resolve-id";
import type { ActionDef } from "../types";

// Permits are prime assistant/field territory (deadlines + inspections). Wraps the existing
// createPermit; logging a permit is a tier-1 reversible record (no money, nothing sent).
export const permitActions: Record<string, ActionDef> = {
  "permit.create": {
    name: "permit.create",
    group: "permit",
    label: "Add a permit",
    description:
      "Log a PERMIT — e.g. 'add an electrical permit for the Miller job, applied today, inspection next Tuesday'. Resolve the job first with list_jobs and pass job_id (optional — a permit can stand alone). type defaults to Electrical, status to applied; dates are YYYY-MM-DD.",
    input: z.object({
      job_id: z.string().nullable().optional(),
      permit_number: z.string().nullable().optional(),
      type: z.string().optional(),
      authority: z.string().nullable().optional(),
      status: z.string().optional(),
      applied_date: z.string().nullable().optional(),
      inspection_date: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      // Forgive a job NAME passed as job_id — a permit can stand alone (null is fine), but a
      // NAME that matches nothing / several ASKS rather than logging it against the wrong job.
      const supabase = await createClient();
      const job = await resolveJobId(supabase, i.job_id ?? null);
      if ("error" in job) return { ok: false, error: job.error };
      return createPermit({
        job_id: job.id,
        permit_number: i.permit_number ?? null,
        type: i.type,
        authority: i.authority ?? null,
        status: i.status,
        applied_date: i.applied_date ?? null,
        inspection_date: i.inspection_date ?? null,
        notes: i.notes ?? null,
      });
    },
  },
};
