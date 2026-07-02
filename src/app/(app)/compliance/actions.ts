"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string };

export interface ComplianceInput {
  type?: string;
  name: string;
  policy_number?: string | null;
  amount?: number;
  issued_date?: string | null;
  expires_date?: string | null;
  notes?: string | null;
  /** Storage path in the private "documents" bucket. Create-time only —
   *  updates go through setComplianceFile so a metadata edit can't wipe it. */
  file_url?: string | null;
}

function clean(input: ComplianceInput) {
  return {
    type: input.type?.trim() || "Insurance",
    name: input.name.trim(),
    policy_number: input.policy_number?.trim() || null,
    amount: Number.isFinite(input.amount) ? input.amount : 0,
    issued_date: input.issued_date || null,
    expires_date: input.expires_date || null,
    notes: input.notes?.trim() || null,
  };
}

function revalidate() {
  revalidatePath("/compliance");
  revalidatePath("/insurance");
}

export async function createCompliance(input: ComplianceInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.name?.trim()) return { ok: false, error: "Name is required." };
  const { error } = await supabase
    .from("compliance_items")
    .insert({ ...clean(input), file_url: input.file_url ?? null, created_by: ctx.userId });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function updateCompliance(id: string, input: ComplianceInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.name?.trim()) return { ok: false, error: "Name is required." };
  const { error } = await supabase.from("compliance_items").update(clean(input)).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

/** Attach/replace/remove the item's document. Replacing or removing also
 *  deletes the old storage object so the bucket doesn't collect orphans. */
export async function setComplianceFile(id: string, fileUrl: string | null): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: existing } = await supabase
    .from("compliance_items")
    .select("file_url")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "That item isn't available." };
  const { error } = await supabase.from("compliance_items").update({ file_url: fileUrl }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  if (existing.file_url && existing.file_url !== fileUrl) {
    await supabase.storage.from("documents").remove([existing.file_url]);
  }
  revalidate();
  return { ok: true };
}

export async function deleteCompliance(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: existing } = await supabase
    .from("compliance_items")
    .select("file_url")
    .eq("id", id)
    .maybeSingle();
  const { error } = await supabase.from("compliance_items").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  if (existing?.file_url) await supabase.storage.from("documents").remove([existing.file_url]);
  revalidate();
  return { ok: true };
}
