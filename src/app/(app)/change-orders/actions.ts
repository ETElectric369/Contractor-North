"use server";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string; id?: string };

export async function createChangeOrder(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const description = String(formData.get("description") ?? "").trim();
  if (!description) return { ok: false, error: "Description is required." };

  const { data, error } = await supabase
    .from("change_orders")
    .insert({
      description,
      amount: Number(formData.get("amount")) || 0,
      job_id: emptyToNull(formData.get("job_id")),
      status: "pending",
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };
  revalidatePath("/change-orders");
  return { ok: true, id: data.id };
}

// PATCH semantics: only the fields present in the FormData are written — an absent key
// never touches its column (it used to zero the AMOUNT and unlink the job when a caller
// didn't repeat them). The edit form submits every field, so the UI is unchanged.
export async function updateChangeOrder(id: string, formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const clean: Record<string, unknown> = {};
  if (formData.has("description")) {
    const description = String(formData.get("description") ?? "").trim();
    if (!description) return { ok: false, error: "Description is required." };
    clean.description = description;
  }
  if (formData.has("amount")) clean.amount = Number(formData.get("amount")) || 0;
  if (formData.has("job_id")) clean.job_id = emptyToNull(formData.get("job_id"));
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };

  const { error } = await supabase.from("change_orders").update(clean).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/change-orders");
  return { ok: true };
}

export async function deleteChangeOrder(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("change_orders").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/change-orders");
  return { ok: true };
}

export async function setChangeOrderStatus(
  id: string,
  status: string,
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("change_orders")
    .update({ status })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/change-orders");
  return { ok: true };
}

