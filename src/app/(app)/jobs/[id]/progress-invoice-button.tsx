"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Percent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented";
import { formatCurrency } from "@/lib/utils";
import { createProgressInvoice } from "../../recurring/actions";
import { recordPayment } from "../../billing/actions";

type OpenInvoice = { id: string; number: string; balance: number };

/** Progress payment hub for a job. Shows the full money picture and lets you
 *  either RECORD A PAYMENT against an open invoice (one-invoice + installments)
 *  or bill a NEW progress invoice for the un-invoiced contract (per-milestone).
 *  Owner picks per job — both flows live here so prior payments are always shown. */
export function ProgressInvoiceButton({
  jobId,
  contract = 0,
  invoiced = 0,
  paid = 0,
  openInvoices = [],
}: {
  jobId: string;
  contract?: number;
  invoiced?: number;
  paid?: number;
  openInvoices?: OpenInvoice[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const balanceDue = Math.max(0, Math.round((invoiced - paid) * 100) / 100);
  const uninvoiced = Math.max(0, Math.round((contract - invoiced) * 100) / 100);

  // Collect when money is owed; otherwise bill a new invoice.
  const [mode, setMode] = useState<"payment" | "invoice">(
    balanceDue > 0 && openInvoices.length ? "payment" : "invoice",
  );

  // New-invoice state
  const [billMode, setBillMode] = useState<"percent" | "fixed">("percent");
  const [pct, setPct] = useState(50);
  const [fixed, setFixed] = useState(0);
  const newAmount =
    billMode === "percent" ? Math.round((uninvoiced * pct) / 100 * 100) / 100 : Math.round((fixed || 0) * 100) / 100;

  // Payment state
  const [payInvoice, setPayInvoice] = useState(openInvoices[0]?.id ?? "");
  const selected = openInvoices.find((i) => i.id === payInvoice) ?? openInvoices[0];
  const [payAmount, setPayAmount] = useState(selected?.balance ?? 0);
  const [method, setMethod] = useState("Zelle");
  const [payDate, setPayDate] = useState("");

  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function pickInvoice(id: string) {
    setPayInvoice(id);
    const inv = openInvoices.find((i) => i.id === id);
    if (inv) setPayAmount(inv.balance);
  }

  const canSave = mode === "payment" ? payAmount > 0 && !!payInvoice : newAmount > 0;

  function go() {
    setError(null);
    start(async () => {
      if (mode === "payment") {
        if (!payInvoice) return setError("No open invoice to apply a payment to.");
        const res = await recordPayment({ invoice_id: payInvoice, amount: payAmount, method, note: "Progress payment", paid_at: payDate || null });
        if (!res.ok) return setError(res.error ?? "Could not record the payment.");
        setOpen(false);
        router.refresh();
      } else {
        const res = await createProgressInvoice(jobId, { mode: billMode, value: billMode === "percent" ? pct : fixed });
        if (!res.ok || !res.id) return setError(res.error ?? "Could not create the invoice.");
        router.push(`/billing/${res.id}`);
      }
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Percent className="h-3.5 w-3.5" /> Progress payment
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Progress payment"
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={go}
            saving={pending}
            saveLabel={mode === "payment" ? "Record payment" : "Create invoice"}
            disabled={!canSave}
          />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {/* The full money picture — prior payments are always visible here. */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-3 text-center sm:grid-cols-4 sm:gap-2">
            <div>
              <div className="text-[11px] text-slate-400">Contract</div>
              <div className="text-sm font-semibold text-slate-800">{formatCurrency(contract)}</div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Invoiced</div>
              <div className="text-sm font-semibold text-slate-800">{formatCurrency(invoiced)}</div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Paid</div>
              <div className="text-sm font-semibold text-emerald-600">{formatCurrency(paid)}</div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Balance due</div>
              <div className="text-sm font-semibold text-brand">{formatCurrency(balanceDue)}</div>
            </div>
          </div>

          <SegmentedControl
            activeId={mode}
            onSelect={(id) => setMode(id as "payment" | "invoice")}
            items={[
              { id: "payment", label: "Record a payment" },
              { id: "invoice", label: "New invoice" },
            ]}
          />

          {mode === "payment" ? (
            openInvoices.length === 0 ? (
              <p className="text-sm text-slate-500">
                No open invoices on this job. Switch to <strong>New invoice</strong> to bill the customer first, then
                record their payment here.
              </p>
            ) : (
              <div className="space-y-3">
                {openInvoices.length > 1 ? (
                  <div>
                    <Label htmlFor="pinv">Apply to invoice</Label>
                    <Select id="pinv" value={payInvoice} onChange={(e) => pickInvoice(e.target.value)}>
                      {openInvoices.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.number} · {formatCurrency(i.balance)} due
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : (
                  selected && (
                    <p className="text-sm text-slate-500">
                      Applying to <span className="font-medium text-slate-800">{selected.number}</span> ·{" "}
                      {formatCurrency(selected.balance)} due
                    </p>
                  )
                )}
                <div>
                  <Label htmlFor="pamt">Amount received</Label>
                  <div className="flex items-center gap-3">
                    <NumberInput id="pamt" value={payAmount} onValueChange={setPayAmount} className="w-40" />
                    {selected && payAmount !== selected.balance && (
                      <button type="button" onClick={() => setPayAmount(selected.balance)} className="text-xs font-medium text-brand">
                        Full balance
                      </button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="pmethod">Method</Label>
                    <Select id="pmethod" value={method} onChange={(e) => setMethod(e.target.value)}>
                      {["Zelle", "Check", "Cash", "Card", "ACH", "Other"].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="pdate">Date received</Label>
                    <Input id="pdate" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="space-y-3">
              <SegmentedControl
                activeId={billMode}
                onSelect={(id) => setBillMode(id as "percent" | "fixed")}
                items={[
                  { id: "percent", label: "% of remaining" },
                  { id: "fixed", label: "Fixed amount" },
                ]}
              />
              {billMode === "percent" ? (
                <div>
                  <Label htmlFor="pct">Percent of remaining contract ({formatCurrency(uninvoiced)})</Label>
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
                  <Label htmlFor="fixed">Invoice amount ($)</Label>
                  <NumberInput id="fixed" value={fixed} onValueChange={setFixed} className="w-40" />
                </div>
              )}
              <div className="rounded-lg bg-brand/5 px-3 py-2 text-sm">
                New invoice: <span className="font-bold text-slate-900">{formatCurrency(newAmount)}</span>
                {uninvoiced === 0 && billMode === "percent" && (
                  <span className="text-amber-600"> · contract fully invoiced — use a fixed amount for extras</span>
                )}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
