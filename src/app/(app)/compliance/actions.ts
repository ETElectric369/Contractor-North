"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { INSURANCE_TYPES, COMPLIANCE_TYPES, AUDIT_TYPES } from "@/lib/compliance-types";

export type Result = { ok: boolean; error?: string };

export interface ComplianceInput {
  type?: string;
  name: string;
  policy_number?: string | null;
  amount?: number;
  issued_date?: string | null;
  expires_date?: string | null;
  notes?: string | null;
  /** Storage path in the private "documents" bucket. Create-time only —
   *  updates go through setComplianceFile so a metadata edit can't wipe it. */
  file_url?: string | null;
}

function clean(input: ComplianceInput) {
  return {
    type: input.type?.trim() || "Insurance",
    // Capture never requires typing — a blank name saves as a placeholder, never a rejection.
    name: input.name?.trim() || "Untitled policy",
    policy_number: input.policy_number?.trim() || null,
    amount: Number.isFinite(input.amount) ? input.amount : 0,
    issued_date: input.issued_date || null,
    expires_date: input.expires_date || null,
    notes: input.notes?.trim() || null,
  };
}

function revalidate() {
  revalidatePath("/compliance");
  revalidatePath("/insurance");
  revalidatePath("/audits"); // audits ride the same compliance_items table
}

export async function createCompliance(input: ComplianceInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase
    .from("compliance_items")
    .insert({ ...clean(input), file_url: input.file_url ?? null, created_by: ctx.userId });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function updateCompliance(id: string, input: ComplianceInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("compliance_items").update(clean(input)).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

/** Attach/replace/remove the item's document. Replacing or removing also
 *  deletes the old storage object so the bucket doesn't collect orphans. */
export async function setComplianceFile(id: string, fileUrl: string | null): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: existing } = await supabase
    .from("compliance_items")
    .select("file_url")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "That item isn't available." };
  const { error } = await supabase.from("compliance_items").update({ file_url: fileUrl }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  if (existing.file_url && existing.file_url !== fileUrl) {
    await supabase.storage.from("documents").remove([existing.file_url]);
  }
  revalidate();
  return { ok: true };
}

export interface ImportPolicyResult {
  ok: boolean;
  error?: string;
  id?: string;
  type?: string;
  name?: string;
  summary?: string;
  /** True when the auto-read failed — the document was STILL filed, it just needs a human look. */
  reviewNeeded?: boolean;
}

const IMPORT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALL_DOC_TYPES = [...INSURANCE_TYPES, ...COMPLIANCE_TYPES, ...AUDIT_TYPES];

/** Pull a JSON object out of a Claude reply (tolerates ```json fences and a
 *  trailing comma before a closing bracket — same idiom as organize/actions). */
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in AI reply");
  return body.slice(start, end + 1).replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Import an already-uploaded company document (policy, bond, license, audit letter):
 * Claude reads it and extracts the renewal-tracking details, then the item is filed
 * with the document attached. THE LAW: capture never requires typing — if the AI
 * read fails for ANY reason, the document is still filed as an "Other" item pointing
 * at the upload, flagged reviewNeeded, never lost.
 */
