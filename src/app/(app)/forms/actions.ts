"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { slugifyFieldKey } from "@/lib/form-field-key";
import { getOrgSettings } from "@/lib/org-settings";
import { starterSchemaJson, starterSheet, starterTradeFor } from "@/lib/inspection/starter-sheets";
import { severeSheetProblems } from "@/lib/inspection/lint";

export type Result = { ok: boolean; error?: string; id?: string };

export type FieldType = "text" | "textarea" | "checkbox" | "number" | "select";

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  /** "only show when <key> is one of <in>" — the tenant's own branching, stored as data so a new
   *  trade is a form someone types rather than a module someone writes. */
  showIf?: { key: string; in: string[] };
}

function slug(label: string, idx: number) {
  return slugifyFieldKey(label) || `field_${idx}`;
}

/** Turn the editor's two text boxes into a stored rule, dropping anything half-written — a rule
 *  with no key or no values must mean "always show", never "never show": a field nobody can reach
 *  is a question nobody knows they were meant to answer. */
function showIfFrom(f: { showIfKey?: string; showIfIn?: string }): { showIf: { key: string; in: string[] } } | Record<string, never> {
  const key = (f.showIfKey ?? "").trim();
  const list = (f.showIfIn ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  return key && list.length ? { showIf: { key, in: list } } : {};
}

export async function createForm(input: {
  name: string;
  description: string;
  /** Marks this form as an INSPECTION SHEET (0165) — selectable on an appointment, and the
   *  source of the typed answers the estimator reads instead of re-parsing prose. */
  is_inspection?: boolean;
  fields: { label: string; type: FieldType; options?: string; showIfKey?: string; showIfIn?: string }[];
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
      ...showIfFrom(f),
    }));

  if (schema.length === 0)
    return { ok: false, error: "Add at least one field." };

  /**
   * THE WRITE BOUNDARY. The editor already shows every problem as advice while you type
   * (cn-v608), and advice is right for SHAPE — a half-built sheet mid-edit is normal, and a
   * validator that refuses to save is one people route around.
   *
   * But a SEVERE problem is different in kind: a rule whose value isn't one of the router's
   * choices, or that names a question which doesn't exist, means the question NEVER RENDERS. That
   * is not a matter of taste. TAHOE DECK carried six of them for months — "Deck replacement" where
   * the choice read "Full replacement" — and on six of eight job types the railing footage, stair
   * counts and door counts silently did not appear. One of twenty inspections there has any
   * answers on it at all.
   *
   * A rule applied at one path is a convention, not a rule. The editor is one path; this is the
   * other, and it's the one an import, a script or a stale client also has to come through.
   */
  const severe = input.is_inspection ? severeSheetProblems(schema) : [];
  if (severe.length)
    return {
      ok: false,
      error: `${severe[0].message}${severe.length > 1 ? ` (+${severe.length - 1} more)` : ""}`,
    };

  const { data, error } = await supabase
    .from("forms")
    .insert({
      name,
      description: input.description.trim() || null,
      is_inspection: !!input.is_inspection,
      schema,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/forms");
  return { ok: true, id: data.id };
}

/**
 * Give this company an inspection sheet, keyed off the trade it told us it's in.
 *
 * THE HOLE THIS FILLS: nothing in the app has ever created a `forms` row with `is_inspection`.
 * The onboarding seed makes job codes and stops, so every new tenant's inspector renders an
 * empty state — the first outside tenant hit exactly that and never reported it, because an
 * empty form reads as a thin product rather than a broken one.
 *
 * Deliberately NOT part of the signup transaction: this is a one-tap offer at the point of use
 * (and in setup), so the sheet arrives when someone is looking at it and can immediately edit
 * it. It is a SEED, not a fixture — the tenant owns it and rewrites it in the Forms editor.
 *
 * Idempotent by intent: refuses when an inspection sheet already exists, so a double-tap or a
 * retried offline op can't leave a company with two sheets and no way to tell them apart.
 */
export async function createStarterInspectionSheet(): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // RLS scopes this to the caller's org — an existing sheet anywhere in the org wins.
  const { data: existing } = await supabase
    .from("forms")
    .select("id")
    .eq("is_inspection", true)
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true, id: existing.id };

  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const trade = starterTradeFor(getOrgSettings((org as { settings?: unknown } | null)?.settings).trade_label);
  const { name } = starterSheet(trade);

  const { data, error } = await supabase
    .from("forms")
    .insert({
      name,
      description: "Starter questions — edit these to match how you actually walk a job.",
      is_inspection: true,
      // The RAW schema, not the parsed one: `forms.schema` is the stored shape, and round-tripping
      // through the parser here would silently drop anything the parser doesn't yet understand.
      schema: starterSchemaJson(trade),
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/forms");
  revalidatePath("/appointments");
  revalidatePath("/inspections");
  return { ok: true, id: data.id };
}

export async function updateForm(
  id: string,
  input: {
    name: string;
    description: string;
    is_inspection?: boolean;
    fields: { label: string; type: FieldType; options?: string; showIfKey?: string; showIfIn?: string }[];
  },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

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
      ...showIfFrom(f),
    }));

  if (schema.length === 0)
    return { ok: false, error: "Add at least one field." };

  // Same guard as createForm, and this is the path that actually matters: a broken sheet is far
  // more often EDITED into existence than authored that way in one go. TAHOE DECK's six dead
  // rules almost certainly arrived by someone renaming a router option and leaving the rules
  // pointing at the old wording — which is a save, not a create.
  const severe = input.is_inspection ? severeSheetProblems(schema) : [];
  if (severe.length)
    return {
      ok: false,
      error: `${severe[0].message}${severe.length > 1 ? ` (+${severe.length - 1} more)` : ""}`,
    };

  // RLS isolates by org; the id match scopes the update to this form.
  const { error } = await supabase
    .from("forms")
    .update({
      name,
      description: input.description.trim() || null,
      is_inspection: !!input.is_inspection,
      schema,
    })
    .eq("id", id);

  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/forms");
  revalidatePath(`/forms/${id}`);
  return { ok: true, id };
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

  if (error) return { ok: false, error: dbError(error) };
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

  if (error) return { ok: false, error: dbError(error) };
  revalidatePath(`/forms/${formId}`);
  return { ok: true };
}

export async function deleteForm(id: string): Promise<Result> {
  // requireStaff, like updateForm and deleteFormSubmission (audit 6). This was the one write here
  // without it, and `forms_write` is staff-only — so a tech's Archive tap hit a zero-row UPDATE,
  // which PostgREST reports as success. It returned ok:true and navigated away as if the form had
  // been archived. The silent-write law: a mutation that affects nothing must not report success.
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data: wrote, error } = await ctx.supabase
    .from("forms")
    .update({ active: false })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "That form didn't archive — check your access and try again." };
  revalidatePath("/forms");
  return { ok: true };
}
