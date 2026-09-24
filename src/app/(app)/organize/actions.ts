"use server";
import { reportError } from "@/lib/observe";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { requireStaff } from "@/lib/staff-guard";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { modelFor, recordAiUsage } from "@/lib/ai-cost";
import { parseAiJson } from "@/lib/ai-json";
import { listJobScopes } from "@/lib/analytics/job-profitability";
import { reconcileReceipt } from "@/lib/receipt-reconcile";
import { AUTO_FILE_BUCKETS, bucketOf, isBusinessCostBucket, looksLikeSupplierFee } from "@/lib/business-cost-buckets";
import { isSha256 } from "@/lib/content-hash";
import {
  billCategoryFor,
  fileRefusal,
  paperTypeOfItem,
  pickedBecause,
  proposalOf,
  readinessOf,
  type MarkJob,
  type MarkPo,
  type NumberMatch,
  type PaperProposal,
} from "@/lib/paperwork";
// TWO PROMPTS ITEMISE A RECEIPT and they must offer the model the SAME categories: the paper
// reader (paperwork-core, any upload) and the job-receipt reader (a receipt already filed to a
// job). One exported string, interpolated into both, is the only version of "identical" that
// stays true. The rule sentence beneath each schema is shared for the same reason.
import {
  FOOD_AND_DRINK_PROMPT_RULE,
  MASKED_PRICE_PROMPT_RULE,
  looksProvisionallyPriced,
  RECEIPT_LINE_CATEGORY_SCHEMA_HINT,
} from "@/app/(app)/bills/receipt-billing";
import {
  billStatusFromItem,
  cleanDocNumber,
  cleanLines,
  exactAccountFor,
  insertItemizedBill,
  insertPaperRow,
  loadBooks,
  matchesOnBooks,
  paperReaderSystem,
  readerFields,
  tradeOf,
  updateItemTolerant,
  type ReaderJob,
} from "./paperwork-core";

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
    status: string; // needs_review (every read waits for a person) | filed (a note keeps itself)
    destination: string; // none | note — nothing a reader decides is ever a job or a cost
    /**
     * Where it might go. `picked` = the PAPER names this job (a printed mark matched exactly), so
     * it is pre-picked beside File It, and `because` says why in a few words. Otherwise it is a
     * model's guess, offered and never picked. Nothing is ever filed by itself.
     */
    suggestion?: { jobLabel: string | null; bucket: string | null; picked?: boolean; because?: string | null } | null;
    /** The reader says this is a plain picture: the row asks "What is this?" first. */
    picture?: boolean;
    /** A one-line account of what was read. */
    line?: string;
  };
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const READ_LIMIT = 8 * 1024 * 1024;

/**
 * The open jobs, twice over: the newest forty as the list the model may GUESS from, and every open
 * job (with its number, name, street and customer) for the exact match of what is printed on the
 * paper (jobFromPaperMarks). One read of jobs; the purchase orders ride beside it, and a PO read
 * that fails is no PO match, never a failed read.
 */
async function readerJobs(supabase: any, orgId: string | null): Promise<{ offered: ReaderJob[]; markJobs: MarkJob[]; pos: MarkPo[] }> {
  let jq = supabase.from("jobs").select("id, job_number, name, address, city, customers(name, company_name)");
  if (orgId) jq = jq.eq("org_id", orgId);
  const { data: jobs } = await jq.in("status", ACTIVE_JOB_STATUSES).order("created_at", { ascending: false }).limit(500);
  const rows = (jobs ?? []) as any[];
  let pos: MarkPo[] = [];
  try {
    let pq = supabase.from("purchase_orders").select("po_number, job_id");
    if (orgId) pq = pq.eq("org_id", orgId);
    const { data, error } = await pq.not("job_id", "is", null).limit(2000);
    if (!error) pos = ((data ?? []) as MarkPo[]).filter((p) => p?.po_number && p?.job_id);
  } catch {
    pos = [];
  }
  return {
    offered: rows.slice(0, 40).map((j) => ({
      id: j.id,
      label: `${j.job_number} — ${j.name}${j.customers?.name ? ` (${j.customers.name})` : ""}${j.address ? `, ${j.address}` : ""}${j.city ? `, ${j.city}` : ""}`,
    })),
    markJobs: rows.map((j) => ({
      id: String(j.id),
      job_number: j.job_number ?? null,
      name: j.name ?? null,
      address: j.address ?? null,
      customerNames: [j.customers?.name, j.customers?.company_name],
    })),
    pos,
  };
}

/**
 * READ ONE PAPER INTO ITS ROW, AND STOP THERE (Erik, 2026-09-24: "Organize photos wait for File
 * It").
 *
 * This used to be the second half of analyzeAndFile, and it FILED: a job the model matched with
 * medium confidence got a documents row and an itemized bill, and a receipt it called overhead
 * became a business cost, with no person looking at either. That is a model read writing money,
 * and a model read is a proposal. So this writes only the row: what the paper says, what KIND of
 * paper it is, the number printed on it, and what the reader SUGGESTS (the job the paper names, a
 * bucket). The row stays needs_review, "Ready To File", until a person picks where it goes and
 * presses File It, which is fileItem below and nothing else.
 *
 * The one exception is a handwritten note with no money on it: it is kept as a note, as before.
 * A note is not a cost, and making every grocery list wait for a button would be the annoying
 * kind of careful.
 */
