"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import { recordSupplierInvoiceAsBill, setSupplierInvoiceJob } from "@/app/(app)/bills/supplier-actions";

export type JobPaperView = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  jobNameRaw: string | null;
  total: number;
  /** Filed on this job by a person already (supplier_invoices.job_id). */
  filed: boolean;
  accountId: string | null;
  /** /bills has it on a Needs You card (onNeedsYouIds, the cards' own rule). A paper on no card
   *  (before the books line, reversed by a credit memo, $0.00) links to the supplier's own line. */
  onNeedsYou: boolean;
  /** Set aside on /bills for a credit (0346): folded under its supplier's Waiting On A Credit. */
  waitingOnCredit?: boolean;
};

/**
 * NAMED ON A PAPER, NOT RECORDED YET (Erik, 2026-09-25: "i think theres a bill missing from this").
 * The supplier's own invoices that name this job and are in nobody's books (job-papers.ts), each
 * with the /bills page's own door: Record It As A Bill. A paper filed nowhere is filed on this job
 * first (setSupplierInvoiceJob), because the paper names it and a person pressed the button here;
 * the record then runs every check it runs on /bills (already in the books, returned, the lines)
 * and its own sentence is shown, whatever it says. When it asks a question only the /bills card
 * can answer (Same Purchase: Tie Them), the row links there.
 *
 * `papers` null = the read failed: said, never an empty list.
 */
export function JobPaperList({ jobId, papers }: { jobId: string; papers: JobPaperView[] | null }) {
  if (papers && papers.length === 0) return null;
  const total = Math.round((papers ?? []).reduce((s, p) => s + (Number(p.total) || 0), 0) * 100) / 100;
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
        <FileWarning className="h-4 w-4 text-amber-500" />
        <span>
          Named On A Paper, Not Recorded Yet
          {papers && <span className="font-normal text-slate-500"> · {papers.length} · {formatCurrency(total)}</span>}
        </span>
      </div>
      {papers === null ? (
        <p className="px-5 py-4 text-sm text-slate-500">
          Couldn&apos;t check the supplier&apos;s papers for this job right now. The Bills page lists every purchase not in your books.
        </p>
      ) : (
        <>
          <p className="px-5 pt-3 text-sm text-slate-500">
            The supplier billed these to this job and they are on no cost list yet, so no invoice has them. Record It As A Bill files the paper on this job and puts its cost here, at the supplier&apos;s own line prices.
          </p>
          <ul className="divide-y divide-slate-100">
            {papers.map((p) => (
              <PaperRow key={p.id} jobId={jobId} paper={p} />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function PaperRow({ jobId, paper }: { jobId: string; paper: JobPaperView }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [refusal, setRefusal] = useState<string | null>(null);

  function record() {
    setRefusal(null);
    start(async () => {
      let filedNow = false;
      if (!paper.filed) {
        const filed = await setSupplierInvoiceJob({ invoiceId: paper.id, jobId });
        if (!filed.ok) return setRefusal(filed.error ?? "That didn't save, so nothing was recorded.");
        filedNow = true;
      }
      const res = await recordSupplierInvoiceAsBill({ invoiceId: paper.id });
      if (!res.ok) {
        const why = res.error ?? "Couldn't record it, so nothing was written.";
        setRefusal(filedNow ? `${paper.invoiceNumber} is filed on this job now. ${why}` : why);
        router.refresh();
        return;
      }
      // The row leaves this list on the refresh (the paper has its bill now) and the bill joins Not
      // Billed Yet above, so the server's sentence rides a toast that stays until it is read.
      toast(res.message ?? `${paper.invoiceNumber} is recorded as a bill on this job.`, "success", undefined, { sticky: true });
      router.refresh();
    });
  }

  return (
    <li className="px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-900">{paper.invoiceNumber}</div>
          <div className="text-xs text-slate-500">
            {[paper.invoiceDate ? formatDate(paper.invoiceDate) : null, paper.jobNameRaw ? `Job name "${paper.jobNameRaw}"` : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <span className="font-medium text-slate-800">{formatCurrency(paper.total)}</span>
        <Button type="button" variant="outline" onClick={record} disabled={pending}>
          {pending ? "Recording It…" : "Record It As A Bill"}
        </Button>
      </div>
      {refusal && (
        <div className="mt-2 text-sm text-amber-700">
          <p>{refusal}</p>
          {/* The questions only /bills answers (Same Purchase: Tie Them, or any other answer as a
              different purchase) live on its Needs You cards since Wave B. A paper no card carries
              (onNeedsYouIds says which) opens its supplier's own line instead (FoldOpener). */}
          <Link
            href={
              paper.onNeedsYou
                ? "/bills#needs-you"
                : paper.waitingOnCredit && paper.accountId
                  ? `/bills#supplier-waiting-credit-${paper.accountId}`
                  : paper.accountId
                  ? `/bills#supplier-invoices-${paper.accountId}`
                  : "/bills"
            }
            className="inline-flex min-h-11 items-center font-medium text-brand hover:underline"
          >
            Open It On Bills
          </Link>
        </div>
      )}
    </li>
  );
}
