"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string };

export interface ComplianceInput {
  type?: string;
  name: string;
  policy_number?: string | null;
  amount?: number;
  issued_date?: string | null;
  expires_date?: string | null;
  notes?: string | null;
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

export async function createCompliance(input: ComplianceInput): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!input.name?.trim()) return { ok: false, error: "Name is required." };
  const { error } = await supabase
    .from("compliance_items")
    .insert({ ...clean(input), created_by: user.id });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/compliance");
  return { ok: true };
}

export async function updateCompliance(id: string, input: ComplianceInput): Promise<Result> {
  const supabase = await createClient();
  if (!input.name?.trim()) return { ok: false, error: "Name is required." };
  const { error } = await supabase.from("compliance_items").update(clean(input)).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/compliance");
  return { ok: true };
}

export async function deleteCompliance(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("compliance_items").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/compliance");
  return { ok: true };
}