async function readInto(
  ctx: { supabase: any; orgId: string | null; userId: string },
  itemId: string,
  file: { path: string; name: string; mime: string },
  opts: { personSaysCost?: boolean } = {},
): Promise<OrganizedResult> {
  const supabase = ctx.supabase;
  const { offered: jobList, markJobs, pos } = await readerJobs(supabase, ctx.orgId);

  const { data: blob, error: dlErr } = await supabase.storage.from("documents").download(file.path);
  if (dlErr || !blob) {
    await updateItemTolerant(supabase, itemId, ctx.orgId, { proposal: { readError: "the file couldn't be opened" } });
    revalidatePath("/organize");
    revalidatePath("/bills");
    return { ok: false, error: `${dlErr?.message ?? "Could not read the upload."} It is saved and waiting; press Read Now to try again.` };
  }
  const bytes = await blob.arrayBuffer();
  // TOO BIG TO READ IS NOT TOO BIG TO KEEP. The file is in; the row says so and keeps every
  // control, and a person types the total in.
  if (bytes.byteLength > READ_LIMIT) {
    await updateItemTolerant(supabase, itemId, ctx.orgId, { proposal: { tooBig: true } });
    revalidatePath("/organize");
    revalidatePath("/bills");
    return { ok: false, error: "Too big to read: fill it in yourself. It is saved and waiting." };
  }
  const base64 = Buffer.from(bytes).toString("base64");
  const isImage = IMAGE_TYPES.includes(file.mime);
  const mediaBlock: any = isImage
    ? { type: "image", source: { type: "base64", media_type: file.mime, data: base64 } }
    : { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };

  let parsed: any;
  try {
    const client = getAnthropic();
    const trade = await tradeOf(supabase, ctx.orgId);
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: paperReaderSystem(trade, jobList),
      messages: [
        {
          role: "user",
          content: [
            mediaBlock,
            {
              type: "text",
              text: `Filename: ${file.name}. ${opts.personSaysCost ? "The person who uploaded it says it is a bill or a receipt. " : ""}Classify and extract.`,
            },
          ],
        },
      ],
    });
    // METER (0162): receipt/document reads are a real cost centre, not just chat.
    void recordAiUsage({ orgId: ctx.orgId, model: (msg as { model?: string }).model ?? DEFAULT_MODEL, surface: "organize", usage: msg.usage as never });
    const text = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    parsed = await parseAiJson(client, text?.text ?? "", ctx.orgId);
  } catch (e: any) {
    // The paper is NOT lost: the row stays in the tray, saying it was not read.
    await updateItemTolerant(supabase, itemId, ctx.orgId, { proposal: { readError: "the reader didn't answer" } });
    revalidatePath("/organize");
    revalidatePath("/bills");
    return { ok: false, error: `${e?.message ?? "AI could not read this file."} It is saved and waiting; press Read Now to try again.` };
  }

  const f = readerFields(parsed, jobList, file.name, { markJobs, pos, personSaysCost: opts.personSaysCost });
  const keepsItself = f.kind === "note" && f.amount === null && !opts.personSaysCost;
  const { error } = await updateItemTolerant(supabase, itemId, ctx.orgId, {
    kind: f.kind,
    title: f.title,
    summary: f.summary,
    vendor: f.vendor,
    amount: f.amount,
    item_date: f.item_date,
    category: f.category,
    confidence: f.confidence,
    status: keepsItself ? "filed" : "needs_review",
    line_items: f.line_items,
    // HOW it was paid, so File It honours the paper instead of re-guessing from the category (0153).
    payment: f.payment,
    doc_type: keepsItself ? null : f.doc_type,
    doc_number: f.doc_number,
    pricing_provisional: f.pricing_provisional,
    proposal: f.proposal,
  });
  if (error) return { ok: false, error: dbError(error) };

  revalidatePath("/organize");
  revalidatePath("/bills");
  const labelOf = (id: string | null | undefined) => {
    if (!id) return null;
    const j = markJobs.find((x) => x.id === id);
    return j ? `${j.job_number ?? ""}${j.name ? ` ${j.name}` : ""}`.trim() || null : null;
  };
  const pickedJob = labelOf(f.proposal.jobId);
  const guessedJob = labelOf(f.proposal.guessJobId);
  const because = pickedBecause({ id: itemId, doc_type: f.doc_type, category: f.category, proposal: f.proposal });
  return {
    ok: true,
    item: {
      id: itemId,
      kind: f.kind,
      title: f.title,
      summary: f.summary,
      vendor: f.vendor,
      amount: f.amount,
      item_date: f.item_date,
      job_id: null,
      job_label: null,
      confidence: f.confidence,
      status: keepsItself ? "filed" : "needs_review",
      destination: keepsItself ? "note" : "none",
      picture: f.proposal.picture === true,
      suggestion:
        pickedJob || guessedJob || f.proposal.bucket
          ? {
              jobLabel: pickedJob ?? guessedJob,
              bucket: f.proposal.bucket ?? null,
              picked: !!pickedJob,
              because: pickedJob ? because : null,
            }
          : null,
    },
  };
}

/**
 * "Organize My": an already-uploaded file becomes a row in the tray, and is READ. It is not filed.
 * The name stays because Nort's registry and the tray both call it; what it does changed on
 * 2026-09-24 (see readInto).
 */
export async function analyzeAndFile(input: {
  path: string; // storage path in the 'documents' bucket
  name: string;
  mime: string;
  size: number;
  /** The file's fingerprint (0295). The same file twice is one row. */
  sha256?: string | null;
}): Promise<OrganizedResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // Cheap input validation first — junk input gets a clean rejection, no row.
  const isImage = IMAGE_TYPES.includes(input.mime);
  const isPdf = input.mime === "application/pdf";
  if (!isImage && !isPdf) {
    return { ok: false, error: "Use a photo (JPG/PNG) or PDF — other file types can't be read yet." };
  }

  // Save the capture BEFORE the AI ever runs, so a failed read can never lose a photographed
  // receipt: worst case it waits in the tray for Read Now or a person's own numbers.
  const placed = await insertPaperRow(supabase, {
    title: String(input.name),
    file_url: input.path,
    created_by: ctx.userId,
    content_sha256: isSha256(input.sha256) ? input.sha256 : null,
    source: "organize",
  });
  if ("duplicate" in placed) {
    return { ok: false, error: `${input.name} is already in: the same file was added before, so it wasn't added twice.` };
  }
  if ("error" in placed) return { ok: false, error: dbError(placed.error) };

  return readInto(ctx, placed.id, input);
}

/** Read Now: run the reader on a row already in the tray (a read that failed, or never ran). */
export async function readPaperworkItem(id: string): Promise<OrganizedResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data: item } = await ctx.supabase
    .from("organized_items")
    .select("id, title, file_url, status")
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (!item) return { ok: false, error: "That paper isn't here any more." };
  if (item.status !== "needs_review") return { ok: false, error: "This is already filed. Undo it first to read it again." };
  if (!item.file_url) return { ok: false, error: "There is no file on this one to read." };
  const mime = mimeFromName(item.file_url);
  if (!mime) return { ok: false, error: "This file isn't a photo or a PDF, so it can't be read. Fix Details and fill it in." };
  return readInto(ctx, String(item.id), { path: String(item.file_url), name: String(item.title ?? "Paper"), mime });
}

/**
 * "BILL OR RECEIPT": a person's answer to "What is this?" on a picture (Erik, 2026-09-24). The
 * row becomes a receipt FIRST, in its own write, so whatever the read does next the question is
 * answered and the row shows the cost controls. Then it is read again, told what the person said,
 * for the total, the lines and anything printed on it that names a job. The job is picked only if
 * the paper names one; otherwise the row asks where it goes. Nothing is filed.
 */
