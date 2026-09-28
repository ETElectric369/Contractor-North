"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { formatPhone } from "@/lib/utils";
import { SUPPLIERS_LIVE_IN_VENDORS, isSupplierCategory } from "./categories";

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

// Staff only, said in words (Wave 0): RLS `resources_write` needs is_org_staff, so a tech's save
// came back as a raw policy error, and a tech's Edit or Delete changed nothing and said "Contact
// deleted". Every write reads its rows back, because a zero-row UPDATE is a 204.
// SUPPLIERS AND SUBCONTRACTORS LIVE IN PRICE LIST › VENDORS (W2-13): a new contact can't be one
// (the form's list doesn't offer it, and Nort's free-text category is refused here in the form's
// words). A contact that already is one keeps its category through an edit: nothing is changed on it
// behind anyone's back.
export async function createResource(input: ResourceInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!input.name?.trim()) return { ok: false, error: "Name is required." };
  const row = clean(input);
  if (isSupplierCategory(row.category)) return { ok: false, error: SUPPLIERS_LIVE_IN_VENDORS };
  const { data, error } = await ctx.supabase.from("resources").insert(row).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That contact didn't save. Try again." };
  revalidatePath("/resources");
  return { ok: true };
}

export async function updateResource(id: string, input: ResourceInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!input.name?.trim()) return { ok: false, error: "Name is required." };
  const row = clean(input);
  if (isSupplierCategory(row.category)) {
    // Only a row that already has this category may keep it.
    let read = ctx.supabase.from("resources").select("category").eq("id", id);
    if (ctx.orgId) read = read.eq("org_id", ctx.orgId);
    const { data: was, error: wasErr } = await read.maybeSingle();
    if (wasErr) return { ok: false, error: dbError(wasErr) };
    if (!was) return { ok: false, error: "That contact wasn't found, so nothing changed." };
    if (String((was as { category?: string | null }).category ?? "").trim() !== row.category) return { ok: false, error: SUPPLIERS_LIVE_IN_VENDORS };
  }
  const { data, error } = await ctx.supabase.from("resources").update(row).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That contact wasn't found, so nothing changed." };
  revalidatePath("/resources");
  return { ok: true };
}

export async function deleteResource(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data, error } = await ctx.supabase.from("resources").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That contact wasn't found, so nothing was deleted." };
  revalidatePath("/resources");
  return { ok: true };
}
