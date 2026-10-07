import "server-only";

/**
 * IS THIS SUPPLIER DOCUMENT ALREADY IN HIS BOOKS? THE SERVER'S OWN READING (audit v994, DB1).
 *
 * The /bills card lists a document under Their Papers › Not Recorded Yet with Same Purchase: Tie
 * Them (or, at another price, Correct This Bill) beside each candidate, and the doors that write
 * (tieSupplierInvoiceToBill, recordSupplierInvoiceAsBill, correctBill) refuse or accept on the SAME
 * candidates, recomputed here from the database: a client's say-so never ties or corrects anything.
 * `null` is a read that failed, which is never "no bill": the caller refuses instead of writing.
 *
 * ONE MODULE (task 2, 2026-10-07) because two doors in two files now ask it: the bills folder's
 * actions and the jobs folder's correctBill. The reading itself is lib/same-purchase's, pure.
 */

import { loadMarkContext } from "@/app/(app)/organize/paperwork-core";
import { jobFromPaperMarks } from "@/lib/paperwork";
import {
  billsCoveredByDocuments,
  namedNumbersOf,
  samePurchaseCandidates,
  type LedgerBill,
  type SamePurchaseCandidate,
  type SupplierDoc,
} from "@/lib/same-purchase";
import { indexSupplierAliases } from "@/lib/supplier-identity";
import { indexSupplierIdentity, resolveSupplierPapers } from "@/lib/supplier-owed";

/**
 * A supplier document as the server re-reads it: the SupplierDoc, and the job label printed on it.
 * A document filed on no job is offered a purchase at another price only on the job its label names
 * by the exact rule (jobFromPaperMarks, the one the card asked), never a guess.
 */
export type SupplierDocRead = SupplierDoc & { job_name_raw?: string | null };

export async function samePurchaseFor(supabase: any, orgId: string, doc: SupplierDocRead): Promise<{ candidates: SamePurchaseCandidate[] } | null> {
  const needsNamedJob = !doc.job_id && !!String(doc.job_name_raw ?? "").trim();
  const [billsRes, docsRes, linksRes, aliasRes, acctRes, mark] = await Promise.all([
    supabase
      .from("bills")
      // corrects_bill_id (0381): a correction and its original are one purchase, found, covered and
      // offered together (same-purchase.ts).
      .select(
        "id, supplier, supplier_account_id, bill_number, supplier_invoice_number, amount, bill_date, job_id, is_statement, corrects_bill_id, notes, jobs(job_number, name), bill_line_items(description)",
      )
      .eq("org_id", orgId)
      .is("superseded_by_bill_id", null)
      .limit(5000),
    supabase.from("supplier_invoices").select("id, invoice_number, supplier_account_id, job_id, total, invoice_date").eq("org_id", orgId).limit(5000),
    supabase.from("bill_supplier_invoices").select("bill_id, supplier_invoice_id").eq("org_id", orgId).limit(5000),
    supabase.from("supplier_aliases").select("alias, supplier_account_id").eq("org_id", orgId).limit(5000),
    // The accounts themselves: a ticket spelled with an account's OWN name is on that account
    // (supplierDocumentRows places papers this way; this reading must offer the same bills the card
    // drew, or Correct This Bill refuses a candidate the card showed). A lost accounts read narrows
    // the placing to filed-or-alias (every reader's rule before 8a982483), never a failed check.
    supabase
      .from("supplier_accounts")
      .select("id, name")
      .eq("org_id", orgId)
      .limit(500)
      .then(
        (r: { data: unknown; error: unknown }) => r,
        (error: unknown) => ({ data: null, error }),
      ),
    // A lost jobs read here is no named job, never a guess: the near and exact offers still stand.
    needsNamedJob ? loadMarkContext(supabase, orgId).catch(() => null) : Promise.resolve(null),
  ]);
  if (billsRes?.error || docsRes?.error || linksRes?.error) return null;
  const aliasRows = aliasRes?.error ? [] : ((aliasRes?.data ?? []) as any[]);
  const identity = resolveSupplierPapers(
    ((billsRes?.data ?? []) as any[]).map((b) => ({ id: String(b.id), supplierAccountId: b.supplier_account_id ?? null, supplier: b.supplier ?? null })),
    indexSupplierIdentity({ accounts: (acctRes?.error ? [] : ((acctRes?.data ?? []) as any[])).map((a) => ({ id: a?.id, name: a?.name })), aliases: aliasRows }),
  );
  const bills: LedgerBill[] = ((billsRes?.data ?? []) as any[]).map((b) => {
    const named = namedNumbersOf(b);
    return {
      ...b,
      // RESOLVED, not raw, exactly as the card reads it (8a982483).
      supplier_account_id: identity.get(String(b.id))?.accountId ?? b.supplier_account_id ?? null,
      is_statement: !!b.is_statement || named.isStatement,
      named_numbers: named.numbers,
    };
  });
  const aliases = indexSupplierAliases(aliasRows);
  const covered = billsCoveredByDocuments(bills, (docsRes?.data ?? []) as SupplierDoc[], (linksRes?.data ?? []) as any[], aliases);
  const named = mark ? jobFromPaperMarks({ po: doc.job_name_raw }, mark.markJobs, mark.pos, mark.selfNames) : null;
  const namedJobId = named?.kind === "one" ? named.jobId : null;
  return { candidates: samePurchaseCandidates(doc, bills, covered, aliases, { namedJobId }) };
}
