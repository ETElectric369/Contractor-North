"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Plus, Trash2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { scheduleStatus, defaultSchedule, milestoneAmount, type Milestone } from "@/lib/payment-schedule-math";
import { setPaymentSchedule, requestNextPayment } from "../../billing/actions";

type Row = { label: string; percent: number };

/** The "payment structure" for a job (the deal-to-cash spine, Phase 1). Fixed-Bid
 *  jobs get a milestone schedule (% of contract) and a one-click "Request next
 *  payment" that drafts the next draw; T&M jobs request the next payment off the
 *  work logged to date. */
export function PaymentScheduleCard({
  jobId,
  billingType = "fixed",
  contractTotal = 0,
  depositPercent = 0,
  milestones = [],
}: {
  jobId: string;
  billingType?: "fixed" | "tm";
  contractTotal?: number;
  depositPercent?: number;
  milestones?: Milestone[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const status = scheduleStatus(milestones, contractTotal);
  const billingStarted = status.rows.some((r) => r.billed);

  function requestNext() {
    setError(null);
    start(async () => {
      const res = await requestNextPayment(jobId);
      if (!res.ok || !(res as { id?: string }).id) {
        setError(res.error ?? "Could not create the payment.");
        return;
      }
      router.push(`/billing/${(res as { id: string }).id}`);
    });
  }

  if (billingType === "tm") {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <CalendarClock className="h-4 w-4" /> Time &amp; Material
            </div>
            <div className="text-xs text-slate-500">Billed by actual work to date — request the next payment any time.</div>
            {error && <div className="mt-1 text-sm text-red-600">{error}</div>}
          </div>
          <Button onClick={requestNext} disabled={pending}>Request next payment</Button>
        </CardContent>
      </Card>
    );
  }

  const hasSchedule = status.rows.length > 0;
  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <CalendarClock className="h-4 w-4" /> Payment schedule
          </div>
          {hasSchedule && !billingStarted && (
            <button onClick={() => setEditing(true)} className="text-xs font-medium text-brand hover:underline">Edit</button>
          )}
        </div>

        {!hasSchedule ? (
          <div className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center">
            <div className="text-sm text-slate-600">No payment schedule yet.</div>
            <div className="mt-0.5 text-xs text-slate-400">Set deposit / progress / final draws as a % of the contract.</div>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => setEditing(true)}>Set up schedule</Button>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100">
              {status.rows.map((r) => {
                const isNext = !!status.next && status.next.index === r.index;
                return (
                  <li key={r.id ?? r.index} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${r.billed ? "bg-emerald-500" : isNext ? "bg-amber-400" : "bg-slate-300"}`} />
                      <span className="truncate text-slate-700">{r.label}</span>
                      {Number(r.percent) > 0 && <span className="text-xs text-slate-400">{Number(r.percent)}%</span>}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="font-medium text-slate-900">{formatCurrency(r.dollars)}</span>
                      <span className={`w-12 text-right text-xs ${r.billed ? "text-emerald-600" : isNext ? "text-amber-600" : "text-slate-400"}`}>
                        {r.billed ? "Billed" : isNext ? "Next" : "—"}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
              <span>Billed {formatCurrency(status.billedTotal)} of {formatCurrency(status.scheduledTotal)}</span>
              {status.percentOff && <span className="text-amber-600">Percents total {status.scheduledPct}% (not 100%)</span>}
            </div>
            {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
            <div className="mt-3 flex items-center justify-end gap-3">
              {billingStarted && <span className="text-xs text-slate-400">Schedule locked — billing started</span>}
              {status.next ? (
                <Button onClick={requestNext} disabled={pending}>
                  Request next payment <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <span className="text-sm font-medium text-emerald-600">All payments billed</span>
              )}
            </div>
          </>
        )}
      </CardContent>

      {editing && (
        <ScheduleEditor
          jobId={jobId}
          contractTotal={contractTotal}
          initial={
            hasSchedule
              ? status.rows.map((r) => ({ label: r.label, percent: Number(r.percent) || 0 }))
              : defaultSchedule(depositPercent).map((m) => ({ label: m.label, percent: Number(m.percent) || 0 }))
          }
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      )}
    </Card>
  );
}

function ScheduleEditor({
  jobId,
  contractTotal,
  initial,
  onClose,
  onSaved,
}: {
  jobId: string;
  contractTotal: number;
  initial: Row[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(initial.length ? initial : [{ label: "Deposit", percent: 30 }]);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const sum = rows.reduce((s, r) => s + (Number(r.percent) || 0), 0);

  function set(i: number, patch: Partial<Row>) {
    setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  function save() {
    setError(null);
    const ms = rows
      .filter((r) => (Number(r.percent) || 0) > 0)
      .map((r) => ({ label: r.label.trim() || "Payment", percent: Number(r.percent) }));
    if (!ms.length) {
      setError("Add at least one payment with a percentage.");
      return;
    }
    start(async () => {
      const res = await setPaymentSchedule(jobId, ms);
      if (!res.ok) {
        setError(res.error ?? "Could not save the schedule.");
        return;
      }
      onSaved();
    });
  }

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      title="Payment schedule"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel="Save schedule" />}
    >
      <div className="space-y-3">
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <p className="text-sm text-slate-600">
          Each payment is a percentage of the contract{contractTotal > 0 ? ` (${formatCurrency(contractTotal)})` : " (set a quote to see dollar amounts)"}.
        </p>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input value={r.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="e.g. Rough-in" className="flex-1" />
              <div className="flex items-center gap-1">
                <NumberInput value={r.percent} onValueChange={(n) => set(i, { percent: n })} className="w-16" />
                <span className="text-sm text-slate-400">%</span>
              </div>
              <span className="w-20 text-right text-sm text-slate-500">
                {contractTotal > 0 ? formatCurrency(milestoneAmount({ sort_order: i, label: r.label, percent: Number(r.percent) || 0 }, contractTotal)) : "—"}
              </span>
              <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-600" aria-label="Remove payment">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <button onClick={() => setRows([...rows, { label: "", percent: 0 }])} className="flex items-center gap-1 text-sm font-medium text-brand hover:underline">
          <Plus className="h-4 w-4" /> Add payment
        </button>
        <div className={`text-right text-sm font-medium ${Math.abs(sum - 100) < 0.5 ? "text-slate-500" : "text-amber-600"}`}>Total: {sum}%</div>
      </div>
    </Modal>
  );
}
