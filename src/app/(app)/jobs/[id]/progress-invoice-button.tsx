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
import { useToast } from "@/components/toast";
import { createProgressInvoice } from "../../recurring/actions";
import { recordPayment, createProgressReportInvoice } from "../../billing/actions";

type OpenInvoice = { id: string; number: string; balance: number };
type DrawKind = "deposit" | "progress" | "final";

/** Progress payment hub for a job. Shows the full money picture (estimate vs
 *  actual work, invoiced, paid, balance) and runs every billing flow through one
 *  path: RECORD A PAYMENT against an open invoice, or create a billing DRAW
 *  (deposit / progress / final). On a Time & Material job the estimate is a
 *  reference, not a cap — "work to date" tells you if you're tracking over. */
export function ProgressInvoiceButton({
  jobId,
  billingType = "fixed",
  estimate = 0,
  worked = 0,
  invoiced = 0,
  paid = 0,
  openInvoices = [],
  scheduleActive = false,
}: {
  jobId: string;
  billingType?: "fixed" | "tm";
  estimate?: number;
  worked?: number;
  invoiced?: number;
  paid?: number;
  openInvoices?: OpenInvoice[];
  /** True when the job uses a payment schedule — draws come from there, so this
   *  button is restricted to recording payments (prevents a parallel draw path). */
  scheduleActive?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const isTM = billingType === "tm";

  const balanceDue = Math.max(0, Math.round((invoiced - paid) * 100) / 100);
  const remainingToEstimate = Math.max(0, Math.round((estimate - invoiced) * 100) / 100);
  const unbilledWork = Math.max(0, Math.round((worked - invoiced) * 100) / 100);

  const [mode, setMode] = useState<"payment" | "invoice">(
    scheduleActive || (balanceDue > 0 && openInvoices.length) ? "payment" : "invoice",
  );

  // New-invoice (draw) state
  const [kind, setKindState] = useState<DrawKind>("progress");
  const [billMode, setBillMode] = useState<"percent" | "fixed" | "actuals">(isTM ? "actuals" : "percent");
  const [pct, setPct] = useState(50);
  const [fixed, setFixed] = useState(0);
  const newAmount =
    billMode === "percent" ? Math.round((remainingToEstimate * pct) / 100 * 100) / 100 : Math.round((fixed || 0) * 100) / 100;
  const showActuals = isTM && (kind === "progress" || kind === "final");

  function setKind(k: DrawKind) {
    setKindState(k);
    // Smart defaults per draw kind.
    if (k === "deposit") {
      setBillMode("fixed");
      setFixed(0);
    } else if (isTM) {
      // T&M progress/final default to billing the actual work to date.
      setBillMode("actuals");
    } else if (k === "final") {
      setBillMode("fixed");
      setFixed(remainingToEstimate);
    } else {
      setBillMode("percent");
      setPct(50);
    }
  }

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

  const canSave =
    mode === "payment"
      ? payAmount > 0 && !!payInvoice
      : billMode === "actuals"
        ? worked > 0
        : newAmount > 0;

  function go() {
    setError(null);
    start(async () => {
      if (mode === "payment") {
        if (!payInvoice) return setError("No open invoice to apply a payment to.");
        const res = await recordPayment({ invoice_id: payInvoice, amount: payAmount, method, note: "Progress payment", paid_at: payDate || null });
        if (!res.ok) return setError(res.error ?? "Could not record the payment.");
        toast("Payment recorded", "success");
        setOpen(false);
        router.refresh();
      } else {
        const res =
          billMode === "actuals"
            ? await createProgressReportInvoice(jobId, kind === "deposit" ? "progress" : kind)
            : await createProgressInvoice(jobId, { kind, mode: billMode, value: billMode === "percent" ? pct : fixed });
        if (!res.ok || !res.id) return setError(res.error ?? "Could not create the invoice.");
        toast("Invoice created", "success");
        router.push(`/billing/${res.id}`);
      }
    });
  }

  // The money picture — adapts to fixed-price vs Time & Material.
  const stats: { label: string; value: number; tone?: string }[] = isTM
    ? [
        { label: "Estimate", value: estimate },
        { label: "Work to date", value: worked, tone: "text-slate-900" },
        { label: "Invoiced", value: invoiced },
        { label: "Paid", value: paid, tone: "text-emerald-600" },
        { label: "Balance due", value: balanceDue, tone: "text-brand" },
        { label: "Left to est.", value: remainingToEstimate },
      ]
    : [
        { label: "Contract", value: estimate },
        { label: "Invoiced", value: invoiced },
        { label: "Paid", value: paid, tone: "text-emerald-600" },
        { label: "Balance due", value: balanceDue, tone: "text-brand" },
      ];

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Percent className="h-3.5 w-3.5" /> Progress Payment
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
            saveLabel={mode === "payment" ? "Record Payment" : `Create ${kind === "deposit" ? "Deposit" : kind === "final" ? "Final Invoice" : "Invoice"}`}
            disabled={!canSave}
          />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          <div className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-3 text-center sm:grid-cols-3">
            {stats.map((s) => (
              <div key={s.label}>
                <div className="text-[11px] text-slate-400">{s.label}</div>
                <div className={`text-sm font-semibold ${s.tone ?? "text-slate-800"}`}>{formatCurrency(s.value)}</div>
              </div>
            ))}
          </div>
          {isTM && worked > estimate && estimate > 0 && (
            <p className="-mt-1 text-xs text-amber-600">
              Work to date is {formatCurrency(worked - estimate)} over the estimate — the final captures the agreed overage.
            </p>
          )}

          {scheduleActive ? (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              This job bills on a payment schedule — create draws with <strong>Request next payment</strong> above. Use this to record a customer&apos;s payment.
            </p>
          ) : (
            <SegmentedControl
              activeId={mode}
              onSelect={(id) => setMode(id as "payment" | "invoice")}
              items={[
                { id: "payment", label: "Record a Payment" },
                { id: "invoice", label: "New Invoice" },
              ]}
            />
          )}

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
                        Full Balance
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
              <div>
                <Label>Draw type</Label>
                <SegmentedControl
                  activeId={kind}
                  onSelect={(id) => setKind(id as DrawKind)}
                  items={[
                    { id: "deposit", label: "Deposit" },
                    { id: "progress", label: "Progress" },
                    { id: "final", label: "Final" },
                  ]}
                />
              </div>

              <SegmentedControl
                activeId={billMode}
                onSelect={(id) => setBillMode(id as "percent" | "fixed" | "actuals")}
                items={
                  showActuals
                    ? [
                        { id: "actuals", label: "Actual T&M" },
                        { id: "percent", label: "% of Est." },
                        { id: "fixed", label: "Fixed" },
                      ]
                    : [
                        { id: "percent", label: "% of Remaining" },
                        { id: "fixed", label: "Fixed Amount" },
                      ]
                }
              />

              {billMode === "actuals" ? (
                <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Work to date (labor + materials)</span>
                    <span className="font-medium text-slate-800">{formatCurrency(worked)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Less previously billed</span>
                    <span className="font-medium text-slate-500">−{formatCurrency(invoiced)}</span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-1">
                    <span className="font-medium text-slate-700">Due this {kind === "final" ? "final" : "draw"}</span>
                    <span className="font-bold text-brand">{formatCurrency(unbilledWork)}</span>
                  </div>
                  <p className="pt-1 text-xs text-slate-400">
                    Builds an itemized progress report — all labor + materials to date, less the deposit — a statement you can send as the payment request.
                  </p>
                </div>
              ) : billMode === "percent" ? (
                <div>
                  <Label htmlFor="pct">Percent of remaining estimate ({formatCurrency(remainingToEstimate)})</Label>
                  <div className="flex items-center gap-2">
                    <Input id="pct" type="number" min={1} max={100} value={pct} onChange={(e) => setPct(Math.max(1, Math.min(100, Number(e.target.value) || 0)))} className="w-24" />
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
                  <div className="mt-2 flex flex-wrap gap-2">
                    {remainingToEstimate > 0 && (
                      <button type="button" onClick={() => setFixed(remainingToEstimate)} className="rounded-full border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
                        To Estimate ({formatCurrency(remainingToEstimate)})
                      </button>
                    )}
                    {isTM && unbilledWork > 0 && (
                      <button type="button" onClick={() => setFixed(unbilledWork)} className="rounded-full border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
                        Work to Date ({formatCurrency(unbilledWork)})
                      </button>
                    )}
                  </div>
                </div>
              )}

              {billMode !== "actuals" && (
                <div className="rounded-lg bg-brand/5 px-3 py-2 text-sm">
                  New {kind} invoice: <span className="font-bold text-slate-900">{formatCurrency(newAmount)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
