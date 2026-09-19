"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import {
  candidateJoinedOwed,
  candidateMoving,
  proposalTotals,
  r2,
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
      setSheetError("Give the account a name you will recognise, like CED Truckee.");
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
      setDone(
        res.message ?? `${trimmed} is now one account, holding ${totals.bills} ${totals.bills === 1 ? "bill" : "bills"}.`,
      );
      router.refresh();
    });
  }

  return (
    <Card className="mb-6 p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">Supplier Names That Look Like One Account</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          The receipt reader types the supplier name fresh on every scan, so one supplier ends up spelled
          several ways and its money gets split between them. These are suggestions. Nothing is joined until
          you say so.
        </p>
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
          const headline =
            count === 1
              ? p.existingAccountName
                ? `${totals.bills} ${totals.bills === 1 ? "bill" : "bills"} scanned as "${p.spellings[0].alias}" belong on ${p.existingAccountName}, holding ${formatCurrency(totals.unpaid)}.`
                : `This spelling is not on an account yet, and it is holding ${formatCurrency(totals.unpaid)}.`
              : totals.unpaid > 0.005
                ? `These ${count} spellings look like one account, holding ${formatCurrency(totals.unpaid)} between them.`
                : `These ${count} spellings look like one account. ${formatCurrency(totals.total)} has been billed between them and none of it is still owed.`;
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
                      </span>
                    </span>
                  </li>
                ))}
              </ul>

              {/* BOTH BUTTONS ARE A WRITE, so both are described before either is pressed. "Not
                  The Same" is not a shrug: it gives each spelling an account of its own, which is
                  the only way a dismissal can stick in this schema. And the door that does not
                  exist is named out loud rather than left for him to go looking for. */}
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                {p.existingAccountId
                  ? `Accepting files these ${totals.bills} ${totals.bills === 1 ? "bill" : "bills"} onto ${p.existingAccountName ?? "the account you already have"}, so they add up into one balance.`
                  : `Accepting makes one account and files these ${totals.bills} ${totals.bills === 1 ? "bill" : "bills"} onto it, so they add up into one balance you can pay in chunks.`}{" "}
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
                placeholder="e.g. CED Truckee"
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
                placeholder="e.g. TR-34426"
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
      setSheetError("Give the account a name you will recognise, like CED Truckee.");
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
        <h2 className="text-base font-semibold text-slate-900">Same Supplier, Or Two?</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          These names look enough alike to be worth asking about, and not enough alike for anything here
          to decide. Only you know which. Nothing happens until you answer.
        </p>
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
          const movingBills = moving.reduce((n, s) => n + s.bills, 0);
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
                          : `${s.bills} ${s.bills === 1 ? "bill" : "bills"}, on no account yet`}
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

              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                {q.existingAccountName
                  ? `Joining files ${movingBills === 1 ? "the bill" : `all ${movingBills} bills`} scanned as ${movingNames} onto ${q.existingAccountName}${joined !== null ? `, so you would owe them ${formatCurrency(joined)} in one place` : ""}.`
                  : `Joining makes one account out of both${joined !== null ? `, holding ${formatCurrency(joined)}` : ""}.`}{" "}
                Each bill keeps the spelling and the job it was scanned with, so your prices still know one
                counter from another. Nothing is renamed, taken off a job, or deleted.{" "}
                {`Keeping them separate gives ${movingNames} ${moving.length === 1 ? "an account of its own with its own balance" : "an account each, with their own balances"}, and this stops being asked.`}{" "}
                There is no button here that joins two accounts back together afterwards, so have a look at
                the money first.
              </p>

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
                    placeholder="e.g. CED Truckee"
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
                    placeholder="e.g. TR-34426"
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
                placeholder="e.g. Sunnyvale"
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
 * THE SPELLINGS THAT LOOKED LIKE NOTHING, AND SO WERE OFFERED NOTHING (review of cn-v963).
 *
 * The merge review only ever showed a spelling that resembled something else. Five of his sixteen
 * resembled nothing - Home Depot, Goodwin's, Tahoe City Lumber, the counters he pays at the till -
 * so the page dropped them, with a long comment arguing that Accept and Not-The-Same would do the
 * same thing on a group of one. That argument is right about a PROPOSAL and wrong as a conclusion:
 * the money was still there, counted in the amber line at the top of the card, named nowhere, with
 * nothing to press.
 *
 * So there is no suggestion on this card at all. There is a list of names and one door each.
 *
 * IT SAYS WHAT KIND OF ACCOUNT IT IS MAKING, because an account with a balance and an account
 * without one are different things on the card above: a till counter carries no running balance,
 * and giving one a balance would put a figure on his screen that he does not owe anybody.
 */
export function SupplierUnfiledSpellings({
  spellings,
  canSetOnAccount = false,
  actions,
}: {
  spellings: SupplierSpelling[];
  /**
   * Whether the card above can actually turn a running balance on. COPY MUST NOT PROMISE A BUTTON
   * THAT DOES NOT EXIST: that door is an optional action on the suppliers card, so the sentence
   * about it only gets written when the door is there to be pointed at.
   */
  canSetOnAccount?: boolean;
  actions: SupplierSpellingActions;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (spellings.length === 0) return null;

  const owedHere = r2(spellings.reduce((s, g) => s + (Number(g.unpaid) || 0), 0));

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
        <h2 className="text-base font-semibold text-slate-900">Supplier Names Not On An Account Yet</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          These came off your receipts and nothing else in your book looks like them, so there is nothing to
          suggest. Give one an account of its own and every bill scanned under that name goes onto it, so its
          money sits in a balance instead of outside all of them.
          {owedHere > 0.005 ? ` ${formatCurrency(owedHere)} of what you owe is sitting out here.` : ""}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          Each one goes on as a counter you pay at the till, which is what most of these are, so it carries no
          running balance. If any of its bills are still marked unpaid, its card up top says so
          {canSetOnAccount
            ? " and offers to turn a running balance on."
            : ", and you can mark those receipts paid in the bills list further down."}
        </p>
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
              <span className="block text-xs text-slate-400">
                {g.bills} {g.bills === 1 ? "bill" : "bills"} · {formatCurrency(g.total)}
                {g.unpaid > 0.005
                  ? ` · ${formatCurrency(g.unpaid)} still marked unpaid`
                  : " · all of it paid at the register already"}
              </span>
            </span>
            <Button variant="outline" disabled={pending} onClick={() => file(g)}>
              {pending && busy === `file:${g.alias}` ? "Adding..." : "Give It Its Own Account"}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
