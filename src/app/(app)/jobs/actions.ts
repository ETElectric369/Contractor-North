"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { pushCalendarItem, deleteCalendarItem } from "@/lib/calendar-sync";
import { JOB_STATUSES } from "@/lib/job-status";
import { DRAW_KINDS } from "@/lib/invoice-math";
import { emptyToNull } from "@/lib/forms";
import { notifyJobCrewAdded } from "@/lib/crew-notify";
import { visibleJobIdOrNull, visiblePoIdOnJobOrNull, visibleTemplateIdOrNull } from "@/lib/job-visibility";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { reportError } from "@/lib/observe";
import { escapeLike } from "@/lib/utils";
import { shouldImportActuals } from "@/lib/invoice-import-rule";
import {
  createInvoiceFromQuote,
  createBlankInvoice,
  importLaborIntoInvoice,
  importCostsIntoInvoice,
  emailInvoice,
} from "../billing/actions";

export type Result = { ok: boolean; error?: string };

/** Create an invoice for a job — from its quote if it has one, else blank. */
export async function createInvoiceForJob(
  jobId: string,
  opts: { importLabor?: boolean; importCosts?: boolean } = {},
): Promise<{ ok: boolean; error?: string; id?: string; importWarning?: string }> {
  // Defaults are decided AFTER we know whether this invoice came from a quote — see
  // fromQuote below. A quoted job is billed by its CONTRACT; auto-importing the actuals
  // on top of the copied quote lines double-bills it (audit 2026-07-20: a $20k quote +
  // 64 logged hours + a $6k PO shipped a $35.5k draft). An explicit `true` from a caller
  // that really wants T&M on top of a quote still works.
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // A scheduled (draw-billed) job bills through its milestone draws, not a standard invoice —
  // the mirror of setPaymentSchedule's guard, so the two billing paths can never mix (which
  // would corrupt the job's billing state).
  const { data: milestone } = await supabase
    .from("payment_milestones")
    .select("id")
    .eq("job_id", jobId)
    .limit(1)
    .maybeSingle();
  if (milestone)
    return { ok: false, error: "This job bills on a payment schedule — request the next draw from Billing instead." };

  // M3 (extended): never spawn a SECOND standard invoice for a job that's already being invoiced —
  // land on the existing one. A DRAFT is returned to edit; a SENT one is handed back with a note so
  // "finish job" (or a second Create Invoice) can't silently create a duplicate that re-bills the
  // same hours. That sent-invoice case is exactly what the old draft-only dedup missed — the Tao
  // chandelier double. Extra work after an invoice went out is billed via a progress payment.
  const { data: existingStd } = await supabase
    .from("invoices")
    .select("id, invoice_number, status")
    .eq("job_id", jobId)
    .eq("invoice_kind", "standard")
    .neq("status", "void")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingStd) {
    return existingStd.status === "draft"
      ? { ok: true, id: existingStd.id }
      : { ok: true, id: existingStd.id, importWarning: `This job is already invoiced on ${existingStd.invoice_number} — opened it instead of creating a duplicate.` };
  }

  const { data: quote } = await supabase
    .from("quotes")
    .select("id")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // THE contract-vs-actuals switch. FinishJobButton already initialised its toggles to
  // !hasQuote — this makes that rule structural, so the three entry points that pass no
  // opts (job Invoices tab "New invoice", /billing "Create Invoice →", and Nort's
  // job.invoice verb) can't double-bill a quoted job.
  const fromQuote = !!quote;
  const wantLabor = shouldImportActuals(fromQuote, opts.importLabor);
  const wantCosts = shouldImportActuals(fromQuote, opts.importCosts);

  let res: { ok: boolean; error?: string; id?: string };
  if (quote) {
    res = await createInvoiceFromQuote(quote.id);
  } else {
    const { data: job } = await supabase
      .from("jobs")
      .select("customer_id, name, description")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return { ok: false, error: "Job not found." }; // L4: never persist a dangling/cross-org job_id
    res = await createBlankInvoice({
      customer_id: job.customer_id ?? null,
      job_id: jobId, // keep the job link so the invoice can pull Labor/Materials
      title: job.name ?? "",
      description: (job as any)?.description ?? null, // scope shown above the line items
      tax_rate: 0,
    });
  }

  // Pre-fill the draft from the job's logged LABOR (hours × rate) + MATERIALS (POs/bills,
  // marked up), best-effort — both importers no-op cleanly when there's nothing to pull.
  // THIS is the fix for "Create invoice lands on an empty draft" — so you can invoice
  // straight from the field instead of having to be back at a desk with the data entered.
  if (res.ok && res.id) {
    const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
    const markup = getOrgSettings((org as any)?.settings).material_markup_percent;
    // CAPTURE each import. A "nothing to pull" no-op (empty:true) is fine; a REAL failure (DB error)
    // must NOT be swallowed — a field tech invoicing by voice can't see the screen, so a silently empty
    // invoice goes out under-billed. Log it AND tell the caller so the UI/voice can flag it.
    const missed: string[] = [];
    if (wantLabor) {
      const labor = await importLaborIntoInvoice(res.id).catch((e) => ({ ok: false as const, error: String(e?.message ?? e), empty: false }));
      if (!labor.ok && !labor.empty) { reportError("createInvoiceForJob.labor", labor.error, { jobId, invoiceId: res.id }); missed.push("labor"); }
    }
    if (wantCosts) {
      // ALWAYS pass the org markup — importing costs at markup 0 bills materials at cost.
      const costs = await importCostsIntoInvoice(res.id, markup).catch((e) => ({ ok: false as const, error: String(e?.message ?? e), empty: false }));
      if (!costs.ok && !costs.empty) { reportError("createInvoiceForJob.costs", costs.error, { jobId, invoiceId: res.id }); missed.push("materials"); }
    }
    if (missed.length) {
      return { ...res, importWarning: `Invoice created, but ${missed.join(" and ")} couldn't be pulled in — review the line items before sending.` };
    }
  }
  return res;
}