export async function readAsCost(id: string): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data: item } = await ctx.supabase
    .from("organized_items")
    .select("id, title, file_url, status, proposal")
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (!item) return { ok: false, error: "That paper isn't here any more." };
  if (item.status !== "needs_review") return { ok: false, error: "This is already filed. Undo it first, then change what it is." };
  const { picture: _wasPicture, ...rest } = proposalOf(item);
  const { data: back, error } = await updateItemTolerant(ctx.supabase, id, ctx.orgId, {
    doc_type: "receipt",
    kind: "receipt",
    category: "Receipt",
    payment: "unknown",
    proposal: rest,
  });
  if (error) return { ok: false, error: dbError(error) };
  if (!back?.length) return { ok: false, error: "Nothing changed. That paper isn't here any more, or this login can't change it." };
  revalidatePath("/organize");
  revalidatePath("/bills");

  const mime = mimeFromName(item.file_url);
  if (!item.file_url || !mime)
    return { ok: true, message: "Marked as a bill or receipt. Fix Details and put the total in, then pick where it goes." };
  const read = await readInto(ctx, String(item.id), { path: String(item.file_url), name: String(item.title ?? "Paper"), mime }, { personSaysCost: true });
  if (!read.ok)
    return { ok: true, message: `Marked as a bill or receipt, but it wasn't read: ${read.error ?? "the reader didn't answer."} Fix Details and put the total in.` };
  const s = read.item?.suggestion;
  return {
    ok: true,
    message:
      s?.picked && s.because
        ? `Read as a bill or receipt. ${s.because}: ${s.jobLabel}. Press File It if that's right.`
        : "Read as a bill or receipt. Pick where it goes, then press File It.",
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
export async function billJobReceipt(
  documentId: string,
  /** What the PERSON stated in the capture form. User attestation beats AI inference:
   *  they were standing at the counter. The AI fills only what was left blank.
   *  billDate is a date the person SET and beats the paper; fallbackBillDate is only the form's
   *  seeded day, used when the paper has no legible date either (so the bill is never dateless). */
  stated?: { paid?: boolean; category?: string | null; billDate?: string | null; fallbackBillDate?: string | null },
): Promise<{
  ok: boolean;
  error?: string;
  already?: boolean;
  amount?: number | null;
  vendor?: string | null;
  lineCount?: number;
  /** Set when the transcribed lines don't add up to the total the bill recorded — the caller
   *  should show it. Nothing silent: a number a person hasn't checked must say so. */
  warning?: string;
}> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

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

  // Budget-vs-actual: the job's estimate scopes. The receipt AI tags this whole cost with the
  // best-fit scope so ACTUAL costs join the estimate BUDGET by scope (the per-scope variance
  // Nort reads). Empty = the job has no scoped estimate → the cost stays Uncategorized.
  const jobScopes = await listJobScopes(supabase, doc.job_id);
  const scopeSchemaLine = jobScopes.length
    ? `\n  "scope_category": one of ${jobScopes.map((s) => `"${s.replace(/"/g, "")}"`).join(" | ")} | "Uncategorized" — the JOB SCOPE this whole receipt belongs to (the single best fit for what was bought; "Uncategorized" if unclear),`
    : "";

  let parsed: any;
  try {
    const client = getAnthropic();
    const trade = await tradeOf(supabase, ctx.orgId);
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: `You read a purchase receipt for a ${trade} and itemize it as a job cost.

Respond with ONLY a JSON object (no prose):
{
  "vendor": store/supplier name or null,
  "amount": grand total in dollars as a number (the amount actually paid), or null only if you truly cannot read it,
  "date": "YYYY-MM-DD" printed on the receipt, or null,
  "document_number": the invoice, ticket or receipt number printed on it, exactly as printed, or null,
  "line_items": [{"description": item name, "quantity": number, "unit_price": price each (number), "amount": line total (number), "category": ${RECEIPT_LINE_CATEGORY_SCHEMA_HINT}}],${scopeSchemaLine}
  "pricing_provisional": true | false — true when the price column is masked (*****), blank or "N/A", or the paper is a quote/counter preview rather than this account's own pricing,
  "payment": "paid_at_purchase" | "on_account" | "unknown" — "paid_at_purchase" ONLY when the document shows tender (cash tendered/change, a card number/••••, or an explicit PAID stamp); "on_account" when it shows a charge account, ON ACCT, net terms, "invoice", or a balance due (supply-house account purchases),
  "confidence": "low" | "medium" | "high"
}
Transcribe EVERY readable line, including tax as its own line. Use [] for line_items only if nothing is legible.
In every "description", write inches as the word in (e.g. "6 in EMT", not 6") and never put a raw double-quote character inside a JSON string.

${FOOD_AND_DRINK_PROMPT_RULE}

${MASKED_PRICE_PROMPT_RULE}`,
      messages: [
        {
          role: "user",
          content: [mediaBlock, { type: "text", text: `Filename: ${doc.name}. Read the total and itemize.` }],
        },
      ],
    });
    // METER (0162): receipt/document reads are a real cost centre, not just chat.
    void recordAiUsage({ orgId: ctx.orgId, model: (msg as { model?: string }).model ?? DEFAULT_MODEL, surface: "organize", usage: msg.usage as never });
    const text = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    parsed = await parseAiJson(client, text?.text ?? "", ctx.orgId);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "AI could not read this receipt." };
  }

  const aiAmount = parsed.amount != null && !isNaN(Number(parsed.amount)) ? Number(parsed.amount) : null;
  const itemDate = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date ?? "")) ? parsed.date : null;
  const lines = cleanLines(parsed.line_items);
  const vendor = parsed.vendor ? String(parsed.vendor).slice(0, 200) : doc.name || "Receipt";
  const confidence = ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "medium";
  // Trust the AI's scope only if it's one of THIS job's real scopes (never let it invent one);
  // else leave null → Uncategorized. This is what makes budget and actual join by scope.
  const allowedScopes = new Set([...jobScopes, "Uncategorized"]);
  const scopeCategory =
    jobScopes.length && allowedScopes.has(String(parsed.scope_category ?? "")) ? String(parsed.scope_category) : null;

  // Fall back to the line-item sum if Claude couldn't read a printed grand total.
  const lineSum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const amount = aiAmount != null ? aiAmount : lineSum > 0 ? Math.round(lineSum * 100) / 100 : null;
  if (amount == null) {
    return {
      ok: false,
      error: "Couldn't read a total on this receipt. Open it and enter the cost manually as a bill.",
    };
  }

  // DOES IT ADD UP? The reader asks the model for a grand total AND every line, then used the
  // total and never compared the two. A misread total — a subtotal, a prior balance, a
  // transposed digit — became the bill's amount with the model's own transcription underneath
  // saying otherwise. That number is job cost, it is the actual side of budget-vs-actual, and
  // importCostsIntoInvoice marks it up and bills it to the homeowner. See receipt-reconcile for
  // why this flags rather than corrects.
  const check = reconcileReceipt(amount, lines);

  // IS THIS PAPER PRICED FOR HIM, OR JUST PRICED? (0271.) The Organize reader always carried this
  // flag onto its bill and this reader, the one behind Snap the Bill and Record as Cost, dropped
  // it: a masked counter preview read here became an ordinary bill whose retail prices the price
  // book then learned. Two chances at the same fact, as there: what the reader answered, or the
  // mask still visible in what it transcribed.
  const provisional =
    parsed?.pricing_provisional === true || lines.some((l) => looksProvisionallyPriced(l?.description));
  const docNumber = cleanDocNumber(parsed?.document_number);
  const accountId = await exactAccountFor(supabase, ctx.orgId, vendor);

  const billId = await insertItemizedBill(
    supabase,
    {
      job_id: doc.job_id,
      supplier: vendor,
      amount,
      bill_date: stated?.billDate || itemDate || stated?.fallbackBillDate || null,
      category: stated?.category || "Receipt",
      scope_category: scopeCategory, // job scope for budget-vs-actual (null → Uncategorized)
      notes: check.mismatch
        ? `Receipt recorded as cost: ${doc.name}\n\n${check.note}`
        : `Receipt recorded as cost: ${doc.name}`,
      created_by: ctx.userId,
      pricing_provisional: provisional,
      bill_number: docNumber ?? undefined,
      supplier_account_id: accountId ?? undefined,
    },
    lines,
    // Paid ONLY when the receipt itself shows tender. Supply-house account purchases
    // (CED "ON ACCT" transaction records — most of Erik's) are debts until the statement
    // is settled; stamping them paid silently hid real payables. Unknown = unpaid: a
    // wrongly-unpaid bill nags and gets corrected, a wrongly-paid one loses money.
    // The user's own "Already paid" checkbox wins when they ticked it — they were there.
    stated?.paid ? "paid" : parsed.payment === "paid_at_purchase" ? "paid" : "unpaid",
  );
  if (!billId) return { ok: false, error: "Could not create the bill." };

  // Link record so the receipt is known to be billed (drives idempotency above).
  const { data: link, error: linkErr } = await supabase.from("organized_items").insert({
    kind: "receipt",
    title: vendor,
    summary: null,
    vendor,
    amount,
    item_date: stated?.billDate || itemDate || stated?.fallbackBillDate || null,
    category: stated?.category || "Receipt",
    confidence,
    payment: stated?.paid ? "paid_at_purchase" : (parsed.payment ?? "unknown"),
    status: "filed",
    job_id: doc.job_id,
    document_id: documentId,
    bill_id: billId,
    line_items: lines.length ? lines : null,
    file_url: doc.file_url,
    created_by: ctx.userId,
  }).select("id");

  // THE LINK ROW IS THE IDEMPOTENCY (same pass as 0278, same class as the teardown above).
  //
  // The "have we already billed this document?" check at the top of this function reads THIS row
  // and nothing else. Written and thrown away, a failure here was invisible and the receipt stayed
  // forever un-billed in the app's eyes: the next tap on Record as Cost reads the same paper again
  // and writes a SECOND bill on the job, double job cost and double marked-up material on the
  // customer's invoice. Exactly the duplicate the teardown checks exist to stop, arriving from the
  // other direction.
  //
  // The bill IS in, so this cannot refuse - throwing an error here would lose a real cost over a
  // bookkeeping row. It rides out on `warning`, which every caller already prints (see
  // receipt-capture's readReceiptDocument), alongside the ops-log line the daily sweep reads.
  const linkMissing = linkErr || !link?.length;
  if (linkMissing) {
    reportError("organize:billJobReceipt.link", linkErr ?? new Error("link insert returned no row"), {
      documentId,
      billId,
      jobId: doc.job_id,
    });
  }
  const linkWarning = linkMissing
    ? "The cost is recorded, but this receipt did not get marked as billed. Tapping Record as Cost on it again would write a second bill, so check the job's costs first."
    : null;

  revalidatePath("/bills");
  revalidatePath("/analytics");
  revalidatePath(`/jobs/${doc.job_id}`);
  return {
    ok: true,
    amount,
    vendor,
    lineCount: lines.length,
    // Both facts or neither: a receipt that did not add up AND did not get linked has two things
    // wrong with it, and hiding one behind the other is how the second one gets found in a month.
    warning: [check.mismatch ? check.note : null, linkWarning].filter(Boolean).join(" ") || undefined,
  };
}

