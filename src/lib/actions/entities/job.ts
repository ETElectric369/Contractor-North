import { z } from "zod";
import {
  scheduleJobWindow,
  addJobDay,
  setJobDayTimes,
  setJobCrew,
  createJob,
  moveJobDay,
  createScheduleProposal,
  setJobHold,
  snoozeJobHold,
} from "@/app/(app)/schedule/actions";
import { setJobStatus, finishJob, updateJobDescription, setJobCustomer } from "@/app/(app)/jobs/actions";
import { linkJobContact, unlinkJobContact } from "@/app/(app)/jobs/[id]/job-contacts-actions";
import { createClient } from "@/lib/supabase/server";
import { orgTimezone } from "@/lib/org-local-time";
import { todayStrInTz } from "@/lib/tz";
import { WAITABLE_KINDS, saveNeedsYouWait, waitKey } from "@/lib/action-items/needs-you-waits";
// Which statuses END a job, so they only go through finishing (which bills first) — the one typed
// table every door reads (M2).
import { finishesTheJob } from "@/lib/job-status";
import { hmToMinutes, minutesToHm } from "@/lib/schedule/fit-day";
import type { JobLength } from "@/lib/schedule/job-block";
import { readJobDay } from "@/lib/schedule/job-day-read";
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

type Db = Awaited<ReturnType<typeof createClient>>;

/**
 * ADD PEOPLE TO A JOB'S CREW the way job.assign does: read the crew as saved, add, never take anyone
 * off, and write through setJobCrew (which rings the bell for someone new). A crew that would not
 * change is not written. Kept beside job.assign, whose own lines are not changed (2026-11-16).
 */
async function addToJobCrew(supabase: Db, jobId: string, ids: string[]): Promise<{ ok: boolean; error?: string }> {
  if (!ids.length) return { ok: true };
  const { data: cur, error } = await supabase.from("jobs").select("assigned_to").eq("id", jobId).maybeSingle();
  if (error) return { ok: false, error: "I couldn't read the job's crew, so nobody was added." };
  const now = (((cur as { assigned_to?: string[] | null } | null)?.assigned_to ?? []) as string[]).map(String);
  const next = Array.from(new Set([...now, ...ids]));
  if (next.length === now.length) return { ok: true };
  return setJobCrew(jobId, next);
}

