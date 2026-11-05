import { dbError } from "@/lib/db-error";
import { isDrawKind } from "@/lib/invoice-math";
import type { AlreadyInvoicedTarget } from "./types";

/**
 * ALREADY INVOICED (the owner, 2026-11-04: June estimates asked for a day on a job long finished and
 * billed). The bill exists; the app just can't see it tie to the work. This door says which invoice
 * it was, and writes ONE real fact so the one settled rule (quoteSettled, and 0403's
 * needs_you_done_not_billed) can see it from then on:
 *
 *   an estimate      the invoice names it: invoices.quote_id (only when it names none yet).
 *   a job            the invoice is put on the job (invoices.job_id, when it is on none); when it
 *                    already bills ANOTHER job, it names this job's estimate instead (quote_id, when
 *                    it names none) — the fact 0403 reads for a job billed on another job's invoice.
 *   a visit          on a job: the job's rule. On no job: the invoice is anchored to the visit
 *                    (invoices.appointment_id); an unpaid one leaves the row as Billed, Not Paid.
 *
 * Nothing else on the invoice moves (no dollar, no status, no line). Every read and write carries the
 * company's org_id (three companies share one database), every write is guarded on the field still
 * being empty and read back (.select("id"), the silent-write law), and a refusal names one action.
 */

type Db = any;

export type InvoiceChoice = {
  id: string;
  number: string | null;
  total: number;
  status: string;
  createdAt: string | null;
  jobWords: string | null;
};

export type AlreadyInvoicedLoad =
  | { ok: true; what: string; customer: string | null; choices: InvoiceChoice[] }
  | { ok: false; error: string };

export type AlreadyInvoicedTie = { ok: true; message: string } | { ok: false; error: string };

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const jobLine = (j: { job_number?: string | null; name?: string | null } | null) => (j ? [j.job_number, j.name].filter(Boolean).join(" · ") || null : null);

type Ctx = { what: string; customerId: string | null; customer: string | null; jobId: string | null; quoteId: string | null; visitId: string | null };

/** What the row's record is: its words, its customer, its job, and which fact a tie writes. */
async function readTarget(db: Db, orgId: string, t: AlreadyInvoicedTarget): Promise<Ctx | { error: string }> {
  if (t.kind === "quote") {
    const { data, error } = await db.from("quotes").select("id, quote_number, job_id, customer_id, customers(name)").eq("org_id", orgId).eq("id", t.id).maybeSingle();
    if (error) return { error: dbError(error) };
    if (!data) return { error: "That estimate isn't here any more. Reload Needs You." };
    return { what: data.quote_number || "This estimate", customerId: data.customer_id ?? null, customer: one(data.customers as any)?.name ?? null, jobId: data.job_id ?? null, quoteId: String(data.id), visitId: null };
  }
  if (t.kind === "job") {
    const { data, error } = await db.from("jobs").select("id, job_number, name, customer_id, customers(name)").eq("org_id", orgId).eq("id", t.id).maybeSingle();
    if (error) return { error: dbError(error) };
    if (!data) return { error: "That job isn't here any more. Reload Needs You." };
    return { what: jobLine(data) ?? "This job", customerId: data.customer_id ?? null, customer: one(data.customers as any)?.name ?? null, jobId: String(data.id), quoteId: null, visitId: null };
  }
  const { data, error } = await db.from("appointments").select("id, title, job_id, customer_id, customers(name)").eq("org_id", orgId).eq("id", t.id).maybeSingle();
  if (error) return { error: dbError(error) };
  if (!data) return { error: "That visit isn't here any more. Reload Needs You." };
  return { what: data.title || "This visit", customerId: data.customer_id ?? null, customer: one(data.customers as any)?.name ?? null, jobId: data.job_id ?? null, quoteId: null, visitId: String(data.id) };
}

/** The customer's live invoices (sent or later: a draft or a void bills nothing; a deposit or progress
 *  draw settles nothing), newest first. */
export async function loadAlreadyInvoiced(db: Db, orgId: string, t: AlreadyInvoicedTarget): Promise<AlreadyInvoicedLoad> {
  const ctx = await readTarget(db, orgId, t);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  let q = db
    .from("invoices")
    .select("id, invoice_number, total, status, invoice_kind, created_at, jobs:job_id(job_number, name)")
    .eq("org_id", orgId)
    .not("status", "in", "(draft,void)")
    .order("created_at", { ascending: false })
    .limit(25);
  if (ctx.customerId) q = q.eq("customer_id", ctx.customerId);
  const { data, error } = await q;
  if (error) return { ok: false, error: dbError(error) };
  // A deposit or progress draw is never offered: the tie refuses it (no dead-end choice).
  const choices: InvoiceChoice[] = ((data ?? []) as any[]).filter((r) => !isDrawKind(r.invoice_kind) || r.invoice_kind === "final").map((r) => ({
    id: String(r.id),
    number: r.invoice_number ?? null,
    total: Number(r.total ?? 0),
    status: String(r.status ?? ""),
    createdAt: r.created_at ?? null,
    jobWords: jobLine(one(r.jobs as any)),
  }));
  return { ok: true, what: ctx.what, customer: ctx.customer, choices };
}