/**
 * THE DATABASE'S REFUSAL, SAID FOR THE DOOR IT CAME THROUGH (0278).
 *
 * guard_billed_bill raises ONE sentence for every door that deletes a bill, and it ends "then
 * delete this receipt" - right under the trash icon, wrong here, where Erik tapped a job name and
 * expected the receipt to MOVE. A refusal that names an action he did not take reads as a second,
 * different bug, and he stops trusting the first sentence too.
 *
 * So the invoice number stays the DATABASE'S (never ours to guess or re-look-up - it is the one
 * fact this app must not invent), and only the tail is this door's. Matching on the guard's own
 * words is deliberate: anything the guard did NOT say falls through to dbError with its text
 * intact, because an unrecognised error keeps its exact wording - that is how bug reports work
 * here.
 *
 * The leading \S matters. invoice_holding_claim coalesces a missing number to "another invoice",
 * so a cross-org claimant opens the sentence in lower case and, if that fallback ever became an
 * empty string, would open it with a space. Require a real first character, then upper-case it,
 * and the toast reads like a sentence either way.
 */
function billClaimRefusal(err: unknown, tail: string): string | null {
  const msg = String((err as { message?: unknown } | null)?.message ?? "");
  const held = msg.match(/^(\S.*? already bills this receipt\.)/);
  if (!held) return null;
  return `${held[1][0].toUpperCase()}${held[1].slice(1)} ${tail}`;
}

// NO PETTY CASH DESTINATION (2026-09-24). Filing a receipt to petty cash wrote an expense with no
// job and replaced the receipt's category with "Receipt", so a job purchase quietly became a
// business cost: that is how CED 8802-1101094, $379.35 of parts for the Rhodesia job, ended up in
// the cash box. A receipt now goes to a job or to one of the six business-cost buckets. An item
// filed to petty cash before this still has its petty_cash_id, and re-filing it tears that row
// down below exactly as before.
export type FileDestination =
  | { type: "job"; jobId: string }
  /** A picture on a job's Photos (Erik, 2026-09-24): a documents row, never a bill. */
  | { type: "photo"; jobId: string }
  | { type: "overhead"; category: string }
  | { type: "unfiled" };

export type FileOptions = {
  /** A person looked at "already on the books" and said it is a different purchase. */
  differentPurchase?: boolean;
};

/** A number match, said as the sentence File It refuses with. */
function sameNumberRefusal(matches: NumberMatch[]): string {
  return `${matches[0].sentence} If it is the same purchase, press Same Purchase: Tie Them. If it is not, press Different Purchase: File It Anyway. Nothing was filed.`;
}

/**
 * Tear down whatever the previous filing made, bill FIRST and only if the database lets it (0278).
 * Returns the refusal sentence, or null when everything came down. The tail names the door.
 */
async function tearDownFiling(supabase: any, item: any, tail: string): Promise<string | null> {
  // THE BILL COMES DOWN FIRST, AND ONLY IF THE DATABASE LETS IT (0278; audit of cn-v951..v966).
  //
  // Re-filing tears the old filing down and builds a new one, and this line tore down a bill a
  // LIVE INVOICE was already billing. invoice_items has no foreign key to bills - a claim is a
  // uuid inside an array - so the invoice lines survived the delete intact and went on charging
  // the customer for a receipt that no longer existed, while the job's cost dropped by the same
  // amount and its margin jumped. Re-filing is the worse half: the replacement bill comes back
  // with a NEW id that no claim covers, so importCostsIntoInvoice will bill the same purchase to
  // a second customer. Bill c0535cdb, $467.87 of CED on J-046, is claimed by eight lines of
  // INV-069 that Jason has already part paid.
  //
  // FIRST, ahead of the document and petty-cash rows, so a refusal leaves the item exactly as it
  // was. No zero-row refusal here, unlike the trash door: bills_write and the organized_items read
  // are the same org+staff gate, so zero rows means the bill is simply already gone (bill_id is
  // ON DELETE SET NULL, and a retry after a half-finished move lands here).
  //
  // A TIED bill (0295) is never here: tied_bill_id is its own column precisely so that this
  // teardown, which deletes bill_id, can never delete a bill this row did not make.
  if (item.bill_id) {
    const { error: billErr } = await supabase.from("bills").delete().eq("id", item.bill_id).select("id");
    if (billErr) return billClaimRefusal(billErr, tail) ?? dbError(billErr);
  }
  // Then the rest of the previous filing. The petty-cash row is torn down HERE too (audit 9,
  // 0202). Both are checked for the bill's own reason - a teardown that fails and says nothing
  // becomes a SECOND row a moment later.
  if (item.document_id) {
    const { error: docErr } = await supabase.from("documents").delete().eq("id", item.document_id).select("id");
    if (docErr) return `${dbError(docErr)} The old copy is still on the job, so nothing was changed.`;
  }
  if (item.petty_cash_id) {
    const { error: pcErr } = await supabase.from("petty_cash").delete().eq("id", item.petty_cash_id).select("id");
    if (pcErr) return `${dbError(pcErr)} The old petty cash entry is still in the drawer, so nothing was changed.`;
  }
  return null;
}

/**
 * FILE IT: THE ONE DOOR A PIECE OF PAPER BECOMES MONEY THROUGH (0295).
 *
 * A person picked where it goes and pressed the button. Every surface that files paper calls this:
 * the Organize tray, Drop Paperwork on /bills, and nothing else. There used to be a second, weaker
 * way in on /organize (a job dropdown that filed the moment it changed, with the category hard-
 * coded to "Receipt", no counter-preview flag and no look at what was already on the books), and a
 * third that let the model file on its own (AI Review & File). Both are gone; this is the only
 * path, and it asks the same question the button does (fileRefusal) before it writes anything.
 *
 * Re-filing tears down whatever the previous filing made, then creates the new rows, so moving
 * things around can never double-count.
 */
