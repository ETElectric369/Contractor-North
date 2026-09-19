"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { NumberInput } from "@/components/ui/number-input";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  SUPPLIER_PAY_METHODS,
  r2,
  sayAge,
  supplierBalance,
  type DuplicateBillGroup,
  type SupplierAccountRow,
  type SupplierActionResult,
  type SupplierCandidateQuestion,
  type SupplierMergeProposal,
  type SupplierPayMethod,
  type SupplierSpelling,
} from "./supplier-balance";
import { SupplierDuplicates, type SupplierDuplicateActions } from "./supplier-duplicates";
import {
  SupplierCandidateReview,
  SupplierMergeReview,
  SupplierUnfiledSpellings,
  type SupplierMergeActions,
  type SupplierSpellingActions,
} from "./supplier-merge-review";

export interface SuppliersCardActions
  extends SupplierMergeActions,
    SupplierDuplicateActions,
    SupplierSpellingActions {
  /**
   * A CHUNK OF MONEY SENT TO A SUPPLIER. Not a ticket, not a tick, and never a figure this app
   * worked out for him: "i pay them in chunks that never match the ticckets".
   */
  recordPayment: (input: {
    accountId: string;
    amount: number;
    paidOn: string;
    method: SupplierPayMethod;
    reference?: string;
    note?: string;
  }) => Promise<SupplierActionResult>;
  /** Void, never delete: the payment stays on the list crossed out and goes back onto the balance. */
  voidPayment: (paymentId: string) => Promise<SupplierActionResult>;
  /**
   * Optional: switch an account between "running balance" and "paid at the register". Without it,
   * a register account carrying unpaid bills is told where the other door is instead.
   */
  setOnAccount?: (input: { accountId: string; onAccount: boolean }) => Promise<SupplierActionResult>;
}

const METHOD_LABELS: Record<SupplierPayMethod, string> = {
  cash: "Cash",
  check: "Check",
  transfer: "Transfer",
  card: "Card",
  other: "Other",
};

/** How many bills or payments one account shows before it says how many more there are. */
const LIST_LIMIT = 8;

/**
 * WHAT HE OWES HIS SUPPLIERS, AND THE FIRST PLACE HE CAN PAY ONE (Erik, 2026-09-18; 0270).
 *
 * The Bills screen opens on Unpaid: $13,040.07 across 21 bills, all of it one CED account spelled
 * five different ways. He asked whether that was what made his margins red. It is not - job profit
 * is cash collected minus cost, and a bill costs the job the moment it exists - but the question
 * found the hole: there was no way to record PAYING a supplier at all, only a checkbox that flips
 * one bill paid (bills-receipts.tsx:320), and that checkbox has never fit how he pays:
 *
 *   "yes i pay them in chunks that never match the ticckets"
 *
 * So this card is the payroll board's shape, for the same reason: OWED = unpaid bills MINUS live
 * payments, an amount he types himself, and no bill is flipped by it. `bills.status` keeps meaning
 * what it has always meant - on account, or settled at the register.
 *
 * FOUR THINGS IT REFUSES TO DO, all of them deliberate:
 *  · It never invents a figure. The payment amount starts empty and no default is offered, not
 *    even the balance itself - the 0095 law, moved one room over.
 *  · It never merges a spelling on its own. Every grouping is a proposal with a button on it,
 *    because the mapping is his judgement (see supplier-merge-review.tsx).
 *  · It never gives a register supplier a balance. A zero there would read as "paid up", which is
 *    a different sentence and not a true one.
 *  · It never hides money it cannot place. Bills that are on no account yet get their own line at
 *    the top with the total on it, so this card can never quietly disagree with the Unpaid tab
 *    below it - the worst thing a money screen can do is add up to something different from the
 *    screen next to it.
 */
