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
// TWO PROMPTS ITEMISE A RECEIPT and they must offer the model the SAME categories: the Organize
// My classifier (any upload) and the job-receipt reader (a receipt already filed to a job). They
// were two hand-maintained copies of one list, which is how "Food & Drink" would have shipped to
// one door and not the other. One exported string, interpolated into both, is the only version of
// "identical" that stays true. The rule sentence beneath each schema is shared for the same reason.
import {
  FOOD_AND_DRINK_PROMPT_RULE,
  MASKED_PRICE_PROMPT_RULE,
  looksProvisionallyPriced,
  RECEIPT_LINE_CATEGORY_SCHEMA_HINT,
  decideReceiptLine,
} from "@/app/(app)/bills/receipt-billing";

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
    /** The business-cost bucket it was filed in, when destination is overhead. */
    bucket?: string | null;
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
  /** false = the company eats this line; it never reaches the customer's invoice (0268). */
  billable: boolean;
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
      const description = String(l?.description ?? "").slice(0, 300).trim();
      const stated = l?.category ? String(l.category).slice(0, 60) : null;
      // WHOSE LINE IS IT (0268). Erik's INV-069 billed a homeowner for a Smartwater, a
      // BodyArmor and a ten cent bottle deposit, and his answer was to stop scanning receipts
      // at all — "i have another receipt that i didnt scan specifically because it was mostly
      // snacks and a $3 part" — which cost him the $3 job cost too. Food and drink now arrives
      // switched OFF the customer's bill and everything else arrives on it, tools included,
      // because he was asked and that is exactly what he chose. This is also the one place a
      // decision he already made survives: a tray item's lines are stored as jsonb and re-read
      // verbatim when it is filed (or moved to another job) later, so an explicit flag in the
      // stored row wins over the default and re-filing never re-bills the snacks.
      //
      // AND THE NET UNDER IT. Twelve minutes after that shipped, with the Food & Drink rule in
      // front of it, the reader filed two bags of kettle chips and an ice cream bar as "Other" —
      // billable — on the Waldow job. A prompt is a request, not a mechanism. decideReceiptLine
      // fills in a shrug ("Other", blank) when the words are plainly food, never touches a
      // category the model actually chose, and never overrules a flag a person already set.
      // This is the only door all three receipt paths pass through — the Organize My classifier,
      // the job-receipt reader, and re-filing a tray item — so it is the only place it belongs.
      const { category, billable } = decideReceiptLine(description, stated, l?.billable);
      return { description, quantity, unit_price, amount, category, billable };
    })
    .filter((l: BillLine) => l.description.length > 0)
    .slice(0, 100);
}

/** A store receipt is already paid; a supplier bill/invoice is still owed. New
 *  uploads default to UNPAID so an owed bill is never silently marked paid. */
function billStatusFor(category: string | null | undefined): "paid" | "unpaid" {
  return /bill|invoice/i.test(category || "") ? "unpaid" : "paid";
}

/** Paid/unpaid for a bill created from an ALREADY-ANALYZED tray item. Prefers what the AI
 *  actually read off the paper (organized_items.payment, migration 0153) and only falls back
 *  to the category-name heuristic for legacy rows analyzed before that column existed.
 *  A classified-but-not-tendered receipt (ON ACCT, net terms) stays UNPAID so the debt shows
 *  up in payables instead of surfacing on next month's supply-house statement. */