export async function fileItem(id: string, dest: FileDestination, opts: FileOptions = {}): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Checked BEFORE anything is torn down, so a bad bucket costs nothing.
  if (dest.type === "overhead" && !isBusinessCostBucket(dest.category))
    return { ok: false, error: "Pick one of the six business cost buckets. Nothing was moved." };

  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  if (!item) return { ok: false, error: "Item not found." };

  const type = paperTypeOfItem(item);
  const isCost = type === "receipt" || type === "bill";

  // THE GATE: the same function the File It button asks. A paper not read, with no total, of a kind
  // this update cannot file, or already filed, is refused here in the sentence the row shows.
  if (dest.type !== "unfiled") {
    const refusal = fileRefusal(
      item,
      dest.type === "job" || dest.type === "photo" ? { type: dest.type, jobId: dest.jobId } : { type: "overhead", category: dest.category as never },
    );
    if (refusal) return { ok: false, error: refusal };
  }

  // IS THIS PURCHASE ALREADY ON THE BOOKS? Same printed number, same supplier. Asked here, on the
  // server, every time, so no screen that forgot to show the offer can make a second bill. A
  // person who has looked and says it is a different purchase passes differentPurchase.
  //
  // Only a BILL refuses (a bill with this number, or the bill that already covers a CED document
  // with it). A CED document NO bill covers is not a cost - owner-money counts bills - so tying to
  // it recorded nothing and dropped the job the person picked, and the only other way through made
  // them sign a note saying it was a different purchase when it was the same one (J-046's counter
  // sheet 8802-1108330, photographed after the CED PDF went on the list). That document is LINKED
  // to the bill this makes, in the same press, and the button said so before it was pressed.
  let linkTo: { id: string; number: string }[] = [];
  if (dest.type !== "unfiled" && dest.type !== "photo" && isCost && item.doc_number && !opts.differentPurchase) {
    const books = await loadBooks(supabase, ctx.orgId);
    const found = matchesOnBooks(item, books);
    const onBooks = found.filter((m) => m.kind === "bill");
    if (onBooks.length) return { ok: false, error: sameNumberRefusal(onBooks) };
    linkTo = found.flatMap((m) => (m.kind === "supplier_invoice" ? [{ id: m.supplierInvoiceId, number: m.invoiceNumber }] : []));
  }

  // CLAIM THE PAPER BEFORE WRITING A CENT (check-then-insert, the v951 class). The same paper
  // shows on /bills Sort These and in the /organize tray, and two presses at once both passed the
  // gate above, both found no bill, and both made one: two bills for one paper, the row pointing at
  // only one, the other orphaned where Undo could never reach it. The row moves out of
  // needs_review ONLY IF it is still there, so exactly one press gets past this line. Every way
  // out below puts it back.
  const claimed = dest.type !== "unfiled";
  if (claimed) {
    const { data: mine, error: claimErr } = await supabase
      .from("organized_items")
      .update({ status: "filed" })
      .eq("id", id)
      .eq("org_id", ctx.orgId)
      .eq("status", "needs_review")
      .select("id");
    if (claimErr) return { ok: false, error: `${dbError(claimErr)} Nothing was filed.` };
    if (!mine?.length)
      return { ok: false, error: "Someone else is filing this paper right now, or just did. Nothing was filed twice; refresh to see where it went." };
  }
  const release = async () => {
    if (claimed) await supabase.from("organized_items").update({ status: "needs_review" }).eq("id", id).eq("org_id", ctx.orgId).select("id");
  };

  const refused = await tearDownFiling(
    supabase,
    item,
    "Void that invoice, or take its materials lines off, then file this again. Nothing was moved.",
  );
  if (refused) {
    await release();
    return { ok: false, error: refused.replace("so nothing was changed", "so this was not re-filed") };
  }
  const prevJob = item.job_id;
  const lines = cleanLines(item.line_items);

  let documentId: string | null = null;
  let billId: string | null = null;
  let jobId: string | null = null;
  let category: string | null = item.category;
  const paperCategory = billCategoryFor(item);
  const vendor = item.vendor ?? item.title;
  // What a person said at the "already on the books" question rides on the bill, so the next
  // person who sees two bills with one number knows it was decided, not missed.
  const decided = opts.differentPurchase ? "\nA person checked: a different purchase from the one already on the books with this number." : "";
  const billFacts = isCost
    ? {
        pricing_provisional: item.pricing_provisional === true,
        bill_number: item.doc_number ? String(item.doc_number) : undefined,
        supplier_account_id: (await exactAccountFor(supabase, ctx.orgId, vendor)) ?? undefined,
      }
    : {};

  // A cost that did not land puts the paper back in the tray holding nothing, and says so, instead
  // of reading "Filed" over a cost that does not exist. A bill this press made a moment ago comes
  // down with it: nothing can have claimed it yet.
  const backToTray = async (message: string): Promise<Result> => {
    if (billId) await supabase.from("bills").delete().eq("id", billId).select("id");
    if (documentId) await supabase.from("documents").delete().eq("id", documentId).select("id");
    await supabase
      .from("organized_items")
      .update({ job_id: null, document_id: null, bill_id: null, petty_cash_id: null, status: "needs_review" })
      .eq("id", id)
      .eq("org_id", ctx.orgId)
      .select("id");
    revalidatePath("/organize");
    revalidatePath("/bills");
    if (prevJob) revalidatePath(`/jobs/${prevJob}`);
    return { ok: false, error: message };
  };

  if (dest.type === "job" || dest.type === "photo") {
    jobId = dest.jobId;
    // The copy on the job carries what the paper IS (a Bill stays a Bill), never a hard-coded
    // "Receipt". A JOB PHOTO is a "Photo" on the job, the same row the job page's own camera makes
    // (uploadJobPhotos → addDocument), so it shows in that job's Photos. It is never a cost: the
    // gate above refused a bill or receipt, and the bill below is for "job" only.
    // A picture a person called "Something Else" and put on a job is kept there as "Other", not
    // as a photo they said it wasn't.
    const docCategory =
      dest.type === "photo"
        ? "Photo"
        : isCost
          ? paperCategory
          : item.category && item.kind === "job_document" && item.category !== "Photo"
            ? item.category
            : "Other";
    category = docCategory;
    const { data: doc } = await supabase
      .from("documents")
      .insert({
        job_id: dest.jobId,
        name: item.title,
        category: docCategory,
        kind: "other",
        file_url: item.file_url,
        uploaded_by: ctx.userId,
      })
      .select("id")
      .single();
    documentId = doc?.id ?? null;
    // For a photo the copy on the job IS the filing: a photo that did not land is not "Filed".
    if (dest.type === "photo" && !documentId)
      return backToTray("The photo didn't save on the job, so it is back in the tray. Try again.");
    // A receipt or bill filed to a job becomes an itemized billable cost on that job.
    if (dest.type === "job" && isCost && item.amount != null) {
      billId = await insertItemizedBill(
        supabase,
        {
          job_id: dest.jobId,
          supplier: vendor,
          amount: item.amount,
          bill_date: item.item_date,
          category: paperCategory,
          notes: `${paperCategory} filed by a person from the tray: ${item.title}${decided}`,
          created_by: ctx.userId,
          ...billFacts,
        },
        lines,
        billStatusFromItem(item),
      );
      if (!billId) return backToTray("The cost didn't save, so this paper is back in the tray. Try File It again.");
    }
  } else if (dest.type === "overhead") {
    category = dest.category;
    billId = await insertItemizedBill(
      supabase,
      {
        job_id: null,
        supplier: vendor,
        amount: item.amount ?? 0,
        bill_date: item.item_date,
        category: dest.category,
        notes: `Business cost filed by a person from the tray: ${item.title}${decided}`,
        created_by: ctx.userId,
        ...billFacts,
      },
      lines,
      billStatusFromItem(item),
    );
    // A business cost IS its bill; there is no copy on a job to show for it.
    if (!billId) return backToTray("The business cost didn't save, so this receipt is back in Needs Review. Try again.");
  }

  // THE CED DOCUMENT THIS PAPER IS (see linkTo above). 0277 lets one bill cover an invoice, once:
  // a duplicate key means another bill covered it between the check and now, so this bill comes
  // down and the paper goes back to show the Tie. Any other failure keeps the cost, which is real,
  // and says the link is missing rather than passing quietly.
  let linkNote = "";
  if (billId && linkTo.length) {
    for (const si of linkTo) {
      const { data: linked, error: linkErr } = await supabase
        .from("bill_supplier_invoices")
        .insert({ org_id: ctx.orgId, bill_id: billId, supplier_invoice_id: si.id })
        .select("id");
      if (linkErr && String((linkErr as { code?: string }).code ?? "") === "23505")
        return backToTray(`CED ${si.number} was just covered by another bill, so this was not filed. It is back in the tray; look again and tie it to that bill.`);
      if (linkErr || !linked?.length) {
        reportError("organize:fileItem.link", linkErr ?? new Error("bill_supplier_invoices insert wrote no rows"), { billId, supplierInvoiceId: si.id });
        linkNote = ` The link to CED ${si.number} didn't save; the cost is on the books, and Record It As A Bill on that document will tie the two.`;
      }
    }
  }

  const patch: Record<string, unknown> = {
    job_id: jobId,
    document_id: documentId,
    bill_id: billId,
    // petty_cash_id is cleared in the SAME write as the others, so a receipt filed to petty cash
    // before that door closed leaves no stale link once it is re-filed (audit 9).
    petty_cash_id: null,
    category,
    status: dest.type === "unfiled" ? "needs_review" : "filed",
  };
  // How it was filed rides on the proposal, so Undo takes down exactly this and nothing else.
  if ("proposal" in item)
    patch.proposal = { ...proposalOf(item), filed: dest.type === "unfiled" ? null : { how: dest.type === "photo" ? "photo" : "bill" } };
  const { data: wrote, error } = await supabase.from("organized_items").update(patch).eq("id", id).eq("org_id", ctx.orgId).select("id");
  if (error || !wrote?.length) {
    // The row that says where the bill is did not save: a bill nothing points at is one Undo can
    // never reach, so it comes down and the paper goes back.
    if (claimed) return backToTray(`${error ? dbError(error) : "The paper's row didn't save."} Nothing was filed; it is back in the tray.`);
    return { ok: false, error: error ? dbError(error) : "Nothing was moved. That paper isn't here any more, or this login can't change it." };
  }

  revalidatePath("/organize");
  revalidatePath("/bills");
  revalidatePath("/petty-cash");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  if (prevJob) revalidatePath(`/jobs/${prevJob}`);
  const linkedSaid = linkTo.length && !linkNote ? ` Linked to CED ${linkTo.map((l) => l.number).join(", ")}.` : "";
  return linkedSaid || linkNote ? { ok: true, message: `Filed.${linkedSaid}${linkNote}` } : { ok: true };
}

