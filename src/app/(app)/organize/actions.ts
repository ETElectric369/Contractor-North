"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";

export type Result = { ok: boolean; error?: string };

export interface OrganizedResult {
  ok: boolean;
  error?: string;
  item?: {
    id: string;
    kind: string;
    title: string;
    summary: string | null;
    vendor: string | null;
    amount: number | null;
    item_date: string | null;
    job_id: string | null;
    job_label: string | null;
    confidence: string;
  };
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const KIND_TO_CATEGORY: Record<string, string> = {
  receipt: "Receipt",
  note: "Other",
  job_document: "Plan",
};

/** Pull a JSON object out of a Claude reply (tolerates ```json fences). */
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in AI reply");
  return body.slice(start, end + 1);
}

/**
 * The heart of "Organize My": given an already-uploaded storage file, have
 * Claude read the image, classify it (receipt / note / job document), extract
 * the details, match it to a job, and file it.
 */
export async function analyzeAndFile(input: {
  path: string; // storage path in the 'documents' bucket
  name: string;
  mime: string;
  size: number;
}): Promise<OrganizedResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // Candidate jobs for matching (recent, active-ish).
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, job_number, name, address, city, customers(name)")
    .in("status", ["estimate", "scheduled", "in_progress", "on_hold"])
    .order("created_at", { ascending: false })
    .limit(40);
  const jobList = (jobs ?? []).map((j: any) => ({
    id: j.id,
    label: `${j.job_number} — ${j.name}${j.customers?.name ? ` (${j.customers.name})` : ""}${j.address ? `, ${j.address}` : ""}${j.city ? `, ${j.city}` : ""}`,
  }));

  // Pull the uploaded file back out of storage for Claude to look at.
  const { data: blob, error: dlErr } = await supabase.storage.from("documents").download(input.path);
  if (dlErr || !blob) return { ok: false, error: dlErr?.message ?? "Could not read the upload." };
  if (input.size > 8 * 1024 * 1024) return { ok: false, error: "File is over 8 MB — try a smaller photo." };
  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");

  const isImage = IMAGE_TYPES.includes(input.mime);
  const isPdf = input.mime === "application/pdf";
  if (!isImage && !isPdf) {
    return { ok: false, error: "Use a photo (JPG/PNG) or PDF — other file types can't be read yet." };
  }

  const mediaBlock: any = isImage
    ? { type: "image", source: { type: "base64", media_type: input.mime, data: base64 } }
    : { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };

  let parsed: any;
  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1200,
      system: `You file paperwork for an electrical contractor. Look at the upload and classify it.

Respond with ONLY a JSON object (no prose):
{
  "kind": "receipt" | "note" | "job_document",
  "title": short label, e.g. "Home Depot — $84.12" or "Note: call inspector Tuesday",
  "summary": receipt → brief list of what was bought; note → full clean transcription of the handwriting; job_document → what the document is,
  "vendor": store/supplier name or null,
  "amount": total in dollars as a number, or null,
  "date": "YYYY-MM-DD" date printed on it, or null,
  "category": "Receipt" | "Bill" | "Invoice" | "Photo" | "Plan" | "Permit" | "Other",
  "job_id": the id of the matching job ONLY if the content clearly points to one (job number, customer name, or address visible), else null,
  "confidence": "low" | "medium" | "high"
}

Jobs you may match against (id — label):
${jobList.map((j) => `${j.id} — ${j.label}`).join("\n") || "(none)"}`,
      messages: [
        {
          role: "user",
          content: [mediaBlock, { type: "text", text: `Filename: ${input.name}. Classify and extract.` }],
        },
      ],
    });
    const text = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    parsed = JSON.parse(extractJsonObject(text?.text ?? ""));
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "AI could not read this file." };
  }

  const kind = ["receipt", "note", "job_document"].includes(parsed.kind) ? parsed.kind : "job_document";
  const jobId = jobList.some((j) => j.id === parsed.job_id) ? parsed.job_id : null;
  const category = String(parsed.category || KIND_TO_CATEGORY[kind] || "Other");
  const title = String(parsed.title || input.name).slice(0, 200);

  // File it on the job (documents row) when matched, so it shows on the job page.
  let documentId: string | null = null;
  if (jobId) {
    const { data: doc } = await supabase
      .from("documents")
      .insert({
        job_id: jobId,
        name: title,
        category,
        kind: "other",
        file_url: input.path,
        size_bytes: input.size || null,
        uploaded_by: user.id,
      })
      .select("id")
      .single();
    documentId = doc?.id ?? null;
  }

  const { data: item, error } = await supabase
    .from("organized_items")
    .insert({
      kind,
      title,
      summary: parsed.summary ? String(parsed.summary).slice(0, 4000) : null,
      vendor: parsed.vendor ? String(parsed.vendor).slice(0, 200) : null,
      amount: parsed.amount != null && !isNaN(Number(parsed.amount)) ? Number(parsed.amount) : null,
      item_date: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date ?? "")) ? parsed.date : null,
      category,
      confidence: ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "medium",
      job_id: jobId,
      document_id: documentId,
      file_url: input.path,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/organize");
  if (jobId) revalidatePath(`/jobs/${jobId}`);

  return {
    ok: true,
    item: {
      id: item.id,
      kind,
      title,
      summary: parsed.summary ?? null,
      vendor: parsed.vendor ?? null,
      amount: parsed.amount != null ? Number(parsed.amount) : null,
      item_date: parsed.date ?? null,
      job_id: jobId,
      job_label: jobList.find((j) => j.id === jobId)?.label ?? null,
      confidence: parsed.confidence ?? "medium",
    },
  };
}

/** Re-file an item: change its job (and keep the job-page documents row in sync). */
export async function refileItem(
  id: string,
  jobId: string | null,
): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).maybeSingle();
  if (!item) return { ok: false, error: "Item not found." };

  let documentId: string | null = item.document_id;
  if (item.document_id && !jobId) {
    await supabase.from("documents").delete().eq("id", item.document_id);
    documentId = null;
  } else if (item.document_id && jobId) {
    await supabase.from("documents").update({ job_id: jobId }).eq("id", item.document_id);
  } else if (!item.document_id && jobId) {
    const { data: doc } = await supabase
      .from("documents")
      .insert({
        job_id: jobId,
        name: item.title,
        category: item.category ?? "Other",
        kind: "other",
        file_url: item.file_url,
        uploaded_by: user.id,
      })
      .select("id")
      .single();
    documentId = doc?.id ?? null;
  }

  const { error } = await supabase
    .from("organized_items")
    .update({ job_id: jobId, document_id: documentId })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/organize");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

/** Delete an organized item, its job-page document row, and the stored file. */
export async function deleteOrganizedItem(id: string): Promise<Result> {
  const supabase = await createClient();
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).maybeSingle();
  if (!item) return { ok: false, error: "Item not found." };

  if (item.document_id) await supabase.from("documents").delete().eq("id", item.document_id);
  if (item.file_url) await supabase.storage.from("documents").remove([item.file_url]);
  const { error } = await supabase.from("organized_items").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/organize");
  return { ok: true };
}