function billStatusFromItem(item: { payment?: string | null; category?: string | null }): "paid" | "unpaid" {
  const p = String(item.payment ?? "");
  if (p === "paid_at_purchase") return "paid";
  if (p === "on_account" || p === "unknown") return "unpaid";
  return billStatusFor(item.category);
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
    scope_category?: string | null; // the JOB SCOPE (Framing, Decking…) for budget-vs-actual
    notes: string;
    created_by: string;
    /** 0271: the prices on this paper are a counter preview, not this account's own. */
    pricing_provisional?: boolean;
  },
  lines: BillLine[],
  status: "paid" | "unpaid" = "unpaid",
): Promise<string | null> {
  const { data, error } = await supabase.from("bills").insert({ ...bill, status }).select("id").single();
  if (error || !data) {
    // A RECEIPT THAT DID NOT BECOME A BILL USED TO SAY NOTHING AT ALL (review, 2026-09-19).
    //
    // This returned a bare null, so the caller filed the document, told Erik it was filed, and the
    // cost simply never existed - the silent-write law broken at the one place a whole receipt can
    // vanish. It is also the exact shape a deploy-before-migration takes here: PostgREST rejects
    // the WHOLE insert for one unknown column, so a push that lands before its migration would
    // have quietly stopped recording every scanned receipt until somebody noticed the money was
    // missing. It cannot be a thrown error (the document IS filed by this point and that is worth
    // keeping), so it goes to the ops log, where the daily sweep reads it.
    reportError("organize:insertItemizedBill", error ?? new Error("bill insert returned no row"), {
      supplier: bill.supplier,
      jobId: bill.job_id,
      amount: bill.amount,
    });
    return null;
  }
  if (lines.length) {
    const { error: lineErr } = await supabase
      .from("bill_line_items")
      .insert(
        lines.map((l, i) => ({
          bill_id: data.id,
          description: l.description,
          quantity: l.quantity,
          unit_price: l.unit_price,
          amount: l.amount,
          category: l.category,
          billable: l.billable,
          sort_order: i,
        })),
      )
      .select("id");
    // A BILL WITH NO LINES IS STILL A NUMBER (silent-write law, same pass as 0278). The bill row
    // is already in and carries the total, so throwing it away would lose the whole cost - but
    // the itemisation is what 0268 bills off and what the Receipt Line editor shows, so a receipt
    // that lands as a bare total must not do it quietly. Same reason it is the ops log and not a
    // thrown error: the cost IS recorded, and that is worth keeping.
    if (lineErr) {
      reportError("organize:insertItemizedBill.lines", lineErr, {
        billId: data.id,
        supplier: bill.supplier,
        lineCount: lines.length,
      });
    }
  }
  return data.id;
}