/**
 * UNDO A FILING (0295). The paper goes back to the tray exactly as it was read, and whatever the
 * filing made comes down under the same 0278 ceiling as every other teardown: a bill a live
 * invoice already bills cannot be un-filed, and the sentence says which invoice and what to do.
 *
 *   · a TIE made nothing, so undoing one removes nothing but the link.
 *   · CED documents added from a PDF: the ones this paper ADDED come off the list, unless
 *     something already points at them (a bill covering it, a job a person set, or another paper
 *     tied to it), which are named and kept.
 */
export async function undoPaperwork(id: string): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  if (!item) return { ok: false, error: "That paper isn't here any more." };
  const p = proposalOf(item);
  const tied = !!(item.tied_bill_id || item.tied_supplier_invoice_id);
  if (item.status === "needs_review" && !item.bill_id && !item.document_id && !item.petty_cash_id && !tied)
    return { ok: false, error: "Nothing to undo: this paper is still waiting to be filed." };

  const kept: string[] = [];
  if (p.filed?.how === "supplier_documents" && p.filed.landed?.length) {
    const { data: docs } = await supabase
      .from("supplier_invoices")
      .select("id, invoice_number, job_id")
      .eq("org_id", ctx.orgId)
      .in("invoice_number", p.filed.landed);
    const ids = (docs ?? []).map((d: any) => String(d.id));
    const { data: links } = ids.length
      ? await supabase.from("bill_supplier_invoices").select("supplier_invoice_id").in("supplier_invoice_id", ids)
      : { data: [] };
    const linked = new Set((links ?? []).map((l: any) => String(l.supplier_invoice_id)));
    // ANOTHER PAPER TIED TO ONE OF THEM. tied_supplier_invoice_id is ON DELETE SET NULL (0295), so
    // deleting the document would leave that paper "filed", tied to nothing, gone from the tray
    // without a word. It is kept and named like the rest.
    const { data: tiedPapers } = ids.length
      ? await supabase.from("organized_items").select("tied_supplier_invoice_id").eq("org_id", ctx.orgId).in("tied_supplier_invoice_id", ids)
      : { data: [] };
    for (const t of tiedPapers ?? []) if ((t as any)?.tied_supplier_invoice_id) linked.add(String((t as any).tied_supplier_invoice_id));
    const removable = (docs ?? []).filter((d: any) => !linked.has(String(d.id)) && !d.job_id);
    for (const d of docs ?? []) if (!removable.includes(d)) kept.push(String(d.invoice_number));
    if (removable.length) {
      const { error: delErr } = await supabase
        .from("supplier_invoices")
        .delete()
        .eq("org_id", ctx.orgId)
        .in("id", removable.map((d: any) => String(d.id)))
        .select("id");
      if (delErr) return { ok: false, error: `${dbError(delErr)} Nothing was undone.` };
    }
  } else if (!tied) {
    const refused = await tearDownFiling(
      supabase,
      item,
      "Void that invoice, or take its materials lines off, then press Undo again. Nothing was undone.",
    );
    if (refused) return { ok: false, error: refused.replace("so nothing was changed", "so nothing was undone") };
  }

  const type = paperTypeOfItem(item);
  const patch: Record<string, unknown> = {
    job_id: null,
    document_id: null,
    bill_id: null,
    petty_cash_id: null,
    status: "needs_review",
    // A business-cost filing replaced the category with its bucket; the paper gets its own back.
    category: type === "receipt" || type === "bill" ? billCategoryFor({ doc_type: item.doc_type, category: null }) : item.category,
  };
  if ("tied_bill_id" in item) {
    patch.tied_bill_id = null;
    patch.tied_supplier_invoice_id = null;
  }
  if ("proposal" in item) patch.proposal = { ...p, filed: null };
  const { data: back, error } = await supabase.from("organized_items").update(patch).eq("id", id).eq("org_id", ctx.orgId).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!back?.length) return { ok: false, error: "Nothing was undone. That paper isn't here any more, or this login can't change it." };

  revalidatePath("/organize");
  revalidatePath("/bills");
  if (item.job_id) revalidatePath(`/jobs/${item.job_id}`);
  return {
    ok: true,
    message: `${tied ? "Untied" : "Undone"}. It is back in the tray, waiting for File It.${kept.length ? ` ${kept.join(", ")} stayed on the CED documents list, because a bill, a job or another paper already points at ${kept.length === 1 ? "it" : "them"}.` : ""}`,
  };
}

/**
 * SAME PURCHASE: TIE THEM (0295). The paper's number is already on the books; a person says it is
 * the same purchase. Nothing new is written and no money moves: the paper is filed AGAINST the
 * existing BILL (its own column, never bill_id, so no teardown can ever delete what it points
 * at). Only a bill the number check actually found can be tied to: a bill with this number, or
 * the bill that already covers a CED document with it. A CED document no bill covers is not a
 * cost, so a tie to it would record nothing; File It links it instead.
 */
