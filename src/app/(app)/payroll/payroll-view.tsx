"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Check, Download, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal, ModalActions } from "@/components/ui/modal";
import { NumberInput } from "@/components/ui/number-input";
import { InfoPopup } from "@/components/info-popup";
import { formatCurrency } from "@/lib/utils";
import {
  firstName,
  noAnswerSentence,
  owedReading,
  paymentsToShow,
  payrollCsvRows,
  periodLabel,
  sayMoney,
  type PayPaymentRow,
  type PayrollRow,
  type PersonBalance,
} from "@/lib/payroll-math";
import { ownerRegister } from "@/lib/owner-draw";
import { clockDoorWords } from "@/lib/long-shift";
import { confirmImportedPayment, recordPayment, settleMileage, unsettleMileage, voidPayment } from "./actions";
import { fmtDay, PaymentLine, PersonStatement } from "./person-statement";
import { PaySheet, type PayFields } from "./pay-sheet";
import { BASE_PAY_FACTS } from "./payroll-facts";

// Format a calendar date STRING without a timezone shift — date-only strings
// parse as UTC midnight, so formatting in a Pacific browser would show the day
// before. Anchor at noon UTC and format in UTC.
const fmtYmd = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const r2 = (n: number) => Math.round(n * 100) / 100;

/** How many payments the "Paid Recently" list shows before it says there are more.
 *  Recent means recent — and a man's OWN payments are now listed in full inside his statement, so
 *  "showing 12 of 40" is no longer the only door to the other 28. */
const RECENT_LIMIT = 12;

