import { z } from "zod";
import { generateContractFromJob, recordPaperSignature } from "@/app/(app)/contracts/actions";
import { createClient } from "@/lib/supabase/server";
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
  // SIGNED ON PAPER (Needs You's ⋯ on an unsigned contract, 2026-11-04): a person's tap behind a
  // confirm, never Nort's (not in AGENT_WRITE_ALLOWED: the agent-write set stays frozen). With no
  // name given, the signer is the contract's own customer; with none on file it asks for the one step.
  "contract.recordPaperSignature": {
    name: "contract.recordPaperSignature",
    group: "contract",
    label: "Record a contract signed on paper",
    description:
      "Record that a SENT contract was signed on paper (or anywhere off-screen). Pass id, and the signer's name and the day (YYYY-MM-DD) when known; with no name, the contract's customer is the signer and today is the day.",
    input: z.object({ id: z.string(), name: z.string().optional(), signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      let name = (i.name ?? "").trim();
      if (!name) {
        const supabase = await createClient();
        const { data } = await supabase.from("contracts").select("customers(name)").eq("id", i.id).maybeSingle();
        const c = (data as { customers?: { name?: string | null } | { name?: string | null }[] | null } | null)?.customers;
        name = String((Array.isArray(c) ? c[0]?.name : c?.name) ?? "").trim();
      }
      if (!name) return { ok: false, error: "This contract has no customer to name as the signer. Open it on the job and say who signed." };
      return recordPaperSignature(i.id, { name, signedOn: i.signedOn ?? null });
    },
  },
};