/** Finish a job: mark complete and auto-build a draft invoice — from the
 *  job's quote when there is one, optionally pulling labor from timecards
 *  and materials from POs/bills. Returns the invoice id for review. */
/** Set a job's status (partial — keeps everything else). For voice: "mark the Miller job on
 *  hold / in progress". Org-scoped by RLS (a cross-org id is a clean no-op). */
export async function setJobStatus(id: string, status: string): Promise<{ ok: boolean; error?: string }> {
  if (!(JOB_STATUSES as readonly string[]).includes(status)) return { ok: false, error: `Status must be one of: ${JOB_STATUSES.join(", ")}.` };
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data, error } = await supabase.from("jobs").update({ status }).eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || !data.length) return { ok: false, error: "Job not found." };
  // Google reconcile (fire-safe): leaving the active set deletes the event,
  // re-activating a scheduled job re-pushes it.
  await pushCalendarItem("job", id);
  revalidatePath(`/jobs/${id}`);
  revalidatePath("/jobs");
  revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
  revalidatePath("/schedule"); // and on/off the calendar (the deleted schedule copy did this)
  return { ok: true };
}

export async function finishJob(
  jobId: string,
  // importLabor/importCosts OPTIONAL: an unspecified flag lets createInvoiceForJob's
  // contract rule decide (quoted job → the quote IS the bill; T&M job → import the
  // actuals). FinishJobButton passes its explicit toggles; Nort passes neither.
  opts: { importLabor?: boolean; importCosts?: boolean; sendInvoice?: boolean },
): Promise<{ ok: boolean; error?: string; id?: string; sent?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // A draw-billed job is finished with a Final draw, not a standard invoice. Mark it
  // complete without creating a conflicting standard invoice (H4), and hand back the
  // latest draw so the UI lands on the job's billing instead of a dead-end.
  const { data: draws } = await supabase
    .from("invoices")
    .select("id")
    .eq("job_id", jobId)
    .neq("status", "void")
    .in("invoice_kind", [...DRAW_KINDS])
    .order("created_at", { ascending: false })
    .limit(1);
  if (draws && draws.length) {
    const { error } = await supabase.from("jobs").update({ status: "complete" }).eq("id", jobId);
    if (error) return { ok: false, error: error.message };
    await pushCalendarItem("job", jobId); // finished job leaves Google (fire-safe)
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
  revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
    return { ok: true, id: draws[0].id };
  }

  // createInvoiceForJob does the imports (labor at rate, materials WITH org markup), honoring the
  // toggles. The old code re-imported here a SECOND time with markup 0, which deleted the marked-up
  // material lines and re-inserted them at raw cost — every finished-job invoice billed materials at
  // cost. That redundant second import is gone.
  const inv = await createInvoiceForJob(jobId, { importLabor: opts.importLabor, importCosts: opts.importCosts });
  if (!inv.ok || !inv.id) return { ok: false, error: inv.error ?? "Could not create the invoice." };

  const { error } = await supabase.from("jobs").update({ status: "complete" }).eq("id", jobId);
  if (error) return { ok: false, error: error.message };
  await pushCalendarItem("job", jobId); // finished job leaves Google (fire-safe)

  // Auto-invoice: when asked, email the draft to the customer now. Best-effort —
  // if they have no email (emailInvoice returns an error), the invoice simply stays
  // a draft and surfaces in the "To be invoiced" queue for manual review/send.
  let sent = false;
  if (opts.sendInvoice) {
    const mailed = await emailInvoice(inv.id);
    sent = mailed.ok;
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/jobs");
  revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
  revalidatePath("/billing");
  return { ok: true, id: inv.id, sent };
}

export type DeleteJobResult = {
  ok: boolean;
  error?: string;
  /** The caller must show these to the user and call again with confirmDestructive. */
  needsConfirm?: boolean;
  /** Plain-English list of what deleting the job PERMANENTLY destroys. */
  destroys?: string[];
};

/**
 * Delete a job — with the linked-record guard deleteCustomer has always had.
 *
 * Deleting a job is not the tidy operation the old confirm dialog promised. Quotes,
 * invoices and time entries do survive (their job_id is ON DELETE SET NULL), but a dozen
 * child tables are ON DELETE CASCADE and vanish with no undo: the contract — including
 * signed_at / signed_name / signed_ip / signed_body, the frozen legal record the DB
 * otherwise makes immutable — the lien record with its served CA 20-day Preliminary
 * Notice, the insurance claim, the payment schedule, permits, change orders, and every
 * job photo. There is no soft delete and no backup surface, so a mis-tap on a duplicated
 * job was unrecoverable.
 *
 * Two tiers:
 *   HARD BLOCK on records that must never disappear on a mis-tap — a customer-SIGNED
 *   contract, or a lien record whose preliminary notice has actually been served (that
 *   notice is the basis of lien rights). Void the contract / clear the record first, or
 *   cancel the job instead of deleting it.
 *   ITEMIZED CONFIRM for everything else: the first call returns what would be destroyed
 *   so the dialog can name it, and only a second call with confirmDestructive proceeds.
 */
export async function deleteJob(
  id: string,
  opts: { confirmDestructive?: boolean } = {},
): Promise<DeleteJobResult> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const headCount = (table: string, apply?: (q: any) => any) => {
    const q = supabase.from(table).select("id", { count: "exact", head: true }).eq("job_id", id);
    return apply ? apply(q) : q;
  };
  const [
    { count: signedContracts },
    { count: liveContracts },
    { data: lien },
    { count: claims },
    { count: billedMilestones },
    { count: milestones },
    { count: docs },
    { count: permits },
    { count: changeOrders },
  ] = await Promise.all([
    headCount("contracts", (q: any) => q.eq("status", "signed")),
    headCount("contracts", (q: any) => q.in("status", ["draft", "sent"])),
    supabase.from("lien_records").select("prelim_sent_at").eq("job_id", id).maybeSingle(),
    headCount("insurance_claims"),
    headCount("payment_milestones", (q: any) => q.eq("status", "billed")),
    headCount("payment_milestones"),
    headCount("documents"),
    headCount("permits"),
    headCount("change_orders"),
  ]);

  // ── Tier 1: legal records that a delete must never be able to take with it ──
  const prelimServed = !!(lien as { prelim_sent_at: string | null } | null)?.prelim_sent_at;
  const blockers: string[] = [];
  if (signedContracts) blockers.push("a contract the customer has signed");
  if (prelimServed) blockers.push("a served preliminary notice (your lien rights)");
  if (billedMilestones) blockers.push(`${billedMilestones} already-billed payment milestone${billedMilestones > 1 ? "s" : ""}`);
  if (blockers.length) {
    return {
      ok: false,
      error:
        `This job has ${blockers.join(" and ")}. Deleting it would destroy that permanently, ` +
        `with no undo. Void or unlink those records first — or set the job to cancelled instead of deleting it.`,
    };
  }

  // ── Tier 2: name what really goes, then require a second, informed confirm ──
  const destroys: string[] = [];
  if (liveContracts) destroys.push(`${liveContracts} contract${liveContracts > 1 ? "s" : ""}`);
  if (lien) destroys.push("the lien / preliminary-notice record");
  if (claims) destroys.push(`${claims} insurance claim${claims > 1 ? "s" : ""}`);
  if (milestones) destroys.push(`${milestones} payment milestone${milestones > 1 ? "s" : ""}`);
  if (docs) destroys.push(`${docs} document${docs > 1 ? "s" : ""} / photo${docs > 1 ? "s" : ""}`);
  if (permits) destroys.push(`${permits} permit${permits > 1 ? "s" : ""}`);
  if (changeOrders) destroys.push(`${changeOrders} change order${changeOrders > 1 ? "s" : ""}`);
  if (destroys.length && !opts.confirmDestructive) {
    return {
      ok: false,
      needsConfirm: true,
      destroys,
      error: `Deleting this job also permanently deletes ${destroys.join(", ")}.`,
    };
  }

  // BEFORE the row goes (it reads google_event_id off the row). Fire-safe.
  await deleteCalendarItem("job", id);
  const { error } = await supabase.from("jobs").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/jobs");
  revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
  revalidatePath("/schedule");
  return { ok: true };
}

