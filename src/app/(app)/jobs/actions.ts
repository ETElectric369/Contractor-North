"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createInvoiceFromQuote, createBlankInvoice } from "../billing/actions";

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
    title: job?.name ?? "",
    tax_rate: 0,
  });
}

export async function addDocument(input: {
  job_id: string;
  name: string;
  category: string;
  file_url: string; // storage path within the 'documents' bucket
  size_bytes: number;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { error } = await supabase.from("documents").insert({
    job_id: input.job_id,
    name: input.name,
    category: input.category || "Receipt",
    kind: "other",
    file_url: input.file_url,
    size_bytes: input.size_bytes || null,
    uploaded_by: user.id,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/jobs/${input.job_id}`);
  return { ok: true };
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