export function PayrollView({
  balances,
  payments,
  nameById,
  ownersOnBoard,
  ownersOnFile,
  viewerId,
  owedPeriods,
  heldMileage,
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
  /** Owners (paid by owner's draw, 0286) who have hours in the board's window. They are not on the
   *  board; one quiet sentence says why, so the missing row is never a mystery. */
  ownersOnBoard: { id: string; name: string }[];
  /** Owners with hours in the VIEWED pay period: named at the foot of the accountant's file. */
  ownersOnFile: { id: string; name: string }[];
  /** The signed-in person, so an owner reading the sentence is told "you" and an office manager
   *  reading the same page is told whose hours they are. */
  viewerId: string | null;
  /** What the owed figure is made of, per person: the UNLOCKED pay periods and their gross. */
  owedPeriods: Record<string, { start: string; end: string; gross: number }[]>;
  /** WHICH PAY PERIODS HOLD EACH PERSON'S UNSETTLED MILES, oldest first, worked out by the same
   *  function the Mileage block reads (page.tsx). Mileage settles one pay period at a time, so a
   *  statement printing an all-window held figure needs this to say where those miles actually are.
   *  A person with none has no key. */
  heldMileage: Record<string, { start: string; end: string; miles: number; offset: number | null }[]>;
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

  /**
   * ── THE ANSWER COMES TO HIS EYE ───────────────────────────────────────────────────────────────
   *
   * THE FAILURE THIS FIXES. The banner is at the TOP of the page and the only door to the pay form is
   * at the FOOT of an open statement, past that person's payment list. Record a payment from there and
   * the sheet closes, nothing scrolls, and the sentence that says what happened — "Aug 16 to Aug 31
   * could not be locked yet… Close it on Timecards", or a refusal from Undo or That's Right — lands
   * hundreds of pixels above the top of the screen. The tap looks like it did nothing, which is the
   * nothing-silent rule broken by geometry rather than by a missing message.
   *
   * ONE BANNER, BROUGHT INTO VIEW — not a second copy drawn inside the statement. Two render sites
   * for one sentence is two places for it to drift, and a sentence about mileage or about a payment
   * made from the cross-person feed belongs to neither statement. bills/suppliers-card.tsx already
   * cures the same failure the same way ("the red line would be below the fold and the door would look
   * like it did nothing").
   *
   * THE COUNTER, not the text, is what the effect watches: `error` is a plain string, so pressing Undo
   * twice and being refused the identical way twice would not re-fire on the second press — and the
   * second press is exactly when he is already scrolled away and needs it brought back.
   */
  const [answerSeq, setAnswerSeq] = useState(0);
  const answerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (answerSeq === 0) return; // nothing has been said yet: never move the page on first paint
    answerRef.current?.scrollIntoView({ block: "center" });
  }, [answerSeq]);

  /** THE TWO WAYS THE PAGE SPEAKS, each one exclusive of the other and each one counted. Every
   *  surface that has something to say goes through these, so none of them can say it silently. */
  function sayDone(d: { text: string; paymentId: string | null }) {
    setError(null);
    setDone(d);
    setAnswerSeq((n) => n + 1);
  }
  function sayError(message: string) {
    setDone(null);
    setError(message);
    setAnswerSeq((n) => n + 1);
  }

  /** WHOSE STATEMENT IS OPEN. One at a time: an accordion, not a page and not a sheet over the
   *  board, so the figures sit inside the card they belong to and the banner above still shows. */
  const [openFor, setOpenFor] = useState<string | null>(null);

  // THE PAY FORM. Its fields live on PaySheet, which the page mounts only while the form is open, so
  // the empty amount is structural rather than five resets anybody could forget (pay-sheet.tsx says
  // why). The WRITE stays here, with its refusal and its sentence.
  const [payFor, setPayFor] = useState<PersonBalance | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  // Settle-mileage modal, UNCHANGED. The amount starts EMPTY (null) every open, ON PURPOSE:
  // mileage pay is a human decision — the app never computes, suggests, or defaults it from any
  // rate. Do not "helpfully" seed this field.
  const [settleFor, setSettleFor] = useState<PayrollRow | null>(null);
  const [settleAmount, setSettleAmount] = useState<number | null>(null);

  // The period reads [start, end); display the inclusive last day.
  const endInclusive = new Date(new Date(`${period.end}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const label = `${fmtYmd(period.start)} – ${fmtYmd(endInclusive)}`;

  // THE BOARD IS THE CREW (0286). The page hands over wages people only: the owner is paid by
  // owner's draw and has no balance, so the old "Your own $40,498 is an owner draw" line (his hours
  // at his own $125, a figure nobody ever owed anyone) is gone, and one quiet sentence says why his
  // row is not here, in the register of whoever is reading (the ownerIsViewer pattern, now shared
  // in lib/owner-draw).
  const crewOwing = balances.filter((b) => b.owed > 0.005);
  // WHAT HE OWES, not a net position: a man who is ahead does not reduce what the next man is
  // owed, so only the positive balances are summed. The ahead rows say so on their own line.
  const totalOwed = r2(crewOwing.reduce((s, b) => s + b.owed, 0));
  const ownerLine = ownersOnBoard.length > 0 ? ownerRegister(ownersOnBoard, viewerId).notOnPayBoard : null;
  const needsCheck = payments.filter((p) => p.needsCheck && !p.voided);
  // A payment still waiting to be checked never falls off the end of this list. The amber line at
  // the top sends him down here to confirm it, and a banner pointing at nothing is a dead end. That
  // promise used to be written out here by hand; it is now paymentsToShow, which the person's own
  // statement reads too, because two hand-written copies of one rule is how one of them loses it.
  const { shown: recent } = paymentsToShow(payments, RECENT_LIMIT);
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
        sayError(res.error ?? "Something went wrong and nothing was saved.");
        return;
      }
      sayDone({ text: res.message ?? fallback, paymentId: undoPaymentId ?? null });
      router.refresh();
    });
  }

  function openPay(b: PersonBalance) {
    // Clear the last sentence: its Undo belongs to the act that is finished, not to the one he is
    // starting now. Every payment keeps an Undo of its own in his statement either way.
    setDone(null);
    setError(null);
    setModalError(null);
    setPayFor(b);
  }

  function closePay() {
    setPayFor(null);
    setModalError(null);
  }

  /** A REFUSAL LANDS ON BOTH SURFACES, because only one of them is on screen and this page cannot
   *  know which. The form holds itself open while the write is out (PaySheet holdOpen), but the
   *  phone's Back still closes it — and a refusal drawn nowhere is how a second payment gets typed
   *  for money that never moved. One sentence, two landing spots, never a figure of our own. */
  function sayRefused(message: string) {
    setModalError(message);
    sayError(message);
  }

  /** ONE WRITE AT A TIME, AND THE REF IS WHAT ENFORCES IT. `pending` comes from useTransition and is
   *  not set synchronously, so two presses dispatched inside one task — a scripted or assistive
   *  double press, which the disabled footer does not stop — both read the old state and both wrote.
   *  A ref flips before the await, so the second press sees it. */
  const paying = useRef(false);

  function submitPay(fields: PayFields) {
    if (!payFor || fields.amount <= 0) return;
    if (paying.current) return;
    paying.current = true;
    const person = payFor;
    setModalError(null);
    setError(null);
    setBusy(`pay:${person.profileId}`);
    start(async () => {
      try {
        const res = await recordPayment({ profileId: person.profileId, ...fields });
        // THE FORM STAYS OPEN ON FAILURE. Closing first would eat the amount he just typed and
        // leave him retyping an off number from memory — the opposite of what this page is for.
        if (!res.ok) {
          sayRefused(res.error ?? "That payment was not saved. Nothing changed.");
          return;
        }
        // recordPayment hands back the row it wrote, so the Undo below voids exactly that payment
        // and not the newest-looking one — and its own sentence, which names the pay periods the
        // money just locked. If either ever stops coming, his statement still carries an Undo on
        // every payment and the fallback sentence still says what was recorded.
        closePay();
        sayDone({
          text:
            res.message ??
            `Recorded ${sayMoney(fields.amount)} paid to ${firstName(person.name)} on ${fmtDay(fields.paidOn)} by ${fields.method}.`,
          paymentId: res.paymentId ?? null,
        });
        // His statement stays open underneath, so the payment he just recorded appears in his own
        // list, with its own Undo, where he is already looking.
        router.refresh();
      } catch {
        // THE ACTION ITSELF FAILED — a dropped connection, a deploy mid-request, a thrown action.
        // Before this there was no catch here at all, so nothing was said and the next thing that
        // happened was a second payment being typed. We do NOT know whether the row was written, so
        // the sentence must not claim either way: noAnswerSentence says so, where a test holds it.
        //
        // AND THE FORM CLOSES, WHICH A REFUSAL ABOVE DOES NOT. A refusal is the server saying the row
        // is NOT there, so the typed figure is worth keeping and retyping it would be pure loss. This
        // is nobody knowing — the insert runs before applyLocks walks the pay periods, so a timeout or
        // a dropped response leaves the money recorded — and recordPayment has no idempotency key
        // (payroll-math noAnswerSentence says so), so a live Record button over that same figure is one
        // tap from paying the man twice. Closing it is the guard, and it costs nothing: PaySheet mounts
        // fresh with an empty amount every open, so he could not have reused the figure anyway without
        // closing the form to go and read his payments, which is exactly what the sentence asks.
        closePay();
        sayError(noAnswerSentence(person.name));
        // Re-read, so the list the sentence sends him to is the one the server has now.
        router.refresh();
      } finally {
        setBusy(null);
        paying.current = false;
      }
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
    // The file is built by payrollCsvRows (pure, tested): two buckets and NO combined Total column,
    // the frozen gross for locked periods, and a footer naming any owner who worked this period but
    // is paid by owner's draw, so the accountant never wonders where those hours went (0286).
    const csv = payrollCsvRows({
      label,
      taxNumber,
      rows,
      frozenBase,
      settledMileage,
      notOnFile: ownersOnFile.map((o) => ({ name: o.name })),
    })
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

  /** Undo and That's Right, worded once, so a payment says the same thing in a statement as it does
   *  in the cross-person feed. */
  const undoPayment = (p: PayPaymentRow) =>
    run(() => voidPayment(p.id), `void:${p.id}`, `Undone. The ${sayMoney(p.amount)} from ${fmtDay(p.paidOn)} is back on his balance.`);
  const confirmPayment = (p: PayPaymentRow) =>
    run(
      () => confirmImportedPayment(p.id),
      `confirm:${p.id}`,
      `Checked off the ${sayMoney(p.amount)} paid to ${firstName(nameById[p.profileId])}.`,
    );

  return (
    <div className="space-y-4">
      {needsCheck.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          {needsCheck.length} {needsCheck.length === 1 ? "payment was" : "payments were"} brought over from the old Mark Paid button. Check {needsCheck.length === 1 ? "it matches" : "they match"} what you actually handed over.
        </div>
      )}

      {/* THE SAME REF ON BOTH ANSWERS, and they are mutually exclusive by construction (sayDone and
          sayError each clear the other), so one of them is on screen at a time and the effect above
          has exactly one element to bring into view. role says it out loud for a screen reader as
          well, because being announced and being visible are two different promises. */}
      {error && (
        <div ref={answerRef} role="alert" className="scroll-mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-4xl font-bold tabular-nums tracking-tight text-slate-900">You Owe {formatCurrency(totalOwed)}</div>
            <div className="mt-1 text-sm text-slate-600">
              {crewOwing.length === 0
                ? "Your crew is paid up."
                : `across ${crewOwing.length} ${crewOwing.length === 1 ? "person" : "people"} on your crew`}
            </div>
          </div>
          {/* ONE LINE ON THE CARD; THE REST AS BULLETS. "Base pay only. Mileage settles separately
              below." and the closing paragraph about rates, mileage and withholding were two blocks
              of small print around this figure. Every fact is in BASE_PAY_FACTS. */}
          <InfoPopup
            title="What This Figure Is"
            label="About What You Owe"
            bullets={BASE_PAY_FACTS}
            className="-mr-2 -mt-1"
          />
        </div>
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
              {/* The office may clock anybody out, forgotten or not; the sheet on Timecards asks
                  when a forgotten one really stopped. */}
              <span>{clockDoorWords(o.name, { self: !!viewerId && o.profileId === viewerId }).clockOut}</span>
              <ChevronRight className="h-4 w-4 shrink-0" />
            </Link>
          ))}
        </div>
      )}

      {done && (
        <div
          ref={answerRef}
          role="status"
          className="flex scroll-mt-4 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5"
        >
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

      {/* THE OWED BOARD. The WHOLE ROW is still the tap target and there is still not one button
          inside it — one thumb, one target, no mis-taps on a ladder. What it OPENS has changed: it
          used to be the form that pays the man, which is why his detail could only be read from
          inside it. Now it opens HIS STATEMENT, in place, and the form has a named door of its own
          at the foot of that (Erik, dfe1f59b: separate the detail from the button to pay them). */}
      {balances.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-slate-400">No hours and no payments on record yet.</p>
      ) : (
        <div className="space-y-2">
          {balances.map((b) => {
            // Two sources for the same fact, on purpose: balanceForPerson sets it from the entries
            // it was handed, and the page also knows which people have an open shift because it
            // fetched the entry to link to. Either one says stop.
            const onClock = b.hasOpenShift || openShiftIds.has(b.profileId);
            // ONE RULE for whether a figure may be drawn at all, shared with the statement below
            // (payroll-math owedReading): a balance quietly short a running shift is worse than no
            // balance, so a withheld reading carries no number to print.
            const reading = owedReading({ name: b.name, owed: b.owed, onClock });
            const bits: string[] = [];
            if (b.unpaidHours > 0) bits.push(`${b.unpaidHours.toFixed(1)} h unpaid`);
            if (b.oldestUnpaid) bits.push(`oldest ${fmtDay(b.oldestUnpaid)}`);
            if (b.lastPayment) {
              bits.push(`last paid ${sayMoney(b.lastPayment.amount)} ${b.lastPayment.method} on ${fmtDay(b.lastPayment.paidOn)}`);
            }
            const open = openFor === b.profileId;
            return (
              <Card key={b.profileId} className="overflow-hidden">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenFor(open ? null : b.profileId)}
                  className="flex min-h-[72px] w-full items-center justify-between gap-3 px-5 py-3.5 text-left active:bg-slate-50"
                >
                  <div className="min-w-0">
                    <div className="truncate text-base font-semibold text-slate-900">{b.name}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {reading.kind === "ahead" ? reading.line : bits.join(" · ") || "Nothing unpaid."}
                    </div>
                    {onClock && <div className="mt-0.5 text-xs text-amber-700">{reading.line}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <div className="text-right">
                      {/* A balance that is quietly short a running shift is worse than no balance:
                          the number is withheld until the hours are trustworthy. */}
                      {reading.amount === null ? (
                        <span className={`text-sm font-semibold ${reading.kind === "onClock" ? "text-amber-700" : "text-slate-500"}`}>
                          {reading.word}
                        </span>
                      ) : reading.kind === "ahead" ? (
                        <span className="text-2xl font-bold tabular-nums text-slate-500">
                          {formatCurrency(reading.amount)} <span className="text-sm font-semibold">ahead</span>
                        </span>
                      ) : (
                        <span className="text-2xl font-bold tabular-nums text-slate-900">{formatCurrency(reading.amount)}</span>
                      )}
                    </div>
                    {/* It says the row opens, so nobody has to tap one to find out. */}
                    <ChevronRight
                      aria-hidden
                      className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
                    />
                  </div>
                </button>
                {open && (
                  <PersonStatement
                    balance={b}
                    periods={owedPeriods[b.profileId] ?? []}
                    heldMileage={heldMileage[b.profileId] ?? []}
                    period={period}
                    payments={payments.filter((p) => p.profileId === b.profileId)}
                    onClock={onClock}
                    pending={pending}
                    onRecord={() => openPay(b)}
                    onUndo={undoPayment}
                    onConfirm={confirmPayment}
                  />
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* WHY THE OWNER HAS NO ROW (0286), said once, quietly, as the board's own footnote: he is
          paid by owner's draw, so his hours are not wages and are not on this board. Only when an
          owner actually has hours in view; otherwise there is nothing missing to explain. */}
      {ownerLine && <p className="-mt-1 px-1 text-xs leading-relaxed text-slate-500">{ownerLine}</p>}

      {recent.length > 0 && (
        <div>
          <h2 className="mb-2 px-1 text-sm font-semibold text-slate-900">Paid Recently</h2>
          <Card className="divide-y divide-slate-100">
            {recent.map((p) => (
              // THE SAME ROW the statement draws, with the name added — one renderer, so a voided
              // payment and its remaining actions cannot look like two different things.
              <PaymentLine
                key={p.id}
                payment={p}
                who={nameById[p.profileId] ?? "—"}
                pending={pending}
                onUndo={() => undoPayment(p)}
                onConfirm={() => confirmPayment(p)}
              />
            ))}
          </Card>
          {payments.length > recent.length && (
            <p className="mt-1.5 px-1 text-xs text-slate-400">
              Showing {recent.length} of {payments.length} payments. Open a person above for all of theirs.
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

      {payFor && (
        <PaySheet
          person={payFor}
          periods={owedPeriods[payFor.profileId] ?? []}
          onClock={payFor.hasOpenShift || openShiftIds.has(payFor.profileId)}
          today={today}
          saving={pending && busy === `pay:${payFor.profileId}`}
          error={modalError}
          onCancel={closePay}
          onSubmit={submitPay}
        />
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