export async function tiePaperwork(id: string, target: { billId: string }): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  if (!item) return { ok: false, error: "That paper isn't here any more." };
  if (item.status !== "needs_review" || item.bill_id) return { ok: false, error: "This is already filed. Undo it first." };
  const books = await loadBooks(supabase, ctx.orgId);
  const matches = matchesOnBooks(item, books);
  const hit = matches.find((m): m is Extract<NumberMatch, { kind: "bill" }> => m.kind === "bill" && m.billId === target.billId);
  if (!hit) return { ok: false, error: "That bill doesn't carry this paper's number and supplier, so they weren't tied. Nothing changed." };
  const patch: Record<string, unknown> = {
    status: "filed",
    tied_bill_id: target.billId,
    tied_supplier_invoice_id: null,
    job_id: hit.jobId ?? null,
    proposal: { ...proposalOf(item), filed: { how: "tie" } } satisfies PaperProposal,
  };
  // Only while it is still waiting: a File It pressed a moment ago on another screen wins.
  const { data: back, error } = await supabase
    .from("organized_items")
    .update(patch)
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .eq("status", "needs_review")
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!back?.length) return { ok: false, error: "Nothing was tied. That paper was just filed somewhere else, isn't here any more, or this login can't change it." };
  revalidatePath("/organize");
  revalidatePath("/bills");
  return { ok: true, message: `Tied. ${hit.sentence.replace(/^Already on the (books|CED documents list): /, "Filed against ")} Nothing new was added.` };
}

/** Delete an organized item, everything it filed (doc row, overhead bill), and the stored file. */
export async function deleteOrganizedItem(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).maybeSingle();
  if (!item) return { ok: false, error: "Item not found." };

  // SAME CEILING, SAME ORDER (0278). A receipt a live invoice is already billing cannot be thrown
  // away, so the bill goes first and a refusal costs nothing: the photo, the copy on the job and
  // the item itself are all still standing when this returns. Before the guard, this discarded
  // the result and carried on, which deleted the picture and the row and left INV-069 charging
  // for a receipt nobody could open. The escape hatch is the invoice's, not ours: void it, or
  // take its materials lines off, and the same tap goes through.
  if (item.bill_id) {
    const { error: billErr } = await supabase.from("bills").delete().eq("id", item.bill_id).select("id");
    if (billErr)
      return {
        ok: false,
        error:
          billClaimRefusal(
            billErr,
            "Void that invoice, or take its materials lines off, then delete this receipt. Nothing was deleted.",
          ) ?? dbError(billErr),
      };
  }
  if (item.document_id) {
    const { error: docErr } = await supabase.from("documents").delete().eq("id", item.document_id).select("id");
    if (docErr) return { ok: false, error: `${dbError(docErr)} The copy on the job is still there, so nothing else was deleted.` };
  }
  // The petty-cash disbursement this filing created goes with it (audit 9, 0202) — deleting the
  // item used to orphan real spend in the drawer with nothing behind it.
  if (item.petty_cash_id) {
    const { error: pcErr } = await supabase.from("petty_cash").delete().eq("id", item.petty_cash_id).select("id");
    if (pcErr)
      return { ok: false, error: `${dbError(pcErr)} The petty cash entry is still in the drawer, so nothing else was deleted.` };
  }

  // THE ROW BEFORE THE PHOTO, and the silent-write law on the row itself: a delete that matches
  // nothing is a 204 that reads exactly like success. Removing the file first meant a refused row
  // delete left an item sitting in the tray pointing at a picture that was already gone.
  const { data: gone, error } = await supabase.from("organized_items").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length)
    return { ok: false, error: "Nothing deleted. That item isn't here any more, or this login can't delete it." };
  if (item.file_url) {
    const { error: rmErr } = await supabase.storage.from("documents").remove([item.file_url]);
    // The item IS gone, which is what was asked for. A left-behind photo costs storage, not
    // money, so it goes to the ops log the daily sweep reads rather than a red box over a deed
    // that already succeeded.
    if (rmErr) reportError("organize:deleteOrganizedItem.storage", rmErr, { id, path: item.file_url });
  }

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
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/organize");
  return { ok: true };
}

/**
 * Correct an item's AI-extracted fields before (or after) filing. The owner can
 * fix what Claude misread — title, vendor, amount, date, category, summary — so a
 * read-only mis-extraction is never a dead end. Org-safe via RLS (the .eq("id")
 * update only matches rows visible to this org); requireStaff gates it to office.
 * Does NOT re-file or move money — it only edits the organized_items row itself.
 */
export async function updateOrganizedItem(
  id: string,
  fields: {
    title?: string;
    vendor?: string | null;
    amount?: number | null;
    item_date?: string | null;
    category?: string | null;
    summary?: string | null;
  },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: item } = await supabase.from("organized_items").select("id").eq("id", id).maybeSingle();
  if (!item) return { ok: false, error: "Item not found." };

  const title = String(fields.title ?? "").trim();
  if (!title) return { ok: false, error: "Title can't be empty." };

  // Mirror analyzeAndFile's validation: clamp lengths, coerce amount to a real
  // number or null, and keep item_date as a clean YYYY-MM-DD string or null.
  const amount =
    fields.amount != null && !isNaN(Number(fields.amount)) ? Number(fields.amount) : null;
  const itemDate = /^\d{4}-\d{2}-\d{2}$/.test(String(fields.item_date ?? "")) ? fields.item_date : null;
  const vendor = fields.vendor ? String(fields.vendor).slice(0, 200) : null;
  const category = fields.category ? String(fields.category).slice(0, 60) : null;
  const summary = fields.summary ? String(fields.summary).slice(0, 4000) : null;

  const { error } = await supabase
    .from("organized_items")
    .update({
      title: title.slice(0, 200),
      vendor,
      amount,
      item_date: itemDate,
      category,
      summary,
    })
    .eq("id", id);
  if (error) return { ok: false, error: dbError(error) };

  revalidatePath("/organize");
  return { ok: true };
}

/** Set an item aside without filing it (moves it to the Archive). */
export async function archiveItem(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("organized_items").update({ status: "archived" }).eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/organize");
  return { ok: true };
}

/** Bring an archived/filed item back to the needs-review tray. A FILED item comes back through
 *  Undo (0295), so its bill comes down with it: a row sitting in the tray over a bill that is
 *  still live would be one File It away from a second bill. */
export async function unarchiveItem(id: string): Promise<Result> {
  const supabase = await createClient();
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).maybeSingle();
  // A filing that wrote none of these columns still has to come down through Undo: Add To CED
  // Documents records what it added on the proposal only, and a plain restore left those documents
  // on the list, then a second Add landed nothing and overwrote the record Undo reads.
  if (
    item &&
    (item.bill_id || item.document_id || item.petty_cash_id || item.tied_bill_id || item.tied_supplier_invoice_id || proposalOf(item).filed)
  )
    return undoPaperwork(id);
  const { error } = await supabase.from("organized_items").update({ status: "needs_review" }).eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/organize");
  return { ok: true };
}

