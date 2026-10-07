"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { WhyFold } from "@/components/why-fold";
import { Input, Label } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import { settledAtTheRegisterSentence } from "@/lib/supplier-owed";
import {
  candidateJoinedOwed,
  candidateMoving,
  proposalTotals,
  r2,
  spellingMoneySaid,
  type SupplierActionResult,
  type SupplierCandidateQuestion,
  type SupplierMergeProposal,
  type SupplierSpelling,
} from "./supplier-balance";

export interface SupplierMergeActions {
  /**
   * Make (or join) the account and file every bill scanned under these spellings onto it. The NAME
   * and ACCOUNT NUMBER come back from this sheet because they are his words, not the scanner's -
   * he may well accept the grouping and reject the name we guessed for it.
   */
  acceptMerge: (input: {
    proposalId: string;
    name: string;
    accountNumber: string | null;
    existingAccountId: string | null;
    spellings: { alias: string; branchLabel: string | null }[];
  }) => Promise<SupplierActionResult>;
  /**
   * He says these are not the same supplier, and the dismissal has to STICK.
   *
   * The only way to make one stick in this schema is to make it TRUE: the action gives each
   * spelling an account of its own, holding its own bills, so the suggestion has nothing left
   * unfiled to be about. That is a real write, so this card says what it does BEFORE the press -
   * including the part it cannot do, which is join two accounts back together afterwards.
   */
  dismissMerge: (proposalId: string) => Promise<SupplierActionResult>;
}

/**
 * THE MERGE REVIEW - THE PART THAT MUST NOT OVERSTEP (Erik, 2026-09-18; migration 0270).
 *
 * `bills.supplier` is free text the receipt reader writes afresh on every scan: 16 spellings for
 * about 9 real vendors, with CED alone stored five ways and holding $12,572.20 between them. A
 * balance keyed on that text would have shown him four CED balances on day one.
 *
 * So the app SUGGESTS and he DECIDES. Nothing is merged, renamed or re-filed without him pressing
 * something, because the mapping is his knowledge and not ours - he is the only one who knows that
 * "Contractors Electrical Distributors" near Sunnyvale is a different storefront he charged to his
 * Truckee account:
 *
 *   "its the local distributor near sunnyvale for the job so i used my truckee account number,
 *    thats how they roll"
 *
 * That is why the branch label survives the merge: the money rolls up to the account, the ticket
 * stays with its branch, and the price book can still tell a Sunnyvale counter price from a
 * Truckee one instead of quietly averaging two markets.
 *
 * Every spelling is listed, not summarised, so he can see exactly what is being joined before he
 * joins it. A suggestion he cannot audit is a backfill with a button on it.
 */
