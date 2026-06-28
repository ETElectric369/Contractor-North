"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";

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

export async function updateEmployeeDoc(
  id: string,
  input: {
    type: string;
    name: string;
    expires_date?: string | null;
    notes?: string | null;
    profile_id: string;
  },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!id) return { ok: false, error: "Missing document." };
  if (!input.profile_id) return { ok: false, error: "Pick an employee." };
  if (!input.name?.trim()) return { ok: false, error: "Name is required." };

  // Org-safe: confirm the target employee is visible to this caller (RLS-scoped)
  // before re-assigning the doc to them.
  const { data: visibleEmp } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", input.profile_id)
    .maybeSingle();
  if (!visibleEmp) return { ok: false, error: "Employee not found." };

  // Metadata/assignment only — file_url is intentionally never touched here.
  const { error } = await supabase
    .from("employee_documents")
    .update({
      profile_id: input.profile_id,
      type: input.type?.trim() || "Other",
      name: input.name.trim(),
      expires_date: input.expires_date || null,
      notes: input.notes?.trim() || null,
    })
    .eq("id", id);
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
