import { z } from "zod";
import { setJobScheduleRanges, setJobCrew, createJob, moveJobDay, createScheduleProposal } from "@/app/(app)/schedule/actions";
import { setJobStatus, finishJob, updateJobDescription } from "@/app/(app)/jobs/actions";
import { linkJobContact, unlinkJobContact } from "@/app/(app)/jobs/[id]/job-contacts-actions";
import { createClient } from "@/lib/supabase/server";
import { resolveCustomerId, resolveContactId, resolveJobId, resolveProfileId } from "../resolve-id";
import type { ActionDef } from "../types";

export const jobActions: Record<string, ActionDef> = {
  "job.linkContact": {
    name: "job.linkContact",
    group: "job",
    label: "Link a contact to a job",
    description:
      "Put a subcontractor, supplier, inspector, or other contact ON a job in a role — 'add Joe's plumbing as the plumbing sub on the Miller job'. The contact must already be in the book (create them with customer.create, type subcontractor). Resolve the job with list_jobs and the contact with list_customers. role defaults to Subcontractor. The same contact can be on many jobs.",
    input: z.object({ job_id: z.string(), customer_id: z.string(), role: z.string().default("Subcontractor") }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      // Forgive a job/contact NAME where an id belongs — resolve both to a single match first.
      const supabase = await createClient();
      const job = await resolveJobId(supabase, i.job_id);
      if ("error" in job) return { ok: false, error: job.error };
      if (!job.id) return { ok: false, error: "Which job? I need the job to link the contact to." };
      const contact = await resolveContactId(supabase, i.customer_id);
      if ("error" in contact) return { ok: false, error: contact.error };
      if (!contact.id) return { ok: false, error: "Which contact? I need the contact to link." };
      return linkJobContact(job.id, contact.id, i.role || "Subcontractor");
    },
  },
  "job.unlinkContact": {
    name: "job.unlinkContact",
    group: "job",
    label: "Remove a contact from a job",
    description: "Remove a linked contact from a job. Pass the link's id (from list_job_contacts) and the job_id.",
    input: z.object({ id: z.string(), job_id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: (i) => unlinkJobContact(i.id, i.job_id),
  },
  "job.setScope": {
    name: "job.setScope",
    group: "job",
    label: "Set job scope",
    description:
      "Set a job's scope / description (REPLACES the existing text) — 'set the scope of the Miller job to: rough-in + panel upgrade + final'. Resolve the job with list_jobs first.",
    input: z.object({ job_id: z.string(), description: z.string() }),
    auth: "staff",
    effect: "write",
    handler: (i) => updateJobDescription(i.job_id, i.description),
  },
  "job.create": {
    name: "job.create",
    group: "job",
    label: "Open a job",
    description:
      "Open a new JOB — e.g. 'start a job for the Miller deck'. Resolve the customer first with list_customers and pass customer_id (or pass new_customer_name to create one). Optional description, address, status (to_be_scheduled, scheduled, in_progress, on_hold, complete, cancelled; default in_progress), and billing_type (fixed or draw). Returns the job id — then you can schedule it, assign it, add costs, or quote it.",
    input: z.object({
      name: z.string().min(1),
      customer_id: z.string().nullable().optional(),
      new_customer_name: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      status: z.string().optional(),
      billing_type: z.enum(["fixed", "draw"]).optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      // Forgive a customer NAME passed as customer_id (the "c1a-first-rob" / "John Chmura"
      // class). Resolve it to a real id; a bad name ASKS rather than silently opening a job on
      // the wrong (or no) customer. The new_customer_name path is untouched — that's the
      // explicit "create one" branch and is handled by createJob itself.
      const supabase = await createClient();
      const cust = await resolveCustomerId(supabase, i.customer_id ?? null);
      if ("error" in cust) return { ok: false, error: cust.error };
      const fd = new FormData();
      fd.set("name", i.name);
      if (cust.id) fd.set("customer_id", cust.id);
      if (i.new_customer_name) fd.set("new_customer_name", i.new_customer_name);
      if (i.description) fd.set("description", i.description);
      if (i.address) fd.set("address", i.address);
      if (i.status) fd.set("status", i.status);
      if (i.billing_type) fd.set("billing_type", i.billing_type);
      return createJob(fd);
    },
  },
  "job.setStatus": {
    name: "job.setStatus",
    group: "job",
    label: "Set job status",
    description:
      "Change a job's status — 'mark the Miller job on hold / in progress / scheduled'. Resolve the job with list_jobs first. Status: to_be_scheduled, scheduled, in_progress, on_hold, complete, cancelled.",
    input: z.object({ id: z.string(), status: z.string() }),
    auth: "staff",
    effect: "write",
    handler: (i) => setJobStatus(i.id, i.status),
  },
  "job.finish": {
    name: "job.finish",
    group: "job",
    label: "Finish a job",
    description:
      "Finish a job: mark it complete and auto-build a DRAFT invoice from its labor + materials (it does NOT send — that stays the user's Send button). Resolve the job with list_jobs. The app asks to confirm first.",
    input: z.object({ id: z.string() }),
    auth: "staff",
    effect: "write",
    confirm: "financial",
    describe: () => "Finish this job and draft its invoice — from its accepted estimate if it has one, else from logged labor + materials. Say yes to confirm. (It won't send.)",
    handler: (i) => finishJob(i.id, { sendInvoice: false }), // flags unset: the contract rule decides (quote vs actuals)
  },
  "job.scheduleDay": {
    name: "job.scheduleDay",
    group: "job",
    label: "Schedule job on a day",
    description:
      "Schedule a job's work window (YYYY-MM-DD). Pass date alone for a one-day job, or date + end for a MULTI-DAY span — 'schedule the Miller job June 10 through 13'. Replaces any existing window.",
    input: z.object({ id: z.string(), date: z.string(), end: z.string().optional() }),
    auth: "staff", // jobs are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    handler: async (i) => {
      // Forgive a job NAME passed as the id — resolve to a single match before scheduling.
      const supabase = await createClient();
      const job = await resolveJobId(supabase, i.id);
      if ("error" in job) return { ok: false, error: job.error };
      if (!job.id) return { ok: false, error: "Which job should I schedule?" };
      return setJobScheduleRanges(job.id, [{ start: i.date, end: i.end || i.date }]);
    },
  },
  "job.move": {
    name: "job.move",
    group: "job",
    label: "Move job to a day",
    description:
      "Move ONE day/range of a job's schedule to a new day, keeping its length and every other scheduled range — use for 'push the Chmura job to Friday'. (job.scheduleDay REPLACES the whole schedule; this SHIFTS it.) to_date is YYYY-MM-DD; pass from_date (the day it currently sits on) when the job has multiple ranges so the right one moves. If it fails because a date-pick link is out to the customer, ask the user whether to withdraw the link, then retry with cancel_proposals true.",
    input: z.object({
      id: z.string(),
      to_date: z.string(),
      from_date: z.string().nullable().optional(),
      cancel_proposals: z.boolean().optional(),
    }),
    auth: "staff", // jobs are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    handler: async (i) => {
      const r = await moveJobDay(i.id, i.from_date ?? null, i.to_date, { cancelProposals: i.cancel_proposals });
      // Teach the agent the recovery path: confirm with the user, then retry with the flag.
      if (!r.ok && r.needsProposalConfirm) {
        return { ...r, error: `${r.error} Ask the user whether to withdraw it, then retry with cancel_proposals: true.` };
      }
      return r;
    },
  },
  "job.proposeDates": {
    name: "job.proposeDates",
    group: "job",
    label: "Propose dates to the customer",
    description:
      "Offer the customer up to 3 date options for a JOB (each YYYY-MM-DD, optional HH:MM start) — creates a pick-a-date link; the customer's tap schedules the job. NOTHING IS SENT by this action: read the returned link back so the user can share it (it's also on the job page under Manage). Optional note for arrival-window wording. To just set dates yourself, use job.move / job.scheduleDay instead.",
    input: z.object({
      id: z.string(),
      slots: z
        .array(z.object({ date: z.string(), window: z.string().nullable().optional() }))
        .min(1)
        .max(3),
      note: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      const r = await createScheduleProposal(
        i.id,
        i.slots.map((s: { date: string; window?: string | null }) => ({ date: s.date, time: s.window ?? undefined })),
        i.note ?? null,
      );
      if (!r.ok || !r.token) return r;
      // Hand back the shareable link — creating it sends nothing; the user shares it.
      return { ...r, data: { link: `${process.env.NEXT_PUBLIC_SITE_URL || ""}/pick/${r.token}` } };
    },
  },
  "job.assign": {
    name: "job.assign",
    group: "job",
    label: "Assign job",
    description: "ADD an employee to a job's crew — keeps anyone already on it (a job can have several people). Pass an explicit null/empty assignee to clear the whole crew.",
    // assignee is REQUIRED (nullable): the old .default("") silently UNASSIGNED the job
    // whenever the field was omitted. Now omitting it asks instead of wiping.
    input: z.object({ id: z.string(), assignee: z.string().nullable() }),
    auth: "staff", // jobs are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    handler: async (i) => {
      // Forgive names on BOTH sides: a job name as the id, and a crew member's name as the
      // assignee. A single match resolves; zero/several ASK.
      const supabase = await createClient();
      const job = await resolveJobId(supabase, i.id);
      if ("error" in job) return { ok: false, error: job.error };
      if (!job.id) return { ok: false, error: "Which job should I assign?" };
      // Explicit null/empty = clear the whole crew.
      if (!i.assignee) return setJobCrew(job.id, []);
      const person = await resolveProfileId(supabase, i.assignee);
      if ("error" in person) return { ok: false, error: person.error };
      if (!person.id) return { ok: false, error: "Which crew member should I add?" };
      // ADD them to the existing crew — never wipe teammates (was setJobAssignee, which overwrote
      // to one person: the same P1 bug the schedule card had). Read → append → dedup.
      const { data: cur } = await supabase.from("jobs").select("assigned_to").eq("id", job.id).maybeSingle();
      const next = Array.from(new Set([...(((cur?.assigned_to as string[] | null) ?? [])), person.id]));
      return setJobCrew(job.id, next);
    },
  },
};