/** Pull a JSON object out of a Claude reply (tolerates ```json fences and a
 *  trailing comma before a closing bracket — a common model slip). */
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
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // Cheap input validation first — junk input gets a clean rejection, no row.
  const isImage = IMAGE_TYPES.includes(input.mime);
  const isPdf = input.mime === "application/pdf";
  if (!isImage && !isPdf) {
    return { ok: false, error: "Use a photo (JPG/PNG) or PDF — other file types can't be read yet." };
  }
  if (input.size > 8 * 1024 * 1024) return { ok: false, error: "File is over 8 MB — try a smaller photo." };

  // Save the capture BEFORE the AI ever runs: a needs_review placeholder row goes
  // in the moment the upload is confirmed, so a failed AI read (or the PWA getting
  // suspended mid-analyze) can never silently lose a photographed receipt — worst
  // case the raw capture waits in the tray for a manual file or an AI retry.
  const { data: placeholder, error: phErr } = await supabase
    .from("organized_items")
    .insert({
      kind: "job_document", // best guess until the AI has looked
      title: String(input.name).slice(0, 200),
      confidence: "low",
      status: "needs_review",
      file_url: input.path,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (phErr || !placeholder) return { ok: false, error: phErr?.message ?? "Could not save the upload." };
  const itemId: string = placeholder.id;

  // Candidate jobs for matching (recent, active-ish).
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, job_number, name, address, city, customers(name)")
    .in("status", ACTIVE_JOB_STATUSES)
    .order("created_at", { ascending: false })
    .limit(40);
  const jobList = (jobs ?? []).map((j: any) => ({
    id: j.id,
    label: `${j.job_number} — ${j.name}${j.customers?.name ? ` (${j.customers.name})` : ""}${j.address ? `, ${j.address}` : ""}${j.city ? `, ${j.city}` : ""}`,
  }));

  // Pull the uploaded file back out of storage for Claude to look at.
  const { data: blob, error: dlErr } = await supabase.storage.from("documents").download(input.path);
  if (dlErr || !blob) {
    revalidatePath("/organize"); // the placeholder stays in the tray
    return { ok: false, error: `${dlErr?.message ?? "Could not read the upload."} Saved to the review tray.` };
  }
  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");

  const mediaBlock: any = isImage
    ? { type: "image", source: { type: "base64", media_type: input.mime, data: base64 } }
    : { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };

  let parsed: any;
  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: `You file paperwork for an electrical contractor. Look at the upload and classify it.

Respond with ONLY a JSON object (no prose):
{
  "kind": "receipt" | "note" | "job_document",
  "title": short label, e.g. "Home Depot — $84.12" or "Note: call inspector Tuesday",
  "summary": receipt → brief list of what was bought; note → full clean transcription of the handwriting; job_document → what the document is,
  "line_items": receipts ONLY — an array of every purchased line: [{"description": item name, "quantity": number, "unit_price": price each (number), "amount": line total (number), "category": ${RECEIPT_LINE_CATEGORY_SCHEMA_HINT}}]. Transcribe EVERY line you can read, including tax as its own line. Use [] for notes/documents or an unreadable receipt,
  "vendor": store/supplier name or null,
  "amount": total in dollars as a number, or null,
  "date": "YYYY-MM-DD" date printed on it, or null,
  "category": "Receipt" | "Bill" | "Invoice" | "Photo" | "Plan" | "Permit" | "Other",
  "pricing_provisional": true | false — true when the price column is masked (*****), blank or "N/A", or the paper is a quote/counter preview rather than this account's own pricing,
  "payment": "paid_at_purchase" | "on_account" | "unknown" — receipts only. "paid_at_purchase" ONLY when the document shows tender (cash tendered/change, a card number/••••, or an explicit PAID stamp); "on_account" when it shows a charge account, ON ACCT, net terms, "invoice", or a balance due (supply-house account purchases); "unknown" when you cannot tell,
  "destination": "job" | "overhead" | "unsure" — receipts only. "job" if the purchase is materials for a specific job; "overhead" if it is clearly a company expense NOT tied to one job (gas station, truck, shop supplies, small tools, phone, office, insurance, licenses); "unsure" otherwise,
  "overhead_category": ${AUTO_FILE_BUCKETS.map((b) => JSON.stringify(b)).join(" | ")} or null — only when destination is "overhead",
  "job_id": the id of the matching job ONLY if the content clearly points to one (job number, customer name, or address visible), else null,
  "confidence": "low" | "medium" | "high"
}

Rules: never guess a job_id — only match when something on the paper points to it. A gas-station or convenience receipt is overhead (Gas & Truck). Generic supply-house receipts with no job reference are "unsure", not overhead. A supplier's finance charge, service charge, late fee or interest is "unsure", never overhead: those come in with the supplier's own paperwork and must not be filed twice. In every "description", write inches as the word in (e.g. "6 in EMT", not 6") and never put a raw double-quote character inside a JSON string.

${FOOD_AND_DRINK_PROMPT_RULE}

${MASKED_PRICE_PROMPT_RULE}

Jobs you may match against (id — label):
${jobList.map((j) => `${j.id} — ${j.label}`).join("\n") || "(none)"}`,
      messages: [
        {
          role: "user",
          content: [mediaBlock, { type: "text", text: `Filename: ${input.name}. Classify and extract.` }],
        },
      ],
    });
    // METER (0162): receipt/document reads are a real cost centre, not just chat.
    void recordAiUsage({ orgId: ctx.orgId, model: (msg as { model?: string }).model ?? DEFAULT_MODEL, surface: "organize", usage: msg.usage as never });
    const text = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    parsed = await parseAiJson(client, text?.text ?? "", ctx.orgId);
  } catch (e: any) {
    // The capture is NOT lost — the placeholder row stays needs_review in the tray.
    revalidatePath("/organize");
    return { ok: false, error: `${e?.message ?? "AI could not read this file."} Saved to the review tray.` };
  }

  const kind = ["receipt", "note", "job_document"].includes(parsed.kind) ? parsed.kind : "job_document";
  const jobId = jobList.some((j) => j.id === parsed.job_id) ? parsed.job_id : null;
  const category = String(parsed.category || KIND_TO_CATEGORY[kind] || "Other");
  const title = String(parsed.title || input.name).slice(0, 200);
  const confidence = ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "medium";
  const amount = parsed.amount != null && !isNaN(Number(parsed.amount)) ? Number(parsed.amount) : null;
  const itemDate = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date ?? "")) ? parsed.date : null;
  // THE READER'S BUCKET IS CHECKED BEFORE IT IS WRITTEN. It used to be saved exactly as the model
  // spelled it, so a model slip ("Fuel", "gas") became a seventh category no other door knew.
  // bucketOf always answers with one of the six. Fees is the one the reader may not pick: a
  // supplier's late or service charge is already on the supplier's own paperwork, so a fee-shaped
  // paper, by the model's word or by its own words, waits in Needs Review for a person.
  const overheadCategory = bucketOf(parsed.overhead_category);
  const feeShaped =
    overheadCategory === "Fees" ||
    looksLikeSupplierFee(title, parsed.vendor ? String(parsed.vendor) : null, parsed.summary ? String(parsed.summary) : null);
  // What the paper says about PAYMENT decides paid/unpaid — not the category heuristic.
  // billStatusFor() calls anything not named "bill/invoice" paid, so an ON-ACCT supply-house
  // ticket filed here vanished from payables until the monthly statement arrived. Unknown
  // defaults to UNPAID: a debt you already settled is harmless, one you forget is not.
  const paymentRead = ["paid_at_purchase", "on_account", "unknown"].includes(String(parsed.payment ?? ""))
    ? String(parsed.payment)
    : "unknown";
  const billStatus: "paid" | "unpaid" = paymentRead === "paid_at_purchase" ? "paid" : "unpaid";
  const lines = kind === "receipt" ? cleanLines(parsed.line_items) : [];

  // Decide where it goes — auto-file only when confident, else the tray.
  // - job matched → file to that job (any kind)
  // - clear overhead receipt with an amount → business-cost bill (no job), never a fee
  // - notes stand alone fine → filed
  // - everything else → needs_review
  const isOverhead =
    kind === "receipt" && parsed.destination === "overhead" && amount != null && confidence !== "low" && !feeShaped;
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
        uploaded_by: ctx.userId,
      })
      .select("id")
      .single();
    documentId = doc?.id ?? null;
  }

  /**
   * IS THIS PAPER PRICED FOR HIM, OR JUST PRICED? (Erik, 2026-09-18; 0271.)
   *
   * His CED account is priced by Truckee. Buy at another branch and the ticket shows that branch's
   * retail counter price with asterisks where his contract price will go - "thats why the invoice
   * has all the *****" - and the real one follows by email days later. Left unmarked, the retail
   * figure becomes a learned price he is never charged, and the priced invoice lands as a SECOND
   * bill for the same purchase.
   *
   * Two chances at the same fact, because one of them is a language model: what the reader
   * answered, OR the mask still visible in the text it transcribed. Either is enough - under-
   * flagging teaches the price book a wrong number, while over-flagging only means a card asks
   * him to confirm a cost he was going to look at anyway.
   */
  const provisional =
    parsed?.pricing_provisional === true ||
    looksProvisionallyPriced(String(parsed?.summary ?? "")) ||
    (lines ?? []).some((l: { description?: string | null }) => looksProvisionallyPriced(l?.description));

  // A receipt becomes a billable cost: an itemized bill on the job (job receipt)
  // or a company expense bill (overhead). Notes/job-documents make no bill.
  let billId: string | null = null;
  if (kind === "receipt" && amount != null && destination === "job" && jobId) {
    billId = await insertItemizedBill(
      supabase,
      { job_id: jobId, supplier: vendor, amount, bill_date: itemDate, category, notes: `Receipt filed by Organize My: ${title}`, created_by: ctx.userId, pricing_provisional: provisional },
      lines,
      billStatus,
    );
  } else if (destination === "overhead") {
    billId = await insertItemizedBill(
      supabase,
      { job_id: null, supplier: vendor, amount, bill_date: itemDate, category: overheadCategory, notes: `Filed by Organize My: ${title}`, created_by: ctx.userId, pricing_provisional: provisional },
      lines,
      billStatus,
    );
    // A business cost IS its bill: there is no copy on a job to fall back on. If the bill did not
    // land, the receipt stays in Needs Review, so the screen never reads "Filed as a Business
    // Cost" over a cost that does not exist.
    if (!billId) {
      destination = "none";
      status = "needs_review";
    }
  }

  // Upgrade the placeholder row with the AI's read (UPDATE, not a second insert,
  // so a retry or crash never leaves duplicates).
  const { error } = await supabase
    .from("organized_items")
    .update({
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
      // Persist HOW it was paid so a later manual file (fileItem) honors the paper
      // instead of re-guessing from the category name (0153).
      payment: kind === "receipt" ? paymentRead : null,
    })
    .eq("id", itemId);
  if (error) return { ok: false, error: dbError(error) };

  revalidatePath("/organize");
  revalidatePath("/bills");
  if (jobId) revalidatePath(`/jobs/${jobId}`);

  return {
    ok: true,
    item: {
      id: itemId,
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
      bucket: destination === "overhead" ? overheadCategory : null,
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
export async function billJobReceipt(
  documentId: string,
  /** What the PERSON stated in the capture form. User attestation beats AI inference:
   *  they were standing at the counter. The AI fills only what was left blank. */
  stated?: { paid?: boolean; category?: string | null; billDate?: string | null },
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
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: `You read a purchase receipt for an electrical contractor and itemize it as a job cost.

Respond with ONLY a JSON object (no prose):
{
  "vendor": store/supplier name or null,
  "amount": grand total in dollars as a number (the amount actually paid), or null only if you truly cannot read it,
  "date": "YYYY-MM-DD" printed on the receipt, or null,
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

  const billId = await insertItemizedBill(
    supabase,
    {
      job_id: doc.job_id,
      supplier: vendor,
      amount,
      bill_date: stated?.billDate || itemDate,
      category: stated?.category || "Receipt",
      scope_category: scopeCategory, // job scope for budget-vs-actual (null → Uncategorized)
      notes: check.mismatch
        ? `Receipt recorded as cost: ${doc.name}\n\n${check.note}`
        : `Receipt recorded as cost: ${doc.name}`,
      created_by: ctx.userId,
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
    item_date: stated?.billDate || itemDate,
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
  | { type: "overhead"; category: string }
  | { type: "unfiled" };

/**
 * File (or re-file) an item to any destination. Tears down whatever rows the
 * previous destination created, then creates the new ones, so moving things
 * around can never double-count.
 */
export async function fileItem(id: string, dest: FileDestination): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Checked BEFORE anything is torn down, so a bad bucket costs nothing.
  if (dest.type === "overhead" && !isBusinessCostBucket(dest.category))
    return { ok: false, error: "Pick one of the six business cost buckets. Nothing was moved." };

  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).maybeSingle();
  if (!item) return { ok: false, error: "Item not found." };

  // THE BILL COMES DOWN FIRST, AND ONLY IF THE DATABASE LETS IT (0278; audit of cn-v951..v966).
  //
  // Re-filing tears the old filing down and builds a new one, and this line tore down a bill a
  // LIVE INVOICE was already billing. invoice_items has no foreign key to bills - a claim is a
  // uuid inside an array - so the invoice lines survived the delete intact and went on charging
  // the customer for a receipt that no longer existed, while the job's cost dropped by the same
  // amount and its margin jumped. Re-filing is the worse half: the replacement bill comes back
  // with a NEW id that no claim covers, so importCostsIntoInvoice will bill the same purchase to
  // a second customer. Bill c0535cdb, $467.87 of CED on J-046, is claimed by eight lines of
  // INV-069 that Jason has already part paid; 26 of the 30 receipts in the Organize archive are
  // in that state today.
  //
  // Throwing the result away is what made it silent: with the guard in place the teardown now
  // FAILS, and the old code walked straight past that into inserting the second bill.
  //
  // FIRST, ahead of the document and petty-cash rows, so a refusal leaves the item exactly as it
  // was and "Nothing was moved" is a fact rather than a hope. No zero-row refusal here, unlike
  // the trash door: bills_write and the organized_items read are the same org+staff gate, so
  // zero rows means the bill is simply already gone (bill_id is ON DELETE SET NULL, and a retry
  // after a half-finished move lands here), and re-filing has to keep working.
  if (item.bill_id) {
    const { error: billErr } = await supabase.from("bills").delete().eq("id", item.bill_id).select("id");
    if (billErr)
      return {
        ok: false,
        error:
          billClaimRefusal(
            billErr,
            "Void that invoice, or take its materials lines off, then file this again. Nothing was moved.",
          ) ?? dbError(billErr),
      };
  }
  // Then the rest of the previous filing. The petty-cash row is torn down HERE too (audit 9,
  // 0202): without a back-link, re-filing a receipt left the first petty_cash row standing and
  // the same disbursement was counted twice in the drawer. Both are checked for the bill's own
  // reason - a teardown that fails and says nothing becomes a SECOND row a moment later.
  if (item.document_id) {
    const { error: docErr } = await supabase.from("documents").delete().eq("id", item.document_id).select("id");
    if (docErr) return { ok: false, error: `${dbError(docErr)} The old copy is still on the job, so this was not re-filed.` };
  }
  if (item.petty_cash_id) {
    const { error: pcErr } = await supabase.from("petty_cash").delete().eq("id", item.petty_cash_id).select("id");
    if (pcErr)
      return { ok: false, error: `${dbError(pcErr)} The old petty cash entry is still in the drawer, so this was not re-filed.` };
  }
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
        uploaded_by: ctx.userId,
      })
      .select("id")
      .single();
    documentId = doc?.id ?? null;
    // A receipt filed to a job becomes an itemized billable cost on that job.
    if (item.kind === "receipt" && item.amount != null) {
      billId = await insertItemizedBill(
        supabase,
        { job_id: dest.jobId, supplier: item.vendor ?? item.title, amount: item.amount, bill_date: item.item_date, category: "Receipt", notes: `Receipt filed by Organize My: ${item.title}`, created_by: ctx.userId },
        lines,
        billStatusFromItem(item),
      );
    }
  } else if (dest.type === "overhead") {
    category = dest.category;
    billId = await insertItemizedBill(
      supabase,
      { job_id: null, supplier: item.vendor ?? item.title, amount: item.amount ?? 0, bill_date: item.item_date, category: dest.category, notes: `Filed by Organize My: ${item.title}`, created_by: ctx.userId },
      lines,
      billStatusFromItem(item),
    );
    // A business cost IS its bill; there is no copy on a job to show for it. If the bill did not
    // land, the old filing is already gone, so the item goes back to Needs Review holding nothing
    // and the tap says so, instead of reading "Filed" over a cost that does not exist.
    if (!billId) {
      await supabase
        .from("organized_items")
        .update({ job_id: null, document_id: null, bill_id: null, petty_cash_id: null, status: "needs_review" })
        .eq("id", id);
      revalidatePath("/organize");
      if (prevJob) revalidatePath(`/jobs/${prevJob}`);
      return { ok: false, error: "The business cost didn't save, so this receipt is back in Needs Review. Try again." };
    }
  }

  const { error } = await supabase
    .from("organized_items")
    // petty_cash_id is cleared in the SAME write as the others, so a receipt filed to petty cash
    // before that door closed leaves no stale link once it is re-filed (audit 9).
    .update({ job_id: jobId, document_id: documentId, bill_id: billId, petty_cash_id: null, category, status: "filed" })
    .eq("id", id);
  if (error) return { ok: false, error: dbError(error) };

  revalidatePath("/organize");
  revalidatePath("/bills");
  revalidatePath("/petty-cash");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  if (prevJob) revalidatePath(`/jobs/${prevJob}`);
  return { ok: true };
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

/** Bring an archived/filed item back to the needs-review tray. */
export async function unarchiveItem(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("organized_items").update({ status: "needs_review" }).eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
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
    .in("status", ACTIVE_JOB_STATUSES)
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
      // Categorising one document into an action bucket, with a human review tray
      // behind it — not the receipt-reading that becomes billable money.
      model: modelFor("routine"),
      max_tokens: 500,
      system: `You triage one piece of paperwork for an electrical contractor and decide the single best action. Output ONLY a JSON object:
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
    // CHECK WHAT fileItem SAID (audit 9). It refuses for a non-staff caller — bills and petty
    // cash are staff-gated — and this reported "Filed to <job>" regardless, so a tech watched
    // the AI confidently file a receipt that stayed exactly where it was. The task and note
    // branches below are genuinely open to techs and keep working.
    if (action === "file_job" && jobList.some((j) => j.id === parsed.job_id)) {
      const r = await fileItem(id, { type: "job", jobId: parsed.job_id });
      if (!r.ok) return { ok: false, message: r.error ?? "Couldn't file that one — ask the office." };
      return { ok: true, message: `Filed to ${jobList.find((j) => j.id === parsed.job_id)?.label}. ${reason}`.trim() };
    }
    if (action === "overhead") {
      // Same two checks as the auto-file path: the bucket is one of the six, and Fees is never
      // the AI's call, because a supplier's late or service charge is already on that supplier's
      // own paperwork. Refusing here files nothing and names the door a person can use.
      const cat = bucketOf(parsed.overhead_category);
      if (cat === "Fees" || looksLikeSupplierFee(item.title, item.vendor, item.summary))
        return {
          ok: false,
          message:
            "This looks like a fee or a supplier's late charge, so it was not filed. A supplier's late interest comes in with that supplier's own paperwork. If it is a different fee, pick Business Cost and then Fees.",
        };
      const r = await fileItem(id, { type: "overhead", category: cat });
      if (!r.ok) return { ok: false, message: r.error ?? "Couldn't file that one — ask the office." };
      return { ok: true, message: `Filed as a Business Cost: ${cat}. ${reason}`.trim() };
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
