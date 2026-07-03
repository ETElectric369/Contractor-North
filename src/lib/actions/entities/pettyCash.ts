import { z } from "zod";
import { addPettyCash } from "@/app/(app)/petty-cash/actions";
import { createClient } from "@/lib/supabase/server";
import { resolveJobId } from "../resolve-id";
import type { ActionDef } from "../types";

export const pettyCashActions: Record<string, ActionDef> = {
  "pettycash.add": {
    name: "pettycash.add",
    group: "pettycash",
    label: "Log petty cash",
    description:
      "Log a petty-cash transaction by voice — '$20 cash for fuel' (kind expense) or 'put $200 in the box' (kind replenish). amount is positive; optionally a category, a note, a date (YYYY-MM-DD), or a job. The app asks to confirm the amount first.",
    input: z.object({
      kind: z.enum(["expense", "replenish"]).default("expense"),
      amount: z.number(),
      category: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      tx_date: z.string().nullable().optional(),
      job_id: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial",
    describe: (i) => `Log a $${i.amount} petty-cash ${i.kind}${i.description ? ` (${i.description})` : ""} — say yes to confirm.`,
    handler: async (i) => {
      // Forgive a job NAME passed as job_id — and catch the '{{APACHE_JOB_ID}}' placeholder
      // class with a "look it up first" nudge instead of a raw uuid-syntax error.
      const supabase = await createClient();
      const job = await resolveJobId(supabase, i.job_id ?? null);
      if ("error" in job) return { ok: false, error: job.error };
      return addPettyCash({
        kind: i.kind,
        amount: i.amount,
        category: i.category ?? null,
        description: i.description ?? null,
        tx_date: i.tx_date ?? null,
        job_id: job.id,
      });
    },
  },
};