/** Let Claude look at a needs-attention item and SUGGEST where it goes: a job or a business-cost
 *  bucket (written onto the row as a suggestion, never filed), or turn a to-do note into a task,
 *  or keep a reference note. Returns what it did. */
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
    .in("status", ACTIVE_JOB_STATUSES)
    .order("created_at", { ascending: false })
    .limit(40);
  const jobList = (jobs ?? []).map((j: any) => ({
    id: j.id,
    label: `${j.job_number} — ${j.name}${j.customers?.name ? ` (${j.customers.name})` : ""}${j.address ? `, ${j.address}` : ""}`,
  }));

  const orgId = (item as { org_id?: string }).org_id ?? null;
  const trade = await tradeOf(supabase, orgId);
  let parsed: any;
  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      // Categorising one document into an action bucket, with a human review tray
      // behind it — not the receipt-reading that becomes billable money.
      model: modelFor("routine"),
      max_tokens: 500,
      system: `You triage one piece of paperwork for a ${trade} and decide the single best action. Output ONLY a JSON object:
{
  "action": "file_job" | "overhead" | "task" | "keep_note" | "unsure",
  "job_id": an id from the list below, or null,
  "overhead_category": one of [${AUTO_FILE_BUCKETS.join(", ")}], or null,
  "task_title": short imperative (e.g. "Call inspector Tuesday"), or null,
  "task_category": "office" | "operations" | "sales",
  "reason": one short sentence
}
Rules: "file_job" ONLY if the content clearly points to a job in the list. "overhead" only for a company-expense receipt with an amount; a supplier's finance charge, service charge, late fee or interest is "unsure", never "overhead". "task" when a note describes something to DO (call, order, schedule, follow up). "keep_note" for reference info. "unsure" if you genuinely can't tell.

Jobs (id — label):
${jobList.map((j) => `${j.id} — ${j.label}`).join("\n") || "(none)"}`,
      messages: [
        {
          role: "user",
          content: `kind=${item.kind}; title="${item.title}"; amount=${item.amount ?? "none"}; vendor=${item.vendor ?? "none"}. Content: ${item.summary ?? item.title}`,
        },
      ],
    });
    // METER (0162): receipt/document reads are a real cost centre, not just chat.
    void recordAiUsage({ orgId: (item as { org_id?: string }).org_id, model: (msg as { model?: string }).model ?? DEFAULT_MODEL, surface: "organize", usage: msg.usage as never });
    const block = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    parsed = await parseAiJson(client, block?.text ?? "", (item as { org_id?: string }).org_id);
  } catch (e: any) {
    return {
      ok: false,
      message: e?.message?.includes("ANTHROPIC_API_KEY") ? "AI review needs the API key set." : "AI couldn't review this one.",
    };
  }

  const action = String(parsed?.action ?? "unsure");
  const reason = typeof parsed?.reason === "string" ? parsed.reason : "";
  try {
    // AI SUGGEST PROPOSES; IT DOES NOT FILE (Erik, 2026-09-24). This button was "AI Review &
    // File" and it called fileItem itself, so a model read could put a bill on a job with no person
    // looking: the same thing the reader was stopped from doing, through a side door. Now a job or
    // a bucket it likes is written onto the row as the SUGGESTION, the tray pre-picks it beside
    // File It, and a person presses the button. The task and note branches below are not money
    // and keep working as before.
    //
    // A GUESS, NOT A PICK (Erik, 2026-09-24). A job it likes is written as guessJobId: a chip on
    // the row a person can tap, never the picker's value. Only what is printed on the paper picks
    // a job (jobId + jobFrom, from the reader), and a model's second look never overwrites that.
    if (action === "file_job" && jobList.some((j) => j.id === parsed.job_id)) {
      const label = jobList.find((j) => j.id === parsed.job_id)?.label;
      const { data: sBack, error: sErr } = await updateItemTolerant(supabase, id, orgId, {
        proposal: { ...proposalOf(item), guessJobId: String(parsed.job_id), bucket: null, why: reason || null },
      });
      if (sErr) return { ok: false, message: dbError(sErr) };
      if (!sBack?.length) return { ok: false, message: "Nothing was suggested. That paper isn't here any more, or this login can't change it." };
      revalidatePath("/organize");
      revalidatePath("/bills");
      return { ok: true, message: `A guess: ${label}. Tap it on the row to pick it, then press File It if that's right. ${reason}`.trim() };
    }
    if (action === "overhead") {
      // The bucket is one of the six, and Fees is never the AI's suggestion, because a supplier's
      // late or service charge is already on that supplier's own paperwork.
      const cat = bucketOf(parsed.overhead_category);
      if (cat === "Fees" || looksLikeSupplierFee(item.title, item.vendor, item.summary))
        return {
          ok: false,
          message:
            "This looks like a fee or a supplier's late charge, so nothing was suggested. A supplier's late interest comes in with that supplier's own paperwork. If it is a different fee, pick Business Cost: Fees yourself.",
        };
      const { data: sBack, error: sErr } = await updateItemTolerant(supabase, id, orgId, {
        proposal: { ...proposalOf(item), guessJobId: null, bucket: cat, why: reason || null },
      });
      if (sErr) return { ok: false, message: dbError(sErr) };
      if (!sBack?.length) return { ok: false, message: "Nothing was suggested. That paper isn't here any more, or this login can't change it." };
      revalidatePath("/organize");
      revalidatePath("/bills");
      return { ok: true, message: `A guess: Business Cost, ${cat}. Tap it on the row to pick it, then press File It if that's right. ${reason}`.trim() };
    }
    // A TASK OR A NOTE TAKES THE PAPER OUT OF THE TRAY, so it is only ever done to paper that is
    // not money. A receipt or bill with a total, a statement, a CED PDF, anything unread: the model
    // saying "task" or "keep_note" used to set it filed with no bill and no person choosing, and
    // its cost was never recorded. For those it is said as a suggestion and the row stays waiting.
    if (action === "task" || action === "keep_note") {
      const said = action === "task" ? `make a task ("${String(parsed.task_title || item.title).slice(0, 200)}")` : "keep it as a note";
      // A picture is asked what it is by a person first (Erik, 2026-09-24); a model does not answer
      // that question for them by moving it.
      if (readinessOf(item).state === "picture")
        return { ok: true, message: `Suggested: ${said}. Nothing was moved: answer What Is This? on the row. ${reason}`.trim() };
      if (readinessOf(item).state !== "keep")
        return {
          ok: true,
          message: `Suggested: ${said}. This paper can be money, so it stays here until a person files it or sets it aside. ${reason}`.trim(),
        };
      if (action === "task") {
        const title = String(parsed.task_title || item.title).slice(0, 200);
        const category = ["office", "operations", "sales"].includes(parsed.task_category) ? parsed.task_category : "operations";
        const { data: task, error: taskErr } = await supabase.from("tasks").insert({ title, category, status: "open", created_by: user.id }).select("id");
        if (taskErr || !task?.length) return { ok: false, message: taskErr ? dbError(taskErr) : "The task didn't save, so this note stays here." };
        let q = supabase.from("organized_items").update({ status: "filed", category: "Task" }).eq("id", id).eq("status", "needs_review");
        if (orgId) q = q.eq("org_id", orgId);
        const { data: moved, error: movedErr } = await q.select("id");
        revalidatePath("/organize");
        revalidatePath("/tasks");
        if (movedErr || !moved?.length)
          return { ok: true, message: `Made a task: "${title}". This note is still in the tray; archive it when you're done with it. ${reason}`.trim() };
        return { ok: true, message: `Made a task: "${title}". ${reason}`.trim() };
      }
      let q = supabase.from("organized_items").update({ status: "filed" }).eq("id", id).eq("status", "needs_review");
      if (orgId) q = q.eq("org_id", orgId);
      const { data: kept, error: keptErr } = await q.select("id");
      if (keptErr) return { ok: false, message: dbError(keptErr) };
      if (!kept?.length) return { ok: false, message: "Nothing was kept. This paper was already moved, or this login can't change it." };
      revalidatePath("/organize");
      return { ok: true, message: `Kept as a note in your archive. ${reason}`.trim() };
    }
    return { ok: false, message: reason || "Not sure where this goes — pick a destination yourself." };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? "Couldn't apply the suggestion." };
  }
}
