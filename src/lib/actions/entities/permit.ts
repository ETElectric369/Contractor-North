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
    // NO INSPECTION DATE HERE (0378). A permit needs SEVERAL inspections, from different authorities,
    // in order — they are rows in permit_inspections now, booked on the permit's own card, and
    // permits.inspection_date is superseded. `authority` is who ISSUED the permit, not who inspects it.
    description:
      "Log a PERMIT — e.g. 'add a <type> permit for the <job> job, applied today'. Resolve the job first with list_jobs and pass job_id (optional — a permit can stand alone). type defaults to Electrical, status to applied; dates are YYYY-MM-DD. `authority` is who ISSUED it. The inspections it needs are separate: each authority that has to come is added on the permit itself, in the order they come.",
    input: z.object({
      job_id: z.string().nullable().optional(),
      permit_number: z.string().nullable().optional(),
      type: z.string().optional(),
      authority: z.string().nullable().optional(),
      status: z.string().optional(),
      applied_date: z.string().nullable().optional(),
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
        notes: i.notes ?? null,
      });
    },
  },
};
