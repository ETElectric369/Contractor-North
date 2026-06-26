import { z } from "zod";
import { generateContractFromJob } from "@/app/(app)/contracts/actions";
import type { ActionDef } from "../types";

export const contractActions: Record<string, ActionDef> = {
  "contract.generate": {
    name: "contract.generate",
    group: "contract",
    label: "Draft contract from job",
    description:
      "Draft a CONTRACT from a job (builds it from the job's scope + customer). It is NOT sent — you review and hit Send. Resolve the job with list_jobs and pass job_id. 'Draft a contract for the Miller job.'",
    input: z.object({ job_id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: (i) => generateContractFromJob(i.job_id),
  },
};
