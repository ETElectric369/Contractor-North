import { z } from "zod";
import {
  scheduleJobWindow,
  setJobCrew,
  createJob,
  moveJobDay,
  createScheduleProposal,
  setJobHold,
  snoozeJobHold,
} from "@/app/(app)/schedule/actions";
import { setJobStatus, finishJob, updateJobDescription } from "@/app/(app)/jobs/actions";
import { linkJobContact, unlinkJobContact } from "@/app/(app)/jobs/[id]/job-contacts-actions";
import { createClient } from "@/lib/supabase/server";
import { orgTimezone } from "@/lib/org-local-time";
import { todayStrInTz } from "@/lib/tz";
import { WAITABLE_KINDS, saveNeedsYouWait, waitKey } from "@/lib/action-items/needs-you-waits";
// Which statuses END a job, so they only go through finishing (which bills first) — the one typed
// table every door reads (M2).
import { finishesTheJob } from "@/lib/job-status";
import { resolveCustomerId, resolveContactId, resolveJobId, resolveProfileId } from "../resolve-id";
import type { ActionDef } from "../types";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A job NAME passed where its id belongs is forgiven; one that matches nothing (or several) asks. */
async function jobIdOf(value: string, ask: string): Promise<{ id: string } | { error: string }> {
  const supabase = await createClient();
  const job = await resolveJobId(supabase, value);
  if ("error" in job) return { error: job.error };
  if (!job.id) return { error: ask };
  return { id: job.id };
}

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
      "Set a job's scope / description (REPLACES the existing text) — 'set the scope of the <job> job to: <the work>'. Resolve the job with list_jobs first.",
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
      "Open a new JOB — e.g. 'start a job for the Miller deck'. Resolve the customer first with list_customers and pass customer_id (or pass new_customer_name to create one). Optional description, address, status (to_be_scheduled, scheduled, in_progress, complete, cancelled; default in_progress — a job is put on hold after it exists, with its reason and a day, never at creation), and billing_type (tm for Time & Material or fixed for a fixed price; left out, the job bills the way most of this company's jobs already do, Time & Material when it has none yet or it's a tie). Returns the job id — then you can schedule it, assign it, add costs, or quote it.",
    input: z.object({
      name: z.string().min(1),
      customer_id: z.string().nullable().optional(),
      new_customer_name: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      status: z.string().optional(),
      // The database's own check allows exactly these two (jobs.billing_type): "draw" was offered and
      // failed on every save, and Time & Material could not be asked for at all (W1-22).
      billing_type: z.enum(["tm", "fixed"]).optional(),
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
      "Change a job's status — 'mark the Miller job on hold / in progress / scheduled'. Resolve the job with list_jobs first. Status: to_be_scheduled, scheduled, in_progress, on_hold, cancelled. FINISHING A JOB IS NOT HERE: 'mark it complete / done / finished' is job.finish, which bills the work first and asks the user to confirm — this tool refuses 'complete' and says so. Putting a job ON HOLD needs its reason (what it's waiting on: it is the reminder when the job comes back) and takes an optional until (YYYY-MM-DD, company-local, today or later: the day it comes back to Needs You; left out, a week from today). With no reason it refuses unless the job already has one saved; ask what it's waiting on.",
    input: z.object({
      id: z.string(),
      status: z.string(),
      reason: z.string().nullable().optional(),
      until: z.string().regex(YMD).nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      /**
       * ONE FINISH TOOL, NOT TWO (M2). Nort could end a job two ways: job.finish, which bills the
       * unbilled work into a draft and asks the user to confirm first (confirm: "financial"), and
       * this tool with status "complete", which wrote the word alone and asked nobody. Same words
       * from Erik, two different consequences — and the cheap one was the one that lost Tao's 19.5
       * hours. So finishing has exactly one door now, and this one points at it in words rather
       * than quietly doing something else (the typed table in lib/job-status says which statuses
       * end a job, so a new one is covered here the day it is added).
       */
      if (finishesTheJob(i.status)) {
        return {
          ok: false,
          error: "Finishing a job bills its work first, so it goes through Finish Job, not a status change. Use job.finish on this job — it drafts the bill, never sends it, and asks them to confirm.",
        };
      }
      // ON HOLD GOES THROUGH THE HOLD (NY-hold, 0366): its reason and its day, the same write the
      // schedule's Hold It makes. Every other status is the plain status write.
      if (i.status !== "on_hold") return setJobStatus(i.id, i.status);
      const said = (i.reason ?? "").trim();
      const when = i.until ? { date: i.until } : null;
      if (said) return setJobHold(i.id, said, when);
      // No reason said: the one the job already carries stands (as it always did); with none saved,
      // setJobStatus refuses in words and nothing is written.
      if (!when) return setJobStatus(i.id, "on_hold");
      const supabase = await createClient();
      const { data } = await supabase.from("jobs").select("hold_reason").eq("id", i.id).maybeSingle();
      const saved = String((data as { hold_reason?: string | null } | null)?.hold_reason ?? "").trim();
      return saved ? setJobHold(i.id, saved, when) : setJobStatus(i.id, "on_hold");
    },
  },
  "job.snoozeHold": {
    name: "job.snoozeHold",
    group: "job",
    label: "Snooze a job on hold",
    description:
      "A job on hold comes back to Needs You on its day with its reason; this moves that day — 'bring the Miller job back next Friday'. Pass the job's id (from list_jobs) and date (YYYY-MM-DD, company-local, today or later). The job stays on hold, held by whoever held it, with its reason; pass reason only when the hold has none saved yet (it never rewrites a saved one). Reversible: pick another day any time.",
    input: z.object({ id: z.string(), date: z.string().regex(YMD), reason: z.string().nullable().optional() }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      const job = await jobIdOf(i.id, "Which job? Give me its name or number.");
      if ("error" in job) return { ok: false, error: job.error };
      return snoozeJobHold(job.id, { date: i.date }, i.reason ?? null);
    },
  },
  "job.takeOffHold": {
    name: "job.takeOffHold",
    group: "job",
    label: "Take a job off hold",
    description:
      "Take a job off hold — 'the permit came in, take the Miller job off hold'. Pass the job's id (from list_jobs). It goes back to scheduled when it has a date, or to be scheduled when it doesn't, and its reason and day are cleared.",
    input: z.object({ id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      const job = await jobIdOf(i.id, "Which job? Give me its name or number.");
      if ("error" in job) return { ok: false, error: job.error };
      return setJobHold(job.id, null);
    },
  },
  "job.snoozeNeedsYou": {
    name: "job.snoozeNeedsYou",
    group: "job",
    label: "Snooze a job's Needs You row",
    description:
      "Some Needs You rows about a job have no day of their own and nothing that ends them: No Costs Yet on a labor-only job (kind job_unbilled_work), To Buy while a part is back-ordered (kind materials_needed). This takes that row off Needs You until a day — 'the Miller parts are back-ordered, bring the To Buy back in two weeks'. Pass the job's id (from list_jobs), the kind, date (YYYY-MM-DD, company-local, today or later) and an optional reason (said on the waiting row). It waits in My Day's Waiting fold with that day and comes back on it.",
    input: z.object({
      id: z.string(),
      kind: z.enum(WAITABLE_KINDS),
      date: z.string().regex(YMD),
      reason: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: async (i, ctx) => {
      const job = await jobIdOf(i.id, "Which job? Give me its name or number.");
      if ("error" in job) return { ok: false, error: job.error };
      const supabase = await createClient();
      const { data: real } = await supabase.from("jobs").select("id").eq("id", job.id).maybeSingle();
      if (!real) return { ok: false, error: "That job isn't available." };
      const tz = await orgTimezone(supabase);
      return saveNeedsYouWait(supabase, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        key: waitKey(i.kind, job.id),
        date: i.date,
        reason: i.reason ?? null,
        todayStr: todayStrInTz(tz),
      });
    },
  },
  "job.finish": {
    name: "job.finish",
    group: "job",
    label: "Finish a job",
    description:
      "Finish a job: mark it complete. On an ordinary job it also builds a DRAFT invoice (from the accepted estimate if there is one, else the logged labor + materials); it never sends. On a job billed with PROGRESS PAYMENTS (a deposit / progress / final draw) it builds no new bill: an open progress report built from actuals takes the last hours and bills; otherwise any hours or bills not on a bill yet are NAMED in the result's warning (e.g. '<hours> h ($<amount>) of work on this job is not on a bill yet') and stay unbilled until the last bill is made with the job's New Invoice → This Is The Last Bill. Read the result's speak AND warning back to the user. Resolve the job with list_jobs. The app asks to confirm first.",
    input: z.object({ id: z.string() }),
    auth: "staff",
    effect: "write",
    confirm: "financial",
    describe: () =>
      "Finish this job. On an ordinary job I'll draft its invoice (from the accepted estimate if it has one, else from logged labor + materials). On a job billed with progress payments I won't bill anything new, and I'll tell you what's still not on a bill. Say yes to confirm. (It won't send.)",
    handler: (i) => finishJob(i.id, { sendInvoice: false }), // flags unset: the contract rule decides (quote vs actuals)
  },
  "job.scheduleDay": {
    name: "job.scheduleDay",
    group: "job",
    label: "Schedule job on a day",
    description:
      "Schedule a job's work window (YYYY-MM-DD). Pass date alone for a one-day job, or date + end for a MULTI-DAY span — 'schedule the Miller job June 10 through 13'. Replaces the planned window, EXCEPT days already worked (time logged, or a visit closed out as done) — those stay on the calendar as history, while the job's listed start date follows the new window. When the result's `recorded` says which days were kept, tell the user.",
    input: z.object({ id: z.string(), date: z.string(), end: z.string().optional() }),
    auth: "staff", // jobs are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    handler: async (i) => {
      // Forgive a job NAME passed as the id — resolve to a single match before scheduling.
      const supabase = await createClient();
      const job = await resolveJobId(supabase, i.id);
      if ("error" in job) return { ok: false, error: job.error };
      if (!job.id) return { ok: false, error: "Which job should I schedule?" };
      const r = await scheduleJobWindow(job.id, i.date, i.end || i.date);
      // ANNOUNCE THE DEED: a kept worked day is part of what happened, so it rides on `recorded`; so
      // does the two-hour default a job with no length lands with (lib/schedule/job-block), said
      // from the write's own answer, never guessed.
      const said = [
        r.note,
        r.defaulted
          ? "It has no length, so it went down as 2 hours from the start of the work day. The length can be changed on the job or by tapping it on the schedule."
          : null,
      ].filter(Boolean).join(" ");
      return said ? { ...r, recorded: said } : r;
    },
  },
  "job.move": {
    name: "job.move",
    group: "job",
    label: "Move job to a day",
    description:
      "Move ONE day/range of a job's schedule to a new day, keeping every other scheduled range — use for 'push the <job> job to Friday'. (job.scheduleDay REPLACES the planned schedule; this SHIFTS one range.) Days of that range already worked (time logged, or a visit closed out as done) stay where they happened and only the days not yet worked move, so a 3-day range with 2 days worked lands as 1 day; `recorded` says so — tell the user. to_date is YYYY-MM-DD; pass from_date (the day it currently sits on) when the job has multiple ranges so the right one moves. If it fails because a date-pick link is out to the customer, ask the user whether to withdraw the link, then retry with cancel_proposals true.",
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
      return r.note ? { ...r, recorded: r.note } : r;
    },
  },
  "job.proposeDates": {
    name: "job.proposeDates",
    group: "job",
    label: "Propose dates to the customer",
    description:
      "Offer the customer up to 3 date options for a JOB (each YYYY-MM-DD, optional HH:MM start) — creates a pick-a-date link; the customer's tap schedules the job. NOTHING IS SENT by this action: read the returned link back so the user can share it (it's also on the job's Overview: Offer Dates beside Scheduled, which reads Dates Offered… while an offer is out). Optional note for arrival-window wording. To just set dates yourself, use job.move / job.scheduleDay instead.",
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
