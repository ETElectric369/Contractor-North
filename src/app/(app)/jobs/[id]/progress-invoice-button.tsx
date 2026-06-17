"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Percent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { createProgressInvoice } from "../../recurring/actions";

/** Bill a percentage of the job's quoted total as a progress-payment invoice. */
export function ProgressInvoiceButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState(50);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function go() {
    setError(null);
    start(async () => {
      const res = await createProgressInvoice(jobId, pct);
      if (!res.ok || !res.id) return setError(res.error ?? "Could not create the invoice.");
      router.push(`/billing/${res.id}`);
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Percent className="h-3.5 w-3.5" /> Progress invoice
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Progress payment"
        footer={
          <ModalActions onCancel={() => setOpen(false)} onSave={go} saving={pending} saveLabel="Create invoice" />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <p className="text-sm text-slate-600">Invoice a percentage of this job&apos;s quoted total now — for deposits or milestone billing.</p>
          <div>
            <Label htmlFor="pct">Percent of contract</Label>
            <div className="flex items-center gap-2">
              <Input id="pct" type="number" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} className="w-24" />
              <span className="text-sm text-slate-500">%</span>
            </div>
            <div className="mt-2 flex gap-1">
              {[25, 33, 50, 100].map((p) => (
                <button key={p} type="button" onClick={() => setPct(p)} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600 hover:bg-slate-200">{p}%</button>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
