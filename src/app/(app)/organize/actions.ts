"use server";
import { reportError } from "@/lib/observe";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
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
  paperTypeLabel,
  paperTypeOfItem,
  isLinelessReturn,
  isPicture,
  linesPointWithTotal,
  paperPickOf,
  pickedBecause,
  pickProvenance,
  proposalOf,
  readinessOf,
  rematchPaper,
  RETURN_ON_JOB_NEEDS_LINES,
  amountOf,
  shelfRowsOf,
  storedMarks,
  type NumberMatch,
  type PaperItem,
  type PaperProposal,
} from "@/lib/paperwork";
import { ticketShelfProblem, type ShelfPick, type TicketLineChoice } from "@/lib/shelf-plan";
import { shelveLines } from "@/lib/stock-ledger";
import { formatCurrency } from "@/lib/utils";
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
import { billLabel, billsCarryingNumber } from "@/lib/same-purchase";
import {
  billStatusFromItem,
  cleanDocNumber,
  cleanLines,
  copyToJobFolder,
  documentInUse,
  exactAccountFor,
  filingDocument,
  insertItemizedBill,
  insertPaperRow,
  loadBooks,
  loadMarkContext,
  matchesOnBooks,
  paperReaderSystem,
  readBillStanding,
  readerFields,
  removeCopy,
  returnTiedPapers,
  standingRefusal,
  takeDownLanded,
  tradeOf,
  updateItemTolerant,
  type BillLine,
  type BillStanding,
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
  const { markJobs, pos, selfNames } = await loadMarkContext(supabase, ctx.orgId);

  // EVERY WRITE HERE LANDS ONLY WHILE THE PAPER IS STILL WAITING (audit v994, TD6). A read takes
  // 5 to 20 seconds; a paper filed from another screen meanwhile keeps its filing, and the late read
  // changes nothing and says so.
  const waiting = { onlyIfStatus: "needs_review" };
  const { data: blob, error: dlErr } = await supabase.storage.from("documents").download(file.path);
  if (dlErr || !blob) {
    await updateItemTolerant(supabase, itemId, ctx.orgId, { proposal: { readError: "the file couldn't be opened" } }, waiting);
    revalidatePath("/organize");
    revalidatePath("/bills");
    return { ok: false, error: `${dlErr?.message ?? "Could not read the upload."} It is saved and waiting; press Read Now to try again.` };
  }
  const bytes = await blob.arrayBuffer();
  // TOO BIG TO READ IS NOT TOO BIG TO KEEP. The file is in; the row says so and keeps every
  // control, and a person types the total in.
  if (bytes.byteLength > READ_LIMIT) {
    await updateItemTolerant(supabase, itemId, ctx.orgId, { proposal: { tooBig: true } }, waiting);
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
      system: paperReaderSystem(trade),
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
    await updateItemTolerant(supabase, itemId, ctx.orgId, { proposal: { readError: "the reader didn't answer" } }, waiting);
    revalidatePath("/organize");
    revalidatePath("/bills");
    return { ok: false, error: `${e?.message ?? "AI could not read this file."} It is saved and waiting; press Read Now to try again.` };
  }

  const f = readerFields(parsed, file.name, { markJobs, pos, selfNames, personSaysCost: opts.personSaysCost });
  // A picture never keeps itself as a note: it waits for a person to say what it is.
  const keepsItself = f.kind === "note" && f.amount === null && !opts.personSaysCost && !f.proposal.picture;
  const { data: landed, error } = await updateItemTolerant(supabase, itemId, ctx.orgId, {
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
    // A NOTE THAT KEEPS ITSELF SAYS HOW (review of wave 2, TD5): with no `filed` on it, a filed row
    // with no links read as "filed over nothing", and dropping the same file again said what it
    // filed is gone, of a note nothing was ever filed from.
    proposal: keepsItself ? ({ ...f.proposal, filed: { how: "note" } } satisfies PaperProposal) : f.proposal,
  }, waiting);
  if (error) return { ok: false, error: dbError(error) };
  if (!landed?.length) {
    revalidatePath("/organize");
    revalidatePath("/bills");
    return { ok: false, error: "This paper was filed while it was being read, so the read changed nothing. Undo it first if it needs reading again." };
  }

  revalidatePath("/organize");
  revalidatePath("/bills");
  const labelOf = (id: string | null | undefined) => {
    if (!id) return null;
    const j = markJobs.find((x) => x.id === id);
    return j ? `${j.job_number ?? ""}${j.name ? ` ${j.name}` : ""}`.trim() || null : null;
  };
  const pickedJob = labelOf(f.proposal.jobId);
  const guessedJob = labelOf(f.proposal.guessJobId);
  const readItem = { id: itemId, doc_type: f.doc_type, category: f.category, proposal: f.proposal };
  const because = pickedBecause(readItem);
  // A company-use word ("TOOLS") the paper names picks a business cost the same way a job is.
  const pickedCost = !pickedJob && paperPickOf(readItem).startsWith("cost:") ? paperPickOf(readItem).slice(5) : null;
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
        pickedJob || guessedJob || pickedCost || f.proposal.bucket
          ? {
              jobLabel: pickedJob ?? (pickedCost ? null : guessedJob),
              bucket: pickedCost ?? f.proposal.bucket ?? null,
              picked: !!pickedJob || !!pickedCost,
              because: pickedJob || pickedCost ? because : null,
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
    .select("id, kind, title, file_url, status, proposal, doc_type, category, summary, amount")
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (!item) return { ok: false, error: "That paper isn't here any more." };
  if (item.status !== "needs_review") return { ok: false, error: "This is already filed. Undo it first, then change what it is." };
  // THE SAME GATE THE BUTTON SHOWS: Bill Or Receipt is the answer to "What is this?", which only a
  // picture asks. A CED PDF, a statement or a credit memo turned into a receipt here would lose
  // what it is and become a cost File It could write.
  if (readinessOf(item).state !== "picture")
    return { ok: false, error: "Only a picture is asked what it is. To change what this paper is, use Fix Details." };
  const { picture: _wasPicture, ...rest } = proposalOf(item);
  const { data: back, error } = await updateItemTolerant(
    ctx.supabase,
    id,
    ctx.orgId,
    {
      doc_type: "receipt",
      kind: "receipt",
      category: "Receipt",
      payment: "unknown",
      proposal: rest,
    },
    { onlyIfStatus: "needs_review" },
  );
  if (error) return { ok: false, error: dbError(error) };
  if (!back?.length) return { ok: false, error: "Nothing changed. That paper was just filed, isn't here any more, or this login can't change it." };
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
  stated?: {
    paid?: boolean;
    category?: string | null;
    billDate?: string | null;
    fallbackBillDate?: string | null;
    /** A person looked at "already on the books" and said this is a different purchase. */
    differentPurchase?: boolean;
  },
): Promise<{
  ok: boolean;
  error?: string;
  already?: boolean;
  /** A bill already carries this paper's number: nothing was written, and this says which. */
  sameAs?: string;
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
  // A return read here (a negative total) keeps its lines pointing the same way (linesPointWithTotal).
  const lines = linesPointWithTotal(aiAmount, cleanLines(parsed.line_items));
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
  // A RETURN WITH NO LINES NEVER GOES ON A JOB (audit v994 review; DB4's class). This door writes
  // straight onto the job, so a return read here with nothing legible under its total would be
  // credited to the customer in full at markup, even for parts they were never charged for.
  // insertItemizedBill refuses it too; this says why, in the words this door's person needs.
  if (isLinelessReturn(amount, lines)) {
    return { ok: false, error: RETURN_ON_JOB_NEEDS_LINES };
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

  // IS THIS PURCHASE ALREADY ON THE BOOKS? (audit v994, DB1.) This door never asked. A CED ticket
  // filed from the tray, then snapped again on the job page, is a new photo, so a new document and
  // a new fingerprint, and this wrote a second bill with the same number and no word: double job
  // cost, and Import Costs billing the customer twice. The same reading every door uses
  // (billsCarryingNumber: the number in either column, same supplier, live bills only). A match
  // writes NOTHING and says so; the person decides, and "Different Purchase: Record It Anyway"
  // comes back through here with differentPurchase. It is `ok` with a warning, not a refusal: the
  // Add Cost sheet falls back to a typed bill on a refusal, which is the second bill again.
  if (docNumber && !stated?.differentPurchase) {
    const books = await loadBooks(supabase, ctx.orgId);
    const same = billsCarryingNumber(docNumber, { accountId, supplier: vendor }, books.bills, books.aliases);
    if (same.length) {
      // THE FACT ONLY, NO DOOR (review of the fix). Each caller names the button it actually
      // renders: the Add Cost sheet and Snap the Bill offer Different Purchase in place, and a
      // sentence here pointing at "Receipts & Documents" sent him to a button that only appears
      // after another Record as Cost press (another paid read).
      const said = `Already on the books: ${billLabel(same[0])}. Nothing was recorded twice.`;
      return { ok: true, already: true, vendor, amount, sameAs: said, warning: said };
    }
  }

  const billId = await insertItemizedBill(
    supabase,
    {
      job_id: doc.job_id,
      supplier: vendor,
      amount,
      bill_date: stated?.billDate || itemDate || stated?.fallbackBillDate || null,
      category: stated?.category || "Receipt",
      scope_category: scopeCategory, // job scope for budget-vs-actual (null → Uncategorized)
      notes: `Receipt recorded as cost: ${doc.name}${
        stated?.differentPurchase ? "\nA person checked: a different purchase from the one already on the books with this number." : ""
      }${check.mismatch ? `\n\n${check.note}` : ""}`,
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
    // THE JOB'S OWN UPLOAD (audit v994, TD1): this row points at a document the job already had,
    // so Undo and Delete take the bill down and never the receipt (filingDocument).
    source: "job",
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
  /**
   * THE SHOP SHELF (Shop Stock, Phase 2): the ticket becomes a bill with no job, on_shelf, and
   * each line a person counted becomes a roll on the shelf. `lines` is a person's answer for every
   * line by its place on the paper (shelfRowsOf): a count, or Not Stock.
   */
  | { type: "stock"; lines: TicketLineChoice[] }
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

/** What a teardown did, for the sentence and for the paper's own row. */
type Teardown =
  | { refused: string }
  | {
      refused: null;
      /** The bill the filing made, as a person left it, read just before it came down. */
      standing: BillStanding | null;
      /** Papers that were tied to that bill and are back in the tray now. */
      papersBack: string[];
      /** The job's own document the row pointed at and did NOT make (TD1): kept on the job. */
      keptDoc: { id: string; file_url: string | null } | null;
    };

/** The words a teardown refusal ends with, for the door that asked. */
type TeardownWords = {
  /** After an invoice's claim: "Void that invoice, or take its materials lines off, then ...". */
  tail: string;
  /** What to press after the fix: "press Undo again". */
  then: string;
  /** "Nothing was undone." */
  nothing: string;
};

/**
 * Tear down whatever the previous filing made, bill FIRST and only if the database lets it (0278).
 * Every read that can refuse runs before anything is deleted, so a refusal leaves the filing
 * exactly as it was. The words name the door.
 */
async function tearDownFiling(supabase: any, orgId: string | null, item: any, words: TeardownWords): Promise<Teardown> {
  // WHAT LEANS ON THE BILL, READ FIRST (audit v994, TD2 and TD3). A copy set aside as its
  // duplicate refuses in words (Erik: "Undo refuses when a duplicate copy was set aside against the
  // bill, and names that copy"), a roll of it on the shop shelf refuses, and the lines a person
  // set on the bill (switched off, part-used) are read so they can ride back onto the paper.
  let standing: BillStanding | null = null;
  if (item.bill_id) {
    const st = await readBillStanding(supabase, orgId, String(item.bill_id));
    if (st && "error" in st) return { refused: st.error };
    standing = st;
    const no = standing ? standingRefusal(standing, words.then, words.nothing) : null;
    if (no) return { refused: no };
  }
  // WHICH DOCUMENT THIS FILING MADE (audit v994, TD1). A receipt recorded as a cost on the job page
  // points at the job's OWN upload; that one is never this teardown's to delete.
  const doc = await filingDocument(supabase, orgId, item);
  if (doc && "error" in doc) return { refused: `${dbError(doc.error)} ${words.nothing}` };
  // WHAT STANDS ON THAT DOCUMENT (review of wave 2, PR4): the customer's page or a panel's photo.
  // Read before anything is deleted, so a refusal leaves the filing exactly as it was.
  if (doc && doc.owned) {
    const used = await documentInUse(supabase, orgId, doc.id);
    if (used && "error" in used) return { refused: `${dbError(used.error)} ${words.nothing}` };
    if (used) return { refused: `${used.sentence}, then ${words.then}. ${words.nothing}` };
  }

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
  let papersBack: string[] = [];
  if (item.bill_id) {
    const { error: billErr } = await supabase.from("bills").delete().eq("id", item.bill_id).select("id");
    if (billErr) return { refused: billClaimRefusal(billErr, words.tail) ?? dbError(billErr) };
    // Papers tied to that bill would be left "filed" over nothing: they go back to the tray, named.
    if (standing?.tiedPapers.length) papersBack = await returnTiedPapers(supabase, orgId, standing.tiedPapers);
  }
  // Then the rest of the previous filing. The petty-cash row is torn down HERE too (audit 9,
  // 0202). Both are checked for the bill's own reason - a teardown that fails and says nothing
  // becomes a SECOND row a moment later.
  if (doc && doc.owned) {
    const { error: docErr } = await supabase.from("documents").delete().eq("id", doc.id).select("id");
    if (docErr) return { refused: `${dbError(docErr)} The old copy is still on the job. ${words.nothing}` };
    // The copy a filing put in the job's own folder (PR4) goes with its row.
    if (doc.file_url && doc.file_url !== item.file_url) await removeCopy(supabase, doc.file_url, orgId);
  }
  if (item.petty_cash_id) {
    const { error: pcErr } = await supabase.from("petty_cash").delete().eq("id", item.petty_cash_id).select("id");
    if (pcErr) return { refused: `${dbError(pcErr)} The old petty cash entry is still in the drawer. ${words.nothing}` };
  }
  return { refused: null, standing, papersBack, keptDoc: doc && !doc.owned ? { id: doc.id, file_url: doc.file_url } : null };
}

/** "Tied to that bill and back in the tray too: X." Empty when there were none. */
function papersBackSaid(titles: string[]): string {
  if (!titles.length) return "";
  const many = titles.length > 1;
  return ` ${many ? `${titles.length} other papers (${titles.map((t) => `"${t}"`).join(", ")}) were` : `"${titles[0]}" was`} tied to that bill and ${many ? "are" : "is"} back in the tray too.`;
}

/** The choices made on the bill that rode back onto the paper, said once (TD3). */
function keptChoicesSaid(lines: BillLine[]): string {
  const off = lines.filter((l) => !l.billable).length;
  const part = lines.filter((l) => l.billable && l.billed_amount !== undefined).length;
  if (!off && !part) return "";
  const bits = [off ? `${off} ${off === 1 ? "line" : "lines"} switched off` : "", part ? `${part} part-used` : ""].filter(Boolean).join(", ");
  return ` The choices made on the bill (${bits}) stay with it, so File It carries them again.`;
}

/**
 * The tray's exact match, run again on the server for the paper about to be filed, and what it
 * says about who decided (pickProvenance). A read that fails is "no paper pick known", said as
 * nothing rather than as a wrong answer, and never stops the filing: this is a record of the
 * decision, not a gate on it.
 */
async function whoPicked(
  supabase: any,
  orgId: string | null,
  item: PaperItem,
  dest: Exclude<FileDestination, { type: "unfiled" }>,
): Promise<ReturnType<typeof pickProvenance> | null> {
  try {
    const { markJobs, pos, selfNames } = await loadMarkContext(supabase, orgId);
    const settled = rematchPaper(item, markJobs, pos, selfNames);
    const destValue = dest.type === "overhead" ? `cost:${dest.category}` : dest.type === "stock" ? "stock" : `${dest.type}:${dest.jobId}`;
    return pickProvenance(settled, destValue);
  } catch (e) {
    reportError("organize:fileItem.whoPicked", e, { itemId: item.id });
    return null;
  }
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
      dest.type === "job" || dest.type === "photo"
        ? { type: dest.type, jobId: dest.jobId }
        : dest.type === "stock"
          ? { type: "stock" }
          : { type: "overhead", category: dest.category as never },
    );
    if (refusal) return { ok: false, error: refusal };
    // Every line answered, a count or Not Stock, and at least one on the shelf: the same gate the
    // sheet's button asks, asked again here before anything is claimed or written.
    if (dest.type === "stock") {
      const shelfProblem = ticketShelfProblem(shelfRowsOf(item), amountOf(item), dest.lines);
      if (shelfProblem) return { ok: false, error: shelfProblem };
    }
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
  // THE SAME LONG NUMBER UNDER ANOTHER SPELLING (Erik, audit v994 DB5) is a warning, never a
  // refusal: the row showed it with Same Purchase: Tie Them, a person pressed File It anyway, and
  // the bill says so, so two bills with one number are known to have been decided, not missed.
  let maybeSaid = "";
  if (dest.type !== "unfiled" && dest.type !== "photo" && isCost && item.doc_number && !opts.differentPurchase) {
    const books = await loadBooks(supabase, ctx.orgId);
    const found = matchesOnBooks(item, books);
    const onBooks = found.filter((m) => m.kind === "bill");
    if (onBooks.length) return { ok: false, error: sameNumberRefusal(onBooks) };
    linkTo = found.flatMap((m) => (m.kind === "supplier_invoice" ? [{ id: m.supplierInvoiceId, number: m.invoiceNumber }] : []));
    const maybes = found.filter((m) => m.kind === "maybe_bill");
    if (maybes.length)
      maybeSaid = `\nA person filed this with a bill carrying the same number under another supplier spelling on the books: ${maybes
        .map((m) => m.sentence.replace(/^Maybe already on the books: /, "").replace(/ It carries this number.*$/, ""))
        .join("; ")}`;
  }

  // WHO DECIDED WHERE IT WENT (audit v994, tray F1). The tray's pick lived only in memory: the tray
  // re-matches every waiting paper on each load and writes nothing, so a paper read before a rule
  // learned something (Paper B, "13897 HERRINGBONE", read 24 minutes before the PO-street rule
  // shipped) was filed with nothing on record saying the PO picked J-011, and a person overriding
  // the paper looked exactly like a person agreeing with it. The same exact match runs here, on
  // the server, while the row is still waiting (so rematchPaper does not step aside), and the
  // answer rides inside `filed`, which Undo clears: the reader's proposal is never rewritten.
  const provenance = dest.type === "unfiled" ? null : await whoPicked(supabase, ctx.orgId, item, dest);

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

  const torn = await tearDownFiling(supabase, ctx.orgId, item, {
    tail: "Void that invoice, or take its materials lines off, then file this again. Nothing was moved.",
    then: "file this again",
    nothing: "Nothing was moved.",
  });
  if (torn.refused !== null) {
    await release();
    return { ok: false, error: torn.refused };
  }
  const prevJob = item.job_id;
  // The lines as a person left them on the bill being replaced (TD3), else as the paper holds them.
  const lines = torn.standing?.lines.length ? torn.standing.lines : cleanLines(item.line_items);
  // DOES IT ADD UP? (audit v994, MR6.) The job-page reader has always compared the total it read
  // with the lines under it and written the gap into the bill's notes; File It wrote the tray's
  // total with no look. Flagged, never corrected, never a refusal: the row said it before the press.
  const total = amountOf(item);
  const check = isCost && total !== null ? reconcileReceipt(total, linesPointWithTotal(total, lines)) : null;
  const checkSaid = check?.mismatch ? `\n\n${check.note}` : "";

  let documentId: string | null = null;
  let billId: string | null = null;
  /** What went on the shelf, said after "Filed" (Shop Stock). */
  let shelfSaid = "";
  let jobId: string | null = null;
  let category: string | null = item.category;
  const paperCategory = billCategoryFor(item);
  const vendor = item.vendor ?? item.title;
  // What a person said at the "already on the books" question rides on the bill, so the next
  // person who sees two bills with one number knows it was decided, not missed.
  const decided =
    (opts.differentPurchase ? "\nA person checked: a different purchase from the one already on the books with this number." : "") +
    maybeSaid +
    (provenance?.note ? `\n${provenance.note}` : "") +
    checkSaid;
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
  /** The copy this press put in the job's own folder (PR4), taken back out if the filing fails. */
  let copyPath: string | null = null;
  const backToTray = async (message: string): Promise<Result> => {
    if (billId) await supabase.from("bills").delete().eq("id", billId).select("id");
    if (documentId) await supabase.from("documents").delete().eq("id", documentId).select("id");
    if (copyPath) await removeCopy(supabase, copyPath, ctx.orgId);
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
    // A PHOTO OR A JOB PAPER GOES IN THE JOB'S OWN FOLDER (audit v994, PR4). Left in
    // <org>/organize/, which only the office can open (0213), a panel photo filed to J-047 was
    // missing from the tech's Photos tab on J-047 and Show On Portal refused it. The document
    // points at a copy in <org>/<job>/; the paper keeps its original for the tray. A receipt or a
    // bill stays where it is: it is the office's paper, with prices on it.
    //
    // PICTURES ONLY (review of wave 2, PR4). Every other paper kept on a job stays in the office's
    // folder as before: a supplier's quote or price sheet read as "not a cost" is still the
    // office's paper with prices on it, and the job folder is one every tech on the job can open.
    // A plan or permit that belongs on the job goes up from the job's own Plans door.
    if (item.file_url && ctx.orgId && (dest.type === "photo" || isPicture(item as PaperItem))) {
      copyPath = await copyToJobFolder(supabase, ctx.orgId, dest.jobId, String(item.file_url));
      if (!copyPath) return backToTray("The file couldn't be copied onto the job, so it is back in the tray. Try again.");
    }
    const { data: doc } = await supabase
      .from("documents")
      .insert({
        job_id: dest.jobId,
        name: item.title,
        category: docCategory,
        kind: "other",
        file_url: copyPath ?? item.file_url,
        uploaded_by: ctx.userId,
      })
      .select("id")
      .single();
    documentId = doc?.id ?? null;
    // For a photo or a paper kept on the job, the copy on the job IS the filing: one that did not
    // land is not "Filed".
    if (dest.type === "photo" && !documentId)
      return backToTray("The photo didn't save on the job, so it is back in the tray. Try again.");
    if (!isCost && !documentId) return backToTray("It didn't save on the job, so it is back in the tray. Try again.");
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
  } else if (dest.type === "stock") {
    // THE SHOP SHELF (Shop Stock, Phase 2). The ticket is a bill with no job, flagged on_shelf (a
    // real flag, never a category word: bucketOf would call an unknown word "Other"), so it is
    // never a job cost and never a business-cost bucket. Then every line a person counted becomes
    // a roll, in one transaction (shelveLines -> 0328). Anything short of that puts the paper back
    // in the tray holding nothing: a shelf ticket with no rolls on it is money in no place.
    category = "Shop Stock";
    billId = await insertItemizedBill(
      supabase,
      {
        job_id: null,
        supplier: vendor,
        amount: item.amount ?? 0,
        bill_date: item.item_date,
        category: "Shop Stock",
        notes: `Shop stock filed by a person from the tray: ${item.title}${decided}`,
        created_by: ctx.userId,
        on_shelf: true,
        ...billFacts,
      },
      lines,
      billStatusFromItem(item),
    );
    if (!billId) return backToTray("The ticket didn't save, so it is back in the tray. Try File It again.");
    const rows = shelfRowsOf(item);
    const { data: written, error: writtenErr } = await supabase
      .from("bill_line_items")
      .select("id, sort_order")
      .eq("bill_id", billId)
      .order("sort_order");
    if (writtenErr || (written ?? []).length !== rows.length)
      return backToTray("The ticket's lines didn't all save, so nothing went on the shelf and the paper is back in the tray. Try again.");
    const idAt = new Map(((written ?? []) as { id: string; sort_order: number }[]).map((w) => [Number(w.sort_order), String(w.id)]));
    const picks: ShelfPick[] = [];
    for (const c of dest.lines) {
      if (c.notStock) continue;
      const lineId = idAt.get(Number(c.index));
      if (!lineId) return backToTray("A line on this ticket didn't save, so nothing went on the shelf. Try again.");
      picks.push({
        lineId,
        pieces: Number(c.pieces),
        used: 0,
        unit: c.unit,
        bought: c.bought ?? null,
        itemId: c.itemId ?? null,
        newItemName: c.newItemName ?? null,
        keyPart: c.keyPart ?? null,
      });
    }
    const shelved = await shelveLines(supabase, String(ctx.orgId), billId, picks);
    if (!shelved.ok) return backToTray(`${shelved.error} Nothing was filed; the paper is back in the tray.`);
    const notStock = dest.lines.filter((c) => c.notStock).length;
    shelfSaid =
      ` ${shelved.lots.map((l) => `${l.pieces} ${l.unit} (${formatCurrency(l.cost)})`).join(", ")} on the shelf.` +
      (notStock ? ` ${notStock === 1 ? "1 line" : `${notStock} lines`} marked Not Stock stay on the ticket as Tools & Supplies, never on the shelf.` : "");
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
  // And who decided it, beside how (whoPicked above): inside `filed`, so Undo takes it with it.
  if ("proposal" in item)
    patch.proposal = {
      ...proposalOf(item),
      // A person filed it again: why it came back (a deleted bill) is answered.
      ...(dest.type === "unfiled" ? {} : { billDeleted: null }),
      filed: dest.type === "unfiled" ? null : { how: dest.type === "photo" ? "photo" : "bill", ...(provenance?.filed ?? {}) },
    } satisfies PaperProposal;
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
  revalidatePath("/inventory");
  const linkedSaid = linkTo.length && !linkNote ? ` Linked to CED ${linkTo.map((l) => l.number).join(", ")}.` : "";
  if (shelfSaid) return { ok: true, message: `Filed on the shop shelf.${shelfSaid}${linkedSaid}${linkNote}` };
  return linkedSaid || linkNote ? { ok: true, message: `Filed.${linkedSaid}${linkNote}` } : { ok: true };
}

/**
 * UNDO A FILING (0295). The paper goes back to the tray, and whatever the filing made comes down
 * under the same 0278 ceiling as every other teardown: a bill a live invoice already bills cannot
 * be un-filed, and the sentence says which invoice and what to do.
 *
 *   · a TIE made nothing, so undoing one removes nothing but the link.
 *   · CED documents added from a PDF: the ones this paper ADDED come off the list, unless
 *     something already points at them (a bill covering it, a job a person set, or another paper
 *     tied to it), which are named and kept.
 *   · a bill with a copy set aside as its duplicate REFUSES and names the copy (Erik, audit v994
 *     TD2), and papers tied to the bill go back to the tray with it, named.
 *   · THE CHOICES MADE ON THE BILL COME BACK WITH THE PAPER (Erik, audit v994 TD3: "Undo, then
 *     refile, keeps the line choices made on the bill"). A tool line switched off and 60 of 500 wire
 *     nuts billed are copied onto the paper's lines, so File It carries them again instead of
 *     billing the tool and the whole box with nothing said.
 *   · a receipt recorded as a cost ON THE JOB PAGE (TD1) takes its bill down and never the job's
 *     own receipt; its link row goes, and Record as Cost on the job makes it a cost again. It never
 *     lands in the tray, where File It would put a second copy of the receipt on the job.
 *   · a task made from a note (PR2): the task comes off the list and the note comes back.
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

  let kept: string[] = [];
  let torn: Extract<Teardown, { refused: null }> | null = null;
  if (p.filed?.how === "supplier_documents" && p.filed.landed?.length) {
    const down = await takeDownLanded(supabase, ctx.orgId, p.filed.landed);
    if (down.error) return { ok: false, error: `${down.error} Nothing was undone.` };
    kept = down.kept;
  } else if (p.filed?.how === "task" && p.filed.taskId) {
    // THE TASK A NOTE BECAME comes off the list first; a task already gone is simply gone.
    let q = supabase.from("tasks").delete().eq("id", p.filed.taskId);
    if (ctx.orgId) q = q.eq("org_id", ctx.orgId);
    const { error: taskErr } = await q.select("id");
    if (taskErr) return { ok: false, error: `${dbError(taskErr)} The task is still on the list, so nothing was undone.` };
  } else if (!tied) {
    const down = await tearDownFiling(supabase, ctx.orgId, item, {
      tail: "Void that invoice, or take its materials lines off, then press Undo again. Nothing was undone.",
      then: "press Undo again",
      nothing: "Nothing was undone.",
    });
    if (down.refused !== null) return { ok: false, error: down.refused };
    torn = down;
  }

  // A RECEIPT RECORDED AS A COST ON THE JOB PAGE (TD1): its bill is down, the job keeps its receipt,
  // and the link row goes, so Record as Cost on that receipt makes it a cost again.
  if (torn && (item.source === "job" || torn.keptDoc)) {
    const { data: gone, error: goneErr } = await supabase.from("organized_items").delete().eq("id", id).eq("org_id", ctx.orgId).select("id");
    if (goneErr || !gone?.length) {
      reportError("organize:undoPaperwork.jobLink", goneErr ?? new Error("link row delete removed no rows"), { id });
      return {
        ok: true,
        message: `Undone: its cost is off the job. The receipt stays on the job, but this row didn't clear; refresh before recording it again.${papersBackSaid(torn.papersBack)}`,
      };
    }
    revalidatePath("/organize");
    revalidatePath("/bills");
    if (item.job_id) revalidatePath(`/jobs/${item.job_id}`);
    return {
      ok: true,
      message: `Undone: its cost is off the job. The receipt stays on the job; press Record as Cost there to make it a cost again.${papersBackSaid(torn.papersBack)}`,
    };
  }

  const type = paperTypeOfItem(item);
  const patch: Record<string, unknown> = {
    job_id: null,
    document_id: null,
    bill_id: null,
    petty_cash_id: null,
    status: "needs_review",
    // A business-cost filing replaced the category with its bucket, and a task replaced it with
    // "Task"; the paper gets its own back.
    category:
      type === "receipt" || type === "bill"
        ? billCategoryFor({ doc_type: item.doc_type, category: null })
        : p.filed?.how === "task"
          ? (p.filed.category ?? "Note")
          : item.category,
  };
  // The bill's lines, as a person left them, ride back onto the paper (TD3).
  const standing = torn?.standing ?? null;
  const keptLines = standing?.lines.length ? standing.lines : null;
  if (keptLines) patch.line_items = keptLines;
  if (standing && standing.amount !== null) patch.amount = standing.amount;
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
  if (p.filed?.how === "task") revalidatePath("/tasks");
  if (item.job_id) revalidatePath(`/jobs/${item.job_id}`);
  return {
    ok: true,
    message:
      `${tied ? "Untied" : "Undone"}. It is back in the tray, waiting for File It.` +
      (keptLines ? keptChoicesSaid(keptLines) : "") +
      papersBackSaid(torn?.papersBack ?? []) +
      (kept.length ? ` ${kept.join(", ")} stayed on the CED documents list, because a bill, a job or another paper already points at ${kept.length === 1 ? "it" : "them"}.` : ""),
  };
}

/**
 * SAME PURCHASE: TIE THEM (0295). The paper's number is already on the books; a person says it is
 * the same purchase. Nothing new is written and no money moves: the paper is filed AGAINST the
 * existing BILL (its own column, never bill_id, so no teardown can ever delete what it points
 * at). Only a bill the number check actually found can be tied to: a bill with this number, the
 * bill that already covers a CED document with it, or a bill carrying the same long number under
 * another spelling of the supplier (DB5's warning, which a person has now answered). A CED document
 * no bill covers is not a cost, so a tie to it would record nothing; File It links it instead.
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
  const hit = matches.find(
    (m): m is Extract<NumberMatch, { kind: "bill" | "maybe_bill" }> => (m.kind === "bill" || m.kind === "maybe_bill") && m.billId === target.billId,
  );
  if (!hit) return { ok: false, error: "That bill doesn't carry this paper's number and supplier, so they weren't tied. Nothing changed." };
  const patch: Record<string, unknown> = {
    status: "filed",
    tied_bill_id: target.billId,
    tied_supplier_invoice_id: null,
    job_id: hit.jobId ?? null,
    proposal: { ...proposalOf(item), billDeleted: null, filed: { how: "tie" } } satisfies PaperProposal,
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
  const against = hit.sentence
    .replace(/^(Maybe )?[Aa]lready on the (books|CED documents list): /, "Filed against ")
    .replace(/ It carries this number, but the supplier is spelled another way.*$/, "");
  return { ok: true, message: `Tied. ${against} Nothing new was added.` };
}

/**
 * Delete an organized item, everything it filed, and the stored file. The same teardown Undo runs
 * (audit v994, TD4): the CED documents a paper added come off the list like any other filing, a
 * bill with a copy set aside against it refuses, and a receipt recorded as a cost on the job page
 * keeps its receipt on the job, file included (TD1).
 */
export async function deleteOrganizedItem(id: string): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  if (!item) return { ok: false, error: "Item not found." };
  const p = proposalOf(item);

  // THE CED DOCUMENTS IT ADDED (TD4): the confirm says Delete removes whatever it filed, and a
  // supplier-documents filing records what it added only on its proposal.
  let kept: string[] = [];
  if (p.filed?.how === "supplier_documents" && p.filed.landed?.length) {
    const down = await takeDownLanded(supabase, ctx.orgId, p.filed.landed);
    if (down.error) return { ok: false, error: `${down.error} Nothing was deleted.` };
    kept = down.kept;
  }

  // SAME CEILING, SAME ORDER (0278). A receipt a live invoice is already billing cannot be thrown
  // away, so the bill goes first and a refusal costs nothing: the photo, the copy on the job and
  // the item itself are all still standing when this returns. Before the guard, this discarded
  // the result and carried on, which deleted the picture and the row and left INV-069 charging
  // for a receipt nobody could open. The escape hatch is the invoice's, not ours: void it, or
  // take its materials lines off, and the same tap goes through.
  const torn = await tearDownFiling(supabase, ctx.orgId, item, {
    tail: "Void that invoice, or take its materials lines off, then delete this receipt. Nothing was deleted.",
    then: "delete this again",
    nothing: "Nothing was deleted.",
  });
  if (torn.refused !== null) return { ok: false, error: torn.refused };

  // THE ROW BEFORE THE PHOTO, and the silent-write law on the row itself: a delete that matches
  // nothing is a 204 that reads exactly like success. Removing the file first meant a refused row
  // delete left an item sitting in the tray pointing at a picture that was already gone.
  const { data: gone, error } = await supabase.from("organized_items").delete().eq("id", id).eq("org_id", ctx.orgId).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length)
    return { ok: false, error: "Nothing deleted. That item isn't here any more, or this login can't delete it." };
  // The file goes too, unless it is the job's own receipt, which stays on the job (TD1).
  const jobsOwnFile = item.source === "job" || (torn.keptDoc && torn.keptDoc.file_url === item.file_url);
  if (item.file_url && !jobsOwnFile) {
    const { error: rmErr } = await supabase.storage.from("documents").remove([item.file_url]);
    // The item IS gone, which is what was asked for. A left-behind photo costs storage, not
    // money, so it goes to the ops log the daily sweep reads rather than a red box over a deed
    // that already succeeded.
    if (rmErr) reportError("organize:deleteOrganizedItem.storage", rmErr, { id, path: item.file_url });
  }

  revalidatePath("/organize");
  revalidatePath("/bills");
  if (item.job_id) revalidatePath(`/jobs/${item.job_id}`);
  const said =
    (jobsOwnFile && item.document_id ? " The receipt stays on the job." : "") +
    papersBackSaid(torn.papersBack) +
    (kept.length ? ` ${kept.join(", ")} stayed on the CED documents list, because a bill, a job or another paper already points at ${kept.length === 1 ? "it" : "them"}.` : "");
  return said ? { ok: true, message: `Deleted.${said}` } : { ok: true };
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

/**
 * AI SUGGEST WRITES ONLY ONTO A PAPER STILL WAITING (review of wave 2, TD6). The paper is read
 * before the model's 5-20 seconds; a paper filed in that time had its whole proposal replaced with
 * the one read before, and the `filed` record inside it (what Undo takes down: the CED documents it
 * added, the task it made) was gone. Every suggestion write is onlyIfStatus needs_review.
 */
const SUGGEST_MISSED =
  "Nothing was suggested: this paper was filed or moved while AI Suggest was looking, or it isn't here any more. Refresh to see where it is.";

/**
 * Let Claude look at a needs-attention item and SUGGEST where it goes: a job or a business-cost
 * bucket (written onto the row as a suggestion, never filed), or turn a to-do note into a task,
 * or keep a reference note. Returns what it did.
 *
 * THE RULES GO FIRST, THE MODEL ONLY FOR WHAT THEY CANNOT SETTLE (Erik, 2026-09-24: a CED sales
 * order with "13897 HERRINGBONE" in its PO box came back from AI Suggest, in a red box, as
 * "Materials receipt lacks a job reference"). The model was handed the title and a one-line
 * summary and nothing the reader had already copied off the paper: not the PO, not the hint, not
 * the lines, and only 40 jobs. Now:
 *   · the exact match (rematchPaper, the same rules the tray runs) is asked first; a paper that
 *     names one open job answers with that job and why, and no model is called;
 *   · otherwise the model sees everything the reader found (type, vendor, total, number, PO, hint,
 *     marks, lines) and every open job the picker offers (number, name, street, customer), with
 *     the company's own names marked as never the customer;
 *   · "nothing to suggest" is an answer, said as a plain note, never styled as an error.
 */
export async function aiReviewItem(id: string): Promise<{ ok: boolean; message: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, message: ctx.error ?? "This action is staff-only." };
  const supabase = ctx.supabase;
  let iq = supabase.from("organized_items").select("*").eq("id", id);
  if (ctx.orgId) iq = iq.eq("org_id", ctx.orgId);
  const { data: item } = await iq.maybeSingle();
  if (!item) return { ok: false, message: "Item not found." };

  const orgId = ctx.orgId ?? (item as { org_id?: string }).org_id ?? null;
  const { markJobs: allJobs, pos, selfNames } = await loadMarkContext(supabase, orgId);
  // The model is offered the OPEN jobs only; a finished job is filed to by a person's own pick.
  const markJobs = allJobs.filter((j) => !j.closed);
  const jobLabelOf = (jobId: string) => {
    const j = markJobs.find((x) => x.id === jobId);
    return j ? `${j.job_number ?? ""}${j.name ? ` ${j.name}` : ""}`.trim() || "that job" : "that job";
  };

  // THE PAPER FIRST: the same exact rules the tray runs. Nothing is written; the tray shows the
  // pick from the same rules on every load.
  const settled = rematchPaper(item as PaperItem, allJobs, pos, selfNames);
  const sp = proposalOf(settled);
  const paperJob = sp.jobId && sp.jobFrom && !sp.jobConflict && markJobs.some((j) => j.id === sp.jobId) ? sp.jobId : null;
  if (paperJob) {
    const because = pickedBecause(settled);
    return {
      ok: true,
      message: `The paper names the job: ${jobLabelOf(paperJob)}.${because ? ` ${because}.` : ""} It's picked on the row; press File It if that's right.`,
    };
  }
  // The paper names the company's own use ("TOOLS" in the PO box): that is the pick, from the
  // paper, and a model's second look has nothing to add to it.
  const paperCost = paperPickOf(settled);
  if (paperCost.startsWith("cost:")) {
    const because = pickedBecause(settled);
    return {
      ok: true,
      message: `The paper names a business cost: ${paperCost.slice(5)}.${because ? ` ${because}.` : ""} It's picked on the row; press File It if that's right.`,
    };
  }

  const p = proposalOf(item);
  const marks = storedMarks(p);
  const fact = (label: string, v: unknown) => {
    const t = String(v ?? "").trim();
    return t ? `${label}: ${t}` : null;
  };
  const lines = Array.isArray((item as { line_items?: unknown }).line_items) ? ((item as { line_items: any[] }).line_items as any[]) : [];
  const paperFacts = [
    fact("Paper type", paperTypeLabel(paperTypeOfItem(item))),
    fact("Title", item.title),
    fact("Vendor", item.vendor),
    fact("Total", item.amount),
    fact("Date", item.item_date),
    fact("Number printed on it", item.doc_number),
    fact("PO / job box", marks.po),
    fact("Job words the reader found", marks.hint),
    fact("Address on it", marks.address),
    fact("Job name on it", marks.jobName),
    fact("Job number on it", marks.jobNumber),
    fact("Customer on it", marks.customer),
    sp.jobConflict ? `Note: ${sp.jobConflict}` : null,
    fact("What it is", item.summary),
    lines.length
      ? `Lines:\n${lines
          .slice(0, 40)
          .map((l) => `- ${String(l?.description ?? "").slice(0, 120)}${l?.amount != null ? ` ($${l.amount})` : ""}`)
          .join("\n")}`
      : null,
  ].filter(Boolean);
  const jobLines = markJobs.map((j) => {
    const customer = (j.customerNames ?? []).filter(Boolean).join(" / ");
    return `${j.id} — ${j.job_number ?? ""} ${j.name ?? ""}${j.address ? `; address: ${j.address}` : ""}${customer ? `; customer: ${customer}` : ""}`;
  });

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
Rules: "file_job" when anything on the paper points to one job in the list: its PO or job box (contractors write the job's name or street there, e.g. "13897 HERRINGBONE" is the job at 13897 Herringbone Way), a job name, a street (a street written without "Way", "Rd" and so on is still that street), a job number, or a customer. "overhead" only for a company-expense receipt with an amount; a supplier's finance charge, service charge, late fee or interest is "unsure", never "overhead". "task" when a note describes something to DO (call, order, schedule, follow up). "keep_note" for reference info. "unsure" if you genuinely can't tell.
${selfNames.length ? `These names are the company itself and its people, printed as who the paper was sold to; they are never the customer or the job: ${selfNames.join(", ")}.\n` : ""}
Open jobs (id — number name; address; customer):
${jobLines.join("\n") || "(none)"}`,
      messages: [
        {
          role: "user",
          content: `kind=${item.kind}\n${paperFacts.join("\n")}`,
        },
      ],
    });
    // METER (0162): receipt/document reads are a real cost centre, not just chat.
    void recordAiUsage({ orgId, model: (msg as { model?: string }).model ?? DEFAULT_MODEL, surface: "organize", usage: msg.usage as never });
    const block = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    parsed = await parseAiJson(client, block?.text ?? "", orgId);
  } catch (e: any) {
    return {
      ok: false,
      message: e?.message?.includes("ANTHROPIC_API_KEY") ? "AI review needs the API key set." : "AI couldn't review this one.",
    };
  }

  const action = String(parsed?.action ?? "unsure");
  const reason = typeof parsed?.reason === "string" ? parsed.reason : "";
  const state = readinessOf(item).state;
  // WHERE THE GUESS SHOWS (no dead doors): a job guess is a chip on a cost's picker, on a kept
  // paper's picker, and on a picture once Job Photo is pressed; a bucket guess only on a bill or
  // receipt. The reply says where to tap, or says nothing is there to tap.
  const isCost = state === "ready" || state === "needs_total";
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
    if (action === "file_job" && markJobs.some((j) => j.id === parsed.job_id)) {
      const label = jobLabelOf(String(parsed.job_id));
      const { data: sBack, error: sErr } = await updateItemTolerant(supabase, id, orgId, {
        proposal: { ...proposalOf(item), guessJobId: String(parsed.job_id), bucket: null, bucketFrom: null, why: reason || null },
      }, { onlyIfStatus: "needs_review" });
      if (sErr) return { ok: false, message: dbError(sErr) };
      if (!sBack?.length) return { ok: false, message: SUGGEST_MISSED };
      revalidatePath("/organize");
      revalidatePath("/bills");
      if (state === "picture")
        return {
          ok: true,
          message: `A guess: ${label}. If it's a job photo, press Job Photo on the row and the guess is there to tap. If it's a bill or receipt, press Bill Or Receipt. ${reason}`.trim(),
        };
      return { ok: true, message: `A guess: ${label}. Tap it on the row to pick it, then press File It if that's right. ${reason}`.trim() };
    }
    if (action === "overhead") {
      // The bucket is one of the six, and Fees is never the AI's suggestion, because a supplier's
      // late or service charge is already on that supplier's own paperwork.
      const cat = bucketOf(parsed.overhead_category);
      // Only a bill or a receipt can be a business cost, and only its row has a bucket to tap.
      if (!isCost)
        return {
          ok: true,
          message: `Suggested: Business Cost, ${cat}. Nothing was picked: ${
            state === "picture"
              ? "if it's a bill or receipt, press Bill Or Receipt on the row first."
              : "this wasn't read as a bill or receipt. If it is one, Fix Details and change its type."
          } ${reason}`.trim(),
        };
      if (cat === "Fees" || looksLikeSupplierFee(item.title, item.vendor, item.summary))
        return {
          ok: true,
          message:
            "This looks like a fee or a supplier's late charge, so nothing was suggested. A supplier's late interest comes in with that supplier's own paperwork. If it is a different fee, pick Business Cost: Fees yourself.",
        };
      const { data: sBack, error: sErr } = await updateItemTolerant(supabase, id, orgId, {
        proposal: { ...proposalOf(item), guessJobId: null, bucket: cat, bucketFrom: "ai", why: reason || null },
      }, { onlyIfStatus: "needs_review" });
      if (sErr) return { ok: false, message: dbError(sErr) };
      if (!sBack?.length) return { ok: false, message: SUGGEST_MISSED };
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
      if (state === "picture")
        return { ok: true, message: `Suggested: ${said}. Nothing was moved: answer What Is This? on the row. ${reason}`.trim() };
      if (state !== "keep")
        return {
          ok: true,
          message: `Suggested: ${said}. This paper can be money, so it stays here until a person files it or sets it aside. ${reason}`.trim(),
        };
      // SUGGEST PROPOSES, EVEN HERE (Erik, audit v994 PR2). This used to insert the task and file
      // the note on its own, and the only message saying so vanished with the card on refresh, with
      // no Undo. Now the proposal is kept on the row as a chip (Make Task: <title>, or Keep As
      // Note), and a person's tap does it, through a door that says what it did and offers Undo.
      const proposal: PaperProposal =
        action === "task"
          ? {
              ...proposalOf(item),
              suggestTask: {
                title: String(parsed.task_title || item.title).slice(0, 200),
                category: ["office", "operations", "sales"].includes(parsed.task_category) ? parsed.task_category : "operations",
              },
              suggestKeep: null,
              why: reason || null,
            }
          : { ...proposalOf(item), suggestTask: null, suggestKeep: true, why: reason || null };
      const { data: sBack, error: sErr } = await updateItemTolerant(supabase, id, orgId, { proposal }, { onlyIfStatus: "needs_review" });
      if (sErr) return { ok: false, message: dbError(sErr) };
      if (!sBack?.length) return { ok: false, message: SUGGEST_MISSED };
      revalidatePath("/organize");
      return {
        ok: true,
        message: `Suggested: ${said}. Tap ${action === "task" ? "Make Task" : "Keep As Note"} on the row if that's right; nothing moves until you do. ${reason}`.trim(),
      };
    }
    // NOTHING TO SUGGEST IS AN ANSWER, NOT A FAILURE (Erik, 2026-09-24): said as a plain note on the
    // row, never in the red box an error gets.
    return {
      ok: true,
      message: `No suggestion. ${reason || "Nothing on this paper points to one job or a business cost."} Pick where it goes yourself.`.trim(),
    };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? "Couldn't apply the suggestion." };
  }
}

/** Can this paper become a task or be kept as a note? Only paper that is not money, still waiting. */
function noteRefusal(item: any): string | null {
  if (!item) return "That paper isn't here any more.";
  if (item.status !== "needs_review") return "This is already filed or kept. Undo it first.";
  const state = readinessOf(item).state;
  if (state === "picture") return "Answer What Is This? on the row first.";
  if (state !== "keep") return "This paper can be money, so it stays here until a person files it or sets it aside.";
  return null;
}

/**
 * MAKE TASK: a person tapped AI Suggest's proposal (Erik, audit v994 PR2). The task is made, the
 * note is filed as a Task, and the filing records the task, so Undo takes the task off the list and
 * brings the note back. The note moves only while it is still waiting; if it moved meanwhile, the
 * task this press made comes back off, so one tap never leaves a task and a note both standing.
 */
export async function makeTaskFromPaper(id: string): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  const no = noteRefusal(item);
  if (no) return { ok: false, error: no };
  const p = proposalOf(item);
  const title = String(p.suggestTask?.title || item.title || "Follow up").slice(0, 200);
  const category = p.suggestTask?.category ?? "operations";
  const { data: task, error: taskErr } = await supabase
    .from("tasks")
    .insert({ title, category, status: "open", created_by: ctx.userId })
    .select("id")
    .single();
  if (taskErr || !task?.id) return { ok: false, error: taskErr ? `${dbError(taskErr)} No task was made.` : "The task didn't save, so this note stays here." };
  const { data: moved, error: movedErr } = await supabase
    .from("organized_items")
    .update({
      status: "filed",
      category: "Task",
      proposal: { ...p, filed: { how: "task", taskId: String(task.id), category: item.category ?? null } } satisfies PaperProposal,
    })
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .eq("status", "needs_review")
    .select("id");
  if (movedErr || !moved?.length) {
    await supabase.from("tasks").delete().eq("id", task.id).select("id");
    return { ok: false, error: movedErr ? `${dbError(movedErr)} No task was made.` : "This note was just moved somewhere else, so no task was made." };
  }
  revalidatePath("/organize");
  revalidatePath("/tasks");
  return { ok: true, message: `Made a task: "${title}". The note is filed with it.` };
}

/** KEEP AS NOTE: a person tapped AI Suggest's proposal (PR2). Filed as a note; Undo brings it back. */
export async function keepAsNote(id: string): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  const no = noteRefusal(item);
  if (no) return { ok: false, error: no };
  const { data: kept, error } = await supabase
    .from("organized_items")
    .update({ status: "filed", proposal: { ...proposalOf(item), filed: { how: "note" } } satisfies PaperProposal })
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .eq("status", "needs_review")
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!kept?.length) return { ok: false, error: "Nothing was kept. This paper was just moved, or this login can't change it." };
  revalidatePath("/organize");
  return { ok: true, message: "Kept as a note. Find it in the Archive." };
}
