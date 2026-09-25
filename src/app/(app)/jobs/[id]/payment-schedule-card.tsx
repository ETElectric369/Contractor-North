"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Plus, Trash2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { formatCurrency } from "@/lib/utils";
import { scheduleStatus, defaultSchedule, milestoneAmount, type Milestone } from "@/lib/payment-schedule-math";
import { setPaymentSchedule, requestNextPayment } from "../../billing/actions";

type Row = { label: string; percent: number };

/** The "payment structure" for a job (the deal-to-cash spine, Phase 1). Fixed-Bid
 *  jobs get a milestone schedule (% of contract) and a one-click "Request next
 *  payment" that drafts the next draw; T&M jobs request the next payment off the
 *  work logged to date.
 *
 *  "SET UP SCHEDULE" ASKED ONE QUESTION AND THE SERVER ASKS TWO (2026-09-18 sweep, INV-069 wave).
 *
 *  This card decided what to offer from the milestone rows alone: no rows, so here is the button.
 *  setPaymentSchedule refuses on two conditions, quoted exactly:
 *    const { data: draw } = await supabase.from("invoices").select("invoice_number")
 *      .eq("job_id", jobId).neq("status", "void").in("invoice_kind", [...DRAW_KINDS]).limit(1)…
 *    if (draw) return { ok: false, error: "This job already has draws — a payment schedule can
 *                        only be set before any billing starts." };
 *    if ((existing ?? []).some((m: any) => m.invoice_id))
 *      return { ok: false, error: "Billing has already started on this schedule…" };
 *  The second one this card could see (that is `billingStarted`). The first one it could not,
 *  because a draw can exist on a job with no milestone rows at all — someone billed a deposit
 *  from the Invoices tab before anyone thought about a schedule. On that job the button was
 *  unmissable, sat in an empty-state box that read "No payment schedule yet", and could only
 *  ever come back refused after a person had filled in three rows of percentages.
 *
 *  `drawsBilled` is the first condition, computed by the page from the invoices it already
 *  reads. It is optional, and false means "no draws" rather than "unknown", so a caller that
 *  hasn't been wired up yet behaves exactly as before and the server still answers. */
export function PaymentScheduleCard({
  jobId,
  billingType = "fixed",
  contractTotal = 0,
  depositPercent = 0,
  milestones = [],
  drawsBilled = false,
}: {
  jobId: string;
  billingType?: "fixed" | "tm";
  contractTotal?: number;
  depositPercent?: number;
  milestones?: Milestone[];
  /** True when a non-void deposit/progress/final invoice already exists on this job — the exact
   *  read setPaymentSchedule does before it will attach or replace a schedule. */
  drawsBilled?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const status = scheduleStatus(milestones, contractTotal);
  const billingStarted = status.rows.some((r) => r.billed);

  function requestNext() {
    setError(null);
    start(async () => {
      const res = await requestNextPayment(jobId);
      if (!res.ok || !res.id) {
        // A refusal that names the open draw carries it, so the way out is one tap, not a hunt.
        const door = res.openDraft;
        setError(res.error ?? "Could not create the payment.");
        if (door) toast(res.error ?? "", "error", { label: `Open ${door.number}`, onClick: () => router.push(`/billing/${door.id}`) });
        return;
      }
      // Landing on an open time-and-materials draw says what it pulled ("Pulled 12 hours and 1 bill
      // into INV-078."); a brand-new draw has nothing to add.
      if (res.note) toast(res.note, res.partial ? "error" : "info");
      router.push(`/billing/${res.id}`);
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
          <Button onClick={requestNext} disabled={pending}>Request Next Payment</Button>
        </CardContent>
      </Card>
    );
  }

  const hasSchedule = status.rows.length > 0;
  // Both of setPaymentSchedule's refusals in one place, so the Edit link and the Set Up button
  // are gated by the same sentence the action is.
  const scheduleEditable = !billingStarted && !drawsBilled;
  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <CalendarClock className="h-4 w-4" /> Payment schedule
          </div>
          {hasSchedule && scheduleEditable && (
            <button onClick={() => setEditing(true)} className="text-xs font-medium text-brand hover:underline">Edit</button>
          )}
        </div>

        {!hasSchedule ? (
          <div className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center">
            {drawsBilled ? (
              // NOT A BLANK BOX WHERE THE BUTTON WAS. The job is already being billed a draw at
              // a time, which is a way of working, not a fault — so the box says that, and
              // points at the control on this same tab that keeps doing it.
              <>
                <div className="text-sm text-slate-600">No payment schedule on this job.</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  Draws have already been billed here, so a schedule can&apos;t be set up now. Keep billing with Progress Payment above.
                </div>
              </>
            ) : (
              <>
                <div className="text-sm text-slate-600">No payment schedule yet.</div>
                <div className="mt-0.5 text-xs text-slate-400">Set deposit / progress / final draws as a % of the contract.</div>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => setEditing(true)}>Set Up Schedule</Button>
              </>
            )}
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
              {/* setPaymentSchedule's over-contract check runs only at creation time, so a
                  contract that DRIFTS afterwards (an edited quote under a part-drawn
                  schedule) was silently over/under-billing with no warning anywhere. These
                  flags are already computed — render them. */}
              {status.overContract ? (
                <span className="text-red-600">
                  Scheduled {formatCurrency(status.scheduledTotal)} exceeds the {formatCurrency(contractTotal)} contract
                </span>
              ) : status.percentOff ? (
                <span className="text-amber-600">Percents total {status.scheduledPct}% (not 100%)</span>
              ) : null}
            </div>
            {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
            <div className="mt-3 flex items-center justify-end gap-3">
              {/* Where the Edit link was. Two reasons, one line, no em-dash (Erik's copy law). */}
              {!scheduleEditable && (
                <span className="text-xs text-slate-400">
                  {billingStarted ? "Schedule locked - billing started" : "Schedule locked - this job already has draws"}
                </span>
              )}
              {status.next ? (
                <Button onClick={requestNext} disabled={pending}>
                  Request Next Payment <ArrowRight className="h-4 w-4" />
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
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel="Save Schedule" />}
    >
      <div className="space-y-3">
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <p className="text-sm text-slate-600">
          Each payment is a percentage of the contract{contractTotal > 0 ? ` (${formatCurrency(contractTotal)})` : " (set an estimate to see dollar amounts)"}.
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
          <Plus className="h-4 w-4" /> Add Payment
        </button>
        <div className={`text-right text-sm font-medium ${Math.abs(sum - 100) < 0.5 ? "text-slate-500" : "text-amber-600"}`}>Total: {sum}%</div>
      </div>
    </Modal>
  );
}
