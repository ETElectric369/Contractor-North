"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string; id?: string };

export async function createJob(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Job name is required." };

  const start = String(formData.get("scheduled_start") ?? "");

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      name,
      customer_id: emptyToNull(formData.get("customer_id")),
      description: emptyToNull(formData.get("description")),
      status: String(formData.get("status") ?? "estimate"),
      address: emptyToNull(formData.get("address")),
      scheduled_start: start ? new Date(start).toISOString() : null,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/schedule");
  return { ok: true, id: data.id };
}

export async function setJobStatus(id: string, status: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("jobs").update({ status }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  return { ok: true };
}

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}
