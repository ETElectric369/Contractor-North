"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Check, Download, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal, ModalActions } from "@/components/ui/modal";
import { NumberInput } from "@/components/ui/number-input";
import { formatCurrency, formatDuration } from "@/lib/utils";
import { markPeriodPaid, unmarkPeriodPaid, settleMileage, unsettleMileage } from "./actions";

// Format a calendar date STRING without a timezone shift — date-only strings
// parse as UTC midnight, so formatting in a Pacific browser would show the day
// before. Anchor at noon UTC and format in UTC.
const fmtYmd = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

interface RateHours {
  rate: number;
  hours: number;
}

interface Row {
  profileId: string;
  name: string;
  rate: number;
  unpaidHours: number;
  unpaidGross: number;
  paidHours: number;
  paidGross: number;
  unpaidRates: RateHours[];
  paidRates: RateHours[];
  heldMiles: number;
  settledMiles: number;
  loggedMiles: number;
}

export function PayrollView({
  rows,
  period,
  offset,
  settledMileage,
}: {
  rows: Row[];
  period: { start: string; end: string };
  offset: number;
  /** Settled mileage $ per profileId — SUMMED kind='mileage' runs for this period
   *  (human-stated amounts; a key exists only after a settlement act). */
  settledMileage: Record<string, number>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Two-tap Mark paid: first tap swaps the button to "Confirm $X" in place, the
  // second fires. Auto-disarms after a beat so a stray tap doesn't leave a row
  // permanently one tap from paying.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Settle-mileage modal. The amount starts EMPTY (null) every open, ON PURPOSE:
  // mileage pay is a human decision — the app never computes, suggests, or
  // defaults it from any rate. Do not "helpfully" seed this field.
  const [settleFor, setSettleFor] = useState<Row | null>(null);
  const [settleAmount, setSettleAmount] = useState<number | null>(null);

  // The period reads [start, end); display the inclusive last day.
  const endInclusive = new Date(new Date(`${period.end}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const label = `${fmtYmd(period.start)} – ${fmtYmd(endInclusive)}`;

  const payable = rows.filter((r) => r.unpaidHours > 0);
  const totals = {
    hours: payable.reduce((s, r) => s + r.unpaidHours, 0),
    gross: payable.reduce((s, r) => s + r.unpaidGross, 0),
  };
  const heldTotal = Math.round(rows.reduce((s, r) => s + r.heldMiles, 0) * 10) / 10;

  // "26h 0m × $40.00 + 8h 0m × $75.00" — a mixed-rate slice is always an explicit
  // split, never a silently blended $/hr (the 48.24 lesson).
  const rateSplit = (rates: RateHours[]) =>
    rates.map((x) => `${formatDuration(x.hours)} × ${formatCurrency(x.rate)}`).join(" + ");

  function armConfirm(id: string) {
    setConfirmId(id);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmId(null), 5000);
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, id: string) {
    setError(null);
    setConfirmId(null);
    setBusyId(id);
    start(async () => {
      const res = await fn();
      setBusyId(null);
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else router.refresh();
    });
  }

  function submitSettle() {
    if (!settleFor || settleAmount === null) return;
    const row = settleFor;
    const amount = settleAmount;
    setSettleFor(null);
    setSettleAmount(null);
    run(
      () => settleMileage({ profileId: row.profileId, periodStart: period.start, periodEnd: period.end, amount }),
      `settle:${row.profileId}`,
    );
  }

  function exportCsv() {
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    // Two buckets, two statuses, NO combined Total column — base wages and the
    // mileage settlement must never sum into one figure on the accountant file.
    const header = ["Employee", "Hours", "Rate ($/hr)", "Gross ($)", "Base status", "Business miles", "Mileage ($)", "Mileage status"];
    const lines = rows.map((r) => {
      // Export BOTH slices: a partly-paid period reports all hours/gross, flagged.
      const hrs = r.paidHours + r.unpaidHours;
      const grossAcc = Math.round((r.paidGross + r.unpaidGross) * 100) / 100;
      const distinct = [...new Set([...r.paidRates, ...r.unpaidRates].map((x) => x.rate))].sort((a, b) => a - b);
      const rateCol =
        distinct.length > 1
          ? `mixed (${distinct.map((x) => x.toFixed(2)).join("/")})`
          : (distinct[0] ?? r.rate).toFixed(2);
      const baseStatus = r.unpaidHours === 0 ? "Paid" : r.paidHours > 0 ? "Partly paid" : "Unpaid";
      const businessMi = Math.round((r.heldMiles + r.settledMiles) * 10) / 10;
      const settled = settledMileage[r.profileId];
      const mileageCol = settled !== undefined ? settled.toFixed(2) : "held";
      const mileageStatus = settled !== undefined ? (r.heldMiles > 0 ? "Partly settled" : "Settled") : "Held";
      return [r.name, hrs.toFixed(2), rateCol, grossAcc.toFixed(2), baseStatus, businessMi.toFixed(1), mileageCol, mileageStatus];
    });
    const csv = [
      [`Payroll — ${label}`],
      header,
      ...lines.map((l) => l),
      ["TOTAL (unpaid base)", totals.hours.toFixed(2), "", totals.gross.toFixed(2), "", "", "", ""],
    ]
      .map((row) => row.map(esc).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll-${period.start}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link
            href={`/payroll?period=${offset + 1}`}
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
            title="Previous period"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <span className="min-w-[170px] text-center text-sm font-medium text-slate-800">
            {offset === 0 ? "This pay period" : label}
          </span>
          <Link
            href={`/payroll?period=${Math.max(0, offset - 1)}`}
            className={`rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50 ${offset === 0 ? "pointer-events-none opacity-40" : ""}`}
            title="Next period"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>

      <p className="text-xs text-slate-400">{label}</p>
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {payable.length > 0 && (
        <Card className="bg-brand/5">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
            <span className="font-semibold text-slate-900">To pay this period</span>
            <span className="text-slate-700">
              {formatDuration(totals.hours)} · <span className="font-bold text-slate-900">{formatCurrency(totals.gross)}</span> base to pay
              {heldTotal > 0 && <span className="text-slate-400"> · {heldTotal.toFixed(1)} mi held</span>}
            </span>
          </div>
        </Card>
      )}

      {rows.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-slate-400">No hours logged in this pay period.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const basePaid = r.paidHours > 0 && r.unpaidHours === 0;
            const basePartly = r.paidHours > 0 && r.unpaidHours > 0;
            const settledAmt = settledMileage[r.profileId]; // undefined = no settlement act yet
            const hasSettled = settledAmt !== undefined;
            const hasHeld = r.heldMiles > 0 || (!hasSettled && r.loggedMiles > 0);
            const busy = pending && busyId?.endsWith(r.profileId) === true;
            const unpaidRate = r.unpaidRates[0]?.rate ?? r.rate;
            return (
              <Card key={r.profileId} className="px-5 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                      {r.name}
                      {basePaid && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                          <Check className="h-3 w-3" /> Base paid
                        </span>
                      )}
                      {basePartly && (
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                          Base partly paid
                        </span>
                      )}
                      {r.heldMiles > 0 ? (
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                          Mileage held
                        </span>
                      ) : hasSettled ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                          <Check className="h-3 w-3" /> Mileage settled
                        </span>
                      ) : null}
                    </div>
                    {/* BASE bucket — the paid slice stays visible as dollars (never just
                        "paid hours"), and a partly-paid period renders BOTH slices. */}
                    {r.paidHours > 0 && (
                      <div className="mt-0.5 text-xs text-slate-400">
                        {formatDuration(r.paidHours)} · {formatCurrency(r.paidGross)} base paid
                      </div>
                    )}
                    {r.unpaidHours > 0 && (
                      <div className="mt-0.5 text-xs text-slate-500">
                        {r.unpaidRates.length > 1 ? (
                          <>
                            {rateSplit(r.unpaidRates)} = <span className="font-medium text-slate-700">{formatCurrency(r.unpaidGross)}</span>{" "}
                            <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                              {r.unpaidRates.length} rates
                            </span>
                          </>
                        ) : (
                          <>
                            {formatDuration(r.unpaidHours)} × {formatCurrency(unpaidRate)}/hr ={" "}
                            <span className="font-medium text-slate-700">{formatCurrency(r.unpaidGross)}</span>
                          </>
                        )}
                      </div>
                    )}
                    {/* MILEAGE bucket — miles are data, dollars only after a human-stated
                        settlement. The held line SURVIVES a base payment. */}
                    {hasSettled && (
                      <div className="mt-0.5 text-xs text-slate-500">
                        {r.settledMiles.toFixed(1)} mi · {formatCurrency(settledAmt)} settled
                      </div>
                    )}
                    {hasHeld && (
                      <div className="mt-0.5 text-xs text-slate-500">
                        {r.heldMiles.toFixed(1)} business mi ({r.loggedMiles.toFixed(1)} logged) · held
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {r.unpaidHours > 0 &&
                      (confirmId === r.profileId ? (
                        <Button
                          size="sm"
                          onClick={() => run(() => markPeriodPaid({ profileId: r.profileId, periodStart: period.start, periodEnd: period.end }), r.profileId)}
                          disabled={busy}
                        >
                          Confirm {formatCurrency(r.unpaidGross)}
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => armConfirm(r.profileId)} disabled={busy}>
                          <Check className="h-4 w-4" /> Mark paid
                        </Button>
                      ))}
                    {r.paidHours > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-slate-500"
                        onClick={() => run(() => unmarkPeriodPaid({ profileId: r.profileId, periodStart: period.start, periodEnd: period.end }), r.profileId)}
                        disabled={busy}
                      >
                        <Undo2 className="h-4 w-4" /> Undo base
                      </Button>
                    )}
                    {r.heldMiles > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setSettleAmount(null); // ALWAYS empty — never pre-filled
                          setSettleFor(r);
                        }}
                        disabled={busy}
                      >
                        Settle mileage…
                      </Button>
                    )}
                    {hasSettled && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-slate-500"
                        onClick={() => run(() => unsettleMileage({ profileId: r.profileId, periodStart: period.start, periodEnd: period.end }), r.profileId)}
                        disabled={busy}
                      >
                        <Undo2 className="h-4 w-4" /> Undo mileage
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <p className="pt-1 text-xs text-slate-400">
        Base pay is hours × pay rate. Mileage is tracked in miles and held separately until you set a
        reimbursement policy — it is never added into gross. Tax deductions &amp; withholdings are handled
        by your accountant / payroll service from this export.
      </p>

      {settleFor && (
        <Modal
          open
          onClose={() => {
            setSettleFor(null);
            setSettleAmount(null);
          }}
          title={`Settle mileage — ${settleFor.name}`}
          size="sm"
          dirty={settleAmount !== null}
          footer={
            <ModalActions
              onCancel={() => {
                setSettleFor(null);
                setSettleAmount(null);
              }}
              onSave={submitSettle}
              saveLabel={settleAmount !== null ? `Settle ${formatCurrency(settleAmount)}` : "Settle"}
              disabled={settleAmount === null}
              saving={pending && busyId === `settle:${settleFor.profileId}`}
            />
          }
        >
          <label className="mb-1.5 block text-sm font-medium text-slate-700">
            Amount paid for {settleFor.heldMiles.toFixed(1)} business miles
          </label>
          {/* Starts EMPTY, required. No default, no suggested rate — a pre-filled
              number here would be the app inventing a paycheck figure. */}
          <NumberInput
            value={settleAmount ?? 0}
            onValueChange={(n) => setSettleAmount(n)}
            placeholder="0.00"
            autoFocus
          />
          <p className="mt-2 text-xs text-slate-400">
            Mileage pay is whatever you decide — the app never computes it.
          </p>
        </Modal>
      )}
    </div>
  );
}
