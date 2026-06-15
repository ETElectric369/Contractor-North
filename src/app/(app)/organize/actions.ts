"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { OVERHEAD_CATEGORIES } from "./constants";

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
    status: string; // filed | needs_review
    destination: string; // job | overhead | note | none
  };
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const KIND_TO_CATEGORY: Record<string, string> = {
  receipt: "Receipt",
  note: "Other",
  job_document: "Plan",
};

export interface BillLine {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  category: string | null;
}

/** Normalize the AI's line_items into clean BillLine rows. */
function cleanLines(raw: any): BillLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l: any) => {
      const quantity = Number(l?.quantity) || 1;
      const unit_price = l?.unit_price != null && !isNaN(Number(l.unit_price)) ? Number(l.unit_price) : 0;
      const amount =
        l?.amount != null && !isNaN(Number(l.amount)) ? Number(l.amount) : Math.round(quantity * unit_price * 100) / 100;
      return {
        description: String(l?.description ?? "").slice(0, 300).trim(),
        quantity,
        unit_price,
        amount,
        category: l?.category ? String(l.category).slice(0, 60) : null,
      };
    })
    .filter((l: BillLine) => l.description.length > 0)
    .slice(0, 100);
}

/** Insert a bill plus its line items (an itemized receipt → billable cost). */
async function insertItemizedBill(
  supabase: any,
  bill: {
    job_id: string | null;
    supplier: string;
    amount: number | null;
    bill_date: string | null;
    category: string;
    notes: string;
    created_by: string;
  },
  lines: BillLine[],
): Promise<string | null> {
  const { data, error } = await supabase.from("bills").insert({ ...bill, status: "paid" }).select("id").single();
  if (error || !data) return null;
  if (lines.length) {
    await supabase.from("bill_line_items").insert(
      lines.map((l, i) => ({
        bill_id: data.id,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price,
        amount: l.amount,
        category: l.category,
        sort_order: i,
      })),
    );
  }
  return data.id;
}

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
  "line_items": receipts ONLY — an array of every purchased line: [{"description": item name, "quantity": number, "unit_price": price each (number), "amount": line total (number), "category": one of "Materials" | "Electrical" | "Tools" | "Fasteners" | "Lumber" | "Plumbing" | "Paint" | "Rental" | "Tax" | "Other"}]. Transcribe EVERY line you can read, including tax as its own line. Use [] for notes/documents or an unreadable receipt,
  "vendor": store/supplier name or null,
  "amount": total in dollars as a number, or null,
  "date": "YYYY-MM-DD" date printed on it, or null,
  "category": "Receipt" | "Bill" | "Invoice" | "Photo" | "Plan" | "Permit" | "Other",
  "destination": "job" | "overhead" | "unsure" — receipts only. "job" if the purchase is materials for a specific job; "overhead" if it is clearly a company expense NOT tied to one job (fuel/gas station, shop supplies, small tools, office, vehicle, insurance); "unsure" otherwise,
  "overhead_category": "Fuel" | "Shop supplies" | "Tools" | "Office" | "Insurance" | "Vehicle" | "Other" or null — only when destination is "overhead",
  "job_id": the id of the matching job ONLY if the content clearly points to one (job number, customer name, or address visible), else null,
  "confidence": "low" | "medium" | "high"
}

