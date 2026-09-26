"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
import { SupplierInvoicesCard, type SupplierInvoiceActions } from "./supplier-invoices-card";
import {
  reconcileSummary,
  type ReconcileJob,
  type SupplierInvoiceRow,
  type SupplierReconcileFeed,
} from "./supplier-reconcile";
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
  reconcile = null,
  noSupplierDocument = {},
  payOn = null,
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
  /**
   * THE SUPPLIER'S OWN DOCUMENTS (migration 0273), for the accounts we hold them for.
   *
   * `byAccount` holds the SAME row objects handed to `accounts[].supplierInvoices`, with the two
   * extra facts a screen needs and a balance does not (the job's name, and how many scanned bills
   * are linked). One array, two readers - so the balance upstairs and the card downstairs can
   * never be looking at different documents.
   */
  reconcile?: {
    byAccount: Record<string, SupplierInvoiceRow[]>;
    /** His jobs, for the picker. Enough on each to tell five Rhodesias apart. */
    jobs: ReconcileJob[];
    /** The day this app's records begin - its earliest scanned bill. Purchases older than it are
     *  counted and named, never nagged about: nothing here could have recorded them. */
    recordsSince: string | null;
  } | null;
  /**
   * PER ACCOUNT, THE SLICE OF ITS UNPAID BILLS THE SUPPLIER'S OWN DOCUMENTS DO NOT COVER.
   *
   * Only ever set for an account on model B, and it is NOT a second balance: `owed` stays the
   * supplier's own figure. It exists because one sentence on this card explained every unpaid
   * bill on a modelled account away as "your paperwork rather than theirs", which is true of a
   * bill CED has closed and false of the $467.87 Sunnyvale counter ticket CED Truckee never
   * issued a document for at all. That money is real and had nowhere on the screen to be.
   */
  noSupplierDocument?: Record<string, { total: number; bills: number; ids: string[] }>;
  /**
   * MY DAY'S DOOR (/bills?pay=<account>): "Pay CED $5,174.62 By Oct 10" lands here with this
   * account's Record A Payment sheet already open. The same sheet, the same write; nothing new.
   */
  payOn?: string | null;
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

  // THE HEADLINE ADDS UP TO WHAT THE UNPAID TAB SAYS, out of parts that are each named underneath
  // it. WHAT HE OWES, not a net position: an account he has paid ahead does not reduce what the
  // next supplier is owed, so only the positive balances are summed and the ahead ones say so on
  // their own rows.
  // THE RECONCILE CARD IS ALL OR NOTHING. Its every section is built around one verb - a person
  // saying which job an invoice belongs to - so without that action wired there is nothing on it
  // but buttons that refuse. The BALANCE still reads model B either way: supplierBalance() works
  // off `accounts[].supplierInvoices` and needs no action from anybody to be right.
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

  const owing = balances.filter((b) => (b.balance.owed ?? 0) > 0.005);
  const onAccountOwed = r2(owing.reduce((s, b) => s + (b.balance.owed ?? 0), 0));
  const ahead = balances.filter((b) => (b.balance.owed ?? 0) < -0.005);
  // ONE VOCABULARY, CARD AND LIST. The bills list below this card stopped printing the raw column
  // ("paid" / "unpaid") and now says On Account / Settled, which is what that tick has always
  // meant - so every sentence up here that tells him to go and change one says the same two
  // words. Copy that names a word no longer on the screen is a dead end with extra steps.
  // Money marked On Account on a supplier he settles at the register. It has no balance to sit in, but
  // it is still money the Unpaid tab is counting, so it is counted here and named on its own row.
  // UNDER MODEL B THOSE BILLS ARE NOT A SECOND PILE OF MONEY. A register account holding supplier
  // documents already has a positive `owed` - the supplier's own gross - which is in `owing`
  // above, and adding its unpaid bills on top would count the same buying twice on one line.
  const registerUnpaid = r2(
    balances
      .filter((b) => b.balance.unpaidOnRegisterAccount && b.balance.model !== "supplier-invoices")
      .reduce((s, b) => s + b.balance.charged, 0),
  );
  const unfiled = r2(unassigned?.total ?? 0);
  const totalOwed = r2(onAccountOwed + registerUnpaid + unfiled);
  // ACCOUNTS WHOSE NUMBER NOW COMES FROM THE SUPPLIER, and what his own paperwork still says
  // about them. The two disagree on purpose and the gap has to be spoken: the Bills list further
  // down this page counts $7,456.20 unpaid at CED while CED itself says $3,845.14, because his
  // $6,000 of payments is already inside what they have closed. A screen that let those two
  // numbers sit on it without a word between them would be the worst version of this card.
  const supplierModelled = balances.filter((b) => b.balance.model === "supplier-invoices");
  const modelledBillsUnpaid = r2(supplierModelled.reduce((s, b) => s + b.balance.charged, 0));
  // THE PART OF THAT PILE THE SUPPLIER HAS NO DOCUMENT FOR (review of cn-v966). "Your paperwork
  // rather than theirs" is the right sentence about a bill CED has closed. It is the wrong
  // sentence about one CED never issued paper for - their figure cannot cover what they have not
  // billed him for, and saying it does buries $467.87 he genuinely owes inside a reassurance.
  const noDocumentAccounts = supplierModelled
    .map(({ account }) => ({ account, slice: noSupplierDocument[account.id] ?? null }))
    .filter(
      (x): x is { account: SupplierAccountRow; slice: { total: number; bills: number; ids: string[] } } =>
        !!x.slice && x.slice.total > 0.005,
    );
  const modelledNoDocument = r2(noDocumentAccounts.reduce((s, x) => s + x.slice.total, 0));
  // What is left is what the sentence was always about: his paperwork for purchases the supplier
  // has already accounted for. Never below zero, and never invented - it is one subtraction of
  // two figures that are both on this screen.
  const modelledExplained = r2(Math.max(0, modelledBillsUnpaid - modelledNoDocument));

  // WHAT IS WAITING ON HIM IN A SUPPLIER'S OWN DOCUMENTS, counted here so the pointer at the top
  // of this card can say it before he has opened anything. Same pure module the card below
  // renders from, so the count on the pointer and the sections it points at are one count.
  const reconcilePointers = useMemo(
    () =>
      balances
        .map(({ account }) => {
          const feed = feeds.get(account.id);
          if (!feed) return null;
          const waiting = reconcileSummary(feed.invoices, feed.jobs, today, { since: feed.recordsSince });
          if (!waiting.anyOpenQuestions) return null;
          const parts = [
            waiting.needsJob.rows > 0
              ? `${waiting.needsJob.rows} ${waiting.needsJob.rows === 1 ? "invoice is" : "invoices are"} on no job`
              : "",
            waiting.needsBill.rows > 0
              ? `${formatCurrency(waiting.needsBill.total)} was bought and never got into your bills`
              : "",
            // THE SOONEST DATE DOES NOT CARRY THE WHOLE DISCOUNT. The two sentences below this
            // one already guarded that; this one, the first thing he reads on the card, did not.
            discountDeadlineSentence(waiting.claimable).sentence,
          ].filter(Boolean);
          return { account, sentence: `${account.name}: ${parts.join(", ")}.` };
        })
        .filter((x): x is { account: SupplierAccountRow; sentence: string } => !!x),
    [balances, feeds, today],
  );

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
          // An emptied field means "there isn't one", which is a different answer from "unchanged"
          // - null says it, and the action's own patch builder only writes the keys it is given.
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
  useEffect(() => {
    if (!payOn || payOnHandled.current === payOn) return;
    payOnHandled.current = payOn;
    const account = accounts.find((a) => a.id === payOn) ?? null;
    if (account && supplierBalance(account, today).owed !== null) openPay(account);
    else
      setError(
        account
          ? `${account.name} is settled at the register, so there is no balance to pay here.`
          : "That supplier account is not in your books any more, so there is no payment to record.",
      );
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("pay");
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
                      ? `${formatCurrency(registerUnpaid)} is on suppliers you pay at the register and is still marked On Account.`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
              {ahead.length > 0
                ? ` You are ahead at ${ahead.map((b) => b.account.name).join(", ")}, which does not come off the total.`
                : ""}
            </div>

            {/* WHERE THE NUMBER CAME FROM, AND WHAT IT NO LONGER COUNTS.
                Once a supplier's own documents are loaded, that account's figure is theirs: the
                sum of what they still call open, with his payments NOT subtracted, because those
                are already inside what the supplier has closed. Taking them off again read
                $1,360.93 against CED's $3,845.14 the night it shipped.
                The Bills list further down this page is still counting his own unpaid paperwork
                for the same account, and the two will not agree. Saying so here is the only thing
                that keeps one screen from quietly arguing with itself. */}
            {supplierModelled.length > 0 && (
              <div className="mt-2 border-t border-slate-200 pt-2 text-xs leading-relaxed text-slate-500">
                {supplierModelled.map((b) => b.account.name).join(", ")}{" "}
                {supplierModelled.length === 1 ? "is counted" : "are counted"} from{" "}
                {supplierModelled.length === 1 ? "its own" : "their own"} open documents, not from
                your bills. Your payments are not taken off that figure: the supplier has already
                taken them off.
                {modelledExplained > 0.005
                  ? ` The bills list further down still shows ${formatCurrency(modelledExplained)} unpaid there, which is your paperwork rather than theirs.`
                  : ""}
              </div>
            )}
          </div>
        )}

        {/* THE SLICE THE SUPPLIER'S OWN FIGURE CANNOT COVER (review of cn-v966). One line per
            account, up here beside the total, because the sentence above it is the one that
            would otherwise have explained this money away. The balance is NOT changed: folding
            it in would invite a cheque for money CED has not billed him. It is named, and he
            decides. */}
        {noDocumentAccounts.map(({ account, slice }) => (
          <div key={account.id} className="mb-3 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
            {formatCurrency(slice.total)} on {slice.bills} {slice.bills === 1 ? "bill has" : "bills have"} no
            document from {account.name} behind {slice.bills === 1 ? "it" : "them"}, so their figure does not
            cover {slice.bills === 1 ? "it" : "them"} and {slice.bills === 1 ? "it is" : "they are"} not in the
            balance above. Open that account below to see which.
          </div>
        ))}

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

        {/* WHAT THE SUPPLIER'S OWN PAPER SAYS IS WAITING, before he has tapped anything. The
            account row below carries the same door beside the balance it explains, but a door
            only reachable by opening an accordion first is a door he has to go looking for, and
            $1,765.72 of buying that no job is carrying is not something to go looking for. */}
        {reconcilePointers.map(({ account, sentence }) => (
          <a
            key={account.id}
            href={`#supplier-invoices-${account.id}`}
            // STACKED, NOT SIDE BY SIDE. Three clauses beside a call to action squeezed the
            // sentence into a six-word-wide column on a 375px phone, which is where he reads it.
            className="mb-3 block min-h-11 rounded-lg bg-amber-50 px-4 py-2.5 text-sm leading-relaxed text-amber-900 hover:bg-amber-100"
          >
            <span className="block">{sentence}</span>
            <span className="mt-1 block font-medium">See What They Say</span>
          </a>
        ))}

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
              const feed = feeds.get(account.id) ?? null;
              const fromSupplier = balance.model === "supplier-invoices";
              const anchorId = `supplier-invoices-${account.id}`;
              // What is waiting on him in that account's documents, counted by the same pure
              // module the card downstairs renders from, so the number on this row and the
              // number on that card are one number.
              const waiting = feed ? reconcileSummary(feed.invoices, feed.jobs, today, { since: feed.recordsSince }) : null;
              // ONE SENTENCE, ONE BUILDER (discountDeadlineSentence, above). `nextDiscountAmount`
              // is the slice that rides on the soonest date; the whole claimable figure only
              // comes off by it when every live discount falls on the same day.
              const discountLine = balance.supplierSays
                ? discountDeadlineSentence({
                    total: balance.supplierSays.discountStillClaimable,
                    dueOnNext: balance.supplierSays.nextDiscountAmount,
                    by: balance.supplierSays.nextDiscountBy,
                  })
                : null;
              // THE BILLS THIS ACCOUNT'S SUPPLIER HAS NO DOCUMENT FOR, listed in full rather than
              // left to the eight-row window further down. A bill past the eighth would never
              // appear, and the amber line at the top of this card tells him to open the account
              // to find it - a pointer to a row that is not on the screen is a dead end.
              const noDocIds = new Set(noSupplierDocument[account.id]?.ids ?? []);
              const noDocBills = account.bills.filter((b) => noDocIds.has(b.id));
              const noDocTotal = r2(noDocBills.reduce((sum, b) => sum + (Number(b.amount) || 0), 0));
              // MODEL A ONLY. Under model B the payments are not subtracted at all, so a ticked
              // bill and a cheque cannot take the same dollar off the balance twice.
              const settledBesidePayments =
                balance.model === "bills-minus-payments" &&
                account.onAccount &&
                balance.settledAtRegister > 0.005 &&
                balance.paid > 0.005;
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
                      {/* WHICH NUMBER HE IS LOOKING AT, without opening anything. After tonight
                          "CED says" and "your bills less your payments" are two different
                          answers to one question, and he has earned knowing which is on screen. */}
                      {owed !== null && (
                        <span className="mt-0.5 block max-w-[8.5rem] truncate text-[11px] text-slate-400">
                          {fromSupplier ? `${account.name} says` : "your bills less payments"}
                        </span>
                      )}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-slate-100 px-4 py-3">
                      {/* THE WORKING, AND IT HAS TO BE THE WORKING OF THE MODEL ACTUALLY USED.
                          "charged minus paid equals owed" is true under model A and FALSE the
                          moment the supplier's own documents arrive - $7,456.20 less $6,000.00 is
                          not CED's $3,845.14, because his payments are already inside what CED
                          has closed. Printing that subtraction under a model-B figure would be
                          this card showing him arithmetic that does not add up. */}
                      {owed !== null && fromSupplier && balance.supplierSays && (
                        <>
                          <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-center">
                            <div>
                              <div className="text-sm font-semibold tabular-nums text-slate-900">
                                {balance.supplierSays.openDocuments}
                              </div>
                              <div className="text-xs text-slate-500">
                                {balance.supplierSays.openDocuments === 1 ? "document open" : "documents open"}
                              </div>
                            </div>
                            <div>
                              <div className="text-sm font-semibold tabular-nums text-slate-900">
                                {formatCurrency(balance.paid)}
                              </div>
                              <div className="text-xs text-slate-500">you have sent them</div>
                            </div>
                            <div>
                              <div className="text-sm font-semibold tabular-nums text-slate-900">
                                {formatCurrency(owed)}
                              </div>
                              <div className="text-xs text-slate-500">they say is open</div>
                            </div>
                          </div>
                          <p className="mt-2 text-xs leading-relaxed text-slate-500">
                            These two do not subtract. What you have sent {account.name} is already
                            off the figure they gave us, so taking it off again would count the same
                            money twice.
                            {balance.firstPayment
                              ? ` Your payments run from ${formatDate(balance.firstPayment.paidOn)}, to tick off against your bank statement.`
                              : ""}
                          </p>
                          {/* A DATE AND A NUMBER, up here where the balance is, because that is
                              where a man decides what cheque to write. */}
                          {discountLine?.sentence && (
                            <p className="mt-1 text-xs font-medium leading-relaxed text-green-800">
                              {/* THE NET-IF-PAID-TODAY FIGURE RIDES ON ONE BRANCH ONLY: the one
                                  where the whole live discount really does come off by that one
                                  date. Printing it beside a staggered deadline would name a
                                  total he cannot reach with the cheque he is about to write. */}
                              {discountLine.sentence}
                              {discountLine.allOnOneDate
                                ? `, which would make it ${formatCurrency(balance.supplierSays.netIfPaidToday)}.`
                                : "."}
                            </p>
                          )}
                        </>
                      )}

                      {owed !== null && !fromSupplier && (
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

                      {/* THE SAME CONTRADICTION AS unpaidOnRegisterAccount, wearing 0273's
                          clothes: a supplier he settles at the register that is nonetheless
                          holding open documents. It has its own figure, so it gets its own
                          sentence rather than being folded into one that would read "$0.00". */}
                      {balance.openDocumentsOnRegisterAccount && balance.supplierSays && (
                        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                          {account.name} is marked paid at the register, but they still have{" "}
                          {balance.supplierSays.openDocuments}{" "}
                          {balance.supplierSays.openDocuments === 1 ? "document" : "documents"} open against you,
                          holding {formatCurrency(balance.supplierSays.gross)}. That is their figure, and it is
                          shown because it has a document behind it.
                        </div>
                      )}

                      {/* WHAT THEIR FIGURE DOES NOT COVER, named one bill at a time. Their
                          number cannot account for a purchase they never billed him for: the
                          $467.87 was bought at a Sunnyvale counter on his Truckee account, and
                          Truckee will not be issuing paper for it. It is not added to the
                          balance, because a balance he can pay should only ever be money the
                          supplier has actually asked him for. */}
                      {fromSupplier && noDocBills.length > 0 && (
                        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                          {formatCurrency(noDocTotal)} on {noDocBills.length}{" "}
                          {noDocBills.length === 1 ? "bill has" : "bills have"} no document from {account.name}{" "}
                          behind {noDocBills.length === 1 ? "it" : "them"}, so{" "}
                          {noDocBills.length === 1 ? "it is" : "they are"} not in the balance above.{" "}
                          {noDocBills.length === 1 ? "It is" : "They are"} still money you owe.
                          <ul className="mt-1.5 space-y-1">
                            {noDocBills.slice(0, LIST_LIMIT).map((b) => (
                              <li key={b.id}>
                                <span className="font-medium tabular-nums">{formatCurrency(b.amount)}</span>
                                {b.billDate ? ` · ${formatDate(b.billDate)}` : ""}
                                {b.supplier ? ` · scanned as ${b.supplier}` : ""}
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
                          {/* The same eight-row window the lists below use. Naming a ninth row he
                              cannot see would be the dead end this block was written to close. */}
                          {noDocBills.length > LIST_LIMIT && (
                            <span className="mt-1 block">
                              And {noDocBills.length - LIST_LIMIT} more like {noDocBills.length - LIST_LIMIT === 1 ? "it" : "them"}, in the bills list further down this page.
                            </span>
                          )}
                          <span className="mt-1.5 block">
                            When you pay {noDocBills.length === 1 ? "it" : "them"}, mark{" "}
                            {noDocBills.length === 1 ? "it" : "them"} Settled in the bills list further down this
                            page.
                          </span>
                        </div>
                      )}

                      {balance.settledAtRegister > 0.005 && (
                        <p className="mt-2 text-xs text-slate-500">
                          Another {formatCurrency(balance.settledAtRegister)} on {balance.settledBills}{" "}
                          {balance.settledBills === 1 ? "receipt is" : "receipts are"} marked Settled At The
                          Counter, so it is not part of this balance.
                        </p>
                      )}

                      {/* THE TICK AND THE CHEQUE CAN BE THE SAME DOLLAR (review of cn-v966).
                          Under model A the balance is charged minus paid, so marking a $456.02
                          bill settled takes it out of `charged` while recording the cheque that
                          covered it puts the same $456.02 into `paid`: the balance falls by
                          $912.04 for one payment. NEITHER CONTROL IS BLOCKED, and neither should
                          be - a counter receipt charged to an on-account supplier is a real
                          thing, and so is a cheque. The app cannot know which bills a cheque
                          covered; that is the premise of the whole ledger. What it can do is say
                          the two can collide, and let him decide which one happened. Fires on no
                          account today, and on the first one that goes wrong. */}
                      {settledBesidePayments && (
                        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                          {formatCurrency(balance.settledAtRegister)} of bills here are marked settled at the
                          counter, and {formatCurrency(balance.paid)} in payments is recorded against the account.
                          If a cheque covered any of those bills, this balance is that much too low. Mark those
                          bills On Account in the bills list further down this page, or undo that payment here,
                          whichever actually happened.
                        </div>
                      )}

                      {/* NO DEAD END. A register supplier with unpaid bills on it is a real
                          contradiction, so it is named and BOTH doors out of it are offered: turn
                          the running balance on, or settle those receipts in the list below. */}
                      {balance.unpaidOnRegisterAccount && (
                        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                          {balance.chargedBills} {balance.chargedBills === 1 ? "bill is" : "bills are"} still marked
                          On Account on a supplier you pay at the register, holding {formatCurrency(balance.charged)}.
                          {actions.setOnAccount ? (
                            <>
                              {" "}
                              If you do have an account here, turn the balance on. If you paid at the counter, mark
                              those receipts Settled in the bills list further down this page.
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
                            <> Mark those receipts Settled in the bills list further down this page and this clears.</>
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

                      {/* THE WAY IN, AND IT DOES NOT WAIT TO BE SCROLLED PAST. Everything
                          reconciling the portal turned up for this account is one tap away, and
                          the count of what is actually waiting on him rides on the button rather
                          than being something he has to go down and discover. */}
                      {feed && waiting && (
                        <a
                          href={`#${anchorId}`}
                          // ONE TARGET, FULL WIDTH, NOTHING BESIDE IT. A summary in the left half
                          // and the words in the right half squeezed to "40 wi..." on a 375px
                          // phone; what is waiting is already said in full on the amber line at
                          // the top of this card, so here it only needs to be a door.
                          className="mt-2 block min-h-12 rounded-lg border border-slate-200 px-4 py-3 text-center text-sm font-medium text-slate-700 active:bg-slate-50"
                        >
                          See What {account.name} Says
                          {!waiting.anyOpenQuestions && (
                            <span className="mt-0.5 block text-xs font-normal text-slate-400">
                              All {waiting.says.documents} of their open documents are on a job and in your bills.
                            </span>
                          )}
                        </a>
                      )}

                      {shownBills.length > 0 && (
                        <div className="mt-3">
                          {/* UNDER MODEL B THESE BILLS ARE NOT WHAT THE BALANCE IS MADE OF, and
                              the heading said they were. The balance is the supplier's own open
                              documents; this is his paperwork beside it, eleven bills of which
                              they have closed and one they never issued at all. */}
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
                                    {b.invoiceNumber ? ` · invoice ${b.invoiceNumber}` : ""}
                                    {b.isStatement ? " · a statement, several invoices on it" : ""}
                                    {b.supplier ? ` · scanned as ${b.supplier}` : ""}
                                  </span>
                                  {fromSupplier && noDocIds.has(b.id) && (
                                    <span className="block text-xs font-medium text-amber-700">
                                      No document from them covers this one, so it is not in the balance above.
                                    </span>
                                  )}
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
                      {actions.updateAccount && (
                        <Button
                          variant="outline"
                          className="mt-3 h-11"
                          disabled={pending}
                          onClick={() => openEdit(account)}
                        >
                          Edit Account
                        </Button>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Card>

      {/* WHAT RECONCILING WITH THE SUPPLIER FOUND, one card per account we hold documents for.
          It sits immediately under the balances rather than at the bottom of the page, because
          the number it explains is the number he just read. */}
      {canReconcile &&
        balances
          .filter(({ account }) => feeds.has(account.id))
          .map(({ account }) => (
            <SupplierInvoicesCard
              key={account.id}
              anchorId={`supplier-invoices-${account.id}`}
              accountName={account.name}
              feed={feeds.get(account.id)!}
              today={today}
              // The payment sheet lives up here and stays there: a second way to record a payment
              // is a second thing to drift.
              onRecordPayment={account.onAccount ? () => openPay(account) : undefined}
              actions={{
                setInvoiceJob: actions.setInvoiceJob!,
                recordAsBill: actions.recordAsBill,
                tieToBill: actions.tieToBill,
                shelfLines: actions.shelfLines,
                recordToShelf: actions.recordToShelf,
              }}
            />
          ))}

      <SupplierMergeReview proposals={proposals} actions={actions} />

      {/* THE QUESTION COMES AFTER THE SUGGESTIONS AND BEFORE THE LEFTOVERS, because that is the
          order of how sure the app is: here is what I think, here is what I cannot tell, here is
          what I have no opinion about at all. */}
      <SupplierCandidateReview questions={questions} actions={actions} />

      <SupplierUnfiledSpellings spellings={loose} canSetOnAccount={!!actions.setOnAccount} actions={actions} />

      <SupplierDuplicates groups={duplicates} actions={actions} />

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
                {(payBalance.owed ?? 0) > 0.005
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
                {payBalance.model === "supplier-invoices"
                  ? `${payFor.name} says so themselves, across ${payBalance.supplierSays?.openDocuments ?? 0} open ${(payBalance.supplierSays?.openDocuments ?? 0) === 1 ? "document" : "documents"}. You have sent them ${formatCurrency(payBalance.paid)} so far, which is already inside their figure.`
                  : `${formatCurrency(payBalance.charged)} charged on ${payBalance.chargedBills} ${payBalance.chargedBills === 1 ? "bill" : "bills"}, ${formatCurrency(payBalance.paid)} paid so far.`}
                {payFor.accountNumber ? ` Account ${payFor.accountNumber}.` : ""}
              </div>
              {amount !== null && amount > 0 && (
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