export function SupplierMergeReview({
  proposals,
  actions,
}: {
  proposals: SupplierMergeProposal[];
  actions: SupplierMergeActions;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The accept sheet. Name and account number start from the suggestion and stay editable: the
  // grouping is the app's guess, the name is his.
  const [accepting, setAccepting] = useState<SupplierMergeProposal | null>(null);
  const [name, setName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [sheetError, setSheetError] = useState<string | null>(null);

  if (proposals.length === 0) return null;

  function run(fn: () => Promise<SupplierActionResult>, key: string, fallback: string) {
    setError(null);
    setBusy(key);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (!res.ok) {
        setDone(null);
        setError(res.error ?? "Nothing was changed. Try again.");
        return;
      }
      setDone(res.message ?? fallback);
      router.refresh();
    });
  }

  function openAccept(p: SupplierMergeProposal) {
    setDone(null);
    setSheetError(null);
    setName(p.existingAccountName?.trim() || p.suggestedName);
    setAccountNumber(p.accountNumber ?? "");
    setAccepting(p);
  }

  function submitAccept() {
    if (!accepting) return;
    const p = accepting;
    const trimmed = name.trim();
    if (!trimmed) {
      setSheetError("Give the account a name you will recognise, like Main Street Supply.");
      return;
    }
    setSheetError(null);
    setBusy(`accept:${p.id}`);
    const totals = proposalTotals(p);
    start(async () => {
      const res = await actions.acceptMerge({
        proposalId: p.id,
        name: trimmed,
        accountNumber: accountNumber.trim() || null,
        existingAccountId: p.existingAccountId ?? null,
        spellings: p.spellings.map((s) => ({ alias: s.alias, branchLabel: s.branchLabel ?? null })),
      });
      setBusy(null);
      // THE SHEET STAYS OPEN ON FAILURE, so the name he typed is still in front of him instead of
      // being retyped from memory - the same rule the payroll sheet keeps.
      if (!res.ok) {
        setSheetError(res.error ?? "That account was not made. Nothing changed.");
        return;
      }
      setAccepting(null);
      // THE FALLBACK COUNTS WHAT THE PRESS MOVED, not what the rows showed. Accept files by spelling,
      // so the settled papers on those names go on too (`totals.moves`). The server's own sentence
      // wins when there is one; this is what gets said when there is not.
      setDone(
        res.message ?? `${trimmed} is now one account, holding ${totals.moves} ${totals.moves === 1 ? "bill" : "bills"}.`,
      );
      router.refresh();
    });
  }

  return (
    <Card className="mb-6 p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">Supplier Names That Look Like One Account ({proposals.length})</h2>
        <WhyFold>
          <p>
            The receipt reader types the supplier name fresh on every scan, so one supplier ends up spelled several
            ways and its money gets split. These are suggestions: nothing is joined until you say so.
          </p>
        </WhyFold>
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {done && (
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">
          {done}
        </div>
      )}

      <div className="space-y-3">
        {proposals.map((p) => {
          const totals = proposalTotals(p);
          const count = p.spellings.length;
          // THE COUNT IS WHAT THE PRESS WOULD MOVE; THE MONEY IS SAID AS WHAT IT IS, through the one
          // function that reads the sign. Paired as "3 bills holding $147.92" the two read as one
          // claim and they are two — a register purchase among them belongs on the account and owes
          // nothing — and summing spellings that include a return made `unpaid` NEGATIVE, so the old
          // "holding $X" could print a debt of minus money. The all-settled branch that used to sit
          // here is gone with it: every spelling in this pile has an open paper now, so the only nets
          // at or under half a cent are a credit and a zero, and both are said properly below.
          const money = spellingMoneySaid(totals.unpaid > 0.005 ? totals.unpaid : totals.total, formatCurrency);
          const headline =
            count === 1
              ? p.existingAccountName
                ? `${totals.moves} ${totals.moves === 1 ? "bill" : "bills"} scanned as "${p.spellings[0].alias}" belong on ${p.existingAccountName}, with ${money}.`
                : `This spelling is not on an account yet, with ${money}.`
              : `These ${count} spellings look like one account, with ${money} across them.`;
          return (
            <div key={p.id} className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-900">{headline}</p>
              {p.because && <p className="mt-0.5 text-xs text-slate-500">{p.because}</p>}

              {/* EVERY SPELLING, LISTED. He has to see exactly what is being joined - a grouping he
                  cannot audit is a backfill with a button on it. */}
              <ul className="mt-2 divide-y divide-slate-100 rounded-md bg-slate-50">
                {p.spellings.map((s) => (
                  <li key={s.alias} className="flex items-start justify-between gap-3 px-3 py-1.5">
                    <span className="min-w-0">
                      <span className="block text-sm text-slate-800">{s.alias}</span>
                      {s.branchLabel && (
                        <span className="block text-xs text-slate-500">Stays its own branch: {s.branchLabel}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm tabular-nums text-slate-800">{formatCurrency(s.total)}</span>
                      <span className="block text-xs text-slate-400">
                        {s.bills} {s.bills === 1 ? "bill" : "bills"}
                        {s.unpaid > 0.005 ? ` · ${formatCurrency(s.unpaid)} owed` : ""}
                        {/* THE SETTLED PAPERS ON THIS NAME GO TOO. The figures above are the open
                            papers, which is what the pile is; the press is by spelling. */}
                        {(s.settledSiblings ?? 0) > 0 ? ` · +${s.settledSiblings} settled, filed too` : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>

              {/* BOTH BUTTONS ARE A WRITE, so both are described before either is pressed. "Not
                  The Same" is not a shrug: it gives each spelling an account of its own, which is
                  the only way a dismissal can stick in this schema. And the door that does not
                  exist is named out loud rather than left for him to go looking for. */}
              <WhyFold label={count > 1 ? "What Does Each Answer Do?" : "What Does Accepting Do?"} className="mt-1">
              <p>
                {/* THE COUNT IS WHAT THE PRESS MOVES (`moves`), not what the rows list. The rows are the
                    OPEN papers, because a purchase paid at the register has one record and nothing to
                    reconcile — but Accept files by spelling, so it takes the settled ones on those names
                    along, and a sentence quoting the smaller number is the face not saying what the tap
                    will do. The settled share is named, so the two numbers reconcile on screen. */}
                {p.existingAccountId
                  ? `Accepting files these ${totals.moves} ${totals.moves === 1 ? "bill" : "bills"} onto ${p.existingAccountName ?? "the account you already have"}, so they add up into one balance.`
                  : `Accepting makes one account and files these ${totals.moves} ${totals.moves === 1 ? "bill" : "bills"} onto it, so they add up into one balance you can pay in chunks.`}{" "}
                {totals.settled > 0
                  ? `${totals.settled} of ${totals.moves === 1 ? "that" : "those"} ${totals.settled === 1 ? "was" : "were"} paid at the register already, so ${totals.settled === 1 ? "it is" : "they are"} not in the figures above and ${totals.settled === 1 ? "it changes" : "they change"} no balance. `
                  : ""}
                Each bill keeps the spelling and the branch it was scanned with, so your prices still know one
                counter from another. Nothing is renamed, taken off a job, or deleted.
                {count > 1 ? (
                  <>
                    {" "}
                    Not The Same puts {count === 2 ? "each of the two" : `each of the ${count}`} on its own account
                    with its own balance instead, so this stops being asked. There is no button here that joins two
                    accounts back together afterwards, so have a look at the spellings first.
                  </>
                ) : (
                  <> If they are not theirs, leave this alone. Nothing changes until you press something.</>
                )}
              </p>
              </WhyFold>
              {/* THE ONE-TAP WRITE SAYS SO ON SCREEN. Accept gets a sheet; Not The Same writes at
                  once and has no undo here, so the warning cannot live only inside a fold. */}
              {count > 1 && (
                <p className="mt-1 text-xs font-medium text-amber-800">Not The Same Can&apos;t Be Undone Here</p>
              )}

              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button onClick={() => openAccept(p)} disabled={pending}>
                  {p.existingAccountId ? "Accept And File Them There" : "Accept And Make The Account"}
                </Button>
                {/* NOT THE SAME IS FOR A GROUP, and only for a group.
                    On a lone spelling that already belongs to an account, this button would do the
                    exact same thing Accept does - the action files a spelling onto the account that
                    already owns it, whichever button sent it - so it would be a second button
                    wearing a different sentence. Two buttons with one outcome teaches him nothing
                    about what the app thinks, which is worse than one button. */}
                {count > 1 && (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => actions.dismissMerge(p.id),
                        `dismiss:${p.id}`,
                        "Kept apart. Each of those spellings is a supplier of its own now, with its own balance.",
                      )
                    }
                  >
                    Not The Same
                  </Button>
                )}
              </div>
            </div>
          );
        })}

        {proposals.length === 0 && (
          <p className="py-2 text-sm text-slate-400">
            No suggestions right now. Every supplier name off your receipts is already on an account.
          </p>
        )}
      </div>

      {accepting && (
        <Modal
          open
          onClose={() => setAccepting(null)}
          title={accepting.existingAccountId ? "File These On That Account" : "Make This One Account"}
          size="sm"
          dirty={name.trim() !== (accepting.suggestedName ?? "") || accountNumber !== (accepting.accountNumber ?? "")}
          footer={
            <ModalActions
              onCancel={() => setAccepting(null)}
              onSave={submitAccept}
              saveLabel={accepting.existingAccountId ? "File Them There" : "Make The Account"}
              disabled={!name.trim()}
              saving={pending && busy === `accept:${accepting.id}`}
            />
          }
        >
          <div className="space-y-4">
            {sheetError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{sheetError}</div>}

            <div>
              <Label htmlFor="merge-name">What You Call Them</Label>
              <Input
                id="merge-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Main Street Supply"
                autoFocus
              />
              <p className="mt-1 text-xs text-slate-400">
                This is the name on the balance card. The bills keep the spellings they were scanned with.
              </p>
            </div>

            <div>
              <Label htmlFor="merge-account">Account Number (optional)</Label>
              <Input
                id="merge-account"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                placeholder="e.g. AB-12345"
              />
              <p className="mt-1 text-xs text-slate-400">
                The number on their statement. It is how a payment you send matches what they have on file.
              </p>
            </div>

            <div>
              <Label>What Gets Joined</Label>
              <ul className="space-y-1 rounded-lg bg-slate-50 px-3 py-2">
                {accepting.spellings.map((s) => (
                  <li key={s.alias} className="text-xs text-slate-600">
                    {s.alias}
                    {s.branchLabel ? ` (${s.branchLabel})` : ""} · {s.bills} {s.bills === 1 ? "bill" : "bills"} ·{" "}
                    {formatCurrency(s.total)}
                    {(s.settledSiblings ?? 0) > 0 ? ` · +${s.settledSiblings} already settled` : ""}
                  </li>
                ))}
              </ul>
            </div>

            <p className="text-xs leading-relaxed text-slate-500">
              Nothing is renamed on a bill, nothing moves off a job, and nothing is deleted. All this does is put
              these bills on one account so what you owe adds up in one place.
            </p>
          </div>
        </Modal>
      )}
    </Card>
  );
}

// ── "I CANNOT TELL" IS AN ANSWER, AND IT NEEDS SOMEWHERE TO BE SAID ────────────────────────────

/**
 * THE QUESTION THE MATCHER WILL NOT ANSWER (review of cn-v963).
 *
 * `suggestSupplierGroups` has always returned `{ groups, candidates }` and the page rendered the
 * groups and threw the candidates away. On Erik's own book that discarded exactly one question,
 * and it is the only genuine judgement call in this whole feature: "Contractors Electrical
 * Distributors" ($467.87) against his four "Consolidated Electrical ..." spellings. Both reduce to
 * the initials CED, they share two of their three words, and the first word differs. It turns out
 * to be one account used at two separately owned branches:
 *
 *   "its the local distributor near sunnyvale for the job so i used my truckee account number,
 *    thats how they roll"
 *
 * There is no way to get that out of a string, which is the entire reason this is a question and
 * not a proposal. THIS CARD MUST NOT READ AS ONE. A proposal says "these are the same, press
 * Accept". This says what it noticed, shows the money on both sides, and offers two doors of equal
 * weight: join them, or keep them apart. Neither is preselected and neither happens on its own.
 *
 * Both doors only ever move the LOOSE spellings - the ones on no account yet. A side that is
 * already an account of his is named and has its balance shown, and nothing here touches it.
 */
export function SupplierCandidateReview({
  questions,
  actions,
}: {
  questions: SupplierCandidateQuestion[];
  actions: SupplierMergeActions;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The join sheet. A join cannot be walked back on this card, so it says what it will do in money
  // before it does it - and when it would make a NEW account, the name is his to type.
  const [joining, setJoining] = useState<SupplierCandidateQuestion | null>(null);
  const [name, setName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [branchLabel, setBranchLabel] = useState("");
  const [sheetError, setSheetError] = useState<string | null>(null);

  if (questions.length === 0) return null;

  function run(fn: () => Promise<SupplierActionResult>, key: string, fallback: string) {
    setError(null);
    setBusy(key);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (!res.ok) {
        setDone(null);
        setError(res.error ?? "Nothing was changed. Try again.");
        return;
      }
      setDone(res.message ?? fallback);
      router.refresh();
    });
  }

  function openJoin(q: SupplierCandidateQuestion) {
    setDone(null);
    setSheetError(null);
    setName(q.existingAccountName?.trim() || q.suggestedName);
    setAccountNumber("");
    setBranchLabel("");
    setJoining(q);
  }

  function submitJoin() {
    if (!joining) return;
    const q = joining;
    const moving = candidateMoving(q);
    const trimmed = name.trim();
    if (!q.existingAccountId && !trimmed) {
      setSheetError("Give the account a name you will recognise, like Main Street Supply.");
      return;
    }
    setSheetError(null);
    setBusy(`join:${q.id}`);
    const branch = branchLabel.trim() || null;
    start(async () => {
      const res = await actions.acceptMerge({
        proposalId: q.id,
        // Joining an account he already has does NOT rename it - he pressed "file it there", not
        // "rename it" - so the server sends back the account's own name and this only ever hands
        // over a name when it is making one.
        name: q.existingAccountName ?? trimmed,
        accountNumber: q.existingAccountId ? null : accountNumber.trim() || null,
        existingAccountId: q.existingAccountId ?? null,
        // THE BRANCH LABEL IS THE WHOLE POINT OF SAYING YES HERE. The money rolls up to one
        // account; the ticket stays with the counter it came from, so the price book can still
        // tell a Sunnyvale price from a Truckee one instead of quietly averaging two markets.
        spellings: moving.map((s) => ({ alias: s.spelling, branchLabel: branch })),
      });
      setBusy(null);
      // THE SHEET STAYS OPEN ON FAILURE, so what he typed is still in front of him.
      if (!res.ok) {
        setSheetError(res.error ?? "That didn't go through. Nothing changed.");
        return;
      }
      setJoining(null);
      setDone(res.message ?? "Joined. They are one account now.");
      router.refresh();
    });
  }

  return (
    <Card className="mb-6 p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">Same Supplier, Or Two? ({questions.length})</h2>
        <WhyFold>
          <p>These names look enough alike to ask about, and not enough for anything here to decide. Only you know which.</p>
        </WhyFold>
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {done && (
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">
          {done}
        </div>
      )}

      <div className="space-y-3">
        {questions.map((q) => {
          const moving = candidateMoving(q);
          const joined = candidateJoinedOwed(q);
          const movingNames = moving.map((s) => `"${s.spelling}"`).join(" and ");
          // WHAT A PRESS MOVES, not what the rows show. Both doors here file by SPELLING, so the
          // settled papers on those names go with them: the rows are the open papers and this is the
          // scope of the tap, which is what the sentence under the doors has to quote.
          const movingBills = moving.reduce((n, s) => n + s.bills + (s.settledSiblings ?? 0), 0);
          return (
            <div key={q.id} className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-900">
                Is {q.sides[0].label} the same account as {q.sides[1].label}?
              </p>

              {/* BOTH SIDES, WITH THE MONEY ON EACH. He is being asked to put one pile of money
                  into another, so both piles are on the screen while he answers. */}
              <ul className="mt-2 divide-y divide-slate-100 rounded-md bg-slate-50">
                {q.sides.map((s) => (
                  <li key={`${s.accountId ?? "loose"}:${s.spelling}`} className="flex items-start justify-between gap-3 px-3 py-1.5">
                    <span className="min-w-0">
                      <span className="block text-sm text-slate-800">{s.label}</span>
                      <span className="block text-xs text-slate-400">
                        {s.accountId
                          ? s.spelling.trim().toLowerCase() === s.label.trim().toLowerCase()
                            ? "A supplier account you already have"
                            : `A supplier account you already have, scanned as ${s.spelling}`
                          : `${s.bills} ${s.bills === 1 ? "bill" : "bills"}, on no account yet${
                              (s.settledSiblings ?? 0) > 0
                                ? ` · +${s.settledSiblings} settled on this name, filed too`
                                : ""
                            }`}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm tabular-nums text-slate-800">
                        {s.accountId
                          ? s.owed === null
                            ? "Paid At The Register"
                            : formatCurrency(s.owed)
                          : formatCurrency(s.unpaid > 0.005 ? s.unpaid : s.total)}
                      </span>
                      <span className="block text-xs text-slate-400">
                        {s.accountId
                          ? s.owed === null
                            ? "no running balance"
                            : "owed right now"
                          : s.unpaid > 0.005
                            ? "still owed"
                            : "billed, none of it still owed"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>

              {/* THE MATCHER'S OWN SENTENCE, not a rewrite of it. It already says what it noticed
                  and why it will not decide. */}
              {q.because && <p className="mt-2 text-xs leading-relaxed text-slate-500">{q.because}</p>}

              <WhyFold label="What Does Each Answer Do?" className="mt-1">
              <p>
                {q.existingAccountName
                  ? `Joining files ${movingBills === 1 ? "the bill" : `all ${movingBills} bills`} scanned as ${movingNames} onto ${q.existingAccountName}${joined !== null ? `, so you would owe them ${formatCurrency(joined)} in one place` : ""}.`
                  : `Joining makes one account out of both${joined !== null ? `, holding ${formatCurrency(joined)}` : ""}.`}{" "}
                Each bill keeps the spelling and the job it was scanned with, so your prices still know one
                counter from another. Nothing is renamed, taken off a job, or deleted.{" "}
                {`Keeping them separate gives ${movingNames} ${moving.length === 1 ? "an account of its own with its own balance" : "an account each, with their own balances"}, and this stops being asked.`}{" "}
                There is no button here that joins two accounts back together afterwards, so have a look at
                the money first.
              </p>
              </WhyFold>
              {/* Keep Them Separate writes at once with no undo here: said on screen, not only in the fold. */}
              <p className="mt-1 text-xs font-medium text-amber-800">Keeping Them Separate Can&apos;t Be Undone Here</p>

              {/* TWO DOORS OF EQUAL WEIGHT. Neither is the "right" one: the app genuinely does not
                  know, and a primary button on one side would be it pretending otherwise. */}
              <div className="mt-2.5 flex flex-wrap gap-2">
                {/* The label says the OUTCOME, not the account's name: "Join Them Onto
                    Consolidated Electrical Distributors, Inc." is a nowrap button wider than a
                    375px phone. The sentence above it names the account. */}
                <Button variant="outline" onClick={() => openJoin(q)} disabled={pending}>
                  Join Them Onto One Account
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => actions.dismissMerge(q.id),
                      `separate:${q.id}`,
                      "Kept apart. That spelling is a supplier of its own now, with its own balance.",
                    )
                  }
                >
                  Keep Them Separate
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {joining && (
        <Modal
          open
          onClose={() => setJoining(null)}
          title={joining.existingAccountName ? "File It On That Account" : "Make This One Account"}
          size="sm"
          dirty={
            branchLabel.trim() !== "" ||
            accountNumber.trim() !== "" ||
            name.trim() !== (joining.existingAccountName?.trim() || joining.suggestedName)
          }
          footer={
            <ModalActions
              onCancel={() => setJoining(null)}
              onSave={submitJoin}
              saveLabel={joining.existingAccountName ? "File It There" : "Make The Account"}
              disabled={!joining.existingAccountId && !name.trim()}
              saving={pending && busy === `join:${joining.id}`}
            />
          }
        >
          <div className="space-y-4">
            {sheetError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{sheetError}</div>}

            <div>
              <Label>What Gets Filed</Label>
              <ul className="space-y-1 rounded-lg bg-slate-50 px-3 py-2">
                {candidateMoving(joining).map((s) => (
                  <li key={s.spelling} className="text-xs text-slate-600">
                    {s.spelling} · {s.bills} {s.bills === 1 ? "bill" : "bills"} · {formatCurrency(s.total)}
                    {s.unpaid > 0.005 ? ` · ${formatCurrency(s.unpaid)} still owed` : ""}
                    {(s.settledSiblings ?? 0) > 0 ? ` · +${s.settledSiblings} already settled` : ""}
                  </li>
                ))}
              </ul>
              {(() => {
                const joined = candidateJoinedOwed(joining);
                if (joined === null) return null;
                return (
                  <p className="mt-1 text-xs text-slate-500">
                    {joining.existingAccountName
                      ? `${joining.existingAccountName} would owe ${formatCurrency(joined)} after this.`
                      : `The account would start out owing ${formatCurrency(joined)}.`}
                  </p>
                );
              })()}
            </div>

            {joining.existingAccountName ? (
              <p className="text-xs leading-relaxed text-slate-500">
                {joining.existingAccountName} keeps the name and the account number it already has. This only
                puts these bills on it.
              </p>
            ) : (
              <>
                <div>
                  <Label htmlFor="candidate-name">What You Call Them</Label>
                  <Input
                    id="candidate-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Main Street Supply"
                    autoFocus
                  />
                  <p className="mt-1 text-xs text-slate-400">
                    This is the name on the balance card. The bills keep the spellings they were scanned with.
                  </p>
                </div>

                <div>
                  <Label htmlFor="candidate-account">Account Number (optional)</Label>
                  <Input
                    id="candidate-account"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    placeholder="e.g. AB-12345"
                  />
                </div>
              </>
            )}

            {/* THE BRANCH IS THE REASON THIS WAS A QUESTION. Two names that come out as the same
                initials are usually two counters of one chain, and those are often separately
                owned - so the ticket keeps its counter while the money rolls up. */}
            <div>
              <Label htmlFor="candidate-branch">Which Counter Is This? (optional)</Label>
              <Input
                id="candidate-branch"
                value={branchLabel}
                onChange={(e) => setBranchLabel(e.target.value)}
                placeholder="e.g. Downtown"
              />
              <p className="mt-1 text-xs text-slate-400">
                If this is the same company at a different counter, say which one. The money still adds up in
                one balance, and your prices still tell the two counters apart.
              </p>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

// ── A NAME WITH NO RELATIVE ANYWHERE ───────────────────────────────────────────────────────────

export interface SupplierSpellingActions {
  /**
   * Make this spelling a supplier in its own right and file every bill scanned under it onto the
   * new account. `onAccount` is left off for the counter he pays at the till, which is what a name
   * with no relative in his book nearly always is.
   */
  fileAsItsOwnAccount: (input: { supplier: string; onAccount?: boolean }) => Promise<SupplierActionResult>;
}

/**
 * ── THE PAPERS ON NO SUPPLIER ACCOUNT. STILL OPEN ONES ONLY, AND THE QUESTION IS THE CATEGORY ──
 *
 * Erik, minutes after this card shipped, on /reconcile, and it is the acceptance test for every
 * line below:
 *
 *   "I don't understand this give it account thing because it's already categorized and identified
 *    and most things are not going to be on an account honestly, so it doesn't make sense to have
 *    all these layers when it can be super simple. What is the expense categorized as if it's
 *    unclear ask."
 *
 *   "So therefore, anything not on an account will most likely be squared up as paid like
 *    everything else in my bills... I think that might be what I'm seeing on this page showing
 *    unaccounted for bills that doesn't make sense."
 *
 * He was looking at thirty-three rows, thirty-two of them register purchases already paid and
 * already categorised, each wearing a button offering to open a supplier account with a petrol
 * station. Three things changed, and none of them deletes a door:
 *
 *  1. ONLY OPEN PAPERS REACH THIS CARD (`paperDisagrees`). A purchase paid at the till has one
 *     record, so it is not a disagreement. What that leaves out is said in one sentence below,
 *     because nothing leaves a figure in silence — and it is ONE sentence, with no names and no
 *     door, because the cure for a stockpile is not a smaller stockpile.
 *  2. THE ROW LEADS WITH WHAT THE EXPENSE IS, in his own rule's words, and asks ONLY when that is
 *     unclear — which here means a paper carrying no category word at all. On his own book that is
 *     zero questions, which is the right number.
 *  3. GIVING IT ITS OWN ACCOUNT IS STILL HERE, because it is exactly right for a real on-account
 *     supplier arriving under a spelling nothing reached. It is no longer what the card pushes.
 *
 * AND IT SAYS WHAT KIND OF ACCOUNT IT WOULD MAKE, because an account with a balance and an account
 * without one are different things on the card above: a till counter carries no running balance,
 * and giving one a balance would put a figure on his screen that he does not owe anybody.
 */
export function SupplierUnfiledSpellings({
  spellings,
  canSetOnAccount = false,
  figure = null,
  unnamed = null,
  settledAtTheRegister = 0,
  actions,
}: {
  spellings: SupplierSpelling[];
  /**
   * Whether the card above can actually turn a running balance on. COPY MUST NOT PROMISE A BUTTON
   * THAT DOES NOT EXIST: that door is an optional action on the suppliers card, so the sentence
   * about it only gets written when the door is there to be pointed at.
   */
  canSetOnAccount?: boolean;
  /**
   * THE ONE FIGURE FOR THIS PILE, exactly as `whatISupplierOwed` counted it — the same object
   * /bills' own "File It" door quotes. The heading says it rather than adding the rows up, which is
   * how that door came to read "$147.92 On 1 Bill" above a list of thirty-one rows. Null when no
   * figure was read, and then the heading counts its own rows instead of inventing money.
   */
  figure?: { papers: number; total: number } | null;
  /**
   * PAPERS WITH NO SUPPLIER NAME ON THEM AT ALL. Not a spelling — there is nothing to type on a
   * button — but they ARE in the door's figure, so they get a row here instead of vanishing from
   * both sides and leaving that door pointing at a section nothing drew.
   */
  unnamed?: { papers: number; total: number } | null;
  /** How many unmatched papers were already settled, so are not rows. Zero says nothing. */
  settledAtTheRegister?: number;
  actions: SupplierSpellingActions;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const namelessPapers = unnamed?.papers ?? 0;
  const rows = spellings.length + (namelessPapers > 0 ? 1 : 0);
  const settledSaid = settledAtTheRegisterSentence(settledAtTheRegister);
  // NO ROWS, NO CARD — and the caller draws the one-line card that carries this card's sentence
  // instead, because the pile's anchor must exist either way and nothing may leave a figure in
  // silence. Two cards for one pile would be the worse answer.
  if (rows === 0) return null;

  // THE HEADING'S FIGURE IS THE READ'S, NEVER THESE ROWS ADDED UP. The fall-back is what the rows
  // carry, for a caller handed no figure, and the heading then counts rows rather than claiming a
  // paper count it did not read.
  const papers = figure?.papers ?? null;
  const owedHere = figure ? r2(figure.total) : r2(spellings.reduce((s, g) => s + (Number(g.unpaid) || 0), 0) + (unnamed?.total ?? 0));
  // THE ONLY QUESTION THIS CARD ASKS NOW: a paper with no category word on it at all. Erik's rule,
  // verbatim — "if it's unclear ask" — so a row whose papers are all categorised asks nothing.
  const toAsk = spellings.filter((g) => (g.uncategorised ?? 0) > 0).length;
  // ── AND HOW MANY OF THE PILE ARE NOT IN THIS LIST, BECAUSE A SUGGESTION ABOVE HOLDS THEM ──────
  // The three name sections are slices of ONE pile, and this list is what no suggestion speaks for
  // (a spelling with two doors doing one thing is its own trap). So the heading's count can be
  // larger than these rows add up to, and nothing may leave a figure in silence.
  const rowPapers = spellings.reduce((n, g) => n + (Number(g.bills) || 0), 0) + namelessPapers;
  const askedAbove = papers == null ? 0 : Math.max(0, papers - rowPapers);

  function file(spelling: SupplierSpelling) {
    setError(null);
    setDone(null);
    setBusy(`file:${spelling.alias}`);
    start(async () => {
      const res = await actions.fileAsItsOwnAccount({ supplier: spelling.alias });
      setBusy(null);
      if (!res.ok) {
        setError(res.error ?? "Nothing was added. Try again.");
        return;
      }
      setDone(res.message ?? `${spelling.alias} is a supplier of its own now.`);
      router.refresh();
    });
  }

  return (
    <Card className="mb-6 p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">
          {/* THE COUNT IS THE PILE'S, NOT THE LIST'S LENGTH: the figure and the count come out of the
              one read together, so this heading and /bills' own File It door quote one pile. */}
          Papers Not On A Supplier Account Yet ({papers ?? rows})
          {owedHere > 0.005 ? (
            <span className="font-normal text-slate-500"> · {formatCurrency(owedHere)} Still Open</span>
          ) : null}
        </h2>
        {/* ── WHAT IS NOT IN THIS LIST, SAID OUT LOUD ────────────────────────────────────────────
            Nothing leaves a figure in silence. One sentence, a count, no names and no door: these
            papers were paid at the till, so each has ONE record and there is no second record for it
            to disagree with. Listing them is what made this page a stockpile. */}
        {/* ONE SENTENCE, FROM ONE PLACE. It was typed here as JSX, and this card returns null the
            moment it has no rows — which is the shape the measured book is in, so on that book the
            settled papers were accounted for nowhere at all. `settledAtTheRegisterSentence` is now
            said by this card, by the one-line card that stands in for it, and by the all-clear. */}
        {settledSaid && <p className="mt-1 text-sm text-slate-500">{settledSaid}</p>}
        {/* THE COUNT ABOVE IS THE WHOLE PILE'S; THESE ROWS ARE WHAT NOTHING ELSE SPEAKS FOR. Said out
            loud, so the figure in the heading and the rows under it never read as a contradiction. */}
        {askedAbove > 0 && (
          <p className="mt-1 text-sm text-slate-500">
            {askedAbove} of {askedAbove === 1 ? "them is" : "them are"} in a question above, under the name on the paper, and{" "}
            {askedAbove === 1 ? "is" : "are"} answered there rather than twice.
          </p>
        )}
        <WhyFold>
          <p>
            {/* THE EXPENSE CATEGORY IS THE USEFUL QUESTION ABOUT A ONE-OFF PURCHASE, in his words:
                "What is the expense categorized as if it's unclear ask." Most of these never belong
                on a supplier account at all, so that door is said last rather than first. */}
            Each of these is still open and sitting on no supplier account. What matters about one is what the expense is
            filed as, which each row says — and nothing is asked where that is already answered.
          </p>
          <p>
            If one of them really is a supplier you buy from on account, Give It Its Own Account and every bill scanned
            under that name goes onto it. It goes on as a counter you pay at the till, with no running balance
            {canSetOnAccount ? ", and its Suppliers line offers to turn a running balance on." : "; you can mark its bills Paid in All Bills."}
          </p>
        </WhyFold>
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {done && (
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">
          {done}
        </div>
      )}

      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {spellings.map((g) => (
          <li key={g.alias} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-slate-800">{g.alias}</span>
              {/* WHAT THE EXPENSE IS, FIRST. A row used to read "all of it paid at the register
                  already" beside a button offering to open a supplier account with it. */}
              <span className="block text-xs text-slate-500">{spellingSaid(g)}</span>
            </span>
            {/* AND ONLY WHERE IT IS UNCLEAR, A QUESTION — answered on the paper itself, which owns
                its category. Reconcile reads; the paper is answered where the paper is. */}
            {/* AND THE DOOR CARRIES THE SPELLING. It used to drop him at /bills#bills-search, whose
                query is React state that reads no URL — a blank box, and the first thing he had to do
                was retype the name the row had just shown him. /bills seeds its box from `?q=`. */}
            {(g.uncategorised ?? 0) > 0 ? (
              <a
                href={`/bills?q=${encodeURIComponent(g.alias)}#bills-search`}
                className="flex min-h-11 shrink-0 items-center text-sm font-medium text-brand hover:underline"
              >
                Say What The Expense Is
              </a>
            ) : null}
            {/* STILL POSSIBLE, NO LONGER PUSHED: the quiet door, after the row has said its piece. */}
            <Button variant="ghost" disabled={pending} onClick={() => file(g)}>
              {pending && busy === `file:${g.alias}` ? "Adding..." : "Give It Its Own Account"}
            </Button>
          </li>
        ))}
        {/* ── THE PAPERS WITH NO NAME ON THEM GET A ROW ───────────────────────────────────────────
            They are in the door's figure and used to be in no section at all, so /bills' File It
            door landed on a page with nothing about them on it. There is no spelling to file, so the
            door is the one place a paper is answered: find it among your papers. */}
        {namelessPapers > 0 && (
          <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-slate-800">No Supplier Name On The Paper</span>
              <span className="block text-xs text-slate-500">
                {namelessPapers} {namelessPapers === 1 ? "paper" : "papers"} · {spellingMoneySaid(unnamed?.total ?? 0, formatCurrency)} ·
                nothing typed in Where, so there is no name to search for
              </span>
            </span>
            {/* ITS DOOR IS NOT A SEARCH BOX. There is by definition nothing to type, and this was the
                row's only door: a paper with no name sent to a box that can only be searched by name.
                All Bills is the list the paper is actually in, and it is where its Where gets typed. */}
            <a
              href="/bills#all-bills"
              className="flex min-h-11 shrink-0 items-center text-sm font-medium text-brand hover:underline"
            >
              Find It In All Bills
            </a>
          </li>
        )}
      </ul>
      {toAsk > 0 && (
        <p className="mt-2 text-sm text-slate-500">
          {toAsk} of {toAsk === 1 ? "these has" : "these have"} a paper with no expense category on it. That is the one thing worth
          answering here.
        </p>
      )}
    </Card>
  );
}

/**
 * WHAT ONE ROW SAYS ABOUT ITSELF: the expense category first, then the money, then what the tap
 * would move. His rule, verbatim — "What is the expense categorized as if it's unclear ask" — so the
 * words lead with the answer where there is one and name the gap where there is not.
 *
 * THREE THINGS IT GOT WRONG AND NOW DOES NOT:
 *
 *  · A CREDIT IS NOT A DEBT. A return goes in as a negative on-account bill, and this printed it
 *    through "still open": "-$51.58 still open" on a row, under a lead on the same page that said
 *    correctly "a credit of $51.58 ... is money back". `spellingMoneySaid` reads the sign.
 *  · A JOB BILL IS NOT UNCATEGORISED. Its expense is the job, and the bill editor cannot give it a
 *    bucket at all, so saying "no expense category on it yet" asked a question nothing could answer.
 *  · THE FACE SAYS WHAT THE TAP WILL DO. `fileSpelling` matches the SPELLING with no status filter,
 *    so Give It Its Own Account moves the settled papers on that name as well. The row counted only
 *    the open ones, so a press on "1 paper · $147.92" moved three bills and $709.32 and said so only
 *    in the toast afterwards — a count that had never been on screen.
 */
function spellingSaid(g: SupplierSpelling): string {
  const bills = `${g.bills} ${g.bills === 1 ? "paper" : "papers"}`;
  const money = spellingMoneySaid(g.unpaid > 0.005 ? g.unpaid : g.total, formatCurrency);
  const categories = g.categories ?? [];
  const onAJob = g.onAJob ?? 0;
  const missing = g.uncategorised ?? 0;
  const settled = g.settledSiblings ?? 0;
  // WHAT IT IS FILED AS: the buckets by name, and a job-costed paper as what it is.
  const filed: string[] = [];
  if (categories.length) filed.push(`Filed as ${categories.join(", ")}`);
  if (onAJob > 0) filed.push(categories.length ? `${onAJob} on a job` : `On ${onAJob === 1 ? "a job" : "jobs"}`);
  const gap = missing > 0 ? ` · ${missing} with no expense category on ${missing === 1 ? "it" : "them"}` : "";
  const alsoMoves =
    settled > 0
      ? ` · filing it takes ${settled} settled ${settled === 1 ? "paper" : "papers"} on this name with it`
      : "";
  if (!filed.length) return `${bills} · ${money} · no expense category on it yet${alsoMoves}`;
  return `${filed.join(" · ")} · ${bills} · ${money}${gap}${alsoMoves}`;
}
