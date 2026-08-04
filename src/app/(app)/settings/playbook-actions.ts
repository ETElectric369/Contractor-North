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

  // THE FIRST SAVE MUST NOT EAT THE SHEET SOMEBODY AUTHORED BY HAND.
  //
  // This wrote `{playbook, schema: sheetFromPlaybook(pb)}` in one statement, and nothing anywhere
  // keeps a copy of the old schema — there is no history table on `forms`. So Chris opening
  // Settings → Playbook on TAHOE DECK's hand-built deck sheet and pressing "Start from: Electrical"
  // out of curiosity destroyed it permanently, and "Back to the plain sheet" then handed him
  // Erik's electrical questions as though they were his.
  //
  // So: keep `schema` in step ONLY once this form is already playbook-backed (its schema is
  // by then a projection of the playbook, and letting it drift would leave every pre-0179 reader
  // describing questions that have moved on). While `playbook` is still null, the schema is the
  // original and it is left exactly where it is — which is what makes clearPlaybook a real way
  // back rather than a promise of one.
  const { data: before } = await ctx.supabase.from("forms").select("playbook").eq("id", formId).maybeSingle();
  const alreadyPlaybook = parsePlaybook((before as { playbook?: unknown } | null)?.playbook).needs.length > 0;

  const { data: wrote, error } = await ctx.supabase
    .from("forms")
    .update(alreadyPlaybook ? { playbook: pb, schema: sheetFromPlaybook(pb) } : { playbook: pb })
    .eq("id", formId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  // A zero-row update is a 204, not an error — never let a blocked write report success.
  if (!wrote?.length) return { ok: false, error: "That didn't save — check your access and try again." };
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
 * What you get back is the sheet this form had BEFORE it became a playbook — savePlaybook leaves
 * the original alone until a playbook already exists, precisely so this button has something real
 * to return to. Once the form is playbook-backed the schema tracks it, so from then on you get the
 * closed half of your own playbook: every question that has a control, its choices, its rules, in
 * order. What a sheet can never hold is the open questions, the second conditions, and the whys —
 * so this is a way back to a SHEET, not a way back in time. The button says so.
 */
export async function clearPlaybook(formId: string): Promise<Result> {
  const ctx = await staff();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { data: wrote, error } = await ctx.supabase
    .from("forms")
    .update({ playbook: null })
    .eq("id", formId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!wrote?.length) return { ok: false, error: "That didn't save — check your access and try again." };
  revalidatePath("/settings");
  revalidatePath("/appointments", "layout");
  return { ok: true };
}
