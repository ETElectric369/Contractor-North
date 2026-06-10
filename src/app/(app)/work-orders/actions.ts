"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string; id?: string };

export async function createWorkOrder(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };

  const jobId = emptyToNull(formData.get("job_id"));
  const scheduled = String(formData.get("scheduled_for") ?? "");

  // Inherit the customer from the chosen job, if any.
  let customerId: string | null = null;
  if (jobId) {
    const { data: job } = await supabase
      .from("jobs")
      .select("customer_id")
      .eq("id", jobId)
      .maybeSingle();
    customerId = job?.customer_id ?? null;
  }

  const { data, error } = await supabase
    .from("work_orders")
    .insert({
      title,
      description: emptyToNull(formData.get("description")),
      job_id: jobId,
      customer_id: customerId,
      status: String(formData.get("status") ?? "draft"),
      assigned_to: emptyToNull(formData.get("assigned_to")),
      scheduled_for: scheduled ? new Date(scheduled).toISOString() : null,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/work-orders");
  return { ok: true, id: data.id };
}

/** Edit a work order's core fields; customer follows the linked job. */
export async function updateWorkOrder(id: string, formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };

  const jobId = emptyToNull(formData.get("job_id"));
  const scheduled = String(formData.get("scheduled_for") ?? "");

  let customerId: string | null = null;
  if (jobId) {
    const { data: job } = await supabase
      .from("jobs")
      .select("customer_id")
      .eq("id", jobId)
      .maybeSingle();
    customerId = job?.customer_id ?? null;
  }

  const { error } = await supabase
    .from("work_orders")
    .update({
      title,
      description: emptyToNull(formData.get("description")),
      job_id: jobId,
      customer_id: customerId,
      assigned_to: emptyToNull(formData.get("assigned_to")),
      scheduled_for: scheduled ? new Date(scheduled).toISOString() : null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/work-orders");
  revalidatePath(`/work-orders/${id}`);
  return { ok: true };
}

export async function deleteWorkOrder(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("work_orders").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/work-orders");
  return { ok: true };
}

export async function setWorkOrderStatus(
  id: string,
  status: string,
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("work_orders")
    .update({ status })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/work-orders");
  revalidatePath(`/work-orders/${id}`);
  return { ok: true };
}

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}
