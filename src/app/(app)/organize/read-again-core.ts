import type { FileDestination, FileOptions } from "./actions";
import { isBusinessCostBucket } from "@/lib/business-cost-buckets";
import { creditExpectedOf, penSentence, penSummary } from "@/lib/pen-marks";
import { formatCurrency } from "@/lib/utils";
import { isStillOwed } from "@/lib/supplier-owed";
import { alreadyBilledSentence, readBillClaimants, sentClaimant } from "@/lib/bill-claimants";

/**
 * READ AGAIN, ON A PAPER ALREADY FILED AS A BILL (cn-v1181). The owner's marked-up tickets were
 * filed before the readers learned pen marks; this reads each one again with today's readers and
 * files it again the way it was filed, in one press, through the doors that already exist:
 *
 *   1. ASK FIRST, CHANGE NOTHING: the bill and its paper (the `organized_items` row whose `bill_id`
 *      is this bill) are read; no paper, no picture, a picture the reader can't open, a correction
 *      or credit memo filed under the bill, a bill that is itself a correction or a copy set aside,
 *      or a reader that is paused: refused in one sentence, nothing changed.
 *   2. UNDO through `undoPaperwork`, the one door that takes a filing down. Every refusal it makes
 *      (an invoice already bills it, a copy set aside, a line in shop stock) comes back as it is.
 *   3. READ AND FILE AGAIN, the way it was filed:
 *        · a receipt recorded on the JOB PAGE (`source === "job"` with its `document_id`) through
 *          `billJobReceipt`, with what the person had stated rebuilt from the old bill and its
 *          paper (paid at the counter, the date, the category, the part of the job, and a
 *          Different Purchase a person had already decided, which the old bill's notes say);
 *        · a TRAY paper through `readPaperworkItem` then `fileItem` to the same place: the old
 *          bill's job (and its part), or its business-cost bucket. A shop-stock ticket needs a
 *          person's count, and a place that can't be told surely is never guessed: the paper is
 *          read and left WAITING, and the answer says where.
 *   4. When a step after the Undo fails the paper is never lost and never half-filed: the answer
 *      reads where it stands now (waiting in the tray, or the receipt back on its job) and says it.
 *
 * The doors are passed in, so every branch is proven without a database (read-again.test.ts); the
 * server action in read-again-actions.ts hands it the real ones.
 */

export type DoorResult = { ok: boolean; error?: string; message?: string };
export type BillJobStated = {
  paid?: boolean;
  category?: string | null;
  billDate?: string | null;
  scope?: string | null;
  differentPurchase?: boolean;
};
export type BillJobResult = { ok: boolean; error?: string; already?: boolean; sameAs?: string; amount?: number | null; warning?: string; pen?: string };

export type ReadAgainDoors = {
  /** Is a read allowed for this company now (lib/ai-cost aiAllowed)? Asked before anything changes. */
  canRead: () => Promise<{ ok: boolean; why?: string }>;
  undo: (itemId: string) => Promise<DoorResult>;
  readTray: (itemId: string) => Promise<{ ok: boolean; error?: string }>;
  fileTray: (itemId: string, dest: FileDestination, opts: FileOptions) => Promise<DoorResult>;
  billJob: (documentId: string, stated: BillJobStated) => Promise<BillJobResult>;
};

type Db = { supabase: any; orgId: string | null };

/** The kinds of file the paper reader opens (mirrors organize/actions mimeFromName, not exported). */
const READABLE = /\.(jpe?g|png|webp|gif|pdf)(\?|$)/i;
/** The sentence fileItem and billJobReceipt write into a bill's notes when a person decided it. */
const DECIDED_DIFFERENT = "A person checked: a different purchase";
const NOTHING = "Nothing changed.";
const TRAY = "It is waiting in the tray on Bills, under Needs You.";

const money = (n: unknown) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? null : formatCurrency(Number(n)));

/** Where the paper stands now, after a step that failed: said, never assumed. */
async function whereNow(db: Db, paperId: string): Promise<string> {
  const { data, error } = await db.supabase
    .from("organized_items")
    .select("id, status")
    .eq("id", paperId)
    .eq("org_id", db.orgId)
    .maybeSingle();
  if (error) return "Where the paper stands now couldn't be read: reload Bills and look in the tray.";
  if (!data) return "The receipt stays on its job: on the job's Costs tab, press Record as Cost on it to make it a cost again.";
  if (data.status === "needs_review") return TRAY;
  return "It was filed from another screen meanwhile: reload the page to see where.";
}