export async function importPolicyDoc(input: {
  path: string; // storage path in the private "documents" bucket (already uploaded client-side)
  mime: string;
  fileName: string;
}): Promise<ImportPolicyResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const baseName = input.fileName.replace(/\.[^.]+$/, "").trim() || input.fileName;

  // Failure STILL files: the fallback row keeps the document reachable no matter what.
  async function fileAnyway(): Promise<ImportPolicyResult> {
    const { data, error } = await supabase
      .from("compliance_items")
      .insert({
        type: "Other",
        name: baseName,
        policy_number: null,
        amount: 0,
        issued_date: null,
        expires_date: null,
        notes: "Imported — auto-read failed, fill in the details.",
        file_url: input.path,
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "Could not save the import." };
    revalidate();
    return { ok: true, id: data.id, type: "Other", name: baseName, summary: "Auto-read failed — filed for review.", reviewNeeded: true };
  }

  // Only images and PDFs can be AI-read; anything else (e.g. HEIC) files straight to review.
  const isImage = IMPORT_IMAGE_TYPES.includes(input.mime);
  const isPdf = input.mime === "application/pdf";
  if (!isImage && !isPdf) return fileAnyway();

  const { data: blob, error: dlErr } = await supabase.storage.from("documents").download(input.path);
  if (dlErr || !blob) return fileAnyway();
  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");

  const mediaBlock: any = isImage
    ? { type: "image", source: { type: "base64", media_type: input.mime, data: base64 } }
    : { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };

  let parsed: any;
  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      system: `You read a CONTRACTOR COMPANY DOCUMENT — an insurance policy or certificate, a bond, a contractor/business license, a certification, a permit, or an audit report — and extract its renewal-tracking details.

Respond with ONLY a JSON object (no prose):
{
  "doc_type": one of exactly ${ALL_DOC_TYPES.map((t) => `"${t}"`).join(" | ")} — or "Other" if none fits,
  "name": carrier/issuer plus a short label, e.g. "State Farm — GL" or "CSLB — C-10 License",
  "policy_number": the policy / license / bond number printed on it, or null,
  "amount": a number ONLY if it is printed on the document — the ANNUAL PREMIUM for insurance, the bond amount for a bond, the fee for a license. NEVER guess, estimate, or compute a number that is not printed. null when not clearly stated,
  "issued_date": "YYYY-MM-DD" effective/issue date printed on it, or null,
  "expires_date": "YYYY-MM-DD" expiration/renewal date printed on it, or null,
  "notes": 1-3 short lines — coverage limits, agent/contact info, anything renewal-relevant
}

Rules: copy numbers and dates exactly as printed — never invent them. If the document is unreadable, still answer with doc_type "Other" and your best name from the filename.`,
      messages: [
        {
          role: "user",
          content: [mediaBlock, { type: "text", text: `Filename: ${input.fileName}. Extract the details.` }],
        },
      ],
    });
    const text = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    parsed = JSON.parse(extractJsonObject(text?.text ?? ""));
  } catch {
    return fileAnyway();
  }

  // Validate + clamp everything the model returned — never trust it raw.
  const type = ALL_DOC_TYPES.includes(String(parsed?.doc_type)) ? String(parsed.doc_type) : "Other";
  const name = String(parsed?.name || baseName).slice(0, 200).trim() || baseName;
  const policy = parsed?.policy_number ? String(parsed.policy_number).slice(0, 100).trim() || null : null;
  const amount =
    parsed?.amount != null && Number.isFinite(Number(parsed.amount)) && Number(parsed.amount) >= 0
      ? Number(parsed.amount)
      : 0;
  const issued = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed?.issued_date ?? "")) ? String(parsed.issued_date) : null;
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed?.expires_date ?? "")) ? String(parsed.expires_date) : null;
  const notes = parsed?.notes ? String(parsed.notes).slice(0, 600).trim() || null : null;

  const { data, error } = await supabase
    .from("compliance_items")
    .insert({
      type,
      name,
      policy_number: policy,
      amount,
      issued_date: issued,
      expires_date: expires,
      notes,
      file_url: input.path,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error || !data) return fileAnyway();
  revalidate();
  return {
    ok: true,
    id: data.id,
    type,
    name,
    summary: `${type}${expires ? ` · renews ${expires}` : ""}`,
  };
}

export async function deleteCompliance(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: existing } = await supabase
    .from("compliance_items")
    .select("file_url")
    .eq("id", id)
    .maybeSingle();
  const { error } = await supabase.from("compliance_items").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  if (existing?.file_url) await supabase.storage.from("documents").remove([existing.file_url]);
  revalidate();
  return { ok: true };
}