export function SuppliersCard({
  accounts,
  today,
  unassigned = null,
  proposals = [],
  questions = [],
  loose = [],
  duplicates = [],
  actions,
}: {
  accounts: SupplierAccountRow[];
  /** The ORG's today (todayStrInTz), never the browser's day: it dates a payment and ages a bill. */
  today: string;
  /** Bills on no account yet. Shown so every dollar on this page is accounted for somewhere. */
  unassigned?: { bills: number; total: number } | null;
  proposals?: SupplierMergeProposal[];
  /** The pairs the matcher will not decide. A question, never a proposal. */
  questions?: SupplierCandidateQuestion[];
  /** Spellings that look like nothing else in the book, each with a door of its own. */
  loose?: SupplierSpelling[];
  duplicates?: DuplicateBillGroup[];
  actions: SuppliersCardActions;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last thing that happened, in its own words, with an Undo beside it - inline where his
   *  thumb already is, never a toast that floats off before a man on a ladder has read it. */
  const [done, setDone] = useState<{ text: string; paymentId: string | null } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // THE PAYMENT SHEET. Amount starts EMPTY every time, on purpose: a pre-filled number here would
  // be the app inventing a figure for his books, and the balance is the LAST thing to seed it with
  // when the whole point is that his chunks never match it.
  const [payFor, setPayFor] = useState<SupplierAccountRow | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [paidOn, setPaidOn] = useState(today);
  const [method, setMethod] = useState<SupplierPayMethod>("check");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [sheetError, setSheetError] = useState<string | null>(null);

  const balances = useMemo(
    () =>
      accounts
        .map((a) => ({ account: a, balance: supplierBalance(a, today) }))
        .sort(
          (x, y) =>
            Number(y.account.onAccount) - Number(x.account.onAccount) ||
            (y.balance.owed ?? 0) - (x.balance.owed ?? 0) ||
            x.account.name.localeCompare(y.account.name),
        ),
    [accounts, today],
  );

  // THE HEADLINE ADDS UP TO WHAT THE UNPAID TAB SAYS, out of parts that are each named underneath
  // it. WHAT HE OWES, not a net position: an account he has paid ahead does not reduce what the
  // next supplier is owed, so only the positive balances are summed and the ahead ones say so on
  // their own rows.
  const owing = balances.filter((b) => (b.balance.owed ?? 0) > 0.005);
  const onAccountOwed = r2(owing.reduce((s, b) => s + (b.balance.owed ?? 0), 0));
  const ahead = balances.filter((b) => (b.balance.owed ?? 0) < -0.005);
  // Money marked unpaid on a supplier he settles at the register. It has no balance to sit in, but
  // it is still money the Unpaid tab is counting, so it is counted here and named on its own row.
  const registerUnpaid = r2(
    balances.filter((b) => b.balance.unpaidOnRegisterAccount).reduce((s, b) => s + b.balance.charged, 0),
  );
  const unfiled = r2(unassigned?.total ?? 0);
  const totalOwed = r2(onAccountOwed + registerUnpaid + unfiled);
  const openDuplicates = duplicates.filter((g) => !g.resolution);
  // HOW MANY DOORS THERE ACTUALLY ARE BELOW THIS LINE for a spelling that is on no account yet:
  // a suggestion, a question, or a row of its own. The amber line reads off this instead of off
  // the proposals alone, which is how it came to say "the suggestions below are how they get
  // there" over five spellings that had nothing below at all.
  const spellingDoors = proposals.length + questions.length + loose.length;

  const payBalance = payFor ? supplierBalance(payFor, today) : null;
  const payDirty = amount !== null || reference.trim() !== "" || note.trim() !== "" || paidOn !== today;

  function run(fn: () => Promise<SupplierActionResult>, key: string, fallback: string, undoPaymentId?: string | null) {
    setError(null);
    setBusy(key);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (!res.ok) {
        setDone(null);
        setError(res.error ?? "Nothing was saved. Try again.");
        return;
      }
      setDone({ text: res.message ?? fallback, paymentId: undoPaymentId ?? null });
      router.refresh();
    });
  }

  function openPay(account: SupplierAccountRow) {
    setDone(null);
    setSheetError(null);
    setAmount(null);
    setPaidOn(today);
    setMethod("check");
    setReference("");
    setNote("");
    setPayFor(account);
  }

  function submitPay() {
    if (!payFor || amount === null || amount <= 0) return;
    const account = payFor;
    const amt = r2(amount);
    const on = paidOn;
    const how = method;
    setSheetError(null);
    setBusy(`pay:${account.id}`);
    start(async () => {
      const res = await actions.recordPayment({
        accountId: account.id,
        amount: amt,
        paidOn: on,
        method: how,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
      });
      setBusy(null);
      // THE SHEET STAYS OPEN ON FAILURE. Closing it would eat the odd amount he just typed and
      // leave him keying it in again from memory, which is the opposite of what this is for.
      if (!res.ok) {
        setSheetError(res.error ?? "That payment was not saved. Nothing changed.");
        return;
      }
      setPayFor(null);
      setAmount(null);
      setReference("");
      setNote("");
      // recordPayment hands back the row it wrote, so the Undo below voids exactly that payment
      // and not the newest-looking one.
      setDone({
        text:
          res.message ??
          `Recorded ${formatCurrency(amt)} paid to ${account.name} on ${formatDate(on)} by ${METHOD_LABELS[how].toLowerCase()}.`,
        paymentId: res.paymentId ?? null,
      });
      router.refresh();
    });
  }

  return (
    <>
      <Card className="mb-6 p-4">
        <div className="mb-3">
          <h2 className="text-base font-semibold text-slate-900">What You Owe Your Suppliers</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            What you still owe on account, supplier by supplier, and the payments you have sent them. A
            payment here is a chunk of money, not a ticket ticked off, so it does not mark any bill paid.
          </p>
        </div>

        {(accounts.length > 0 || unfiled > 0.005) && (
          <div className="mb-3 rounded-lg bg-slate-50 px-4 py-3">
            <div className="text-2xl font-bold tabular-nums text-slate-900">{formatCurrency(totalOwed)}</div>
            <div className="mt-0.5 text-xs leading-relaxed text-slate-500">
              {totalOwed <= 0.005
                ? "You are square with every supplier on here."
                : [
                    onAccountOwed > 0.005
                      ? `${formatCurrency(onAccountOwed)} on ${owing.length} ${owing.length === 1 ? "account" : "accounts"} you can pay down below.`
                      : "",
                    registerUnpaid > 0.005
                      ? `${formatCurrency(registerUnpaid)} is on suppliers you pay at the register and is still marked unpaid.`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
              {ahead.length > 0
                ? ` You are ahead at ${ahead.map((b) => b.account.name).join(", ")}, which does not come off the total.`
                : ""}
            </div>
          </div>
        )}

        {/* NOTHING HIDES. Until a spelling is on an account, its money belongs to no balance on
            this card - and the Unpaid tab further down the page is still counting it. Saying that
            out loud is the only thing that keeps the two halves of one screen from arguing. */}
        {unassigned && unassigned.total > 0.005 && (
          <div className="mb-3 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
            {unassigned.bills} {unassigned.bills === 1 ? "bill is" : "bills are"} not on a supplier account yet, and{" "}
            {formatCurrency(unassigned.total)} of what you owe is on them.
            {/* THE SENTENCE HAS TO MATCH THE BUTTONS THAT EXIST (review, 2026-09-19). It once read
                "Put those bills on an account and they turn into a balance you can pay down" - an
                instruction with no control anywhere on the page. Then it read that nothing in the
                book looked like them, which was true and still offered nothing: five of his sixteen
                spellings had no door at all. Now every one of them is listed below - in a
                suggestion, in a question, or in a list of its own - so the line can point down the
                page again and mean it. */}
            {spellingDoors > 0
              ? " Every one of them is listed below with a way to file it."
              : " Nothing else on this page can place them, so they are counted here and left alone."}
          </div>
        )}

        {/* The duplicate lives in its own card further down, because it is a different kind of
            problem - but it is money on the wrong job, so it gets a pointer from up here rather
            than waiting to be scrolled past. */}
        {openDuplicates.length > 0 && (
          <a
            href="#same-ticket-two-jobs"
            className="mb-3 flex min-h-11 items-center justify-between gap-3 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-900 hover:bg-amber-100"
          >
            <span className="min-w-0">
              {openDuplicates.length === 1
                ? `The same ${formatCurrency(openDuplicates[0].amount)} ticket is filed to two jobs, so one of them may be carrying a cost that is not its own.`
                : `${openDuplicates.length} tickets are each filed more than once, so some job costs may be wrong.`}
            </span>
            <span className="shrink-0 font-medium">Sort It Out</span>
          </a>
        )}

        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {done && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5">
            <span className="min-w-0 text-sm text-slate-700">{done.text}</span>
            {done.paymentId && (
              <Button
                variant="outline"
                className="shrink-0"
                disabled={pending}
                onClick={() =>
                  run(
                    () => actions.voidPayment(done.paymentId as string),
                    `void:${done.paymentId}`,
                    "That payment is undone. It is back on what you owe.",
                  )
                }
              >
                <Undo2 className="h-4 w-4" /> Undo
              </Button>
            )}
          </div>
        )}

        {accounts.length === 0 ? (
          <p className="py-3 text-sm text-slate-400">
            {proposals.length > 0 || (unassigned?.bills ?? 0) > 0
              ? "No supplier accounts yet. The supplier names off your receipts are below, ready to go on one."
              : "No supplier accounts yet. Scan a receipt or add a bill, and the supplier names on them show up here ready to be turned into an account you can pay."}
          </p>
        ) : (
          <div className="space-y-2">
            {balances.map(({ account, balance }) => {
              const isOpen = !!open[account.id];
              const owed = balance.owed;
              const unpaidBills = account.bills.filter((b) => String(b.status ?? "").toLowerCase() !== "paid");
              const oldestFirst = [...unpaidBills].sort((a, b) =>
                String(a.billDate ?? "").localeCompare(String(b.billDate ?? "")),
              );
              const shownBills = oldestFirst.slice(0, LIST_LIMIT);
              const hiddenBills = oldestFirst.length - shownBills.length;
              const hiddenBillTotal = r2(oldestFirst.slice(LIST_LIMIT).reduce((s, b) => s + (Number(b.amount) || 0), 0));
              const shownPayments = account.payments.slice(0, LIST_LIMIT);
              const hiddenPayments = account.payments.length - shownPayments.length;
              const facts: string[] = [];
              if (account.accountNumber) facts.push(`Account ${account.accountNumber}`);
              if (balance.chargedBills > 0) {
                facts.push(`${balance.chargedBills} ${balance.chargedBills === 1 ? "bill" : "bills"} on account`);
              }
              if (balance.oldestUnpaid) facts.push(`oldest ${sayAge(balance.oldestUnpaidDays)}`);

              return (
                <Card key={account.id} className="overflow-hidden">
                  {/* THE WHOLE ROW IS THE TAP TARGET, with no second button inside it - one thumb,
                      one target, no mis-taps on a ladder (the payroll board's rule). Paying is a
                      full-width button inside, where he has already read the balance. */}
                  <button
                    type="button"
                    onClick={() => setOpen((o) => ({ ...o, [account.id]: !o[account.id] }))}
                    aria-expanded={isOpen}
                    className="flex min-h-[72px] w-full items-center justify-between gap-3 px-4 py-3 text-left active:bg-slate-50"
                  >
                    <span className="flex min-w-0 items-start gap-2">
                      {isOpen ? (
                        <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                      ) : (
                        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-base font-semibold text-slate-900">{account.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-slate-500">
                          {facts.join(" · ") || "Nothing on account."}
                        </span>
                        {balance.lastPayment && (
                          <span className="block truncate text-xs text-slate-400">
                            Last paid {formatCurrency(balance.lastPayment.amount)} by {balance.lastPayment.method} on{" "}
                            {formatDate(balance.lastPayment.paidOn)}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      {/* A pay-at-the-register supplier has NO running balance and must not be
                          given one: a zero here would read as "paid up", which is a different
                          sentence and not a true one. */}
                      {owed === null ? (
                        <span className="text-sm font-semibold text-slate-500">Paid At The Register</span>
                      ) : owed > 0.005 ? (
                        <span className="text-2xl font-bold tabular-nums text-slate-900">{formatCurrency(owed)}</span>
                      ) : owed < -0.005 ? (
                        <span className="text-2xl font-bold tabular-nums text-slate-500">
                          {formatCurrency(-owed)} <span className="text-sm font-semibold">ahead</span>
                        </span>
                      ) : (
                        <span className="text-sm font-semibold text-slate-500">Paid Up</span>
                      )}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-slate-100 px-4 py-3">
                      {owed !== null && (
                        <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-center">
                          <div>
                            <div className="text-sm font-semibold tabular-nums text-slate-900">
                              {formatCurrency(balance.charged)}
                            </div>
                            <div className="text-xs text-slate-500">charged to the account</div>
                          </div>
                          <div>
                            <div className="text-sm font-semibold tabular-nums text-slate-900">
                              {formatCurrency(balance.paid)}
                            </div>
                            <div className="text-xs text-slate-500">you have paid</div>
                          </div>
                          <div>
                            <div className="text-sm font-semibold tabular-nums text-slate-900">
                              {formatCurrency(owed)}
                            </div>
                            <div className="text-xs text-slate-500">still owed</div>
                          </div>
                        </div>
                      )}

                      {balance.settledAtRegister > 0.005 && (
                        <p className="mt-2 text-xs text-slate-500">
                          Another {formatCurrency(balance.settledAtRegister)} on {balance.settledBills}{" "}
                          {balance.settledBills === 1 ? "receipt was" : "receipts were"} paid at the register, so it
                          is not part of this balance.
                        </p>
                      )}

                      {/* NO DEAD END. A register supplier with unpaid bills on it is a real
                          contradiction, so it is named and BOTH doors out of it are offered: turn
                          the running balance on, or settle those receipts in the list below. */}
                      {balance.unpaidOnRegisterAccount && (
                        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                          {balance.chargedBills} {balance.chargedBills === 1 ? "bill is" : "bills are"} still marked
                          unpaid on a supplier you pay at the register, holding {formatCurrency(balance.charged)}.
                          {actions.setOnAccount ? (
                            <>
                              {" "}
                              If you do have an account here, turn the balance on. If you paid at the counter, mark
                              those receipts paid in the bills list further down this page.
                              <span className="mt-2 block">
                                <Button
                                  variant="outline"
                                  disabled={pending}
                                  onClick={() =>
                                    run(
                                      () => actions.setOnAccount!({ accountId: account.id, onAccount: true }),
                                      `onaccount:${account.id}`,
                                      `${account.name} now keeps a running balance.`,
                                    )
                                  }
                                >
                                  Turn On A Running Balance
                                </Button>
                              </span>
                            </>
                          ) : (
                            <> Mark those receipts paid in the bills list further down this page and this clears.</>
                          )}
                        </div>
                      )}

                      {/* A control that can only refuse must not render: there is no balance to pay
                          down at a supplier he settles at the register. */}
                      {owed !== null && (
                        <Button className="mt-3 h-12 w-full" onClick={() => openPay(account)} disabled={pending}>
                          Record A Payment
                        </Button>
                      )}

                      {shownBills.length > 0 && (
                        <div className="mt-3">
                          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                            What The Balance Is Made Of
                          </h3>
                          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                            {shownBills.map((b) => (
                              <li key={b.id} className="flex items-start justify-between gap-3 px-3 py-2">
                                <span className="min-w-0">
                                  <span className="block truncate text-sm text-slate-800">
                                    {b.jobId && b.jobName ? (
                                      <Link href={`/jobs/${b.jobId}`} className="hover:text-brand hover:underline">
                                        {b.jobName}
                                      </Link>
                                    ) : (
                                      "Overhead (no job)"
                                    )}
                                  </span>
                                  <span className="block truncate text-xs text-slate-400">
                                    {b.billDate ? formatDate(b.billDate) : "No date"}
                                    {b.invoiceNumber ? ` · invoice ${b.invoiceNumber}` : ""}
                                    {b.isStatement ? " · a statement, several invoices on it" : ""}
                                    {b.supplier ? ` · scanned as ${b.supplier}` : ""}
                                  </span>
                                </span>
                                <span className="shrink-0 text-sm tabular-nums text-slate-800">
                                  {formatCurrency(b.amount)}
                                </span>
                              </li>
                            ))}
                          </ul>
                          {hiddenBills > 0 && (
                            <p className="mt-1 text-xs text-slate-400">
                              And {hiddenBills} more, {formatCurrency(hiddenBillTotal)}. The whole list is in Bills
                              below.
                            </p>
                          )}
                        </div>
                      )}

                      {shownPayments.length > 0 && (
                        <div className="mt-3">
                          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                            Payments You Have Recorded
                          </h3>
                          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                            {shownPayments.map((p) => (
                              <li key={p.id} className="flex items-start justify-between gap-3 px-3 py-2">
                                <span className="min-w-0">
                                  <span
                                    className={`block truncate text-sm ${p.voided ? "text-slate-400 line-through" : "text-slate-800"}`}
                                  >
                                    {formatDate(p.paidOn)} · {formatCurrency(p.amount)} · {p.method}
                                  </span>
                                  {p.voided && <span className="block text-xs font-medium text-slate-500">undone</span>}
                                  {p.reference && (
                                    <span className="block truncate text-xs text-slate-400">ref {p.reference}</span>
                                  )}
                                  {p.note && <span className="block truncate text-xs text-slate-400">{p.note}</span>}
                                </span>
                                {!p.voided && (
                                  <Button
                                    variant="ghost"
                                    className="shrink-0 text-slate-500"
                                    disabled={pending}
                                    onClick={() =>
                                      run(
                                        () => actions.voidPayment(p.id),
                                        `void:${p.id}`,
                                        `Undone. The ${formatCurrency(p.amount)} from ${formatDate(p.paidOn)} is back on what you owe ${account.name}.`,
                                      )
                                    }
                                  >
                                    <Undo2 className="h-4 w-4" /> Undo
                                  </Button>
                                )}
                              </li>
                            ))}
                          </ul>
                          {/* Say what Undo MEANS before he presses it, not after. */}
                          <p className="mt-1 text-xs text-slate-400">
                            Undo puts a payment back on what you owe. It stays on this list, crossed out, so your
                            history still shows it happened.
                            {hiddenPayments > 0
                              ? ` Showing ${shownPayments.length} of ${account.payments.length} payments.`
                              : ""}
                          </p>
                        </div>
                      )}

                      {account.aliases.length > 0 && (
                        <p className="mt-3 text-xs text-slate-400">
                          Filed under:{" "}
                          {account.aliases
                            .map((a) => (a.branchLabel ? `${a.alias} (${a.branchLabel})` : a.alias))
                            .join(" · ")}
                        </p>
                      )}
                      {account.note && <p className="mt-1 text-xs text-slate-400">{account.note}</p>}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Card>

      <SupplierMergeReview proposals={proposals} actions={actions} />

      {/* THE QUESTION COMES AFTER THE SUGGESTIONS AND BEFORE THE LEFTOVERS, because that is the
          order of how sure the app is: here is what I think, here is what I cannot tell, here is
          what I have no opinion about at all. */}
      <SupplierCandidateReview questions={questions} actions={actions} />

      <SupplierUnfiledSpellings spellings={loose} canSetOnAccount={!!actions.setOnAccount} actions={actions} />

      <SupplierDuplicates groups={duplicates} actions={actions} />

      {payFor && payBalance && (
        <Modal
          open
          onClose={() => setPayFor(null)}
          title={`Pay ${payFor.name}`}
          size="sm"
          dirty={payDirty}
          footer={
            <ModalActions
              onCancel={() => setPayFor(null)}
              onSave={submitPay}
              saveLabel={amount !== null && amount > 0 ? `Record ${formatCurrency(amount)} Paid` : "Record Payment"}
              disabled={amount === null || amount <= 0}
              saving={pending && busy === `pay:${payFor.id}`}
            />
          }
        >
          <div className="space-y-4">
            {/* WHAT IT WILL DO, BEFORE HE PRESSES: the balance now and the balance after, which is
                the one thing a man sending an odd chunk of money actually wants to see. */}
            <div className="rounded-lg bg-slate-50 px-3 py-2.5">
              <div className="text-sm font-semibold text-slate-900">
                {(payBalance.owed ?? 0) > 0.005
                  ? `You owe ${formatCurrency(payBalance.owed ?? 0)} right now`
                  : (payBalance.owed ?? 0) < -0.005
                    ? `${formatCurrency(-(payBalance.owed ?? 0))} paid ahead right now`
                    : "Paid up right now"}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {formatCurrency(payBalance.charged)} charged on {payBalance.chargedBills}{" "}
                {payBalance.chargedBills === 1 ? "bill" : "bills"}, {formatCurrency(payBalance.paid)} paid so far.
                {payFor.accountNumber ? ` Account ${payFor.accountNumber}.` : ""}
              </div>
              {amount !== null && amount > 0 && (
                <div className="mt-1.5 border-t border-slate-200 pt-1.5 text-sm font-medium text-slate-900">
                  After this: {formatCurrency(Math.abs(r2((payBalance.owed ?? 0) - amount)))}
                  {r2((payBalance.owed ?? 0) - amount) < -0.005 ? " paid ahead" : " still owed"}
                </div>
              )}
              {amount !== null && amount > (payBalance.owed ?? 0) + 0.005 && (
                <div className="mt-1 text-xs leading-relaxed text-amber-700">
                  That is {formatCurrency(r2(amount - (payBalance.owed ?? 0)))} more than this account shows owing.
                  Fine if you are paying ahead or a ticket has not been scanned yet - the extra sits on the account
                  and comes off the next bills.
                </div>
              )}
              {payBalance.hasStatements && (
                <div className="mt-1 text-xs leading-relaxed text-slate-500">
                  Some of these are statements covering several of their invoices, so this payment cannot be pinned
                  to one invoice number. Put what you can match in the reference below.
                </div>
              )}
            </div>

            {sheetError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{sheetError}</div>}

            <div>
              <Label htmlFor="supplier-pay-amount">Amount You Sent</Label>
              {/* Starts EMPTY, required, and NEVER seeded from the balance. He pays in chunks that
                  match no ticket; a number we put here would be a figure we invented for his books. */}
              <NumberInput
                id="supplier-pay-amount"
                value={amount ?? 0}
                onValueChange={(n) => setAmount(n)}
                placeholder="0.00"
                autoFocus
              />
              <p className="mt-1 text-xs text-slate-400">
                Whatever you actually sent them. It does not have to match a ticket, and it does not mark any bill
                paid.
              </p>
            </div>

            <div>
              <Label htmlFor="supplier-pay-on">Paid On</Label>
              <Input id="supplier-pay-on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </div>

            <div>
              <Label htmlFor="supplier-pay-method-cash">How</Label>
              <div className="grid grid-cols-3 gap-2">
                {SUPPLIER_PAY_METHODS.map((m) => (
                  <button
                    key={m}
                    id={`supplier-pay-method-${m}`}
                    type="button"
                    onClick={() => setMethod(m)}
                    aria-pressed={method === m}
                    className={`min-h-[44px] rounded-lg border px-2 text-sm font-medium transition-colors ${
                      method === m
                        ? "border-[rgb(var(--glass-ink))] bg-[rgb(var(--glass-ink))] text-white"
                        : "border-slate-300 bg-white text-slate-700"
                    }`}
                  >
                    {METHOD_LABELS[m]}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label htmlFor="supplier-pay-ref">Check Number Or Reference (optional)</Label>
              <Input
                id="supplier-pay-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g. check #1042"
              />
              <p className="mt-1 text-xs text-slate-400">
                What they will ask you for when you call about the statement.
              </p>
            </div>

            <div>
              <Label htmlFor="supplier-pay-note">Note (optional)</Label>
              <Input
                id="supplier-pay-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. against the August statement"
              />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
