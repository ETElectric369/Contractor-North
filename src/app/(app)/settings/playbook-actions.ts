"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { parsePlaybook } from "@/lib/playbook/parse";
import { playbookStarter } from "@/lib/playbook/starters";
import { sheetFromPlaybook } from "@/lib/playbook/from-sheet";

type Result = { ok: true } | { ok: false; error: string };

type Staff =
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>> }
  | { ok: false; error: string };

async function staff(): Promise<Staff> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  const { data: me } = await supabase.from("profiles").select("role, org_id").eq("id", user.id).maybeSingle();
  const role = (me as { role?: string } | null)?.role;
  // A playbook is what every estimate for this company is built from. Editing it is an owner /
  // admin / office act, not a field one — and RLS scopes the write to the org regardless.
  if (!role || !["owner", "admin", "office"].includes(role))
    return { ok: false, error: "You don't have access to that." };
  return { ok: true, supabase };
}

/**
 * Write a playbook to a form.
 *
 * PARSED SERVER-SIDE BEFORE IT LANDS. The client sends a document; parsePlaybook is the same
 * tolerant boundary the reader uses, so a rule pointing at a deleted need or a select with no
 * options is resolved HERE, once, rather than becoming a question that can never be reached on a
 * phone in a crawlspace. Six of Chris's sheet rules could never match, and nobody found out for a
 * month.
 */
export async function savePlaybook(formId: string, needs: unknown): Promise<Result> {
  const ctx = await staff();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const pb = parsePlaybook({ needs });
  if (!pb.needs.length) return { ok: false, error: "A playbook needs at least one question." };

  // KEEP `schema` IN STEP. Anything still reading the old shape — the lint, an export, a reader
  // written before 0179 — must not go on describing a playbook that has moved on. The projection
  // drops what a sheet cannot say (open needs, second clauses), which is exactly what the sheet
  // could never say in the first place.
  const { error } = await ctx.supabase
    .from("forms")
    .update({ playbook: pb, schema: sheetFromPlaybook(pb) })
    .eq("id", formId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/appointments", "layout");
  return { ok: true };
}

/** Start from somebody's real playbook rather than a blank page. Overwrites — the caller confirms. */
export async function installPlaybookStarter(formId: string, starterKey: string): Promise<Result> {
  const ctx = await staff();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const pb = playbookStarter(starterKey);
  if (!pb) return { ok: false, error: "That starter doesn't exist." };
  return savePlaybook(formId, pb.needs);
}

/**
 * Drop the playbook and fall back to the sheet.
 *
 * The undo, and it is a real one rather than a promise of one — a way back is the difference
 * between trying something and committing to it.
 *
 * What you get back is the sheet, which savePlaybook has been keeping in step: every question that
 * has a control, its choices, its rules, in order. What it cannot hold is the part a sheet never
 * could — the open questions, the second conditions, and the whys — so this is a way back to a
 * SHEET, not a way back in time. The button says so.
 */
export async function clearPlaybook(formId: string): Promise<Result> {
  const ctx = await staff();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase.from("forms").update({ playbook: null }).eq("id", formId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/appointments", "layout");
  return { ok: true };
}
