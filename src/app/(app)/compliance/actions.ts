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
    if (error || !data) {
      // The insert definitively failed, so nothing references this upload — remove
      // the now-orphaned storage object (best-effort; race-free at this point).
      await supabase.storage.from("documents").remove([input.path]).catch(() => {});
      return { ok: false, error: error?.message ?? "Could not save the import." };
    }
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

  // SAVE ONCE (the Spinnaker COI lesson): the same policy number imported again is the
  // same POLICY. A doc-less match absorbs this file + any blanks; a match that already
  // holds a document means THIS file is a companion (certificate, endorsement) — file it,
  // but say so instead of minting what reads as a second policy.
  if (policy) {
    const { data: match } = await supabase
      .from("compliance_items")
      .select("id, name, amount, issued_date, expires_date, notes, file_url")
      .eq("policy_number", policy)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (match && !match.file_url) {
      const { error: upErr } = await supabase
        .from("compliance_items")
        .update({
          file_url: input.path,
          amount: Number(match.amount) > 0 ? match.amount : amount,
          issued_date: match.issued_date ?? issued,
          expires_date: match.expires_date ?? expires,
          notes: match.notes ?? notes,
        })
        .eq("id", match.id);
      if (!upErr) {
        revalidate();
        return { ok: true, id: match.id, type, name: match.name, summary: `attached to the existing ${match.name} (same policy #)` };
      }
    } else if (match) {
      const { data: comp, error: compErr } = await supabase
        .from("compliance_items")
        .insert({
          type,
          name,
          policy_number: policy,
          amount,
          issued_date: issued,
          expires_date: expires,
          notes: `Companion document to "${match.name}" (same policy #). ${notes ?? ""}`.trim().slice(0, 600),
          file_url: input.path,
          created_by: ctx.userId,
        })
        .select("id")
        .single();
      if (compErr || !comp) return fileAnyway();
      revalidate();
      return { ok: true, id: comp.id, type, name, summary: `companion doc to ${match.name} (same policy #)` };
    }
  }

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

export interface CslbImportResult {
  ok: boolean;
  error?: string;
  /** One line per compliance item touched, for narration in the import list. */
  results?: { action: "created" | "updated"; type: string; name: string; detail?: string }[];
}

/**
 * Import the company's public CSLB record (cslb.ca.gov/{number} — plain HTML, no JS):
 * the license itself, the contractor's bond, and workers' comp, filed as compliance
 * items with dates and numbers ONLY as printed on the board's page. Idempotent on
 * purpose — re-running UPDATES the same items (matched by org + type + policy number),
 * so this doubles as the "re-check the board" path. Unlike importPolicyDoc there is no
 * uploaded document to preserve, so a failed fetch/read errors cleanly and files NOTHING.
 */
