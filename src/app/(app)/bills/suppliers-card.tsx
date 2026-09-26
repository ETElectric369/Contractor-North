"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { NumberInput } from "@/components/ui/number-input";
import { openFoldsTo } from "@/components/fold-opener";
import { Fold, WhyFold } from "@/components/why-fold";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  SUPPLIER_PAY_METHODS,
  r2,
  sayAge,
  supplierBalance,
  type SupplierAccountRow,
  type SupplierActionResult,
  type SupplierPayMethod,
} from "./supplier-balance";
import { SupplierPaperLists, type SupplierInvoiceActions } from "./supplier-invoices-card";
import { type ReconcileJob, type SupplierInvoiceRow, type SupplierPaperCard, type SupplierReconcileFeed } from "./supplier-reconcile";

/**
 * The supplier accounts' own doors. The supplier-NAME housekeeping (merge review, the same-supplier
 * question, spellings on no account) and the same-ticket-two-jobs card moved to More on /bills
 * (Wave B), so this card only carries what an account itself does.
 */
export interface SuppliersCardActions {
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
  /**
   * CORRECTING WHAT THE ACCOUNT ACTUALLY IS. The account number is the one field here that is
   * genuinely load-bearing - it is how a payment he sent gets matched when CED asks about it - and
   * it arrives typed off a phone photo. The write has existed since 0270 and had no door at all
   * until the audit counted it (2026-09-20), which is the dead-door class the other way round:
   * not a control that does nothing, but a capability nothing can reach.
   */
  updateAccount?: (input: {
    accountId: string;
    name?: string;
    accountNumber?: string | null;
    branchCode?: string | null;
    note?: string | null;
  }) => Promise<SupplierActionResult>;
  /**
   * A PERSON says which job a supplier invoice belongs to (migration 0273). Optional, and its
   * absence is what switches the whole reconcile card off: every section of that card is built
   * around this one verb, so without it the card could only refuse, and a control that can only
   * refuse must not render. The BALANCE is untouched either way - reading what the supplier says
   * is open needs no permission from anybody.
   */
  setInvoiceJob?: SupplierInvoiceActions["setInvoiceJob"];
  /** Optional, and optional inside the card too: record a supplier invoice the app never scanned
   *  as a bill on its job. Without it those rows still name the money and link to the job. */
  recordAsBill?: SupplierInvoiceActions["recordAsBill"];
  tieToBill?: SupplierInvoiceActions["tieToBill"];
  shelfLines?: SupplierInvoiceActions["shelfLines"];
  recordToShelf?: SupplierInvoiceActions["recordToShelf"];
  /** Stop Waiting on the folded Waiting On A Credit line (0346). */
  stopWaitingOnCredit?: SupplierInvoiceActions["stopWaitingOnCredit"];
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
 * THE DISCOUNT SENTENCE, AND THE ONE DATE IT IS ALLOWED TO NAME (review of cn-v966).
 *
 * CED's rule is "cash discount if paid by the 10th of the month FOLLOWING purchase", so every
 * month of invoices carries a later deadline than the month before it. `total` is every discount
 * still live across all of them; `by` is only the SOONEST of those dates; `dueOnNext` is the
 * slice that actually rides on that date. Today all six of his live discounts happen to fall on
 * Oct 10, which makes total and dueOnNext accidentally equal - and a sentence that is only
 * accidentally true is one that goes confidently wrong the first time a September discount is
 * still open when an October invoice lands. It would then read "$34.48 comes off if they are
 * paid by Oct 10" over $9 that is not at risk until Nov 10: money hurried for no reason, which
 * is the same sin as money forgotten.
 *
 * THREE PLACES WERE BUILDING THIS SENTENCE and only two of them guarded it. One function now, so
 * a fourth copy cannot get it wrong. No full stop on the end: the amber pointer joins its
 * clauses with commas and closes the sentence itself.
 */
export function discountDeadlineSentence(claim: { total: number; dueOnNext: number; by: string | null }): {
  sentence: string;
  /** True when the whole claimable figure really does ride on that one date. */
  allOnOneDate: boolean;
} {
  if (!(claim.total > 0.005) || !claim.by) return { sentence: "", allOnOneDate: false };
  const allOnOneDate = claim.dueOnNext >= claim.total - 0.005;
  return {
    allOnOneDate,
    sentence: allOnOneDate
      ? `${formatCurrency(claim.total)} comes off if they are paid by ${formatDate(claim.by)}`
      : `${formatCurrency(claim.dueOnNext)} of ${formatCurrency(claim.total)} in discount goes if they are not paid by ${formatDate(claim.by)}`,
  };
}

/**
 * ONE LINE PER SUPPLIER, AND THE FIRST PLACE HE CAN PAY ONE (Erik, 2026-09-18; 0270; Wave B).
 *
 * Owed = unpaid bills MINUS live payments (model A), or what the supplier itself calls open once
 * its own papers are loaded (model B, supplierBalance). He pays in chunks that never match the
 * tickets, so a payment is an amount he types, and no bill is flipped by it.
 *
 * WAVE B, "IT LOOKS LIKE ONE BIG RUN-ON SENTENCE": each account is ONE LINE (its name, what it says
 * is owed) that opens to its detail: the numbers, Record A Payment, its bills, its payments, the
 * names it is filed under, and, for a supplier whose own papers are loaded (CED), those papers as
 * short folded lists (SupplierPaperLists). Every paragraph that used to explain the card became a
 * one-line label and a Why? fold holding the words. The balance is said once, on the line.
 *
 * STILL REFUSED, all of them deliberate: it never invents a figure (the payment amount starts
 * empty), it never gives a register supplier a balance, and it never hides money it cannot place
 * (bills on no account get their own line, pointing at More where they are filed).
 */
export function SuppliersCard({
  accounts,
  today,
  unassigned = null,
  reconcile = null,
  noSupplierDocument = {},
  needsYouIds = [],
  waitingOnCredit = [],
  payOn = null,
  balancesUnread = false,
  actions,
}: {
  accounts: SupplierAccountRow[];
  /** The ORG's today (todayStrInTz), never the browser's day: it dates a payment and ages a bill. */
  today: string;
  /** Bills on no account yet. Shown so every dollar on this page is accounted for somewhere. */
  unassigned?: { bills: number; total: number } | null;
  /**
   * THE SUPPLIER'S OWN DOCUMENTS (migration 0273), for the accounts we hold them for. `byAccount`
   * holds the SAME row objects handed to `accounts[].supplierInvoices`: one array, two readers.
   */
  reconcile?: {
    byAccount: Record<string, SupplierInvoiceRow[]>;
    /** His jobs, for the picker. Enough on each to tell five Rhodesias apart. */
    jobs: ReconcileJob[];
    /** The day this app's records begin. Purchases older than it are counted, never nagged about. */
    recordsSince: string | null;
  } | null;
  /**
   * PER ACCOUNT, THE SLICE OF ITS UNPAID BILLS THE SUPPLIER'S OWN DOCUMENTS DO NOT COVER. Never a
   * second balance: `owed` stays the supplier's own figure. Named so $467.87 he does owe is not
   * explained away (the Sunnyvale counter ticket CED Truckee never issued paper for).
   */
  noSupplierDocument?: Record<string, { total: number; bills: number; ids: string[] }>;
  /** Papers on a Needs You card: the supplier's own lists never repeat them. */
  needsYouIds?: string[];
  /** Papers a person said wait on a credit (0346), not back yet: one folded line under their supplier. */
  waitingOnCredit?: SupplierPaperCard[];
  /**
   * MY DAY'S DOOR (/bills?pay=<account>): "Pay CED $5,174.62 By Oct 10" lands here with this
   * account's Record A Payment sheet already open. The same sheet, the same write; nothing new.
   */
  payOn?: string | null;
  /**
   * A READ A BALANCE IS BUILT FROM FAILED (audit v1018, class 2): the supplier's own papers, the
   * bills, or the payments. An account counted from bills less payments then says it couldn't total
   * instead of showing a figure built from half its rows, and an account CED's own papers would have
   * counted never quietly switches to the other model. The payment sheet still opens, amount empty.
   */
  balancesUnread?: boolean;
  actions: SuppliersCardActions;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last thing that happened, in its own words, with an Undo beside it - inline where his
   *  thumb already is, never a toast that floats off before a man on a ladder has read it. */
  const [done, setDone] = useState<{ text: string; paymentId: string | null } | null>(null);

  // THE PAYMENT SHEET. Amount starts EMPTY every time, on purpose: a pre-filled number here would
  // be the app inventing a figure for his books.
  const [payFor, setPayFor] = useState<SupplierAccountRow | null>(null);
  const [editFor, setEditFor] = useState<SupplierAccountRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editNumber, setEditNumber] = useState("");
  const [editBranch, setEditBranch] = useState("");
  const [editNote, setEditNote] = useState("");
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

  // THE SUPPLIER'S OWN PAPERS ARE ALL OR NOTHING: every list is built around one verb (a person
  // saying which job an invoice belongs to), so without that action there is nothing to show but
  // buttons that refuse. The BALANCE reads model B either way.
  const canReconcile = !!reconcile && !!actions.setInvoiceJob;
  const feeds = useMemo(() => {
    const map = new Map<string, SupplierReconcileFeed>();
    if (!canReconcile || !reconcile) return map;
    for (const [accountId, invoices] of Object.entries(reconcile.byAccount ?? {})) {
      if (!invoices?.length) continue;
      map.set(accountId, { invoices, jobs: reconcile.jobs ?? [], recordsSince: reconcile.recordsSince ?? null });
    }
    return map;
  }, [canReconcile, reconcile]);

  /** No figure for this account: it is counted from bills less payments and one of those reads
   *  (or the supplier's own papers, which would have counted it instead) failed. */
  const cantTotal = (account: SupplierAccountRow, balance: ReturnType<typeof supplierBalance>) =>
    balancesUnread && account.onAccount && balance.model !== "supplier-invoices";

  // WHAT HE OWES, not a net position: an account paid ahead does not reduce the next one's bill.
  const owing = balances.filter((b) => (b.balance.owed ?? 0) > 0.005);
  const onAccountOwed = r2(owing.reduce((s, b) => s + (b.balance.owed ?? 0), 0));
  const ahead = balances.filter((b) => (b.balance.owed ?? 0) < -0.005);
  // Money marked On Account on a supplier he settles at the register: no balance to sit in, still
  // money. UNDER MODEL B it is not a second pile: that account's `owed` is already the supplier's.
  const registerUnpaid = r2(
    balances
      .filter((b) => b.balance.unpaidOnRegisterAccount && b.balance.model !== "supplier-invoices")
      .reduce((s, b) => s + b.balance.charged, 0),
  );
  const unfiled = r2(unassigned?.total ?? 0);
  const totalOwed = r2(onAccountOwed + registerUnpaid + unfiled);
  // Accounts whose figure now comes from the supplier, and what his own paperwork still says.
  const supplierModelled = balances.filter((b) => b.balance.model === "supplier-invoices");
  const modelledBillsUnpaid = r2(supplierModelled.reduce((s, b) => s + b.balance.charged, 0));
  const modelledNoDocument = r2(
    supplierModelled.reduce((s, { account }) => s + (noSupplierDocument[account.id]?.total ?? 0), 0),
  );
  const modelledExplained = r2(Math.max(0, modelledBillsUnpaid - modelledNoDocument));

  const payBalance = payFor ? supplierBalance(payFor, today) : null;
  const payUnread = !!payFor && !!payBalance && cantTotal(payFor, payBalance);
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

  function openEdit(account: SupplierAccountRow) {
    setSheetError(null);
    setEditFor(account);
    setEditName(account.name ?? "");
    setEditNumber(account.accountNumber ?? "");
    setEditBranch(account.branchCode ?? "");
    setEditNote(account.note ?? "");
  }

  function saveEdit() {
    if (!editFor || !actions.updateAccount) return;
    const account = editFor;
    const name = editName.trim();
    if (!name) {
      setSheetError("An account needs a name. It is what every receipt gets filed under.");
      return;
    }
    run(
      () =>
        actions.updateAccount!({
          accountId: account.id,
          name,
          // An emptied field means "there isn't one", which is a different answer from "unchanged".
          accountNumber: editNumber.trim() || null,
          branchCode: editBranch.trim() || null,
          note: editNote.trim() || null,
        }),
      `editacct:${account.id}`,
      `Saved ${name}.`,
    );
    setEditFor(null);
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

  // MY DAY'S DOOR OPENS THE SHEET, ONCE. The same gate as the account row's Record A Payment button
  // (a balance to pay down), and a door that cannot open says why instead of doing nothing. The
  // `pay` param comes off the address afterwards so a refresh after recording does not reopen it.
  const payOnHandled = useRef<string | null>(null);
  // The why lands where he lands: this card sits below Needs You and Sort These, so on a phone the
  // red line would be below the fold and the door would look like it did nothing.
  const errorRef = useRef<HTMLDivElement | null>(null);
  const [showDoorError, setShowDoorError] = useState(false);
  useEffect(() => {
    if (!showDoorError || !error) return;
    setShowDoorError(false);
    errorRef.current?.scrollIntoView({ block: "center" });
  }, [showDoorError, error]);
  useEffect(() => {
    if (!payOn || payOnHandled.current === payOn) return;
    payOnHandled.current = payOn;
    const account = accounts.find((a) => a.id === payOn) ?? null;
    const canPay = !!account && supplierBalance(account, today).owed !== null;
    if (account && canPay) {
      // WAVE B: the sheet opens INSIDE the account's own detail. The supplier line (a folded
      // <details>) opens around it, so closing the sheet leaves him on that account's numbers, its
      // one Record A Payment, and its papers - not on a row of closed lines.
      openFoldsTo(`supplier-invoices-${account.id}`);
      openPay(account);
    } else {
      setShowDoorError(true);
      setError(
        account
          ? `${account.name} is settled at the register, so there is no balance to pay here.`
          : "That supplier account is not in your books any more, so there is no payment to record.",
      );
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("pay");
      // A refresh lands on the same account's open detail (FoldOpener), never a second sheet.
      if (account && canPay) url.hash = `supplier-invoices-${account.id}`;
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // The address keeps its ?pay=; the sheet only ever opens once per visit either way.
    }
    // openPay only resets this component's own state; the door runs once per account asked for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payOn, accounts, today]);

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
      // THE SHEET STAYS OPEN ON FAILURE, so the odd amount he just typed is not eaten.
      if (!res.ok) {
        setSheetError(res.error ?? "That payment was not saved. Nothing changed.");
        return;
      }
      setPayFor(null);
      setAmount(null);
      setReference("");
      setNote("");
      // recordPayment hands back the row it wrote, so the Undo below voids exactly that payment.
      setDone({
        text:
          res.message ??
          `Recorded ${formatCurrency(amt)} paid to ${account.name} on ${formatDate(on)} by ${METHOD_LABELS[how].toLowerCase()}.`,
        paymentId: res.paymentId ?? null,
      });
      router.refresh();
    });
  }

  /** "In All Bills below", as a door that opens the ledger fold (FoldOpener), never a phantom.
   *  Inline, so only inside a Why? fold's words; on the open screen it is seeAllInAllBills. */
  const toAllBills = (
    <a href="#all-bills" className="font-medium underline">
      All Bills
    </a>
  );
  /** The same door on the open screen: its own line, 44px tall, saying what it opens. */
  const seeAllInAllBills = (label: string) => (
    <a href="#all-bills" className="flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
      {label}
    </a>
  );

  return (
    <>
      <Card className="mb-6 p-4" id="suppliers">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">Suppliers</h2>
          {balancesUnread ? (
            <span className="text-sm font-semibold text-amber-800">Couldn&apos;t Total Just Now</span>
          ) : (
            (accounts.length > 0 || unfiled > 0.005) && (
              <span className="text-sm font-semibold tabular-nums text-slate-900">
                {totalOwed <= 0.005 ? "Square With Everyone" : `${formatCurrency(totalOwed)} Owed`}
              </span>
            )
          )}
        </div>
        {balancesUnread && (
          <p className="mt-1 text-sm text-amber-800" role="alert">
            Couldn&apos;t read everything your balances are made of just now, so the ones that depend on it aren&apos;t totalled. Reload the page to try again.
          </p>
        )}
        <WhyFold>
          <p>
            What you still owe on account, supplier by supplier. A payment is a chunk of money, not a ticket ticked
            off, so it marks no bill paid.
          </p>
          {totalOwed > 0.005 && !balancesUnread && (
            <p>
              {[
                onAccountOwed > 0.005 ? `${formatCurrency(onAccountOwed)} on ${owing.length} ${owing.length === 1 ? "account" : "accounts"}.` : "",
                registerUnpaid > 0.005 ? `${formatCurrency(registerUnpaid)} is on suppliers you pay at the register and still marked On Account.` : "",
                unfiled > 0.005 ? `${formatCurrency(unfiled)} is on bills with no supplier account yet.` : "",
              ]
                .filter(Boolean)
                .join(" ")}
              {ahead.length > 0 ? ` You are ahead at ${ahead.map((b) => b.account.name).join(", ")}, which does not come off the total.` : ""}
            </p>
          )}
          {supplierModelled.length > 0 && (
            <p>
              {supplierModelled.map((b) => b.account.name).join(", ")} {supplierModelled.length === 1 ? "is" : "are"} counted from
              their own open papers, not your bills, and your payments are not taken off again: they already did.
              {modelledExplained > 0.005 ? ` All Bills still shows ${formatCurrency(modelledExplained)} unpaid there, which is your paperwork rather than theirs.` : ""}
            </p>
          )}
        </WhyFold>

        {/* NOTHING HIDES: money on bills with no supplier account is in no balance until it is filed,
            and the doors that file it live under More. */}
        {unassigned && unassigned.total > 0.005 && (
          <a
            href="#supplier-names"
            className="mb-2 flex min-h-11 items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 hover:bg-amber-100"
          >
            <span className="min-w-0">
              {formatCurrency(unassigned.total)} On {unassigned.bills} {unassigned.bills === 1 ? "Bill" : "Bills"} With No Supplier Account
            </span>
            <span className="shrink-0 font-medium">File It</span>
          </a>
        )}

        {error && (
          <div ref={errorRef} role="alert" className="mb-3 scroll-mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

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
            No supplier accounts yet. The supplier names off your receipts are under More, ready to go on one.
          </p>
        ) : (
          <div className="space-y-2">
            {balances.map(({ account, balance }) => {
              const owed = balance.owed;
              const unread = cantTotal(account, balance);
              const feed = feeds.get(account.id) ?? null;
              const fromSupplier = balance.model === "supplier-invoices";
              const discountLine = balance.supplierSays
                ? discountDeadlineSentence({
                    total: balance.supplierSays.discountStillClaimable,
                    dueOnNext: balance.supplierSays.nextDiscountAmount,
                    by: balance.supplierSays.nextDiscountBy,
                  })
                : null;
              // Listed in full, not left to the eight-row window: a pointer to a row that is not
              // on the screen is a dead end.
              const noDocIds = new Set(noSupplierDocument[account.id]?.ids ?? []);
              const noDocBills = account.bills.filter((b) => noDocIds.has(b.id));
              const noDocTotal = r2(noDocBills.reduce((sum, b) => sum + (Number(b.amount) || 0), 0));
              // MODEL A ONLY: a ticked bill and a cheque can take the same dollar off twice.
              const settledBesidePayments =
                !unread &&
                balance.model === "bills-minus-payments" &&
                account.onAccount &&
                balance.settledAtRegister > 0.005 &&
                balance.paid > 0.005;
              const unpaidBills = account.bills.filter((b) => String(b.status ?? "").toLowerCase() !== "paid");
              const oldestFirst = [...unpaidBills].sort((a, b) => String(a.billDate ?? "").localeCompare(String(b.billDate ?? "")));
              const shownBills = oldestFirst.slice(0, LIST_LIMIT);
              const hiddenBills = oldestFirst.length - shownBills.length;
              const hiddenBillTotal = r2(oldestFirst.slice(LIST_LIMIT).reduce((s, b) => s + (Number(b.amount) || 0), 0));
              const shownPayments = account.payments.slice(0, LIST_LIMIT);
              const hiddenPayments = account.payments.length - shownPayments.length;
              const facts: string[] = [];
              if (account.accountNumber) facts.push(`Account ${account.accountNumber}`);
              if (balance.chargedBills > 0) facts.push(`${balance.chargedBills} ${balance.chargedBills === 1 ? "bill" : "bills"} on account`);
              if (balance.oldestUnpaid) facts.push(`oldest ${sayAge(balance.oldestUnpaidDays)}`);

              return (
                <Card key={account.id} className="overflow-hidden">
                  {/* ONE LINE PER SUPPLIER: the whole line is the tap target, and it opens to the
                      detail. A <details>, so a link to this supplier ("#supplier-invoices-<id>",
                      from a job's papers) opens it (FoldOpener). */}
                  <details id={`supplier-invoices-${account.id}`} className="scroll-mt-20">
                    <summary className="flex min-h-[72px] cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 active:bg-slate-50 [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0">
                        <span className="block truncate text-base font-semibold text-slate-900">{account.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-slate-500">{facts.join(" · ") || "Nothing on account."}</span>
                        {/* THE DISCOUNT'S DEADLINE IS ON THE CLOSED LINE: money with a date on it is
                            not left behind a fold. Said once, here; the detail lists the invoices.
                            supplierSays only counts a discount whose date is today or later, and the
                            builder says nothing when none is live, so this never nags after it. */}
                        {fromSupplier && discountLine?.sentence && balance.supplierSays && (
                          <span className="mt-0.5 block text-xs font-medium leading-snug text-green-800">
                            {discountLine.sentence}
                            {discountLine.allOnOneDate ? `, which would make it ${formatCurrency(balance.supplierSays.netIfPaidToday)}` : ""}
                          </span>
                        )}
                        {fromSupplier && noDocTotal > 0.005 && (
                          <span className="block truncate text-xs font-medium text-amber-700">
                            + {formatCurrency(noDocTotal)} they never sent paper for
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-right">
                        {/* A register supplier has NO running balance: a zero would read "paid up". */}
                        {unread ? (
                          <span className="text-sm font-semibold text-amber-800">Couldn&apos;t Total</span>
                        ) : owed === null ? (
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
                        {owed !== null && !unread && (
                          <span className="mt-0.5 block max-w-[8.5rem] truncate text-[11px] text-slate-400">
                            {fromSupplier ? `${account.name} says` : "your bills less payments"}
                          </span>
                        )}
                      </span>
                    </summary>

                    <div className="border-t border-slate-100 px-4 py-3">
                      {/* THE WORKING OF THE MODEL ACTUALLY USED: under model B his payments are
                          already inside what the supplier closed, so they are never subtracted. */}
                      {owed !== null && fromSupplier && balance.supplierSays && (
                        <>
                          <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-center">
                            <div>
                              <div className="text-sm font-semibold tabular-nums text-slate-900">{balance.supplierSays.openDocuments}</div>
                              <div className="text-xs text-slate-500">{balance.supplierSays.openDocuments === 1 ? "paper open" : "papers open"}</div>
                            </div>
                            <div>
                              <div className="text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(balance.paid)}</div>
                              <div className="text-xs text-slate-500">you have sent them</div>
                            </div>
                            <div>
                              <div className="text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(owed)}</div>
                              <div className="text-xs text-slate-500">they say is open</div>
                            </div>
                          </div>
                          <WhyFold label="Why Don't These Subtract?">
                            <p>
                              What you have sent {account.name} is already off the figure they gave us, so taking it off again
                              would count the same money twice.
                              {balance.firstPayment ? ` Your payments run from ${formatDate(balance.firstPayment.paidOn)}.` : ""}
                            </p>
                          </WhyFold>
                        </>
                      )}

                      {unread && (
                        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
                          Couldn&apos;t read everything this balance is made of just now, so it isn&apos;t totalled. Reload the page to try again.
                        </p>
                      )}
                      {owed !== null && !fromSupplier && !unread && (
                        <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-center">
                          <div>
                            <div className="text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(balance.charged)}</div>
                            <div className="text-xs text-slate-500">charged to the account</div>
                          </div>
                          <div>
                            <div className="text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(balance.paid)}</div>
                            <div className="text-xs text-slate-500">you have paid</div>
                          </div>
                          <div>
                            <div className="text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(owed)}</div>
                            <div className="text-xs text-slate-500">still owed</div>
                          </div>
                        </div>
                      )}

                      {/* A register supplier nonetheless holding open papers: their figure, said. */}
                      {balance.openDocumentsOnRegisterAccount && balance.supplierSays && (
                        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                          Marked paid at the register, but {balance.supplierSays.openDocuments} of their papers are open,
                          holding {formatCurrency(balance.supplierSays.gross)}.
                        </p>
                      )}

                      {/* WHAT THEIR FIGURE DOES NOT COVER, one bill at a time. Not added to the
                          balance: a balance he can pay is only money the supplier has asked for. */}
                      {fromSupplier && noDocBills.length > 0 && (
                        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                          <p className="font-medium">
                            {formatCurrency(noDocTotal)} On {noDocBills.length} {noDocBills.length === 1 ? "Bill" : "Bills"} They Never
                            Sent Paper For
                          </p>
                          <ul className="mt-1 space-y-1">
                            {noDocBills.slice(0, LIST_LIMIT).map((b) => (
                              <li key={b.id}>
                                <span className="font-medium tabular-nums">{formatCurrency(b.amount)}</span>
                                {b.billDate ? ` · ${formatDate(b.billDate)}` : ""}
                                {b.jobId && b.jobName ? (
                                  <>
                                    {" · "}
                                    <Link href={`/jobs/${b.jobId}`} className="underline">
                                      {b.jobName}
                                    </Link>
                                  </>
                                ) : (
                                  " · overhead (no job)"
                                )}
                              </li>
                            ))}
                          </ul>
                          {noDocBills.length > LIST_LIMIT &&
                            seeAllInAllBills(`See The Other ${noDocBills.length - LIST_LIMIT} In All Bills`)}
                          <WhyFold>
                            <p>
                              Their figure cannot cover a purchase they never billed you for, so {noDocBills.length === 1 ? "it is" : "they are"} not
                              in the balance above, and still money you owe. When you pay, mark {noDocBills.length === 1 ? "it" : "them"} Settled in{" "}
                              {toAllBills}.
                            </p>
                          </WhyFold>
                        </div>
                      )}

                      {balance.settledAtRegister > 0.005 && (
                        <p className="mt-2 text-xs text-slate-500">
                          + {formatCurrency(balance.settledAtRegister)} on {balance.settledBills}{" "}
                          {balance.settledBills === 1 ? "receipt" : "receipts"} settled at the counter, not in this balance.
                        </p>
                      )}

                      {/* THE TICK AND THE CHEQUE CAN BE THE SAME DOLLAR (model A). Neither control is
                          blocked: the app cannot know which bills a cheque covered. It says so. */}
                      {settledBesidePayments && (
                        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                          <p className="font-medium">A Settled Bill And A Payment May Be The Same Money</p>
                          <WhyFold>
                            <p>
                              {formatCurrency(balance.settledAtRegister)} of bills here are marked settled at the counter, and{" "}
                              {formatCurrency(balance.paid)} in payments is recorded. If a cheque covered any of those bills, this
                              balance is that much too low. Mark those bills On Account in {toAllBills}, or undo that payment here.
                            </p>
                          </WhyFold>
                        </div>
                      )}

                      {/* NO DEAD END: a register supplier with bills On Account gets both doors out. */}
                      {balance.unpaidOnRegisterAccount && (
                        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                          <p className="font-medium">
                            {balance.chargedBills} {balance.chargedBills === 1 ? "Bill" : "Bills"} Marked On Account, {formatCurrency(balance.charged)}
                          </p>
                          <WhyFold>
                            <p>
                              You pay this supplier at the register. If you do have an account here, turn the balance on. If you
                              paid at the counter, mark those receipts Settled in {toAllBills}.
                            </p>
                          </WhyFold>
                          {actions.setOnAccount && (
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
                          )}
                        </div>
                      )}

                      {/* THE ONE Record A Payment. A register supplier has no balance to pay down. */}
                      {owed !== null && (
                        <Button className="mt-3 h-12 w-full" onClick={() => openPay(account)} disabled={pending}>
                          Record A Payment
                        </Button>
                      )}

                      {shownBills.length > 0 && (
                        <div className="mt-3">
                          {/* Under model B these are his paperwork beside the balance, not its parts. */}
                          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                            {fromSupplier ? "Your Bills On This Account" : "What The Balance Is Made Of"}
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
                                    {b.invoiceNumber ? ` · #${b.invoiceNumber}` : ""}
                                    {b.isStatement ? " · a statement" : ""}
                                    {fromSupplier && noDocIds.has(b.id) ? " · no paper from them" : ""}
                                  </span>
                                </span>
                                <span className="shrink-0 text-sm tabular-nums text-slate-800">{formatCurrency(b.amount)}</span>
                              </li>
                            ))}
                          </ul>
                          {hiddenBills > 0 &&
                            seeAllInAllBills(`See The Other ${hiddenBills}, ${formatCurrency(hiddenBillTotal)}, In All Bills`)}
                        </div>
                      )}

                      {shownPayments.length > 0 && (
                        <div className="mt-3">
                          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Payments You Have Recorded</h3>
                          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                            {shownPayments.map((p) => (
                              <li key={p.id} className="flex items-start justify-between gap-3 px-3 py-2">
                                <span className="min-w-0">
                                  <span className={`block truncate text-sm ${p.voided ? "text-slate-400 line-through" : "text-slate-800"}`}>
                                    {formatDate(p.paidOn)} · {formatCurrency(p.amount)} · {p.method}
                                  </span>
                                  {p.voided && <span className="block text-xs font-medium text-slate-500">undone</span>}
                                  {p.reference && <span className="block truncate text-xs text-slate-400">ref {p.reference}</span>}
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
                          {hiddenPayments > 0 && (
                            <p className="mt-1 text-xs text-slate-400">
                              Showing {shownPayments.length} of {account.payments.length} payments.
                            </p>
                          )}
                          <WhyFold label="What Does Undo Do?">
                            <p>It puts a payment back on what you owe. It stays on this list, crossed out, so your history still shows it.</p>
                          </WhyFold>
                        </div>
                      )}

                      {account.aliases.length > 0 && (
                        <Fold
                          className="mt-2"
                          summary={<span className="text-xs font-medium text-slate-500">Names It&apos;s Filed Under ({account.aliases.length})</span>}
                        >
                          <p className="pb-2 text-xs text-slate-400">
                            {account.aliases.map((a) => (a.branchLabel ? `${a.alias} (${a.branchLabel})` : a.alias)).join(" · ")}
                          </p>
                        </Fold>
                      )}
                      {account.note && <p className="mt-1 text-xs text-slate-400">{account.note}</p>}
                      {actions.updateAccount && (
                        <Button variant="outline" className="mt-2 h-11" disabled={pending} onClick={() => openEdit(account)}>
                          Edit Account
                        </Button>
                      )}

                      {/* THE SUPPLIER'S OWN PAPERS, folded into its own detail (Wave B). */}
                      {feed && (
                        <SupplierPaperLists
                          accountId={account.id}
                          accountName={account.name}
                          feed={feed}
                          today={today}
                          onNeedsYou={needsYouIds}
                          waitingOnCredit={waitingOnCredit}
                          actions={{
                            setInvoiceJob: actions.setInvoiceJob!,
                            recordAsBill: actions.recordAsBill,
                            tieToBill: actions.tieToBill,
                            shelfLines: actions.shelfLines,
                            recordToShelf: actions.recordToShelf,
                            stopWaitingOnCredit: actions.stopWaitingOnCredit,
                          }}
                        />
                      )}
                    </div>
                  </details>
                </Card>
              );
            })}
          </div>
        )}
      </Card>
      {editFor && actions.updateAccount && (
        <Modal
          open
          onClose={() => setEditFor(null)}
          title={`Edit ${editFor.name}`}
          footer={
            <ModalActions
              onCancel={() => setEditFor(null)}
              onSave={saveEdit}
              saveLabel="Save Account"
              saving={pending && busy === `editacct:${editFor.id}`}
              disabled={!editName.trim()}
            />
          }
        >
          <div className="space-y-3">
            {sheetError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{sheetError}</div>}
            <div>
              <Label htmlFor="acct-name">Name</Label>
              <Input id="acct-name" value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
              <p className="mt-1 text-xs text-slate-400">
                What every receipt from them gets filed under. The spellings already filed here do not change.
              </p>
            </div>
            <div>
              <Label htmlFor="acct-number">Account Number</Label>
              <Input
                id="acct-number"
                value={editNumber}
                onChange={(e) => setEditNumber(e.target.value)}
                placeholder="TR-34426"
              />
              <p className="mt-1 text-xs text-slate-400">
                Theirs, not yours. It is how a payment you sent gets matched when they ask about it.
              </p>
            </div>
            <div>
              <Label htmlFor="acct-branch">Branch</Label>
              <Input
                id="acct-branch"
                value={editBranch}
                onChange={(e) => setEditBranch(e.target.value)}
                placeholder="8802 Truckee"
              />
              <p className="mt-1 text-xs text-slate-400">
                Which counter this account is yours at. The money rolls up here whichever branch a ticket came from.
              </p>
            </div>
            <div>
              <Label htmlFor="acct-note">Note</Label>
              <Input id="acct-note" value={editNote} onChange={(e) => setEditNote(e.target.value)} />
            </div>
          </div>
        </Modal>
      )}

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
                {payUnread
                  ? "Couldn't total what you owe just now"
                  : (payBalance.owed ?? 0) > 0.005
                  ? `You owe ${formatCurrency(payBalance.owed ?? 0)} right now`
                  : (payBalance.owed ?? 0) < -0.005
                    ? `${formatCurrency(-(payBalance.owed ?? 0))} paid ahead right now`
                    : "Paid up right now"}
              </div>
              {/* THE WORKING UNDER THE FIGURE HAS TO BE THE WORKING THAT PRODUCED IT (review,
                  2026-09-19). This sub-line printed "$7,456.20 charged on N bills, $6,000.00 paid"
                  underneath a number that came from the supplier's own open documents and never
                  subtracted a payment - model A's arithmetic sitting under model B's answer, on the
                  one screen where he decides how much to write a cheque for. The accordion row was
                  branched for exactly this and the sheet, twelve hundred lines away, was not. */}
              <div className="mt-0.5 text-xs text-slate-500">
                {payUnread
                  ? "Some of what this balance is made of didn't load, so no figure is shown. What you record here is saved either way."
                  : payBalance.model === "supplier-invoices"
                  ? `${payFor.name} says so themselves, across ${payBalance.supplierSays?.openDocuments ?? 0} open ${(payBalance.supplierSays?.openDocuments ?? 0) === 1 ? "document" : "documents"}. You have sent them ${formatCurrency(payBalance.paid)} so far, which is already inside their figure.`
                  : `${formatCurrency(payBalance.charged)} charged on ${payBalance.chargedBills} ${payBalance.chargedBills === 1 ? "bill" : "bills"}, ${formatCurrency(payBalance.paid)} paid so far.`}
                {payFor.accountNumber ? ` Account ${payFor.accountNumber}.` : ""}
              </div>
              {amount !== null && amount > 0 && !payUnread && (
                <div className="mt-1.5 border-t border-slate-200 pt-1.5 text-sm font-medium text-slate-900">
                  {/* UNDER MODEL B THIS IS A PREDICTION, NOT A FACT, and the words have to admit
                      it: the number on the left is the supplier's, and it only moves when THEY
                      apply the payment. Saying "after this: X" would be the app asserting what
                      another company's ledger is going to say. */}
                  {payBalance.model === "supplier-invoices" ? (
                    <>
                      {payFor.name} should read{" "}
                      {formatCurrency(Math.abs(r2((payBalance.owed ?? 0) - amount)))}
                      {r2((payBalance.owed ?? 0) - amount) < -0.005 ? " paid ahead" : " owing"} once they apply this.
                    </>
                  ) : (
                    <>
                      After this: {formatCurrency(Math.abs(r2((payBalance.owed ?? 0) - amount)))}
                      {r2((payBalance.owed ?? 0) - amount) < -0.005 ? " paid ahead" : " still owed"}
                    </>
                  )}
                </div>
              )}
              {amount !== null && amount > (payBalance.owed ?? 0) + 0.005 && !payUnread && (
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
