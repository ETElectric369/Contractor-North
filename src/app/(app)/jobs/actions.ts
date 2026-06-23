"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { emptyToNull } from "@/lib/forms";
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
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const supabase = await createClient();

  const { data: quote } = await supabase
    .from("quotes")
    .select("id")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (quote) {
    const res = await createInvoiceFromQuote(quote.id);
    return res;
  }

  const { data: job } = await supabase
    .from("jobs")
    .select("customer_id, name")
    .eq("id", jobId)
    .maybeSingle();
  return createBlankInvoice({
    customer_id: job?.customer_id ?? null,
    job_id: jobId, // keep the job link so the invoice can pull Labor/Materials
    title: job?.name ?? "",
    tax_rate: 0,
  });
}

/** Finish a job: mark complete and auto-build a draft invoice — from the
 *  job's quote when there is one, optionally pulling labor from timecards
 *  and materials from POs/bills. Returns the invoice id for review. */
export async function finishJob(
  jobId: string,
  opts: { importLabor: boolean; importCosts: boolean; sendInvoice?: boolean },
): Promise<{ ok: boolean; error?: string; id?: string; sent?: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // A draw-billed job is finished with a Final draw, not a standard invoice. Mark it
  // complete without creating a conflicting standard invoice (H4), and hand back the
  // latest draw so the UI lands on the job's billing instead of a dead-end.
  const { data: draws } = await supabase
    .from("invoices")
    .select("id")
    .eq("job_id", jobId)
    .neq("status", "void")
    .in("invoice_kind", ["deposit", "progress", "final"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (draws && draws.length) {
    const { error } = await supabase.from("jobs").update({ status: "complete" }).eq("id", jobId);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
    return { ok: true, id: draws[0].id };
  }

  const inv = await createInvoiceForJob(jobId);
  if (!inv.ok || !inv.id) return { ok: false, error: inv.error ?? "Could not create the invoice." };

  // Best-effort imports — "nothing to import" shouldn't block finishing.
  if (opts.importLabor) await importLaborIntoInvoice(inv.id);
  if (opts.importCosts) await importCostsIntoInvoice(inv.id);

  const { error } = await supabase.from("jobs").update({ status: "complete" }).eq("id", jobId);
  if (error) return { ok: false, error: error.message };

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
  revalidatePath("/billing");
  return { ok: true, id: inv.id, sent };
}

/** Delete a job after warning about linked records (quotes/invoices keep
 *  their data; their job link is cleared by FK rules). */
export async function deleteJob(id: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.from("jobs").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/jobs");
  revalidatePath("/schedule");
  return { ok: true };
}

/** Edit every job field in one place: details, address, schedule, customer
 *  (existing or created inline), and assigned staff. */
export async function updateJob(
  id: string,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

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
        created_by: user.id,
      })
      .select("id")
      .single();
    if (cErr) return { ok: false, error: cErr.message };
    customerId = cust.id;
  }

  const start = String(formData.get("scheduled_start") ?? "");
  const end = String(formData.get("scheduled_end") ?? "");
  const assigned = formData.getAll("assigned_to").map(String).filter(Boolean);

  const { error } = await supabase
    .from("jobs")
    .update({
      name,
      description: emptyToNull(formData.get("description")),
      customer_id: customerId,
      ...(formData.get("billing_type") != null ? { billing_type: String(formData.get("billing_type")) } : {}),
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

  revalidatePath(`/jobs/${id}`);
  revalidatePath("/jobs");
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
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!input.supplier.trim()) return { ok: false, error: "Supplier is required." };

  const { error } = await supabase.from("bills").insert({
    job_id: input.job_id || null,
    supplier: input.supplier.trim(),
    bill_number: input.bill_number.trim() || null,
    amount: input.amount || 0,
    status: input.status || "unpaid",
    bill_date: input.bill_date || null,
    notes: input.notes.trim() || null,
    category: input.category ?? null,
    created_by: user.id,
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
  },
): Promise<Result> {
  const supabase = await createClient();
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

  const { data, error } = await supabase.from("bills").update(clean).eq("id", id).select("job_id").maybeSingle();
  if (error) return { ok: false, error: error.message };
  if ((data as any)?.job_id) revalidatePath(`/jobs/${(data as any).job_id}`);
  revalidatePath("/bills");
  return { ok: true };
}

export async function setBillStatus(
  id: string,
  status: string,
  jobId: string,
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("bills").update({ status }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function deleteBill(id: string, jobId: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("bills").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function updateJobNotes(
  jobId: string,
  notes: string,
): Promise<Result> {
  const supabase = await createClient();
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
  const supabase = await createClient();
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

export async function deleteDocument(
  id: string,
  path: string,
  jobId: string,
): Promise<Result> {
  const supabase = await createClient();
  // Remove the file then the row (best-effort on the file).
  await supabase.storage.from("documents").remove([path]);
  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}
