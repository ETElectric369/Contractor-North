"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { formatPhone } from "@/lib/utils";

export type Result = { ok: boolean; error?: string };

export interface ResourceInput {
  name: string;
  category?: string;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  notes?: string | null;
}

function clean(input: ResourceInput) {
  return {
    name: input.name.trim(),
    category: input.category?.trim() || "Other",
    contact_name: input.contact_name?.trim() || null,
    phone: input.phone ? formatPhone(input.phone) : null,
    email: input.email?.trim() || null,
    website: input.website?.trim() || null,
    address: input.address?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

export async function createResource(input: ResourceInput): Promise<Result> {
  const supabase = await createClient();
  if (!input.name?.trim()) return { ok: false, error: "Name is required." };
  const { error } = await supabase.from("resources").insert(clean(input));
  if (error) return { ok: false, error: error.message };
  revalidatePath("/resources");
  return { ok: true };
}

export async function updateResource(id: string, input: ResourceInput): Promise<Result> {
  const supabase = await createClient();
  if (!input.name?.trim()) return { ok: false, error: "Name is required." };
  const { error } = await supabase.from("resources").update(clean(input)).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/resources");
  return { ok: true };
}

export async function deleteResource(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("resources").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/resources");
  return { ok: true };
}