Rules: never guess a job_id — only match when something on the paper points to it. A gas-station or convenience receipt is overhead (Fuel). Generic supply-house receipts with no job reference are "unsure", not overhead.

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
  const confidence = ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "medium";
  const amount = parsed.amount != null && !isNaN(Number(parsed.amount)) ? Number(parsed.amount) : null;
  const itemDate = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date ?? "")) ? parsed.date : null;
  const overheadCategory = String(parsed.overhead_category || "Other");
  const lines = kind === "receipt" ? cleanLines(parsed.line_items) : [];

  // Decide where it goes — auto-file only when confident, else the tray.
  // - job matched → file to that job (any kind)
  // - clear overhead receipt with an amount → overhead bill (no job)
  // - notes stand alone fine → filed
  // - everything else → needs_review
  const isOverhead =
    kind === "receipt" && parsed.destination === "overhead" && amount != null && confidence !== "low";
  let destination: "job" | "overhead" | "note" | "none" = "none";
  let status = "needs_review";
  if (jobId && confidence !== "low") {
    destination = "job";
    status = "filed";
  } else if (isOverhead) {
    destination = "overhead";
    status = "filed";
  } else if (kind === "note") {
    destination = "note";
    status = "filed";
  }

  const vendor = parsed.vendor ? String(parsed.vendor).slice(0, 200) : title;

  // File on the job (documents row) so the image shows on the job page.
  let documentId: string | null = null;
  if (destination === "job" && jobId) {
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

  // A receipt becomes a billable cost: an itemized bill on the job (job receipt)
  // or a company expense bill (overhead). Notes/job-documents make no bill.
  let billId: string | null = null;
  if (kind === "receipt" && amount != null && destination === "job" && jobId) {
    billId = await insertItemizedBill(
      supabase,
      { job_id: jobId, supplier: vendor, amount, bill_date: itemDate, category, notes: `Receipt filed by Organize My: ${title}`, created_by: user.id },
      lines,
    );
  } else if (destination === "overhead") {
    billId = await insertItemizedBill(
      supabase,
      { job_id: null, supplier: vendor, amount, bill_date: itemDate, category: overheadCategory, notes: `Filed by Organize My: ${title}`, created_by: user.id },
      lines,
    );
  }

  const { data: item, error } = await supabase
    .from("organized_items")
    .insert({
      kind,
      title,
      summary: parsed.summary ? String(parsed.summary).slice(0, 4000) : null,
      vendor: parsed.vendor ? String(parsed.vendor).slice(0, 200) : null,
      amount,
      item_date: itemDate,
      category: destination === "overhead" ? overheadCategory : category,
      confidence,
      status,
      job_id: destination === "job" ? jobId : null,
      document_id: documentId,
      bill_id: billId,
      line_items: lines.length ? lines : null,
      file_url: input.path,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/organize");
  revalidatePath("/bills");
  if (jobId) revalidatePath(`/jobs/${jobId}`);

  return {
    ok: true,
    item: {
      id: item.id,
      kind,
      title,
      summary: parsed.summary ?? null,
      vendor: parsed.vendor ?? null,
      amount,
      item_date: itemDate,
      job_id: destination === "job" ? jobId : null,
      job_label: destination === "job" ? jobList.find((j) => j.id === jobId)?.label ?? null : null,
      confidence,
      status,
      destination,
    },
  };
}

/** Infer a media type from a stored filename / path. */
function mimeFromName(name: string | null | undefined): string | null {
  const ext = String(name ?? "").toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/)?.[1];
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "pdf":
      return "application/pdf";
    default:
      return null;
  }
}

/**
 * Turn a receipt already attached to a job (a `documents` row) into a job-linked
 * itemized bill, so it shows up in the job's Costs tab and in Analytics. Claude
 * reads the image to autopopulate the total + line items. Idempotent: re-running
 * on a receipt that's already been billed is a no-op.
 *
 * This is the bridge for receipts uploaded directly on a job (Costs → Receipts &
 * documents), which previously just stored a file and never became a cost.
 */
