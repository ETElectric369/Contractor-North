"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { MANAGE_ROW_CLS } from "./job-manage-menu";
import { finishJob, finishJobPreview, type FinishJobPreview } from "../actions";

/**
 * "Finish Job" — quick end-of-job questions, then marks the job complete and puts its billing in
 * front of the office.
 *
 * THE TRUTH AT THE BUTTON (Connected North Phase 1; Tao Zhu, J-002). A job billed with progress
 * payments is not billed by this modal: its toggles did nothing on the server, and "draft the
 * invoice" was a promise it didn't keep. So when it opens it asks the server what finishing will
 * actually do (finishJobPreview) and says that — including the hours and bills no bill holds
 * ("Not billed yet: 19.5 h ($2,437.50)…"), which finishing would otherwise drop off every screen.
 * And after the press it SHOWS what happened (the server's sentence, and any warning) with a door
 * to the invoice, instead of navigating away blind.
 */
export function FinishJobButton({
  jobId,
  hasQuote,
  defaultSendInvoice = false,
  isDrawBilled = false,
  menuItem = false,
}: {
  jobId: string;
  hasQuote: boolean;
  defaultSendInvoice?: boolean;
  isDrawBilled?: boolean;
  /** Render the trigger as a Manage-menu row instead of a standalone button. */
  menuItem?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FinishJobPreview | null>(null);
  const [done, setDone] = useState<{ id?: string; speak: string; warning?: string } | null>(null);
  const [timeIn, setTimeIn] = useState(false);
  const [costsIn, setCostsIn] = useState(false);
  const [importLabor, setImportLabor] = useState(!hasQuote);
  const [importCosts, setImportCosts] = useState(!hasQuote);
  const [sendInvoice, setSendInvoice] = useState(defaultSendInvoice);

  // The server's answer wins over the page's (a draw sent since the page rendered); until it
  // answers, the page's flag decides what shows.
  const drawBilled = preview?.ok ? !!preview.drawBilled : isDrawBilled;
  // The "email now" option only applies to standard invoices — a draw-billed job is billed with its
  // progress payments, which are sent from their own page.
  const wantSend = sendInvoice && !drawBilled;

  function openModal() {
    setError(null);
    setDone(null);
    setPreview(null);
    setOpen(true);
    void finishJobPreview(jobId).then(setPreview, () => setPreview({ ok: false, error: "Couldn't read this job's bills just now." }));
  }

  function go() {
    setError(null);
    start(async () => {
      const res = await finishJob(jobId, drawBilled ? {} : { importLabor, importCosts, sendInvoice: wantSend });
      if (!res.ok) {
        setError(res.error ?? "Could not finish the job.");
        return;
      }
      // Finished, but the email did NOT go out (no customer email, nothing billable, or sending
      // isn't enabled yet). Said, never pretended.
      const notSent =
        wantSend && !res.sent
          ? "The invoice wasn't emailed — the customer may have no email on file, or there was nothing billable to send. It's saved as a draft for you to review and send."
          : undefined;
      setDone({ id: res.id, speak: res.speak ?? "Job finished.", warning: [res.warning, notSent].filter(Boolean).join(" ") || undefined });
      router.refresh();
    });
  }

  const draftNo = preview?.openDraft?.number ?? "the open progress payment";
  const drawLine = !preview?.ok
    ? null
    : preview.schedule
      ? "This job bills on a payment schedule. Finishing marks it complete; request the Final draw from Billing."
      : preview.openDraft?.refreshable
        ? `Finishing pulls the last hours and bills onto ${draftNo} (still a draft) and marks the job complete. Nothing is sent.`
        : preview.openDraft
          ? `${draftNo} is still a draft and bills a set part of the contract. Finishing marks the job complete; send ${draftNo} (or delete it), then bill the rest as the final progress payment.`
          : "This job bills with progress payments. Finishing marks it complete; it doesn't write or send a bill.";
  const offBill = drawBilled ? preview?.offBill ?? null : null;
  const saveLabel = drawBilled ? (offBill ? "Finish Without Billing" : "Finish Job") : wantSend ? "Finish & Send Invoice" : "Finish & Review Invoice";

  return (
    <>
      {menuItem ? (
        <button type="button" onClick={openModal} className={MANAGE_ROW_CLS}>
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Finish Job
        </button>
      ) : (
        <Button onClick={openModal}>
          <CheckCircle2 className="h-4 w-4" /> Finish Job
        </Button>
      )}

      <Modal
        open={open}
        onClose={() => !pending && setOpen(false)}
        title="Finish this job"
        portal
        footer={
          done ? (
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
              {done.id && <Button onClick={() => router.push(`/billing/${done.id}`)}>Open The Invoice</Button>}
            </div>
          ) : (
            <ModalActions
              onCancel={() => setOpen(false)}
              onSave={go}
              saving={pending}
              // A draw-billed job waits for the server's answer: the button must not say less than it knows.
              disabled={!timeIn || !costsIn || (drawBilled && !preview)}
              saveLabel={saveLabel}
            />
          )
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {done ? (
            <div className="space-y-2">
              <div className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">{done.speak}</div>
              {done.warning && done.warning !== done.speak.replace(/^Job finished\.\s*/, "") && (
                <div className="rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-800">{done.warning}</div>
              )}
            </div>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                {drawBilled ? "Quick check before I mark it complete:" : "Quick check before I mark it complete and draft the invoice:"}
              </p>
              <div className="space-y-2">
                <label className={`flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-sm ${timeIn ? "border-slate-200" : "border-amber-300 bg-amber-50"}`}>
                  <input type="checkbox" checked={timeIn} onChange={(e) => setTimeIn(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
                  <span className="text-slate-700">All time entries for this job are in</span>
                </label>
                <label className={`flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-sm ${costsIn ? "border-slate-200" : "border-amber-300 bg-amber-50"}`}>
                  <input type="checkbox" checked={costsIn} onChange={(e) => setCostsIn(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
                  <span className="text-slate-700">All materials, POs &amp; bills are logged</span>
                </label>
              </div>

              {drawBilled ? (
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Billing</div>
                  {!preview ? (
                    <p className="flex items-center gap-2 text-sm text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin" /> Checking what&apos;s billed…
                    </p>
                  ) : !preview.ok ? (
                    <p className="text-sm text-amber-800">{preview.error ?? "Couldn't read this job's bills just now."} Look at the Invoices tab before you finish.</p>
                  ) : (
                    <>
                      {drawLine && <p className="text-sm text-slate-600">{drawLine}</p>}
                      {offBill && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{offBill}</div>}
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="space-y-2 border-t border-slate-100 pt-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Build the invoice from</div>
                    {hasQuote && (
                      <p className="text-sm text-slate-600">✓ The job&apos;s estimate (line items copy over automatically)</p>
                    )}
                    <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={importLabor} onChange={(e) => setImportLabor(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
                      Add labor from timecards (hours × each person&apos;s rate)
                    </label>
                    <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={importCosts} onChange={(e) => setImportCosts(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
                      Add materials from POs &amp; bills (at the job&apos;s markup — adjust after)
                    </label>
                  </div>

                  <div className="space-y-1 border-t border-slate-100 pt-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">When done</div>
                    <label className="flex min-h-11 items-start gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={sendInvoice} onChange={(e) => setSendInvoice(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
                      <span>
                        Email the invoice to the customer now
                        <span className="block text-xs text-slate-500">
                          {sendInvoice
                            ? "Sends as soon as you finish — double-check the amounts first."
                            : "Leave unchecked to hold it as a draft for review."}
                        </span>
                      </span>
                    </label>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
