"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { finishJob } from "../actions";

/** "Finish job" — quick end-of-job questions, then marks the job complete and
 *  builds a draft invoice to review (quote items + optional labor/materials).
 *  Optionally emails the invoice to the customer straight away (the per-job
 *  override of the org's auto-send default). Draw-billed jobs are finished with
 *  their Final draw, so the email-now option is hidden for them. */
export function FinishJobButton({
  jobId,
  hasQuote,
  defaultSendInvoice = false,
  isDrawBilled = false,
}: {
  jobId: string;
  hasQuote: boolean;
  defaultSendInvoice?: boolean;
  isDrawBilled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [timeIn, setTimeIn] = useState(false);
  const [costsIn, setCostsIn] = useState(false);
  const [importLabor, setImportLabor] = useState(!hasQuote);
  const [importCosts, setImportCosts] = useState(!hasQuote);
  const [sendInvoice, setSendInvoice] = useState(defaultSendInvoice);

  // The "email now" option only applies to standard invoices — a draw-billed job is
  // finished with its Final draw (sent through the progress-report flow).
  const wantSend = sendInvoice && !isDrawBilled;

  function go() {
    setError(null);
    setWarn(null);
    start(async () => {
      const res = await finishJob(jobId, { importLabor, importCosts, sendInvoice: wantSend });
      if (!res.ok || !res.id) {
        setError(res.error ?? "Could not finish the job.");
        return;
      }
      if (wantSend && !res.sent) {
        // Finished, but the email did NOT go out (no customer email, nothing billable,
        // or sending isn't enabled yet). Don't pretend it sent — keep the modal open
        // with the truth and a link to review/send it manually.
        setDoneId(res.id);
        setWarn(
          "The job is finished, but the invoice wasn’t emailed — the customer may have no email on file, or there was nothing billable to send. It’s saved as a draft in “To be invoiced” for you to review and send.",
        );
        return;
      }
      router.push(`/billing/${res.id}`);
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <CheckCircle2 className="h-4 w-4" /> Finish job
      </Button>

      <Modal
        open={open}
        onClose={() => !pending && setOpen(false)}
        title="Finish this job"
        footer={
          warn ? (
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setOpen(false); router.refresh(); }}>Close</Button>
              {doneId && <Button onClick={() => router.push(`/billing/${doneId}`)}>Review &amp; send →</Button>}
            </div>
          ) : (
            <ModalActions
              onCancel={() => setOpen(false)}
              onSave={go}
              saving={pending}
              disabled={!timeIn || !costsIn}
              saveLabel={wantSend ? "Finish & send invoice" : "Finish & review invoice"}
            />
          )
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {warn ? (
            <div className="rounded-lg bg-amber-50 px-3 py-3 text-sm">
              <div className="font-medium text-amber-800">Finished — invoice not sent</div>
              <p className="mt-1 text-amber-700">{warn}</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                Quick check before I mark it complete and draft the invoice:
              </p>
              <div className="space-y-2">
                <label className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${timeIn ? "border-slate-200" : "border-amber-300 bg-amber-50"}`}>
                  <input type="checkbox" checked={timeIn} onChange={(e) => setTimeIn(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
                  <span className="text-slate-700">All time entries for this job are in</span>
                </label>
                <label className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${costsIn ? "border-slate-200" : "border-amber-300 bg-amber-50"}`}>
                  <input type="checkbox" checked={costsIn} onChange={(e) => setCostsIn(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
                  <span className="text-slate-700">All materials, POs &amp; bills are logged</span>
                </label>
              </div>

              <div className="space-y-2 border-t border-slate-100 pt-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Build the invoice from</div>
                {hasQuote && (
                  <p className="text-sm text-slate-600">✓ The job&apos;s estimate (line items copy over automatically)</p>
                )}
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={importLabor} onChange={(e) => setImportLabor(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
                  Add labor from timecards (hours × each person&apos;s rate)
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={importCosts} onChange={(e) => setImportCosts(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
                  Add materials from POs &amp; bills (at cost — adjust after)
                </label>
              </div>

              {!isDrawBilled && (
                <div className="space-y-1 border-t border-slate-100 pt-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">When done</div>
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={sendInvoice} onChange={(e) => setSendInvoice(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
                    <span>
                      Email the invoice to the customer now
                      <span className="block text-xs text-slate-500">
                        {sendInvoice
                          ? "Sends as soon as you finish — double-check the amounts first."
                          : "Leave unchecked to hold it in “To be invoiced” for review."}
                      </span>
                    </span>
                  </label>
                </div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