/** The new filing, read back: its total, whether it is paid, and what the pen marks say. */
async function newFiling(
  db: Db,
  find: { id: string } | { documentId: string },
): Promise<{ amount: number | null; status: string | null; pen: string | null } | { error: string }> {
  let q = db.supabase.from("organized_items").select("id, bill_id, line_items, payment");
  q = "id" in find ? q.eq("id", find.id) : q.eq("document_id", find.documentId);
  const { data: rows, error } = await q.eq("org_id", db.orgId).limit(5);
  if (error) return { error: "The new bill couldn't be read back: open it on Bills to check its total and its lines." };
  const row = ((rows ?? []) as any[]).find((r) => r?.bill_id);
  if (!row) return { error: "The new bill couldn't be found from its paper: open Bills to check it." };
  const { data: bill, error: billErr } = await db.supabase
    .from("bills")
    .select("id, amount, status")
    .eq("id", row.bill_id)
    .eq("org_id", db.orgId)
    .maybeSingle();
  if (billErr || !bill) return { error: "The new bill couldn't be read back: open it on Bills to check its total and its lines." };
  const lines = Array.isArray(row.line_items) ? row.line_items : [];
  const pen = penSentence(penSummary(lines), { creditExpected: creditExpectedOf({ paperPayment: row.payment }) });
  return { amount: bill.amount === null || bill.amount === undefined ? null : Number(bill.amount), status: bill.status ?? null, pen };
}