export async function billJobReceipt(documentId: string): Promise<{
  ok: boolean;
  error?: string;
  already?: boolean;
  amount?: number | null;
  vendor?: string | null;
  lineCount?: number;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: doc } = await supabase
    .from("documents")
    .select("id, name, file_url, size_bytes, job_id")
    .eq("id", documentId)
    .single();
  if (!doc) return { ok: false, error: "Receipt not found." };
  if (!doc.job_id) return { ok: false, error: "This receipt isn't attached to a job." };

  // Idempotency: have we already turned this document into a bill?
  const { data: prior } = await supabase
    .from("organized_items")
    .select("id, bill_id")
    .eq("document_id", documentId)
    .not("bill_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (prior?.bill_id) return { ok: true, already: true };

  const mime = mimeFromName(doc.name) ?? mimeFromName(doc.file_url);
  if (!mime) return { ok: false, error: "Use a photo (JPG/PNG) or PDF receipt." };
  if ((doc.size_bytes ?? 0) > 8 * 1024 * 1024)
    return { ok: false, error: "Receipt is over 8 MB — try a smaller photo." };

  const { data: blob, error: dlErr } = await supabase.storage.from("documents").download(doc.file_url);
  if (dlErr || !blob) return { ok: false, error: dlErr?.message ?? "Could not read the receipt file." };
  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");

  const isImage = IMAGE_TYPES.includes(mime);
  const mediaBlock: any = isImage
    ? { type: "image", source: { type: "base64", media_type: mime, data: base64 } }
    : { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };

  let parsed: any;
  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1200,
      system: `You read a purchase receipt for an electrical contractor and itemize it as a job cost.

Respond with ONLY a JSON object (no prose):
{
  "vendor": store/supplier name or null,
  "amount": grand total in dollars as a number (the amount actually paid), or null only if you truly cannot read it,
  "date": "YYYY-MM-DD" printed on the receipt, or null,
  "line_items": [{"description": item name, "quantity": number, "unit_price": price each (number), "amount": line total (number), "category": one of "Materials" | "Electrical" | "Tools" | "Fasteners" | "Lumber" | "Plumbing" | "Paint" | "Rental" | "Tax" | "Other"}],
  "confidence": "low" | "medium" | "high"
}
Transcribe EVERY readable line, including tax as its own line. Use [] for line_items only if nothing is legible.`,
      messages: [
        {
          role: "user",
          content: [mediaBlock, { type: "text", text: `Filename: ${doc.name}. Read the total and itemize.` }],
        },
      ],
    });
    const text = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    parsed = JSON.parse(extractJsonObject(text?.text ?? ""));
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "AI could not read this receipt." };
  }

  const aiAmount = parsed.amount != null && !isNaN(Number(parsed.amount)) ? Number(parsed.amount) : null;
  const itemDate = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date ?? "")) ? parsed.date : null;
  const lines = cleanLines(parsed.line_items);
  const vendor = parsed.vendor ? String(parsed.vendor).slice(0, 200) : doc.name || "Receipt";
  const confidence = ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "medium";

  // Fall back to the line-item sum if Claude couldn't read a printed grand total.
  const lineSum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const amount = aiAmount != null ? aiAmount : lineSum > 0 ? Math.round(lineSum * 100) / 100 : null;
  if (amount == null) {
    return {
      ok: false,
      error: "Couldn't read a total on this receipt. Open it and enter the cost manually as a bill.",
    };
  }

  const billId = await insertItemizedBill(
    supabase,
    {
      job_id: doc.job_id,
      supplier: vendor,
      amount,
      bill_date: itemDate,
      category: "Receipt",
      notes: `Receipt recorded as cost: ${doc.name}`,
      created_by: user.id,
    },
    lines,
  );
  if (!billId) return { ok: false, error: "Could not create the bill." };

  // Link record so the receipt is known to be billed (drives idempotency above).
  await supabase.from("organized_items").insert({
    kind: "receipt",
    title: vendor,
    summary: null,
    vendor,
    amount,
    item_date: itemDate,
    category: "Receipt",
    confidence,
    status: "filed",
    job_id: doc.job_id,
    document_id: documentId,
    bill_id: billId,
    line_items: lines.length ? lines : null,
    file_url: doc.file_url,
    created_by: user.id,
  });

  revalidatePath("/bills");
  revalidatePath("/analytics");
  revalidatePath(`/jobs/${doc.job_id}`);
  return { ok: true, amount, vendor, lineCount: lines.length };
}

export type FileDestination =
  | { type: "job"; jobId: string }
  | { type: "overhead"; category: string }
  | { type: "petty_cash" }
  | { type: "unfiled" };

/**
 * File (or re-file) an item to any destination. Tears down whatever rows the
 * previous destination created, then creates the new ones, so moving things
 * around can never double-count.
 */
