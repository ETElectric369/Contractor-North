"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { finishJob } from "../actions";

/** "Finish job" — quick end-of-job questions, then marks the job complete and
 *  builds a draft invoice to review (quote items + optional labor/materials). */
export function FinishJobButton({ jobId, hasQuote }: { jobId: string; hasQuote: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [timeIn, setTimeIn] = useState(false);
  const [costsIn, setCostsIn] = useState(false);
  const [importLabor, setImportLabor] = useState(!hasQuote);
  const [importCosts, setImportCosts] = useState(!hasQuote);

  function go() {
    setError(null);
    start(async () => {
      const res = await finishJob(jobId, { importLabor, importCosts });
      if (!res.ok || !res.id) {
        setError(res.error ?? "Could not finish the job.");
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
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={go}
            saving={pending}
            disabled={!timeIn || !costsIn}
            saveLabel="Finish & invoice"
          />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
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
              <p className="text-sm text-slate-600">✓ The job&apos;s quote (line items copy over automatically)</p>
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
        </div>
      </Modal>
    </>
  );
}
