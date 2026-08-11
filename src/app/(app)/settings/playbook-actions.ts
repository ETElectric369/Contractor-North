"use server";

import { revalidatePath } from "next/cache";
import { stampNeeds } from "@/lib/playbook/stamp";
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
/**
 * A FINGERPRINT OF WHAT THE EDITOR LOADED, so two people cannot silently overwrite each other.
 *
 * Erik and Andrew were both in Vivian Builders' intake playbook at the same time. I wrote his two
 * changes and verified them in a live browser; Andrew then pressed Save on a page that had loaded
 * BEFORE that write, and his stale copy went straight over the top. No error, no warning, nothing
 * in either UI — the whole exchange looked successful to both of us, and the questions simply
 * reverted. That is the silent-write law wearing a different hat: the row updated fine, it just
 * updated to the wrong thing.
 *
 * Deliberately a hash of the CONTENT rather than a version column: no migration, and it compares
 * the only thing that actually matters — is the playbook still what you were editing.
 */
function playbookStamp(v: unknown): string {
  const s = JSON.stringify(parsePlaybook(v).needs ?? []);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return String(h);
}

export async function savePlaybook(
  formId: string,
  needs: unknown,
  /** playbookStamp() of what the editor opened. Omitted = an old client; save as before rather
   *  than refuse, because a deploy must never lock somebody out of their own questions. */
  baseStamp?: string,
): Promise<Result> {
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

  // SOMEBODY ELSE CHANGED IT WHILE YOU HAD IT OPEN. Refuse rather than clobber: their work is
  // already saved and yours is still on your screen, which is the recoverable order of those two.
  if (baseStamp !== undefined && stampNeeds(parsePlaybook((before as { playbook?: unknown } | null)?.playbook).needs) !== baseStamp)
    return {
      ok: false,
      error: "Someone else changed these questions while you had them open. Reload the page to see their version, then make your change again.",
    };

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

  // REGENERATE THE MIRROR BEFORE DROPPING THE PLAYBOOK (cn-v700).
  //
  // This wrote `{ playbook: null }` and nothing else, so the form landed on whatever `schema`
  // happened to be stored — and that row can be MONTHS old. Vivian Builders' site inspection has
  // eight `multi: true` needs in its playbook and zero in its stored schema, because that schema
  // was last written before cn-v698 taught sheetFromPlaybook to carry `multi`. Clearing it would
  // have turned eight pick-any questions into pick-one, and coerceNeed then keeps only the first
  // element of every stored array answer.
  //
  // Rebuilding the mirror from the CURRENT playbook first means the way back is the closed half
  // of the questions you have now, which is what the doc-comment above always claimed it was.
  // It does NOT rescue file or scopes needs — a sheet has no shape for those — which is why the
  // button now names what it is about to delete before it does it.
  const { data: before } = await ctx.supabase.from("forms").select("playbook").eq("id", formId).maybeSingle();
  const current = parsePlaybook((before as { playbook?: unknown } | null)?.playbook);

  const { data: wrote, error } = await ctx.supabase
    .from("forms")
    .update(current.needs.length ? { playbook: null, schema: sheetFromPlaybook(current) } : { playbook: null })
    .eq("id", formId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!wrote?.length) return { ok: false, error: "That didn't save — check your access and try again." };
  revalidatePath("/settings");
  revalidatePath("/appointments", "layout");
  return { ok: true };
}
