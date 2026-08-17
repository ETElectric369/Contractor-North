"use server";
import { dbError } from "@/lib/db-error";
import { parsePlaybook } from "@/lib/playbook/parse";

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


  /**
   * A PLAYBOOK-BACKED FORM CANNOT BE EDITED HERE, AND SAYING SO IS NOT ENOUGH.
   *
   * /forms/[id] already carries a banner whose own words are "A SHEET EDITOR THAT SILENTLY DOES
   * NOTHING IS WORSE THAN NO EDITOR" — and then it left the editor enabled and the write allowed.
   * So this is what actually happened to Andrew:
   *
   *   `schema` is a live MIRROR of the playbook (savePlaybook writes sheetFromPlaybook(pb) beside
   *   it), so this page renders every one of his website's questions, Budget included. He deleted
   *   Budget here and saved. The update below wrote `schema` and not `playbook` — and the public
   *   door reads through playbookForForm, which prefers `playbook` and never looks at `schema`.
   *   Success toast, unchanged form, and the next playbook save regenerates the mirror and puts
   *   Budget back. He rang Erik the next morning to say the playbook was frozen.
   *
   * Refusing is the honest answer: there is nowhere for this edit to go. Name is still editable —
   * it is a real column that nothing mirrors — so only the fields are refused.
   */
  const { data: existing } = await supabase.from("forms").select("playbook, schema").eq("id", id).maybeSingle();
  const isPlaybook = parsePlaybook((existing as { playbook?: unknown } | null)?.playbook).needs.length > 0;

  /**
   * AUDIT 7: the old guard compared JSON BYTES of a rebuilt schema against the stored mirror —
   * but the editor round-trip is LOSSY (keys re-slugged from labels, multi/other/measured props
   * dropped, jsonb key order), so the compare tripped on EVERY save and playbook-backed forms
   * were un-renamable. Compare at the level the editor actually round-trips instead: label,
   * type, options, and the show-rule with its key resolved to the LABEL it points at (keys are
   * incomparable across the two key spaces; labels are what survive). A genuine field edit
   * still refuses honestly — Andrew's Budget deletion stays refused, never silently dropped —
   * while a rename passes and writes NAME ONLY, never the lossy rebuilt schema.
   * The severe-sheet lint runs only on the non-playbook branch: a playbook form's fields are
   * not being written, so linting the lossy rebuild produced false orphan-rule refusals.
   */
  if (isPlaybook) {
    type Fld = { key: string; label: string; type: string; options?: string[]; showIf?: { key: string; in: string[] } };
    const project = (fields: Fld[]) => {
      const labelByKey = new Map(fields.map((f) => [f.key, f.label.trim().toLowerCase()]));
      return fields.map((f) => ({
        label: f.label.trim().toLowerCase(),
        type: f.type,
        options: (f.options ?? []).map((o) => o.trim()).filter(Boolean),
        show: f.showIf ? { q: labelByKey.get(f.showIf.key) ?? f.showIf.key, in: [...f.showIf.in].map((v) => v.trim()) } : null,
      }));
    };
    const stored = Array.isArray((existing as { schema?: unknown } | null)?.schema)
      ? ((existing as { schema: Fld[] }).schema)
      : [];
    if (JSON.stringify(project(schema as Fld[])) !== JSON.stringify(project(stored)))
      return {
        ok: false,
        error: "These questions live in the playbook now — this page only shows a copy. Edit them in Settings → Playbook.",
      };
  } else {
    if (schema.length === 0) return { ok: false, error: "Add at least one field." };
    const severe = input.is_inspection ? severeSheetProblems(schema) : [];
    if (severe.length)
      return {
        ok: false,
        error: `${severe[0].message}${severe.length > 1 ? ` (+${severe.length - 1} more)` : ""}`,
      };
  }

  // RLS isolates by org; the id match scopes the update to this form. A playbook form's write
  // OMITS schema — the mirror belongs to savePlaybook, and writing the lossy rebuild over it
  // would re-key every field and orphan the show-rules and submission data.
  const { data: wrote, error } = await supabase
    .from("forms")
    .update({
      name,
      description: input.description.trim() || null,
      is_inspection: !!input.is_inspection,
      ...(isPlaybook ? {} : { schema }),
    })
    .eq("id", id)
    .select("id");

  if (error) return { ok: false, error: dbError(error) };
  // A zero-row UPDATE is a 204, not an error — the silent-write law. Without this an RLS-refused
  // edit reports success and the form simply does not change, which is the same shape of failure
  // this whole commit is about.
  if (!wrote?.length) return { ok: false, error: "That didn't save — check your access and try again." };
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