export async function fileItem(id: string, dest: FileDestination): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).maybeSingle();
  if (!item) return { ok: false, error: "Item not found." };

  // Tear down the previous filing.
  if (item.document_id) await supabase.from("documents").delete().eq("id", item.document_id);
  if (item.bill_id) await supabase.from("bills").delete().eq("id", item.bill_id);
  const prevJob = item.job_id;
  const lines = cleanLines(item.line_items);

  let documentId: string | null = null;
  let billId: string | null = null;
  let jobId: string | null = null;
  let category: string | null = item.category;

  if (dest.type === "job") {
    jobId = dest.jobId;
    const docCategory = item.kind === "receipt" ? "Receipt" : item.category && item.kind === "job_document" ? item.category : "Other";
    category = docCategory;
    const { data: doc } = await supabase
      .from("documents")
      .insert({
        job_id: dest.jobId,
        name: item.title,
        category: docCategory,
        kind: "other",
        file_url: item.file_url,
        uploaded_by: user.id,
      })
      .select("id")
      .single();
    documentId = doc?.id ?? null;
    // A receipt filed to a job becomes an itemized billable cost on that job.
    if (item.kind === "receipt" && item.amount != null) {
      billId = await insertItemizedBill(
        supabase,
        { job_id: dest.jobId, supplier: item.vendor ?? item.title, amount: item.amount, bill_date: item.item_date, category: "Receipt", notes: `Receipt filed by Organize My: ${item.title}`, created_by: user.id },
        lines,
      );
    }
  } else if (dest.type === "overhead") {
    category = dest.category;
    billId = await insertItemizedBill(
      supabase,
      { job_id: null, supplier: item.vendor ?? item.title, amount: item.amount ?? 0, bill_date: item.item_date, category: dest.category, notes: `Filed by Organize My: ${item.title}`, created_by: user.id },
      lines,
    );
  } else if (dest.type === "petty_cash") {
    category = "Petty cash";
    const { error: pcErr } = await supabase.from("petty_cash").insert({
      tx_date: item.item_date ?? new Date().toISOString().slice(0, 10),
      kind: "expense",
      amount: item.amount ?? 0,
      category: item.kind === "receipt" ? "Receipt" : "Other",
      description: item.title,
      created_by: user.id,
    });
    if (pcErr) return { ok: false, error: pcErr.message };
  }

  const { error } = await supabase
    .from("organized_items")
    .update({ job_id: jobId, document_id: documentId, bill_id: billId, category, status: "filed" })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/organize");
  revalidatePath("/bills");
  revalidatePath("/petty-cash");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  if (prevJob) revalidatePath(`/jobs/${prevJob}`);
  return { ok: true };
}

/** Delete an organized item, everything it filed (doc row, overhead bill), and the stored file. */
export async function deleteOrganizedItem(id: string): Promise<Result> {
  const supabase = await createClient();
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).maybeSingle();
  if (!item) return { ok: false, error: "Item not found." };

  if (item.document_id) await supabase.from("documents").delete().eq("id", item.document_id);
  if (item.bill_id) await supabase.from("bills").delete().eq("id", item.bill_id);
  if (item.file_url) await supabase.storage.from("documents").remove([item.file_url]);
  const { error } = await supabase.from("organized_items").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/organize");
  revalidatePath("/bills");
  return { ok: true };
}