export async function importFromCslb(licenseNumber: string): Promise<CslbImportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const licNum = (licenseNumber ?? "").trim();
  if (!/^\d{4,8}$/.test(licNum)) {
    return { ok: false, error: "A CSLB license number is 4–8 digits — check it and try again." };
  }
  const notALicense = `CSLB didn't return a license page for #${licNum} — check the number.`;

  let html: string;
  try {
    const res = await fetch(`https://www.cslb.ca.gov/${licNum}`, {
      headers: { "user-agent": "Mozilla/5.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: notALicense };
    html = await res.text();
  } catch {
    return { ok: false, error: `Couldn't reach CSLB for #${licNum} — try again in a minute.` };
  }

  // Strip to plain text for the AI read: drop scripts/styles/tags, decode the common
  // entities, collapse whitespace, cap the size.
  const pageText = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15_000);
  if (pageText.length < 300) return { ok: false, error: notALicense };

  let parsed: any;
  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      system: `You read the plain text of a public CSLB (California Contractors State License Board) license-detail page and extract the record.

Respond with ONLY a JSON object (no prose):
{
  "found": true when the text really is a license detail page for a contractor; false when it is a not-found / error / search page,
  "business_name": the business name as shown, or null,
  "license_number": the license number as shown, or null,
  "status": the license status as one short plain sentence, e.g. "This license is current and active.", or null,
  "classifications": the classification(s) as one string, e.g. "C-10 Electrical", or null,
  "license_expires": "YYYY-MM-DD" license expiration date, or null,
  "bond": { "surety": surety company name, "bond_number": string, "amount": the bond amount as a plain number, or null, "effective": "YYYY-MM-DD" or null } — or null when the page has no contractor's bond section,
  "workers_comp": { "carrier": insurer name, "policy_number": string, "expires": "YYYY-MM-DD" or null } — or { "exempt": true, "note": the exemption statement in one short line } when the page shows a workers'-comp exemption on file — or null when there is no workers' comp section
}

Rules: copy names, numbers, and dates EXACTLY as printed — never guess, estimate, or compute anything that is not on the page. Use null for anything not clearly stated.`,
      messages: [{ role: "user", content: `CSLB page text for license #${licNum}:\n\n${pageText}` }],
    });
    const text = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    parsed = JSON.parse(extractJsonObject(text?.text ?? ""));
  } catch {
    return { ok: false, error: `Couldn't read the CSLB page for #${licNum} — try again in a minute.` };
  }

  // Validate + clamp everything the model returned — never trust it raw.
  const dateOf = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : null);
  const strOf = (v: unknown, max: number) => {
    const s = v == null ? "" : String(v).trim();
    return s ? s.slice(0, max) : null;
  };

  const businessName = strOf(parsed?.business_name, 150);
  if (!parsed?.found || !businessName) return { ok: false, error: notALicense };
  const status = strOf(parsed?.status, 200);
  const classifications = strOf(parsed?.classifications, 150);
  const licenseExpires = dateOf(parsed?.license_expires);
  const wc = parsed?.workers_comp ?? null;
  const wcExempt = !!wc?.exempt;

  const results: NonNullable<CslbImportResult["results"]> = [];

  /** Create-or-update, never duplicate: match org (RLS) + type + policy_number,
   *  falling back to type + name when there's no number. `fields` carries ONLY
   *  what CSLB actually shows — an update never touches file_url or any field
   *  the board doesn't publish (a null never wipes a hand-entered value). */
  async function upsertItem(
    type: string,
    name: string,
    policyNumber: string | null,
    fields: Record<string, string | number | null>,
    detail?: string,
  ): Promise<string | null> {
    let match = supabase.from("compliance_items").select("id").eq("type", type);
    match = policyNumber ? match.eq("policy_number", policyNumber) : match.eq("name", name);
    const { data: existing, error: findErr } = await match.limit(1).maybeSingle();
    if (findErr) return findErr.message;
    if (existing) {
      const patch: Record<string, string | number | null> = { name, ...fields };
      if (policyNumber) patch.policy_number = policyNumber;
      const { error } = await supabase.from("compliance_items").update(patch).eq("id", existing.id);
      if (error) return error.message;
      results.push({ action: "updated", type, name, detail });
    } else {
      const { error } = await supabase
        .from("compliance_items")
        .insert({ type, name, policy_number: policyNumber, amount: 0, ...fields, created_by: ctx.userId });
      if (error) return error.message;
      results.push({ action: "created", type, name, detail });
    }
    return null;
  }

  // (a) The license itself — classifications + the board's status line live in notes.
  const licenseNotes =
    [
      classifications ? `Classifications: ${classifications}` : null,
      status,
      wcExempt ? "CSLB shows a workers'-comp exemption on file." : null,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 600) || null;
  let err = await upsertItem(
    "Contractor License",
    `${businessName} — CSLB #${licNum}`,
    licNum,
    { notes: licenseNotes, ...(licenseExpires ? { expires_date: licenseExpires } : {}) },
    licenseExpires ? `renews ${licenseExpires}` : undefined,
  );
  if (err) {
    revalidate();
    return { ok: false, error: err, results };
  }

  // (b) The contractor's bond — CSLB prints the amount + effective date but NO expiry.
  const surety = strOf(parsed?.bond?.surety, 150);
  if (surety) {
    const bondNumber = strOf(parsed?.bond?.bond_number, 100);
    const rawAmount = parsed?.bond?.amount != null ? Number(String(parsed.bond.amount).replace(/[$,\s]/g, "")) : NaN;
    const bondAmount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : null;
    const effective = dateOf(parsed?.bond?.effective);
    err = await upsertItem(
      "Bond",
      surety,
      bondNumber,
      {
        notes: "Bond expiry isn't shown on CSLB — attach the bond paperwork for the renewal date.",
        ...(bondAmount != null ? { amount: bondAmount } : {}),
        ...(effective ? { issued_date: effective } : {}),
      },
      bondAmount != null ? `$${bondAmount.toLocaleString("en-US")}` : undefined,
    );
    if (err) {
      revalidate();
      return { ok: false, error: err, results };
    }
  }

  // (c) Workers' comp — a carrier files its own item; an exemption is only the
  //     notes line on the license above, never a separate item.
  const wcCarrier = wcExempt ? null : strOf(wc?.carrier, 150);
  if (wcCarrier) {
    const wcPolicy = strOf(wc?.policy_number, 100);
    const wcExpires = dateOf(wc?.expires);
    err = await upsertItem(
      "Workers' Comp",
      wcCarrier,
      wcPolicy,
      wcExpires ? { expires_date: wcExpires } : {},
      wcExpires ? `renews ${wcExpires}` : undefined,
    );
    if (err) {
      revalidate();
      return { ok: false, error: err, results };
    }
  }

  revalidate();
  return { ok: true, results };
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