export async function readFiledPaperAgainWith(db: Db, billId: string, doors: ReadAgainDoors): Promise<DoorResult> {
  if (!billId || typeof billId !== "string") return { ok: false, error: `Which bill? Reload the page and try again. ${NOTHING}` };

  // ── 1. ASK FIRST ──
  const { data: bill, error: billErr } = await db.supabase
    .from("bills")
    .select("id, amount, amount_paid, status, job_id, po_id, category, bill_date, scope_category, notes, on_shelf, corrects_bill_id, superseded_by_bill_id")
    .eq("id", billId)
    .eq("org_id", db.orgId)
    .maybeSingle();
  if (billErr) return { ok: false, error: `This bill couldn't be read, so ${NOTHING.toLowerCase()} Try again.` };
  if (!bill) return { ok: false, error: "That bill isn't on the books any more. Reload the page." };
  if (bill.corrects_bill_id)
    return { ok: false, error: `This bill is a correction filed under another bill, and Read Again can't file it back under it. ${NOTHING}` };
  if (bill.superseded_by_bill_id)
    return { ok: false, error: `This bill was set aside as a copy of another, and reading it again would make it count again. ${NOTHING}` };

  const { data: papers, error: paperErr } = await db.supabase
    .from("organized_items")
    .select("id, status, file_url, document_id, source, payment")
    .eq("bill_id", billId)
    .eq("org_id", db.orgId)
    .limit(2);
  if (paperErr) return { ok: false, error: `This bill's paper couldn't be read, so ${NOTHING.toLowerCase()} Try again.` };
  const paper = ((papers ?? []) as any[])[0];
  if (!paper) return { ok: false, error: `This bill wasn't made from a paper, so there is no picture to read again. ${NOTHING}` };
  if (!paper.file_url) return { ok: false, error: `This bill's paper has no picture on it (it was typed in), so there is nothing to read again. ${NOTHING}` };
  if (!READABLE.test(String(paper.file_url)))
    return { ok: false, error: `This bill's paper isn't a photo or a PDF, so it can't be read. ${NOTHING}` };
  const fromJob = paper.source === "job";
  if (fromJob && !paper.document_id)
    return { ok: false, error: `This receipt's link to its job is missing, so it can't be filed again the same way. ${NOTHING}` };

  const { data: under, error: underErr } = await db.supabase
    .from("bills")
    .select("id, bill_number, amount")
    .eq("corrects_bill_id", billId)
    .eq("org_id", db.orgId)
    .limit(20);
  if (underErr) return { ok: false, error: `What is filed under this bill couldn't be checked, so ${NOTHING.toLowerCase()} Try again.` };
  const leaning = (under ?? []) as any[];
  if (leaning.length) {
    const named = leaning.map((c) => `${Number(c.amount) < 0 ? "a credit memo" : "a correction"}${c.bill_number ? ` #${c.bill_number}` : ""}`);
    return {
      ok: false,
      error: `${named.join(" and ")} ${named.length > 1 ? "are" : "is"} filed under this bill, and reading the bill again would take it down from under ${named.length > 1 ? "them" : "it"}. Delete ${named.length > 1 ? "them" : "it"} first, then press Read Again. ${NOTHING}`,
    };
  }

  // A BILL AN INVOICE THAT WENT OUT ALREADY BILLS is not taken down (skeptic #84, S2): asked here,
  // before the Undo, in the sentence the bill's own lines give, read the one way every door reads it.
  const claims = await readBillClaimants(db.supabase, billId, bill.po_id ?? null);
  if ("error" in claims) return { ok: false, error: `Which invoices already bill this bill couldn't be checked, so ${NOTHING.toLowerCase()} Try again.` };
  const held = sentClaimant(claims.rows);
  if (held) return { ok: false, error: alreadyBilledSentence(held.number, held.via === "po" ? "the order this bill delivered" : "this bill") };

  // A PAYMENT RECORD NEVER GOES WITH IT (skeptic #84, S5). Taking the bill down deletes what paid it
  // (0383's allocations go with the bill), and the bill made again comes back owed. So while money is
  // recorded against this bill that is not the paper's own payment at the counter, Read Again refuses
  // and names the way: mark the lines Returned on the bill. A matched bank line pays a bill through a
  // supplier payment's allocation (0363 lines carry no bill), so the allocations are the fact asked.
  const paidAtPurchase = paper.payment === "paid_at_purchase";
  const { data: allocs, error: allocErr } = await db.supabase
    .from("supplier_payment_allocations")
    .select("id")
    .eq("bill_id", billId)
    .eq("org_id", db.orgId)
    .limit(1);
  if (allocErr) return { ok: false, error: `The payments recorded on this bill couldn't be checked, so ${NOTHING.toLowerCase()} Try again.` };
  const paidOtherwise =
    !paidAtPurchase &&
    (Math.abs(Number(bill.amount_paid) || 0) >= 0.005 ||
      !isStillOwed({ status: bill.status ?? null, amount: bill.amount, amountPaid: bill.amount_paid ?? null }));
  if ((allocs ?? []).length || paidOtherwise)
    return {
      ok: false,
      error: `${(allocs ?? []).length ? "A supplier payment is recorded against this bill" : "This bill is marked paid"}, and reading it again would take that record down with it. Mark the lines that went back Returned on the bill instead. ${NOTHING}`,
    };

  const gate = await doors.canRead();
  if (!gate.ok) return { ok: false, error: `${gate.why ?? "Reading is paused for this company."} ${NOTHING}` };

  // WHERE IT GOES AGAIN, decided before anything comes down.
  const differentPurchase = String(bill.notes ?? "").includes(DECIDED_DIFFERENT);
  const scope = String(bill.scope_category ?? "").trim() || null;
  let dest: FileDestination | null = null;
  let unsure = "";
  if (!fromJob) {
    if (bill.job_id) dest = { type: "job", jobId: String(bill.job_id), scope };
    else if (bill.on_shelf) unsure = "It was filed to shop stock, which needs your count line by line.";
    else if (isBusinessCostBucket(bill.category)) dest = { type: "overhead", category: bill.category };
    else unsure = "Where it was filed couldn't be told for sure, so it isn't guessed.";
  }
  const old = money(bill.amount);

  // ── 2. UNDO ──
  const undone = await doors.undo(String(paper.id));
  if (!undone.ok) return { ok: false, error: undone.error ?? `Undo didn't go through. ${NOTHING}` };
  const down = `The old bill${old ? ` (${old})` : ""} is down.`;

  // ── 3. READ AND FILE AGAIN ──
  let doorSaid = "";
  let filing: Awaited<ReturnType<typeof newFiling>>;
  if (fromJob) {
    const stated: BillJobStated = {
      paid: paper.payment === "paid_at_purchase",
      category: bill.category ?? null,
      billDate: bill.bill_date ?? null,
      scope,
      ...(differentPurchase ? { differentPurchase: true } : {}),
    };
    const made = await doors.billJob(String(paper.document_id), stated);
    if (!made.ok) return { ok: false, error: `${down} Reading it again didn't work: ${made.error ?? "no answer came back."} ${await whereNow(db, String(paper.id))}` };
    if (made.already)
      return { ok: true, message: `${down} ${made.sameAs ?? "This receipt is already on the books under another bill, so nothing new was recorded."}` };
    doorSaid = [made.pen, made.warning].filter(Boolean).join(" ");
    filing = await newFiling(db, { documentId: String(paper.document_id) });
  } else {
    const read = await doors.readTray(String(paper.id));
    if (!read.ok) return { ok: false, error: `${down} Reading it again didn't work: ${read.error ?? "no answer came back."} ${await whereNow(db, String(paper.id))}` };
    if (!dest) return { ok: true, message: `${down} The paper was read again. ${unsure} ${TRAY} Pick where it goes there.` };
    const filed = await doors.fileTray(String(paper.id), dest, differentPurchase ? { differentPurchase: true } : {});
    if (!filed.ok) return { ok: false, error: `${down} The paper was read again, but filing it didn't work: ${filed.error ?? "no answer came back."} ${await whereNow(db, String(paper.id))}` };
    doorSaid = String(filed.message ?? "").replace(/^Filed\.\s*/, "");
    filing = await newFiling(db, { id: String(paper.id) });
  }

  // ── 4. WHAT CHANGED ──
  if ("error" in filing) return { ok: true, message: `Read again and filed the same way. ${filing.error}${doorSaid ? ` ${doorSaid}` : ""}` };
  const now = money(filing.amount);
  const total = old && now && old !== now ? `The total was ${old} and is ${now} now.` : now ? `The total is ${now}, as before.` : "";
  const pen = filing.pen && !/pen mark/i.test(doorSaid) ? filing.pen : "";
  const paid =
    !isStillOwed({ status: bill.status ?? null, amount: bill.amount, amountPaid: bill.amount_paid ?? null }) &&
    isStillOwed({ status: filing.status, amount: filing.amount })
      ? "The old bill was marked paid and the new one is owed: if it is paid, mark it paid on Bills."
      : "";
  return { ok: true, message: ["Read again and filed the same way.", total, pen, doorSaid, paid].filter(Boolean).join(" ") };
}
