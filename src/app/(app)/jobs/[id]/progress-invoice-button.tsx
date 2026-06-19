"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Percent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented";
import { formatCurrency } from "@/lib/utils";
import { createProgressInvoice } from "../../recurring/actions";

/** Bill a progress payment — a % of the REMAINING balance (contract minus what's
 *  already been billed) or a fixed $ amount. Shows the running contract tally. */
export function ProgressInvoiceButton({
  jobId,
  contract = 0,
  billed = 0,
}: {
  jobId: string;
  contract?: number;
  billed?: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"percent" | "fixed">("percent");
  const [pct, setPct] = useState(50);
  const [fixed, setFixed] = useState(0);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remaining = Math.max(0, contract - billed);
  const amount =
    mode === "percent" ? Math.round((remaining * pct) / 100 * 100) / 100 : Math.round((fixed || 0) * 100) / 100;

  function go() {
    setError(null);
    start(async () => {
      const res = await createProgressInvoice(jobId, { mode, value: mode === "percent" ? pct : fixed });
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
          <ModalActions onCancel={() => setOpen(false)} onSave={go} saving={pending} saveLabel="Create invoice" disabled={amount <= 0} />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {/* Running tally so each milestone reflects prior invoices. */}
          <div className="grid grid-cols-3 gap-2 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-center text-sm">
            <div>
              <div className="text-xs text-slate-400">Contract</div>
              <div className="font-semibold text-slate-800">{formatCurrency(contract)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400">Billed</div>
              <div className="font-semibold text-slate-800">{formatCurrency(billed)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400">Remaining</div>
              <div className="font-semibold text-brand">{formatCurrency(remaining)}</div>
            </div>
          </div>

          <SegmentedControl
            activeId={mode}
            onSelect={(id) => setMode(id as "percent" | "fixed")}
            items={[
              { id: "percent", label: "% of remaining" },
              { id: "fixed", label: "Fixed amount" },
            ]}
          />

          {mode === "percent" ? (
            <div>
              <Label htmlFor="pct">Percent of remaining balance</Label>
              <div className="flex items-center gap-2">
                <Input id="pct" type="number" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} className="w-24" />
                <span className="text-sm text-slate-500">%</span>
              </div>
              <div className="mt-2">
                <SegmentedControl
                  activeId={String(pct)}
                  onSelect={(id) => setPct(Number(id))}
                  items={[
                    { id: "25", label: "25%" },
                    { id: "33", label: "33%" },
                    { id: "50", label: "50%" },
                    { id: "100", label: "100%" },
                  ]}
                />
              </div>
            </div>
          ) : (
            <div>
              <Label htmlFor="fixed">Fixed amount ($)</Label>
              <NumberInput id="fixed" value={fixed} onValueChange={setFixed} className="w-40" />
            </div>
          )}

          <div className="rounded-lg bg-brand/5 px-3 py-2 text-sm">
            This invoice: <span className="font-bold text-slate-900">{formatCurrency(amount)}</span>
            {mode === "percent" && remaining > 0 && <span className="text-slate-500"> · leaves {formatCurrency(Math.max(0, remaining - amount))} to bill</span>}
          </div>
        </div>
      </Modal>
    </>
  );
}