/** "A", "A and B", "A, B and C". */
function andList(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * THE CREW AS STORED, read back after a write, so what Nort says about who is on a job is what the
 * database holds and never what he asked for (2026-11-16: he said a crew was on three jobs that had
 * no day). The crew is the JOB's, on every one of its days.
 */
async function crewNow(supabase: Db, jobId: string): Promise<string> {
  const { data: row, error } = await supabase.from("jobs").select("assigned_to").eq("id", jobId).maybeSingle();
  if (error || !row) return "I couldn't read the job's crew back.";
  const ids = (((row as { assigned_to?: string[] | null }).assigned_to ?? []) as string[]).map(String).filter(Boolean);
  if (!ids.length) return "Nobody is on the job yet.";
  const { data: people, error: pErr } = await supabase.from("profiles").select("id, full_name").in("id", ids);
  if (pErr) return "I couldn't read the crew's names back.";
  const byId = new Map(((people ?? []) as { id: string; full_name: string | null }[]).map((p) => [String(p.id), String(p.full_name ?? "").trim()]));
  const names = ids.map((id) => byId.get(id) || "someone whose name I can't read");
  return `Crew on the job now: ${andList(names)}.`;
}

/** Every crew name resolved BEFORE anything is written: the first that fails asks, with its own words. */
async function resolveCrew(supabase: Db, crew: string[] | null | undefined): Promise<{ ids: string[] } | { error: string }> {
  const ids: string[] = [];
  for (const raw of crew ?? []) {
    if (!String(raw ?? "").trim()) continue;
    const person = await resolveProfileId(supabase, raw);
    if ("error" in person) return { error: person.error };
    if (!person.id) return { error: "Which crew member should I add?" };
    ids.push(person.id);
  }
  return { ids: Array.from(new Set(ids)) };
}

/**
 * THE DAY'S HOURS AS NORT PASSED THEM, checked before anything is written. `start` is 24-hour HH:MM on
 * the company's wall clock; the length is ONE of full_day, end_time (needs start) or minutes; end_time
 * and minutes together only when they agree. Nothing given = the door's own default.
 */
function readDayHoursInput(i: {
  start?: string | null;
  end_time?: string | null;
  minutes?: number | null;
  full_day?: boolean | null;
}): { start?: string; length?: JobLength } | { error: string } {
  const start = i.start == null || i.start === "" ? undefined : String(i.start).trim();
  const startMin = start === undefined ? null : hmToMinutes(start);
  if (start !== undefined && startMin == null) return { error: "start must be a 24-hour HH:MM time, like 13:30." };
  const endGiven = i.end_time != null && i.end_time !== "";
  const minutesGiven = i.minutes != null;
  const fullGiven = i.full_day === true;
  let fromEnd: number | undefined;
  if (endGiven) {
    if (startMin == null) return { error: "An end time needs a start time: pass start too." };
    const endMin = hmToMinutes(String(i.end_time).trim());
    if (endMin == null) return { error: "end_time must be a 24-hour HH:MM time, like 15:30." };
    if (endMin <= startMin) return { error: "The end time must be after the start time." };
    fromEnd = endMin - startMin;
  }
  const given = [endGiven, minutesGiven, fullGiven].filter(Boolean).length;
  if (given > 1 && !(given === 2 && endGiven && minutesGiven && fromEnd === i.minutes)) {
    return { error: "Give one of end_time, minutes or full_day: they don't agree." };
  }
  const length: JobLength | undefined = fullGiven ? "full" : fromEnd !== undefined ? fromEnd : minutesGiven ? Number(i.minutes) : undefined;
  // "7:30" is stored as "07:30": the writers read and keep the two-digit form.
  return { ...(startMin != null ? { start: minutesToHm(startMin) } : {}), ...(length !== undefined ? { length } : {}) };
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
  "job.setCustomer": {
    name: "job.setCustomer",
    group: "job",
    label: "Set job customer",
    description:
      "Put, or change, the customer on a job that ALREADY exists — 'make Sam Tillery the customer on the Larkspur job'. Pass job_id (a job name, number or street is fine) and customer_id (a customer name or id; resolve it with list_customers). Pass new_customer_name (with phone / email if given) ONLY after the person confirmed this is a new customer, never to guess. It refuses when the job already has invoices under a different customer; say so and point the person to Edit Job. Changes nothing else on the job.",
    input: z.object({
      job_id: z.string(),
      customer_id: z.string().nullable().optional(),
      new_customer_name: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      const supabase = await createClient();
      // A name or number passed as the id is forgiven; zero or several matches ASK (never guess).
      const job = await resolveJobId(supabase, i.job_id);
      if ("error" in job) return { ok: false, error: job.error };
      if (!job.id) return { ok: false, error: "Which job? Say its name, number or street." };
      let who: { customerId: string } | { newCustomer: { name: string; phone?: string | null; email?: string | null } };
      if (i.new_customer_name && i.new_customer_name.trim()) {
        who = { newCustomer: { name: i.new_customer_name, phone: i.phone ?? null, email: i.email ?? null } };
      } else {
        const cust = await resolveCustomerId(supabase, i.customer_id ?? null);
        if ("error" in cust) return { ok: false, error: cust.error };
        if (!cust.id) return { ok: false, error: "Which customer? Say their name, or confirm a new one." };
        who = { customerId: cust.id };
      }
      const r = await setJobCustomer(job.id, who);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        id: job.id,
        recorded: `Recorded: ${r.jobLabel ?? "the job"} is now for ${r.customerName ?? "that customer"}.`,
      };
    },
  },
  "job.create": {
    name: "job.create",
    group: "job",
    label: "Open a job",
    description:
      "Open a new JOB — e.g. 'start a job for the Miller deck'. If the person did not say who the customer is, ASK before creating the job. Resolve the customer first with list_customers and pass customer_id (or pass new_customer_name to create one) so the job is born with its customer. Optional description, address, status (to_be_scheduled, scheduled, in_progress, complete, cancelled; default in_progress — a job is put on hold after it exists, with its reason and a day, never at creation), and billing_type (tm for Time & Material or fixed for a fixed price; left out, the job bills the way most of this company's jobs already do, Time & Material when it has none yet or it's a tie). Returns the job id — then you can schedule it, assign it, add costs, or quote it. When the new job filed an open site visit at the same place with it, the result's speak says which; read the speak AND warning back to the user.",
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
      // Forgive a customer NAME passed as customer_id (the "c1a-first-rob" / "John Clover"
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
      // THE VISIT createJob TIED is in the words Nort gives back (skeptic #84, S6): `note` is not a field
      // the model is handed (agent-tool-result), so it rides as `speak`; a failed tie is `warning`.
      const made = await createJob(fd);
      return made.ok && made.note ? { ...made, speak: made.note } : made;
    },
  },
  "job.setStatus": {
    name: "job.setStatus",
    group: "job",
    label: "Set job status",
    description:
      "Change a job's status — 'mark the Miller job on hold / in progress / scheduled'. Resolve the job with list_jobs first. Status: to_be_scheduled, scheduled, in_progress, on_hold, cancelled. FINISHING A JOB IS NOT HERE: 'mark it complete / done / finished' is job.finish, which bills the work first and asks the user to confirm — this tool refuses 'complete' and says so. Putting a job ON HOLD needs its reason (what it's waiting on: it is what the reminder says) and takes an optional until (YYYY-MM-DD, company-local, today or later: its reminder day, when it shows in My Day's Tasks & Reminders; left out, a week from today). The job stays on hold on that day. With no reason it refuses unless the job already has one saved; ask what it's waiting on.",
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
       * from Erik, two different consequences — and the cheap one was the one that lost Tess's 19.5
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
      if (i.status === "scheduled") {
        /* A STATUS IS NOT A DAY (2026-11-16): Nort set a job to Scheduled and said it was on the
           schedule while it still sat under Waiting for a Day. The write is the same; when the job has
           no day, `recorded` says so and names the door that gives one. */
        const r = await setJobStatus(i.id, i.status);
        if (!r.ok) return r;
        const supabase = await createClient();
        const { data } = await supabase.from("jobs").select("scheduled_start").eq("id", i.id).maybeSingle();
        if (data && (data as { scheduled_start?: string | null }).scheduled_start == null) {
          return {
            ...r,
            recorded:
              "Its status says Scheduled, but it has no day yet, so it is still under Waiting for a Day. A job gets its day from job.scheduleDay.",
          };
        }
        return r;
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
      "A job on hold shows as a reminder in My Day's Tasks & Reminders on its day, with its reason, and stays on hold; this moves that reminder day — 'bring the Miller job back next Friday'. Pass the job's id (from list_jobs) and date (YYYY-MM-DD, company-local, today or later). The job stays on hold, held by whoever held it, with its reason; pass reason only when the hold has none saved yet (it never rewrites a saved one). Reversible: pick another day any time.",
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
      "Finish a job: mark it complete. On an ordinary job it also builds a DRAFT invoice (from the accepted estimate if there is one, else the logged labor + materials); it never sends. On a job billed with PROGRESS PAYMENTS (a deposit / progress / final draw) it builds no new bill: an open progress report built from actuals takes the last hours and bills; otherwise any hours or bills not on a bill yet are NAMED in the result's warning (e.g. '<hours> h ($<amount>) of work on this job is not on a bill yet') and stay unbilled until the last bill is made with the job's New Invoice → This Is the Last Bill. Read the result's speak AND warning back to the user. Resolve the job with list_jobs. The app asks to confirm first.",
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
      "THE way a job's work gets a day on the schedule. One call carries the day, the start, how long, and who: date (YYYY-MM-DD), start (24-hour HH:MM on this company's wall clock, e.g. 07:30), then ONE of end_time (HH:MM, needs start), minutes, or full_day: true (left out, the job's own length, else 2 hours, said), and crew (names or ids). The crew is the JOB's crew on every one of its days (there is no per-day crew), and crew ADDS people: nobody already on the job is taken off. Without replace or end, the call ADDS that day: the days of the job's live plan are kept, while a job on hold, or one with no day, starts a fresh plan with this day and only the days already worked stay. That call also takes a job on hold off hold, and a job waiting for a day becomes Scheduled. A job already on that day has its hours there changed to what was passed and the crew added, and `recorded` says the hours as stored. replace: true, or date + end for a MULTI-DAY window ('June 10 through 13'; end is the last day, never before date), REPLACES the planned days not yet worked (days already worked stay as history), takes no hours in the same call, and does NOT take a job off hold. If it fails because a date-pick link is out to the customer, ask the user whether to withdraw it, then retry with cancel_proposals: true. NEVER use appointment.create for a job's work: a visit is not the job's day. Say `recorded` back and claim nothing it does not say (the day, the hours, who is on the job).",
    input: z.object({
      id: z.string(),
      date: z.string(),
      end: z.string().optional(),
      replace: z.boolean().optional(),
      start: z.string().nullable().optional(),
      end_time: z.string().nullable().optional(),
      minutes: z.number().int().positive().nullable().optional(),
      full_day: z.boolean().nullable().optional(),
      crew: z.array(z.string()).max(12).nullable().optional(),
      cancel_proposals: z.boolean().optional(),
    }),
    auth: "staff", // jobs are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    handler: async (i) => {
      // Forgive a job NAME passed as the id — resolve to a single match before scheduling.
      const supabase = await createClient();
      const job = await resolveJobId(supabase, i.id);
      if ("error" in job) return { ok: false, error: job.error };
      if (!job.id) return { ok: false, error: "Which job should I schedule?" };
      // An end before the start would have become a one-day REPLACE of the whole plan: refused first.
      if (i.end && YMD.test(i.end) && YMD.test(i.date) && i.end < i.date) {
        return { ok: false, error: "The end day is before the start day: pass date as the first day and end as the last." };
      }
      // Every crew name is settled before anything is written: a name that asks writes nothing.
      const crew = await resolveCrew(supabase, i.crew);
      if ("error" in crew) return { ok: false, error: crew.error };
      const hoursGiven = (i.start != null && i.start !== "") || (i.end_time != null && i.end_time !== "") || i.minutes != null || i.full_day === true;

      /* THE WINDOW ROUTE: a replaced plan, or a span of several days. Exactly the write it always was
         (Needs You's Schedule tap sends replace: true, so a person's tap does what it did). */
      if (i.replace === true || (i.end && i.end !== i.date)) {
        if (hoursGiven) {
          return {
            ok: false,
            error: "A multi-day window or a replaced plan takes no hours in this call. Put the job on each day with its own call (date, start, and end_time or minutes).",
          };
        }
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
        if (!r.ok) return said ? { ...r, recorded: said } : r;
        // The window's writer never lifts a hold (only the day route's door does): said, never implied.
        const { data: after } = await supabase.from("jobs").select("status").eq("id", job.id).maybeSingle();
        const held =
          (after as { status?: string | null } | null)?.status === "on_hold"
            ? "It is still on hold: take it off hold with job.setStatus, or put it on a day without replace."
            : null;
        if (!crew.ids.length) {
          const all = [said, held].filter(Boolean).join(" ");
          return all ? { ...r, recorded: all } : r;
        }
        const c = await addToJobCrew(supabase, job.id, crew.ids);
        const crewSaid = [c.ok ? null : `The crew did not change: ${c.error ?? "the write was refused"}.`, await crewNow(supabase, job.id)]
          .filter(Boolean)
          .join(" ");
        return { ...r, recorded: [said, held, crewSaid].filter(Boolean).join(" ") };
      }

      /* THE DAY ROUTE (2026-11-16). Nort booked a day of three jobs as three visits with nobody on them
         and gave no job a day, because this verb took a date only and replaced the plan. A day is ADDED
         now through the app's own door, Add to Schedule (addJobDay): its hours, the crew, a hold lifted,
         a job waiting for a day made Scheduled, and the job's other days left as they are. */
      const hours = readDayHoursInput(i);
      if ("error" in hours) return { ok: false, error: hours.error };
      const r = await addJobDay(
        job.id,
        { day: i.date, start: hours.start, length: hours.length, crew: crew.ids.length ? { add: crew.ids } : undefined },
        { cancelProposals: i.cancel_proposals },
      );
      if (r.ok) {
        // The door's own note says a two-hour default ("(2 hours; change it on its block)"): not said twice.
        const said = [r.note, await crewNow(supabase, job.id)].filter(Boolean).join(" ");
        return { ...r, recorded: said };
      }
      // Teach the agent the recovery path: confirm with the user, then retry with the flag (job.move's).
      if (r.needsProposalConfirm) {
        return { ...r, error: `${r.error} Ask the user whether to withdraw it, then retry with cancel_proposals: true.` };
      }
      if (!r.alreadyOnDay) return r;

      /* ALREADY ON THAT DAY is not a failure here: what was passed is made true there. The start first,
         then the length from that start, as two writes, because one day's writer applies a start OR a
         length to a day of a longer plan (nextDayHours), never both at once. What is SAID is the day as
         read back after the writes (the calendar's own rule, lib/schedule/job-day-read), never the asked
         values: the writer clamps a day at 23:59, so "22:00 for 5 hours" stores 22:00 to 23:59. */
      if (hours.start === undefined && hours.length === undefined && !crew.ids.length) {
        return { ok: true, id: job.id, recorded: `The job is already on ${i.date}. Nothing changed.` };
      }
      const notChanged: string[] = [];
      let stored = false;
      if (hours.start !== undefined) {
        const t = await setJobDayTimes(job.id, i.date, { start: hours.start });
        if (!t.ok) return { ok: false, error: `The job is already on ${i.date}, and its start there did not change: ${t.error ?? "the write was refused"}` };
        stored = true;
      }
      if (hours.length !== undefined) {
        const t = await setJobDayTimes(job.id, i.date, { length: hours.length });
        if (!t.ok) {
          // Nothing stored yet: a plain refusal. A start already stored is a half-write, said as one.
          if (!stored) return { ok: false, error: `The job is already on ${i.date}, and its length there did not change: ${t.error ?? "the write was refused"}` };
          notChanged.push(`The start there was changed, but its length did NOT change: ${t.error ?? "the write was refused"}`);
        } else {
          stored = true;
        }
      }
      if (crew.ids.length) {
        const c = await addToJobCrew(supabase, job.id, crew.ids);
        if (!c.ok) notChanged.push(`The crew did not change: ${c.error ?? "the write was refused"}.`);
      }
      const said: string[] = [`The job was already on ${i.date}.`];
      if (stored) {
        const back = await readJobDay(supabase, job.id, i.date);
        said.push(
          back.ok && back.block
            ? `On that day it is now ${back.block.start} to ${back.block.end}${back.block.all_day ? " (the whole work day)" : ""}.`
            : `The hours were sent, but the day could not be read back: schedule_overview for ${i.date} has the truth.`,
        );
      }
      said.push(...notChanged, await crewNow(supabase, job.id));
      return { ok: true, id: job.id, recorded: said.join(" ") };
    },
  },
  "job.move": {
    name: "job.move",
    group: "job",
    label: "Move job to a day",
    description:
      "Move ONE day/range of a job's schedule to a new day, keeping every other scheduled range — use for 'push the <job> job to Friday'. (job.scheduleDay ADDS a day, or REPLACES the planned schedule with replace: true; this SHIFTS one range.) Days of that range already worked (time logged, or a visit closed out as done) stay where they happened and only the days not yet worked move, so a 3-day range with 2 days worked lands as 1 day; `recorded` says so — tell the user. to_date is YYYY-MM-DD; pass from_date (the day it currently sits on) when the job has multiple ranges so the right one moves. If it fails because a date-pick link is out to the customer, ask the user whether to withdraw the link, then retry with cancel_proposals true.",
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
