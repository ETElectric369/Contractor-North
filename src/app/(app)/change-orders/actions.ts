"use server";

import { revalidatePath } from "next/cache";
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

export async function updateChangeOrder(id: string, formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return { ok: false, error: "Description is required." };

  const { error } = await supabase
    .from("change_orders")
    .update({
      description,
      amount: Number(formData.get("amount")) || 0,
      job_id: emptyToNull(formData.get("job_id")),
    })
    .eq("id", id);
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

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}