/** Save a typed/dictated note as a needs-review item (no photo). */
export async function saveVoiceNote(text: string): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const clean = text.trim();
  if (!clean) return { ok: false, error: "Nothing to save." };
  const title = clean.length > 60 ? clean.slice(0, 57) + "…" : clean;
  const { error } = await supabase.from("organized_items").insert({
    kind: "note",
    title,
    summary: clean,
    category: "Note",
    confidence: "high",
    status: "needs_review",
    file_url: null,
    created_by: user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/organize");
  return { ok: true };
}

/** Set an item aside without filing it (moves it to the Archive). */
export async function archiveItem(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("organized_items").update({ status: "archived" }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/organize");
  return { ok: true };
}

/** Bring an archived/filed item back to the needs-review tray. */
export async function unarchiveItem(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("organized_items").update({ status: "needs_review" }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/organize");
  return { ok: true };
}

/** Let Claude review a needs-attention item and file it appropriately:
 *  match it to a job, file it as overhead, turn a to-do note into a task, or
 *  keep it as a reference note. Returns what it did. */
export async function aiReviewItem(id: string): Promise<{ ok: boolean; message: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Not signed in." };
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).maybeSingle();
  if (!item) return { ok: false, message: "Item not found." };

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, job_number, name, address, customers(name)")
    .in("status", ["estimate", "scheduled", "in_progress", "on_hold"])
    .order("created_at", { ascending: false })
    .limit(40);
  const jobList = (jobs ?? []).map((j: any) => ({
    id: j.id,
    label: `${j.job_number} — ${j.name}${j.customers?.name ? ` (${j.customers.name})` : ""}${j.address ? `, ${j.address}` : ""}`,
  }));

  let parsed: any;
  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 500,
      system: `You triage one piece of paperwork for an electrical contractor and decide the single best action. Output ONLY a JSON object:
{
  "action": "file_job" | "overhead" | "task" | "keep_note" | "unsure",
  "job_id": an id from the list below, or null,
  "overhead_category": one of [${OVERHEAD_CATEGORIES.join(", ")}], or null,
  "task_title": short imperative (e.g. "Call inspector Tuesday"), or null,
  "task_category": "office" | "operations" | "sales",
  "reason": one short sentence
}
Rules: "file_job" ONLY if the content clearly points to a job in the list. "overhead" only for a company-expense receipt with an amount. "task" when a note describes something to DO (call, order, schedule, follow up). "keep_note" for reference info. "unsure" if you genuinely can't tell.

Jobs (id — label):
${jobList.map((j) => `${j.id} — ${j.label}`).join("\n") || "(none)"}`,
      messages: [
        {
          role: "user",
          content: `kind=${item.kind}; title="${item.title}"; amount=${item.amount ?? "none"}; vendor=${item.vendor ?? "none"}. Content: ${item.summary ?? item.title}`,
        },
      ],
    });
    const block = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    parsed = JSON.parse(extractJsonObject(block?.text ?? ""));
  } catch (e: any) {
    return {
      ok: false,
      message: e?.message?.includes("ANTHROPIC_API_KEY") ? "AI review needs the API key set." : "AI couldn't review this one.",
    };
  }

  const action = String(parsed?.action ?? "unsure");
  const reason = typeof parsed?.reason === "string" ? parsed.reason : "";
  try {
    if (action === "file_job" && jobList.some((j) => j.id === parsed.job_id)) {
      await fileItem(id, { type: "job", jobId: parsed.job_id });
      return { ok: true, message: `Filed to ${jobList.find((j) => j.id === parsed.job_id)?.label}. ${reason}`.trim() };
    }
    if (action === "overhead") {
      const cat = OVERHEAD_CATEGORIES.includes(parsed.overhead_category) ? parsed.overhead_category : "Other";
      await fileItem(id, { type: "overhead", category: cat });
      return { ok: true, message: `Filed as overhead (${cat}). ${reason}`.trim() };
    }
    if (action === "task") {
      const title = String(parsed.task_title || item.title).slice(0, 200);
      const category = ["office", "operations", "sales"].includes(parsed.task_category) ? parsed.task_category : "operations";
      await supabase.from("tasks").insert({ title, category, status: "open", created_by: user.id });
      await supabase.from("organized_items").update({ status: "filed", category: "Task" }).eq("id", id);
      revalidatePath("/organize");
      revalidatePath("/tasks");
      return { ok: true, message: `Made a task: "${title}". ${reason}`.trim() };
    }
    if (action === "keep_note") {
      await supabase.from("organized_items").update({ status: "filed" }).eq("id", id);
      revalidatePath("/organize");
      return { ok: true, message: `Kept as a note in your archive. ${reason}`.trim() };
    }
    return { ok: false, message: reason || "Not sure where this goes — pick a destination yourself." };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? "Couldn't apply the suggestion." };
  }
}
