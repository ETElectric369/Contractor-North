"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string; id?: string };

export type FieldType = "text" | "textarea" | "checkbox" | "number" | "select";

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
}

function slug(label: string, idx: number) {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || `field_${idx}`;
}

export async function createForm(input: {
  name: string;
  description: string;
  fields: { label: string; type: FieldType; options?: string }[];
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Form name is required." };

  const schema: FormField[] = input.fields
    .filter((f) => f.label.trim())
    .map((f, i) => ({
      key: slug(f.label, i),
      label: f.label.trim(),
      type: f.type,
      ...(f.type === "select" && f.options
        ? { options: f.options.split(",").map((o) => o.trim()).filter(Boolean) }
        : {}),
    }));

  if (schema.length === 0)
    return { ok: false, error: "Add at least one field." };

  const { data, error } = await supabase
    .from("forms")
    .insert({
      name,
      description: input.description.trim() || null,
      schema,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };
  revalidatePath("/forms");
  return { ok: true, id: data.id };
}

export async function submitForm(input: {
  form_id: string;
  job_id: string | null;
  data: Record<string, unknown>;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data, error } = await supabase
    .from("form_submissions")
    .insert({
      form_id: input.form_id,
      job_id: input.job_id,
      data: input.data,
      submitted_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/forms/${input.form_id}`);
  return { ok: true, id: data.id };
}

export async function deleteFormSubmission(
  id: string,
  formId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // Scope the delete to a submission that belongs to the form being viewed.
  // RLS already isolates by org; this matches it to formId so a stray id
  // can't be deleted out from under a different form's view.
  const { error } = await supabase
    .from("form_submissions")
    .delete()
    .eq("id", id)
    .eq("form_id", formId);

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/forms/${formId}`);
  return { ok: true };
}

export async function deleteForm(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("forms")
    .update({ active: false })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/forms");
  return { ok: true };
}