/** Edit every job field in one place: details, address, schedule, customer
 *  (existing or created inline), and assigned staff. */
export async function updateJob(
  id: string,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Job name is required." };

  // Optionally create a customer inline (when none selected).
  let customerId = emptyToNull(formData.get("customer_id"));
  const newCustomerName = String(formData.get("new_customer_name") ?? "").trim();
  if (!customerId && newCustomerName) {
    const { data: cust, error: cErr } = await supabase
      .from("customers")
      .insert({
        name: newCustomerName,
        phone: emptyToNull(formData.get("new_customer_phone")),
        email: emptyToNull(formData.get("new_customer_email")),
        status: "active",
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (cErr) return { ok: false, error: cErr.message };
    customerId = cust.id;
  }

  const start = String(formData.get("scheduled_start") ?? "");
  const end = String(formData.get("scheduled_end") ?? "");
  const assigned = formData.getAll("assigned_to").map(String).filter(Boolean);

  // Scope the template to the caller's org — a job can't reference another org's template.
  const codeTemplatePatch = formData.has("code_template_id")
    ? { code_template_id: await visibleTemplateIdOrNull(supabase, emptyToNull(formData.get("code_template_id")) as string | null) }
    : {};

  // Old crew first — this writer also changes assigned_to, so newly ADDED members
  // get the same bell + "assigned" push as setJobCrew (the shared diff helper).
  const { data: prevJob } = await supabase
    .from("jobs")
    .select("assigned_to, org_id, job_number")
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase
    .from("jobs")
    .update({
      name,
      description: emptyToNull(formData.get("description")),
      customer_id: customerId,
      ...(formData.get("billing_type") != null ? { billing_type: String(formData.get("billing_type")) } : {}),
      ...codeTemplatePatch,
      address: emptyToNull(formData.get("address")),
      city: emptyToNull(formData.get("city")),
      state: emptyToNull(formData.get("state")),
      zip: emptyToNull(formData.get("zip")),
      scheduled_start: start ? new Date(start).toISOString() : null,
      scheduled_end: end ? new Date(end).toISOString() : null,
      assigned_to: assigned,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  if (prevJob) {
    const p = prevJob as { assigned_to: string[] | null; org_id: string | null; job_number: string | null };
    // Awaited (not `void`): serverless can drop an un-awaited promise after the action
    // returns. The helper never throws, so this can't break the job update.
    await notifyJobCrewAdded({ id, org_id: p.org_id, job_number: p.job_number, name }, p.assigned_to, assigned, ctx.userId);
  }

  // This writer touches name/address/schedule — keep Google current (fire-safe).
  await pushCalendarItem("job", id);

  revalidatePath(`/jobs/${id}`);
  revalidatePath("/jobs");
  revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
  revalidatePath("/schedule");
  return { ok: true };
}

export async function createBill(input: {
  job_id: string | null; // null = company overhead (no job)
  supplier: string;
  bill_number: string;
  amount: number;
  status: string;
  bill_date: string | null;
  notes: string;
  category?: string | null;
  /** The purchase order this bill pays (migration 0142). Setting it makes the bill
   *  SUPERSEDE that PO in every material-cost sum, so one delivery entered as both a
   *  PO and the supplier's invoice is costed and billed ONCE, at the invoiced amount. */
  po_id?: string | null;
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.supplier.trim()) return { ok: false, error: "Supplier is required." };

  // Drop a job_id the caller can't see (e.g. a crafted voice/registry call) — never
  // persist a cross-org job reference on a bill.
  const jobId = await visibleJobIdOrNull(supabase, input.job_id);
  // The PO link: keep it only when the PO is visible (RLS) AND on THIS bill's job — a bill
  // may only supersede a PO on its own job, or the supersede silently drops another job's
  // order from the cost rollup. A mismatched/foreign id is ignored (the bill still saves).
  const poId = await visiblePoIdOnJobOrNull(supabase, input.po_id ?? null, jobId);

  const { error } = await supabase.from("bills").insert({
    job_id: jobId,
    po_id: poId,
    supplier: input.supplier.trim(),
    bill_number: input.bill_number.trim() || null,
    amount: input.amount || 0,
    status: input.status || "unpaid",
    bill_date: input.bill_date || null,
    notes: input.notes.trim() || null,
    category: input.category ?? null,
    created_by: ctx.userId,
  });
  if (error) return { ok: false, error: error.message };
  if (input.job_id) revalidatePath(`/jobs/${input.job_id}`);
  revalidatePath("/bills");
  return { ok: true };
}

export async function updateBill(
  id: string,
  patch: {
    supplier?: string;
    bill_number?: string | null;
    amount?: number;
    status?: string;
    bill_date?: string | null;
    notes?: string | null;
    category?: string | null;
    job_id?: string | null;
    po_id?: string | null;
  },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const clean: Record<string, unknown> = {};
  if (patch.supplier !== undefined) {
    if (!patch.supplier.trim()) return { ok: false, error: "Supplier is required." };
    clean.supplier = patch.supplier.trim();
  }
  if (patch.bill_number !== undefined) clean.bill_number = patch.bill_number?.trim() || null;
  if (patch.amount !== undefined) clean.amount = patch.amount || 0;
  if (patch.status !== undefined) clean.status = patch.status;
  if (patch.bill_date !== undefined) clean.bill_date = patch.bill_date || null;
  if (patch.notes !== undefined) clean.notes = patch.notes?.trim() || null;
  if (patch.category !== undefined) clean.category = patch.category ?? null;
  if (patch.job_id !== undefined) clean.job_id = patch.job_id || null;

  // One stored-row read of the bill's current job — feeds BOTH the old-job revalidation (a
  // re-pointed bill's cost must leave its old job) AND the PO same-job check below. Read
  // whenever either needs it: a job move, or a PO link on a bill whose job isn't changing.
  let oldJobId: string | null = null;
  if (patch.job_id !== undefined || (patch.po_id !== undefined && !!patch.po_id)) {
    const { data: prev } = await supabase.from("bills").select("job_id").eq("id", id).maybeSingle();
    oldJobId = (prev as { job_id: string | null } | null)?.job_id ?? null;
  }

  // Linking/unlinking the PO this bill pays MOVES money: a linked PO stops being counted
  // (the bill supersedes it), an unlinked one starts counting again. The bill may only
  // supersede a PO on ITS OWN job — a cross-job link would silently cancel a DIFFERENT
  // job's order — so scope the check to the bill's TARGET job (the just-changed job when
  // this update moves it, else its stored job). A mismatch is ignored (clears the link).
  if (patch.po_id !== undefined) {
    const targetJob = patch.job_id !== undefined ? patch.job_id || null : oldJobId;
    clean.po_id = await visiblePoIdOnJobOrNull(supabase, patch.po_id || null, targetJob);
  }

  const { data, error } = await supabase.from("bills").update(clean).eq("id", id).select("job_id").maybeSingle();
  if (error) return { ok: false, error: error.message };
  for (const jid of new Set([oldJobId, (data as any)?.job_id].filter(Boolean) as string[])) revalidatePath(`/jobs/${jid}`);
  revalidatePath("/bills");
  revalidatePath("/analytics"); // bill cost moves job profitability
  return { ok: true };
}

export async function setBillStatus(
  id: string,
  status: string,
  jobId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("bills").update({ status }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function deleteBill(id: string, jobId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("bills").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function updateJobNotes(
  jobId: string,
  notes: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase
    .from("jobs")
    .update({ notes: notes.trim() || null })
    .eq("id", jobId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

/** Inline-edit the job's description (scope) right on the Overview tab. */
export async function updateJobDescription(
  jobId: string,
  description: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase
    .from("jobs")
    .update({ description: description.trim() || null })
    .eq("id", jobId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function addDocument(input: {
  job_id: string;
  name: string;
  category: string;
  file_url: string; // storage path within the 'documents' bucket
  size_bytes: number;
}): Promise<Result & { id?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data, error } = await supabase
    .from("documents")
    .insert({
      job_id: input.job_id,
      name: input.name,
      category: input.category || "Receipt",
      kind: "other",
      file_url: input.file_url,
      size_bytes: input.size_bytes || null,
      uploaded_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/jobs/${input.job_id}`);
  return { ok: true, id: data?.id };
}

/** Rename / re-categorize an already-uploaded document. Staff only; partial patch.
 *  RLS scopes the update to the caller's org, so a crafted id can't reach another
 *  org's document — mirrors updateBill's pattern. */
export async function updateDocument(
  id: string,
  patch: {
    name?: string;
    category?: string | null;
  },
  jobId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const clean: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) return { ok: false, error: "Name is required." };
    clean.name = patch.name.trim();
  }
  if (patch.category !== undefined) clean.category = patch.category ?? null;

  const { error } = await supabase.from("documents").update(clean).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function deleteDocument(
  id: string,
  path: string | null,
  jobId: string,
): Promise<Result> {
  const supabase = await createClient();
  // Remove the file then the row (best-effort on the file). Organize notes filed
  // to a job have NO file (file_url null) — skip storage for those, like /organize does.
  if (path) await supabase.storage.from("documents").remove([path]);
  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export type JobImportRow = {
  customer: string;
  job_name: string;
  value?: number;
  status?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  email?: string;
  phone?: string;
};
export type JobImportResult = { name: string; status: "created" | "failed"; reason?: string };

/** Bulk-import jobs from a roster (migration importer): find-or-create the customer,
 *  create the job, and record its contract value as an ACCEPTED quote so the job's
 *  Contract / Invoiced / Paid math works. Staff only; best-effort per row. */
export async function importJobs(
  rows: JobImportRow[],
): Promise<{ ok: boolean; error?: string; results?: JobImportResult[] }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, userId } = ctx;

  const results: JobImportResult[] = [];
  for (const r of (rows ?? []).slice(0, 200)) {
    const cname = (r.customer || "").trim();
    const jobName = (r.job_name || "").trim() || cname;
    if (!cname && !jobName) {
      results.push({ name: "(blank)", status: "failed", reason: "Missing customer and job name." });
      continue;
    }

    // Find-or-create the customer (match by name, narrowed by email when given) — RLS
    // already scopes this to the caller's org.
    let customerId: string | null = null;
    if (cname) {
      const email = (r.email || "").trim().toLowerCase();
      let q = supabase.from("customers").select("id").ilike("name", escapeLike(cname)).limit(1);
      if (email) q = q.ilike("email", escapeLike(email));
      const { data: hit } = await q.maybeSingle();
      if (hit) customerId = hit.id;
      else {
        const { data: nc, error: ce } = await supabase
          .from("customers")
          .insert({
            name: cname,
            email: r.email?.trim() || null,
            phone: r.phone?.trim() || null,
            address: r.address?.trim() || null,
            city: r.city?.trim() || null,
            state: r.state?.trim() || null,
            zip: r.zip?.trim() || null,
            status: "active",
            created_by: userId,
          })
          .select("id")
          .single();
        if (ce) {
          results.push({ name: jobName, status: "failed", reason: ce.message });
          continue;
        }
        customerId = nc.id;
      }
    }

    // Legacy CSV statuses from the old lifecycle: an "estimate" row is a job waiting to be
    // scheduled; an "invoiced" row is finished work (money owed lives in AR, not job status).
    // Anything else off-spine imports as in_progress.
    const rawStatus = (r.status || "").trim();
    const mapped = rawStatus === "estimate" ? "to_be_scheduled" : rawStatus === "invoiced" ? "complete" : rawStatus;
    const status = (JOB_STATUSES as readonly string[]).includes(mapped) ? mapped : "in_progress";
    const { data: job, error: je } = await supabase
      .from("jobs")
      .insert({
        name: jobName,
        customer_id: customerId,
        status,
        address: r.address?.trim() || null,
        city: r.city?.trim() || null,
        state: r.state?.trim() || null,
        zip: r.zip?.trim() || null,
        created_by: userId,
      })
      .select("id, job_number")
      .single();
    if (je) {
      results.push({ name: jobName, status: "failed", reason: je.message });
      continue;
    }

    // Contract value -> accepted quote + a single line item.
    const value = Number(r.value) || 0;
    let valueNote = "";
    if (value > 0) {
      const { data: quote, error: qe } = await supabase
        .from("quotes")
        .insert({
          job_id: job.id,
          customer_id: customerId,
          status: "accepted",
          title: "Imported contract",
          subtotal: value,
          tax: 0,
          total: value,
          created_by: userId,
        })
        .select("id")
        .single();
      if (quote) {
        await supabase
          .from("quote_line_items")
          .insert({ quote_id: quote.id, description: jobName || "Contract", quantity: 1, unit: "ea", unit_price: value, sort_order: 0 });
      } else if (qe) {
        // Job was created but the contract value didn't attach — flag it instead of
        // silently dropping the money.
        valueNote = " — value not saved, add it manually";
      }
    }
    results.push({ name: `${job.job_number} · ${jobName}${valueNote}`, status: "created" });
  }
  revalidatePath("/jobs");
  revalidatePath("/planner"); // a status/finish change moves a job on/off today's My Day
  revalidatePath("/crm");
  return { ok: true, results };
}
