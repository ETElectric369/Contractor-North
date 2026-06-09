"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string };

export async function addEmployeeDoc(input: {
  profile_id: string;
  type: string;
  name: string;
  file_url: string;
  expires_date?: string | null;
  notes?: string | null;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!input.profile_id) return { ok: false, error: "Pick an employee." };

  const { error } = await supabase.from("employee_documents").insert({
    profile_id: input.profile_id,
    type: input.type?.trim() || "Other",
    name: input.name.trim(),
    file_url: input.file_url,
    expires_date: input.expires_date || null,
    notes: input.notes?.trim() || null,
    uploaded_by: user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/employee-docs");
  return { ok: true };
}

export async function deleteEmployeeDoc(id: string, path: string): Promise<Result> {
  const supabase = await createClient();
  await supabase.storage.from("documents").remove([path]);
  const { error } = await supabase.from("employee_documents").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/employee-docs");
  return { ok: true };
}
