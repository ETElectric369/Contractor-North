"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string };

export async function addPettyCash(input: {
  tx_date?: string | null;
  kind: "expense" | "replenish";
  amount: number;
  category?: string | null;
  description?: string | null;
  job_id?: string | null;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!input.amount || input.amount <= 0) return { ok: false, error: "Enter an amount." };

  const { error } = await supabase.from("petty_cash").insert({
    tx_date: input.tx_date || new Date().toISOString().slice(0, 10),
    kind: input.kind === "replenish" ? "replenish" : "expense",
    amount: input.amount,
    category: input.category?.trim() || null,
    description: input.description?.trim() || null,
    job_id: input.job_id || null,
    created_by: user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/petty-cash");
  return { ok: true };
}

export async function deletePettyCash(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("petty_cash").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/petty-cash");
  return { ok: true };
}
