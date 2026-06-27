import { z } from "zod";
import { setJobScheduleRanges, setJobAssignee, createJob } from "@/app/(app)/schedule/actions";
import { setJobStatus, finishJob, updateJobDescription } from "@/app/(app)/jobs/actions";
import { linkJobContact, unlinkJobContact } from "@/app/(app)/jobs/[id]/job-contacts-actions";
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
    handler: (i) => linkJobContact(i.job_id, i.customer_id, i.role || "Subcontractor"),
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
      "Open a new JOB — e.g. 'start a job for the Miller deck'. Resolve the customer first with list_customers and pass customer_id (or pass new_customer_name to create one). Optional description, address, status (default estimate), and billing_type (fixed or draw). Returns the job id — then you can schedule it, assign it, add costs, or quote it.",
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
    handler: (i) => {
      const fd = new FormData();
      fd.set("name", i.name);
      if (i.customer_id) fd.set("customer_id", i.customer_id);
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
      "Change a job's status — 'mark the Miller job on hold / in progress / scheduled'. Resolve the job with list_jobs first. Status: estimate, scheduled, in_progress, on_hold, complete, invoiced, cancelled.",
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
    describe: () => "Finish this job and draft its invoice from logged labor + materials — say yes to confirm. (It won't send.)",
    handler: (i) => finishJob(i.id, { importLabor: true, importCosts: true, sendInvoice: false }),
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
    handler: (i) => setJobScheduleRanges(i.id, [{ start: i.date, end: i.end || i.date }]),
  },
  "job.assign": {
    name: "job.assign",
    group: "job",
    label: "Assign job",
    description: "Assign a job to a single employee (profile id), or empty to clear.",
    input: z.object({ id: z.string(), assignee: z.string().nullable().default("") }),
    auth: "staff", // jobs are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    handler: (i) => setJobAssignee(i.id, i.assignee ?? ""),
  },
};