/** One guarded write: `field` set on the invoice only while it is still empty, read back. */
async function setWhileEmpty(db: Db, orgId: string, invoiceId: string, field: "quote_id" | "job_id" | "appointment_id", value: string): Promise<string | null> {
  const { data, error } = await db.from("invoices").update({ [field]: value }).eq("org_id", orgId).eq("id", invoiceId).is(field, null).select("id");
  if (error) return dbError(error);
  if (!data?.length) return "That invoice changed while you were looking. Reload Needs You and pick it again.";
  return null;
}

/** The estimate a job was won on: its newest accepted one, else its newest sent one. */
async function jobQuote(db: Db, orgId: string, jobId: string): Promise<{ id: string; number: string | null } | null> {
  const { data } = await db.from("quotes").select("id, quote_number, status, created_at").eq("org_id", orgId).eq("job_id", jobId).in("status", ["accepted", "sent"]).order("created_at", { ascending: false }).limit(10);
  const rows = (data ?? []) as { id: string; quote_number: string | null; status: string }[];
  const pick = rows.find((r) => r.status === "accepted") ?? rows[0] ?? null;
  return pick ? { id: String(pick.id), number: pick.quote_number ?? null } : null;
}

export async function tieAlreadyInvoiced(db: Db, orgId: string, t: AlreadyInvoicedTarget, invoiceId: string): Promise<AlreadyInvoicedTie> {
  if (!invoiceId) return { ok: false, error: "Pick the invoice that billed it. Nothing was changed." };
  const ctx = await readTarget(db, orgId, t);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data: inv, error } = await db
    .from("invoices")
    .select("id, invoice_number, status, invoice_kind, job_id, quote_id, appointment_id")
    .eq("org_id", orgId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) return { ok: false, error: dbError(error) };
  if (!inv) return { ok: false, error: "That invoice isn't here any more. Reload Needs You and pick another." };
  if (inv.status === "draft" || inv.status === "void") return { ok: false, error: "A draft or a void bills nothing. Pick a sent invoice." };
  const num = inv.invoice_number || "That invoice";
  // A deposit or a progress draw is money for work still ahead: it never settles the work (quoteSettled's
  // rule), so tying one would write a fact that changes nothing. A final draw finishes it and ties.
  if (isDrawKind(inv.invoice_kind) && inv.invoice_kind !== "final") {
    return { ok: false, error: `${num} is a ${inv.invoice_kind === "deposit" ? "deposit" : "progress draw"}: money for work still ahead, so it doesn't settle this. Pick the invoice that billed the finished work. Nothing was changed.` };
  }

  // An estimate: the invoice names it.
  if (ctx.quoteId) {
    if (inv.quote_id && String(inv.quote_id) === ctx.quoteId) return { ok: true, message: `${num} already names ${ctx.what}. It stops asking.` };
    if (inv.quote_id) return { ok: false, error: `${num} already names another estimate. Pick another invoice, or change it on ${num}'s own page.` };
    const err = await setWhileEmpty(db, orgId, inv.id, "quote_id", ctx.quoteId);
    return err ? { ok: false, error: err } : { ok: true, message: `${num} now names ${ctx.what}, so it stops asking. Nothing on ${num} changed but that.` };
  }

  // Done work on a job (a finished job, or a visit on one).
  if (ctx.jobId) {
    if (inv.job_id && String(inv.job_id) === ctx.jobId) return { ok: true, message: `${num} is already on this job. It stops asking.` };
    if (!inv.job_id) {
      const err = await setWhileEmpty(db, orgId, inv.id, "job_id", ctx.jobId);
      return err ? { ok: false, error: err } : { ok: true, message: `${num} is now on this job, so it stops asking. Nothing on ${num} changed but that.` };
    }
    // It bills another job: it names this job's estimate (the fact 0403 reads), never moves.
    const quote = await jobQuote(db, orgId, ctx.jobId);
    if (!quote) return { ok: false, error: `${num} bills another job and this job has no estimate to name. Open ${num} and put it on this job.` };
    if (inv.quote_id && String(inv.quote_id) === quote.id) return { ok: true, message: `${num} already names ${quote.number ?? "this job's estimate"}. It stops asking.` };
    if (inv.quote_id) return { ok: false, error: `${num} bills another job and names another estimate. Open ${num} and put it on this job.` };
    const err = await setWhileEmpty(db, orgId, inv.id, "quote_id", quote.id);
    return err
      ? { ok: false, error: err }
      : { ok: true, message: `${num} now names ${quote.number ?? "this job's estimate"}, so this job stops asking. It still bills the job it was on.` };
  }

  // A visit on no job: the invoice is anchored to it.
  if (ctx.visitId) {
    if (inv.appointment_id && String(inv.appointment_id) === ctx.visitId) return { ok: true, message: `${num} is already this visit's bill.` };
    if (inv.appointment_id) return { ok: false, error: `${num} is another visit's bill. Pick another invoice.` };
    const err = await setWhileEmpty(db, orgId, inv.id, "appointment_id", ctx.visitId);
    return err
      ? { ok: false, error: err }
      : { ok: true, message: `${num} is now this visit's bill. Until it is paid the visit reads Billed, Not Paid.` };
  }
  return { ok: false, error: "Couldn't tell what this was for. Nothing was changed." };
}
