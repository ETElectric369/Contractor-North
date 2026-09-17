"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Download, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal, ModalActions } from "@/components/ui/modal";
import { NumberInput } from "@/components/ui/number-input";
import { Input, Label } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import {
  firstName,
  periodLabel,
  sayMoney,
  type PayMethod,
  type PayPaymentRow,
  type PayrollRow,
  type PersonBalance,
} from "@/lib/payroll-math";
import { confirmImportedPayment, recordPayment, settleMileage, unsettleMileage, voidPayment } from "./actions";

// Format a calendar date STRING without a timezone shift — date-only strings
// parse as UTC midnight, so formatting in a Pacific browser would show the day
// before. Anchor at noon UTC and format in UTC.
const fmtYmd = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Sep 12" — the short form the balance board and the payment list read in. */
const fmtDay = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const r2 = (n: number) => Math.round(n * 100) / 100;

const METHODS: { value: PayMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "transfer", label: "Transfer" },
  { value: "other", label: "Other" },
];

/** How many payments the "Paid Recently" list shows before it says there are more.
 *  Recent means recent — the full history is the accountant's export, not this list. */
const RECENT_LIMIT = 12;

export function PayrollView({
  balances,
  payments,
  nameById,
  owedPeriods,
  openShifts,
  today,
  rows,
  period,
  offset,
  settledMileage,
  frozenBase,
  taxNumber = "",
}: {
  /** One per person with hours, a payment, or a locked period — sorted most-owed first.
   *  Every figure on it comes from balanceForPerson, which is pure and shared, so this page
   *  and any future surface cannot disagree about what a man is owed. */
  balances: PersonBalance[];
  /** Every payment, newest first, voided ones included (a void stays visible). */
  payments: PayPaymentRow[];
  nameById: Record<string, string>;
  /** What the owed figure is made of, per person: the UNLOCKED pay periods and their gross. */
  owedPeriods: Record<string, { start: string; end: string; gross: number }[]>;
  /** People with a shift still running, and the entry to go fix. */
  openShifts: { profileId: string; name: string; entryId: string }[];
  /** The ORG's today (lib/tz) — the Paid On default. Never the browser's day. */
  today: string;
  /** The VIEWED pay period's entries, aggregated — mileage block and CSV only. */
  rows: PayrollRow[];
  period: { start: string; end: string };
  offset: number;
  /** Settled mileage $ per profileId — SUMMED kind='mileage' runs for this period
   *  (human-stated amounts; a key exists only after a settlement act). */
  settledMileage: Record<string, number>;
  /** The FROZEN hours/gross/rates of this period's locked runs, per profileId. The CSV reads
   *  these instead of re-pricing locked hours at today's rate. */
  frozenBase: Record<string, { hours: number; gross: number; rates: number[] }>;
  /** The org's EIN / tax # (Settings → Company) — stamped on the CSV export's
   *  company header so the accountant file says which employer it belongs to. */
  taxNumber?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last thing that happened, said in its own words with an Undo beside it — inline, where
   *  his thumb already is, never a toast that floats off before a man on a ladder has read it. */
  const [done, setDone] = useState<{ text: string; paymentId: string | null } | null>(null);

  // THE PAY MODAL. Amount starts EMPTY (null) every open, ON PURPOSE — the same law the mileage
  // modal below has carried since 0095: a pre-filled number here would be the app inventing a
  // paycheck figure. Erik: "sometimes i need to throw his a few hundred or an off ammount."
  const [payFor, setPayFor] = useState<PersonBalance | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [paidOn, setPaidOn] = useState(today);
  const [method, setMethod] = useState<PayMethod>("cash");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);

  // Settle-mileage modal, UNCHANGED. The amount starts EMPTY (null) every open, ON PURPOSE:
  // mileage pay is a human decision — the app never computes, suggests, or defaults it from any
  // rate. Do not "helpfully" seed this field.
  const [settleFor, setSettleFor] = useState<PayrollRow | null>(null);
  const [settleAmount, setSettleAmount] = useState<number | null>(null);

  // The period reads [start, end); display the inclusive last day.
  const endInclusive = new Date(new Date(`${period.end}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const label = `${fmtYmd(period.start)} – ${fmtYmd(endInclusive)}`;

  const owing = balances.filter((b) => b.owed > 0.005);
  // WHAT HE OWES, not a net position: a man who is ahead does not reduce what the next man is
  // owed, so only the positive balances are summed. The ahead rows say so on their own line.
  const totalOwed = r2(owing.reduce((s, b) => s + b.owed, 0));
  const needsCheck = payments.filter((p) => p.needsCheck && !p.voided);
  const newest = payments.slice(0, RECENT_LIMIT);
  // A payment still waiting to be checked never falls off the end of this list. The amber line at
  // the top sends him down here to confirm it, and a banner pointing at nothing is a dead end.
  const recent = [...newest, ...needsCheck.filter((p) => !newest.some((n) => n.id === p.id))];
  const periodHours = rows.reduce((s, r) => s + r.paidHours + r.unpaidHours, 0);
  // Only people who actually drove: this block is about miles now, so a row with nothing but a
  // name in it would be the fluff Erik asked to skim. The CSV below still exports every person.
  const mileageRows = rows.filter((r) => r.heldMiles > 0 || r.loggedMiles > 0 || settledMileage[r.profileId] !== undefined);
  const openShiftIds = new Set(openShifts.map((o) => o.profileId));

  /** Run one action and say what it did. THE SENTENCE IS THE ACTION'S OWN: recordPayment,
   *  voidPayment and confirmImportedPayment each hand back a `message` that names what actually
   *  happened down in the database (which pay periods locked, which one refused and why) — this
   *  page cannot know that and must not guess at it. `fallback` covers the actions that carry no
   *  sentence of their own, the two mileage ones. */
  function run(
    fn: () => Promise<{ ok: boolean; error?: string; message?: string }>,
    key: string,
    fallback: string,
    undoPaymentId?: string | null,
  ) {
    setError(null);
    setBusy(key);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (!res.ok) {
        setDone(null);
        setError(res.error ?? "Something went wrong and nothing was saved.");
        return;
      }
      setDone({ text: res.message ?? fallback, paymentId: undoPaymentId ?? null });
      router.refresh();
    });
  }

  function openPay(b: PersonBalance) {
    // Clear the last sentence: its Undo belongs to the act that is finished, not to the one he is
    // starting now. Every payment keeps an Undo of its own in Paid Recently either way.
    setDone(null);
    setAmount(null);
    setPaidOn(today);
    setMethod("cash");
    setReference("");
    setNote("");
    setModalError(null);
    setPayFor(b);
  }

  function closePay() {
    setPayFor(null);
    setAmount(null);
    setReference("");
    setNote("");
    setModalError(null);
  }

  function submitPay() {
    if (!payFor || amount === null || amount <= 0) return;
    const person = payFor;
    const amt = amount;
    const on = paidOn;
    const how = method;
    setModalError(null);
    setBusy(`pay:${person.profileId}`);
    start(async () => {
      const res = await recordPayment({
        profileId: person.profileId,
        amount: amt,
        paidOn: on,
        method: how,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
      });
      setBusy(null);
      // THE MODAL STAYS OPEN ON FAILURE. Closing first would eat the amount he just typed and
      // leave him retyping an off number from memory — the opposite of what this page is for.
      if (!res.ok) {
        setModalError(res.error ?? "That payment was not saved. Nothing changed.");
        return;
      }
      // recordPayment hands back the row it wrote, so the Undo below voids exactly that payment
      // and not the newest-looking one — and its own sentence, which names the pay periods the
      // money just locked. If either ever stops coming, the Paid Recently list still carries an
      // Undo on every row and the fallback sentence still says what was recorded.
      closePay();
      setDone({
        text: res.message ?? `Recorded ${sayMoney(amt)} paid to ${firstName(person.name)} on ${fmtDay(on)} by ${how}.`,
        paymentId: res.paymentId ?? null,
      });
      router.refresh();
    });
  }

  function submitSettle() {
    if (!settleFor || settleAmount === null) return;
    const row = settleFor;
    const amt = settleAmount;
    setSettleFor(null);
    setSettleAmount(null);
    run(
      () => settleMileage({ profileId: row.profileId, periodStart: period.start, periodEnd: period.end, amount: amt }),
      `settle:${row.profileId}`,
      `Settled ${sayMoney(amt)} of mileage for ${firstName(row.name)}.`,
    );
  }

  function exportCsv() {
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    // Two buckets, two statuses, NO combined Total column — base wages and the
    // mileage settlement must never sum into one figure on the accountant file.
    const header = ["Employee", "Hours", "Rate ($/hr)", "Gross ($)", "Base status", "Business miles", "Mileage ($)", "Mileage status"];
    const lines = rows.map((r) => {
      // THE FROZEN GROSS, NOT TODAY'S RATE. This used to rebuild every figure from the CURRENT
      // pay rate, so re-exporting a period after a raise handed the accountant a different file
      // from the one he already had for the same fortnight. A lock froze what those hours came
      // to; read that. The unpaid slice is still live, because nothing has frozen it yet.
      const frozen = frozenBase[r.profileId];
      const paidHrs = frozen ? frozen.hours : r.paidHours;
      const paidGross = frozen ? frozen.gross : r.paidGross;
      const hrs = paidHrs + r.unpaidHours;
      const grossAcc = r2(paidGross + r.unpaidGross);
      const paidRateCols = frozen ? frozen.rates : r.paidRates.map((x) => x.rate);
      const distinct = [...new Set([...paidRateCols, ...r.unpaidRates.map((x) => x.rate)])].sort((a, b) => a - b);
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
    const unpaidHours = rows.reduce((s, r) => s + r.unpaidHours, 0);
    const unpaidGross = r2(rows.reduce((s, r) => s + r.unpaidGross, 0));
    const csv = [
      [`Payroll — ${label}`],
      // Company identity for the accountant: the org's EIN (Settings → Company).
      // Only when set — an org without one keeps the exact old file shape.
      ...(taxNumber ? [["Company EIN", taxNumber]] : []),
      header,
      ...lines.map((l) => l),
      ["TOTAL (unpaid base)", unpaidHours.toFixed(2), "", unpaidGross.toFixed(2), "", "", "", ""],
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

  const payPeriods = payFor ? (owedPeriods[payFor.profileId] ?? []) : [];
  const payPeriodsSum = r2(payPeriods.reduce((s, p) => s + p.gross, 0));
  // The gap between the open periods and the owed figure is money already handed over against
  // those same hours — say it, rather than letting two numbers on one card fail to add up.
  const alreadyApplied = payFor ? r2(payPeriodsSum - payFor.owed) : 0;
  const payDirty = amount !== null || reference !== "" || note !== "" || paidOn !== today || method !== "cash";

  return (
    <div className="space-y-4">
      {needsCheck.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          {needsCheck.length} {needsCheck.length === 1 ? "payment was" : "payments were"} brought over from the old Mark Paid button. Check {needsCheck.length === 1 ? "it matches" : "they match"} what you actually handed over.
        </div>
      )}

      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div>
        <div className="text-4xl font-bold tabular-nums tracking-tight text-slate-900">You Owe {formatCurrency(totalOwed)}</div>
        <div className="mt-1 text-sm text-slate-600">
          {owing.length === 0 ? "Everyone is paid up." : `across ${owing.length} ${owing.length === 1 ? "person" : "people"}`}
        </div>
        <div className="mt-0.5 text-xs text-slate-400">Base pay only. Mileage settles separately below.</div>
      </div>

      {openShifts.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-amber-200 bg-amber-50">
          <div className="px-4 py-2.5 text-sm text-amber-800">
            {openShifts.map((o) => firstName(o.name)).join(", ")} {openShifts.length === 1 ? "has" : "have"} a shift still on the clock, so those hours are not counted yet.
          </div>
          {openShifts.map((o) => (
            <Link
              key={o.profileId}
              href={`/timecards?entry=${o.entryId}`}
              className="flex min-h-[44px] items-center justify-between border-t border-amber-200 px-4 text-sm font-medium text-amber-900 active:bg-amber-100"
            >
              <span>Fix On Timecards{openShifts.length > 1 ? ` · ${firstName(o.name)}` : ""}</span>
              <ChevronRight className="h-4 w-4 shrink-0" />
            </Link>
          ))}
        </div>
      )}

      {done && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5">
          <span className="min-w-0 text-sm text-slate-700">{done.text}</span>
          {done.paymentId && (
            <Button
              variant="outline"
              className="shrink-0"
              disabled={pending}
              onClick={() =>
                run(() => voidPayment(done.paymentId as string), `void:${done.paymentId}`, "That payment is undone. It is back on his balance.")
              }
            >
              <Undo2 className="h-4 w-4" /> Undo
            </Button>
          )}
        </div>
      )}

      {/* THE OWED BOARD. The WHOLE ROW is the tap target and there is not one button inside it —
          one thumb, one target, no mis-taps on a ladder. */}
      {balances.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-slate-400">No hours and no payments on record yet.</p>
      ) : (
        <div className="space-y-2">
          {balances.map((b) => {
            // Two sources for the same fact, on purpose: balanceForPerson sets it from the entries
            // it was handed, and the page also knows which people have an open shift because it
            // fetched the entry to link to. Either one says stop.
            const onClock = b.hasOpenShift || openShiftIds.has(b.profileId);
            const ahead = b.owed < -0.005;
            const square = !ahead && b.owed <= 0.005;
            const bits: string[] = [];
            if (b.unpaidHours > 0) bits.push(`${b.unpaidHours.toFixed(1)} h unpaid`);
            if (b.oldestUnpaid) bits.push(`oldest ${fmtDay(b.oldestUnpaid)}`);
            if (b.lastPayment) {
              bits.push(`last paid ${sayMoney(b.lastPayment.amount)} ${b.lastPayment.method} on ${fmtDay(b.lastPayment.paidOn)}`);
            }
            return (
              <Card key={b.profileId} className="overflow-hidden">
                <button
                  type="button"
                  onClick={() => openPay(b)}
                  className="flex min-h-[72px] w-full items-center justify-between gap-3 px-5 py-3.5 text-left active:bg-slate-50"
                >
                  <div className="min-w-0">
                    <div className="truncate text-base font-semibold text-slate-900">{b.name}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {ahead ? "You have paid more than he has earned so far. It comes off his next hours." : bits.join(" · ") || "Nothing unpaid."}
                    </div>
                    {onClock && (
                      <div className="mt-0.5 text-xs text-amber-700">A shift is still running, so the amount is not final.</div>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    {/* A balance that is quietly short a running shift is worse than no balance:
                        the number is withheld until the hours are trustworthy. */}
                    {onClock ? (
                      <span className="text-sm font-semibold text-amber-700">On the clock</span>
                    ) : square ? (
                      <span className="text-sm font-semibold text-slate-500">Paid Up</span>
                    ) : ahead ? (
                      <span className="text-2xl font-bold tabular-nums text-slate-500">
                        {formatCurrency(-b.owed)} <span className="text-sm font-semibold">ahead</span>
                      </span>
                    ) : (
                      <span className="text-2xl font-bold tabular-nums text-slate-900">{formatCurrency(b.owed)}</span>
                    )}
                  </div>
                </button>
              </Card>
            );
          })}
        </div>
      )}

      {recent.length > 0 && (
        <div>
          <h2 className="mb-2 px-1 text-sm font-semibold text-slate-900">Paid Recently</h2>
          <Card className="divide-y divide-slate-100">
            {recent.map((p) => (
              <div key={p.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className={`text-sm ${p.voided ? "text-slate-400 line-through" : "text-slate-800"}`}>
                    {fmtDay(p.paidOn)} · {nameById[p.profileId] ?? "—"} · {formatCurrency(p.amount)} · {p.method}
                  </div>
                  {p.voided && <div className="mt-0.5 text-xs font-medium text-slate-500">voided</div>}
                  {p.reference && <div className="mt-0.5 text-xs text-slate-400">ref {p.reference}</div>}
                  {p.note && (
                    <div className={`mt-0.5 text-xs ${p.needsCheck && !p.voided ? "text-amber-700" : "text-slate-400"}`}>{p.note}</div>
                  )}
                </div>
                {!p.voided && (
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {p.needsCheck && (
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => confirmImportedPayment(p.id),
                            `confirm:${p.id}`,
                            `Checked off the ${sayMoney(p.amount)} paid to ${firstName(nameById[p.profileId])}.`,
                          )
                        }
                      >
                        <Check className="h-4 w-4" /> That&apos;s Right
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="text-slate-500"
                      disabled={pending}
                      onClick={() =>
                        run(
                          () => voidPayment(p.id),
                          `void:${p.id}`,
                          `Undone. The ${sayMoney(p.amount)} from ${fmtDay(p.paidOn)} is back on his balance.`,
                        )
                      }
                    >
                      <Undo2 className="h-4 w-4" /> Undo
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </Card>
          {payments.length > recent.length && (
            <p className="mt-1.5 px-1 text-xs text-slate-400">
              Showing {recent.length} of {payments.length} payments.
            </p>
          )}
        </div>
      )}

      {/* MILEAGE — its own bucket, its own lock, its own human-typed dollar amount (0095's
          two-lock rule). It is never added into the owed figure above. This block stays
          period-scoped because a settlement covers a period, so the period it covers is
          named right here rather than left for the reader to assume. */}
      <div>
        <h2 className="mb-1 px-1 text-sm font-semibold text-slate-900">Mileage</h2>
        <p className="mb-2 px-1 text-xs text-slate-500">
          Settled separately. You type the amount; the app never computes it. {periodLabel(period.start, period.end)}.
        </p>
        {mileageRows.length === 0 ? (
          <p className="px-1 py-4 text-center text-sm text-slate-400">No miles logged in this pay period.</p>
        ) : (
          <div className="space-y-2">
            {mileageRows.map((r) => {
              const settledAmt = settledMileage[r.profileId]; // undefined = no settlement act yet
              const hasSettled = settledAmt !== undefined;
              const hasHeld = r.heldMiles > 0 || (!hasSettled && r.loggedMiles > 0);
              const rowBusy = pending && busy?.endsWith(r.profileId) === true;
              return (
                <Card key={r.profileId} className="px-5 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                        {r.name}
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
                      {/* Miles are DATA; dollars appear only after a human-stated settlement. */}
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
                      {r.heldMiles > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSettleAmount(null); // ALWAYS empty — never pre-filled
                            setSettleFor(r);
                          }}
                          disabled={rowBusy}
                        >
                          Settle Mileage…
                        </Button>
                      )}
                      {hasSettled && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-slate-500"
                          onClick={() =>
                            run(
                              () => unsettleMileage({ profileId: r.profileId, periodStart: period.start, periodEnd: period.end }),
                              `unsettle:${r.profileId}`,
                              `Mileage for ${firstName(r.name)} is held again.`,
                            )
                          }
                          disabled={rowBusy}
                        >
                          <Undo2 className="h-4 w-4" /> Undo Mileage
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* THE ACCOUNTANT'S UNIT, collapsed. A pay period is what gets exported, not what gets paid —
          it opens on its own when he has paged back to an older one so he is never looking at a
          period he cannot see the name of. */}
      <details open={offset > 0} className="group rounded-xl border border-slate-200 bg-white">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-open:rotate-90" />
          <span className="min-w-0 flex-1 truncate">
            {offset === 0 ? "This Pay Period" : "Pay Period"} · {periodLabel(period.start, period.end)} · {periodHours.toFixed(1)} h
          </span>
        </summary>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-3">
          <div className="flex items-center gap-2">
            <Link
              href={`/payroll?period=${offset + 1}`}
              className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
              title="Previous period"
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <span className="min-w-[150px] text-center text-sm font-medium text-slate-800">{label}</span>
            <Link
              href={`/payroll?period=${Math.max(0, offset - 1)}`}
              className={`flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 ${offset === 0 ? "pointer-events-none opacity-40" : ""}`}
              title="Next period"
            >
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
          <Button variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
        </div>
      </details>

      <p className="pt-1 text-xs text-slate-400">
        Base pay is hours times pay rate. Mileage is never added into it. Your accountant handles
        withholding from this export.
      </p>

      {payFor && (
        <Modal
          open
          onClose={closePay}
          title={`Pay ${payFor.name}`}
          size="sm"
          dirty={payDirty}
          footer={
            <ModalActions
              onCancel={closePay}
              onSave={submitPay}
              saveLabel={amount !== null && amount > 0 ? `Record ${formatCurrency(amount)} Paid` : "Record Payment"}
              disabled={amount === null || amount <= 0}
              saving={pending && busy === `pay:${payFor.profileId}`}
            />
          }
        >
          <div className="space-y-4">
            <div className="rounded-lg bg-slate-50 px-3 py-2.5">
              <div className="text-sm font-semibold text-slate-900">
                {payFor.owed > 0.005
                  ? `Owed ${formatCurrency(payFor.owed)}`
                  : payFor.owed < -0.005
                    ? `${formatCurrency(-payFor.owed)} ahead`
                    : "Paid up"}
              </div>
              {payPeriods.length > 0 && (
                <div className="mt-0.5 text-xs text-slate-500">
                  {payPeriods.map((p) => `${periodLabel(p.start, p.end)} ${formatCurrency(p.gross)}`).join(" · ")}
                </div>
              )}
              {alreadyApplied > 0.005 && payFor.owed > 0.005 && (
                <div className="mt-0.5 text-xs text-slate-500">
                  Less {formatCurrency(alreadyApplied)} you have already paid against these.
                </div>
              )}
              {(payFor.hasOpenShift || openShiftIds.has(payFor.profileId)) && (
                <div className="mt-1 text-xs text-amber-700">A shift is still on the clock, so this is not final yet.</div>
              )}
            </div>

            {modalError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{modalError}</div>}

            <div>
              <Label htmlFor="pay-amount">Amount You Paid</Label>
              {/* Starts EMPTY, required. No default, no suggested figure, not even the balance
                  above — a pre-filled number here would be the app inventing a paycheck figure. */}
              <NumberInput
                id="pay-amount"
                value={amount ?? 0}
                onValueChange={(n) => setAmount(n)}
                placeholder="0.00"
                autoFocus
              />
            </div>

            <div>
              <Label htmlFor="pay-on">Paid On</Label>
              {/* Defaults to the org's today and stays editable: he pays early, and he pays for
                  last Friday on a Monday. */}
              <Input id="pay-on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </div>

            <div>
              <Label htmlFor="pay-method-cash">How</Label>
              <div className="grid grid-cols-4 gap-2">
                {METHODS.map((m) => (
                  <button
                    key={m.value}
                    id={`pay-method-${m.value}`}
                    type="button"
                    onClick={() => setMethod(m.value)}
                    aria-pressed={method === m.value}
                    className={`min-h-[44px] rounded-lg border px-2 text-sm font-medium transition-colors ${
                      method === m.value
                        ? "border-[rgb(var(--glass-ink))] bg-[rgb(var(--glass-ink))] text-white"
                        : "border-slate-300 bg-white text-slate-700"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label htmlFor="pay-ref">Check number or reference (optional)</Label>
              <Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. check #1042" />
            </div>

            <div>
              <Label htmlFor="pay-note">Note (optional)</Label>
              <Input id="pay-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. cash on the Wilson job" />
            </div>

            <p className="text-xs text-slate-400">
              This records money you handed over. It pays off whole pay periods oldest first, so a
              half paid week stays open until the rest of it is paid.
            </p>
          </div>
        </Modal>
      )}

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
              saving={pending && busy === `settle:${settleFor.profileId}`}
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
