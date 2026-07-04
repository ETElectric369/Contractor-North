"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string };

export async function addPettyCash(input: {
  tx_date?: string | null;
  kind: "expense" | "replenish";
  amount: number;
  category?: string | null;
  description?: string | null;
  job_id?: string | null;
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.amount || input.amount <= 0) return { ok: false, error: "Enter an amount." };

  const { error } = await supabase.from("petty_cash").insert({
    tx_date: input.tx_date || new Date().toISOString().slice(0, 10),
    kind: input.kind === "replenish" ? "replenish" : "expense",
    amount: input.amount,
    category: input.category?.trim() || null,
    description: input.description?.trim() || null,
    job_id: input.job_id || null,
    created_by: ctx.userId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/petty-cash");
  return { ok: true };
}

export async function updatePettyCash(
  id: string,
  patch: {
    tx_date?: string | null;
    kind: "expense" | "replenish";
    amount: number;
    category?: string | null;
    description?: string | null;
  },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!patch.amount || patch.amount <= 0) return { ok: false, error: "Enter an amount." };

  const { error } = await supabase
    .from("petty_cash")
    .update({
      tx_date: patch.tx_date || new Date().toISOString().slice(0, 10),
      kind: patch.kind === "replenish" ? "replenish" : "expense",
      amount: patch.amount,
      category: patch.category?.trim() || null,
      description: patch.description?.trim() || null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/petty-cash");
  return { ok: true };
}

export async function deletePettyCash(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("petty_cash").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/petty-cash");
  return { ok: true };
}
