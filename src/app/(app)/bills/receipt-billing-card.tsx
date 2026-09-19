"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Modal, ModalActions } from "@/components/ui/modal";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented";
import { useToast } from "@/components/toast";
import { billedPortion } from "@/lib/bill-itemisation";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  containerHint,
  perUnitCost,
  perUnitLabel,
  round2,
  splitReceiptBilling,
  usedCost,
  usedCountFromCost,
} from "./receipt-billing";
import { setReceiptLineBillable, setReceiptLineUsage } from "./receipt-billing-actions";

export interface ReceiptBillingLine {
  id: string;
  description: string;
  quantity: number;
  amount: number;
  /** What the line cost when its extension is $0.00 - a back-ordered part carries a real price
   *  beside an empty total, and the invoice reads it even when this column is blank. Carried so
   *  this card and the invoice cannot disagree about one line (the projection law, 2026-09-19). */
  unitPrice: number | null;
  category: string | null;
  billable: boolean;
  /**
   * THE THIRD STATE (migration 0272). Dollars of this line THIS job used, when the line is a
   * container bought whole: a 500 count box of wire nuts at $108.36, of which sixty went into one
   * panel. Null - and every row written before 0272 - means the whole line, unchanged.
   */
  billedAmount: number | null;
  /** The container was counted onto the shelf. A label, never money - the money is billedAmount. */
  isStock: boolean;
}

export interface ReceiptForBilling {
  id: string;
  supplier: string;
  bill_date: string | null;
  job_id: string | null;
  job_name: string | null;
  amount: number;
  /**
   * The invoice that already holds this receipt, when one does, WITH its status — because
   * "already billed" is two different situations wearing one word (review of this wave).
   *
   * On an invoice the customer is holding, a claimed bill is settled: the importer skips it
   * forever after, so flipping a line here could not move a dollar, and the way to take something
   * off is a credit against that invoice.
   *
   * On a DRAFT it is not settled at all — that invoice's own lines are still editable, and the
   * switch still means something for the next import. Locking it there would rebuild the same
   * false wall Erik hit on INV-069, one page over, in the code written to remove it.
   */
  billedOn: { label: string; status: string } | null;
  lines: ReceiptBillingLine[];
}

/** What the card is allowed to believe before the server has agreed. */
type LineOverride = Partial<Pick<ReceiptBillingLine, "billable" | "billedAmount" | "isStock">>;

/**
 * THE SWITCH ERIK NEVER HAD (Erik, 2026-09-18; migration 0268).
 *
 * INV-069 billed a homeowner for a bottle of Smartwater, a BodyArmor and a ten cent bottle
 * deposit, because the receipt reader transcribes a Home Depot run line by line and the importer
 * bills every line it finds. He did the only thing left to him and stopped scanning receipts:
 *
 *   "i have another receipt that i didnt scan specifically because it was mostly snacks and a $3
 *    part"
 *
 * — which cost him the $3 job cost and the snack deduction both. This card is where he takes a
 * line off the customer's bill on the RECEIPT, before it is ever an invoice line and before
 * anybody has been handed anything. Two figures ride at the top of every receipt, because the
 * only way a switch is trustworthy is if its effect is visible the instant it moves: what the
 * receipt cost him, and what the customer is billed for it.
 *
 * ── AND THE LINE THE SWITCH HAD NO ANSWER FOR (Erik, 2026-09-19; migration 0272) ─────────────
 *
 *   "the Twister box i was confused about and i remebered that is a whole ccontainer of wire nuts
 *    that we uses some of but is certainly stock and shouldnt be charged to the customer in full
 *    however necessary for the job"
 *
 * IDEAL 30641, 500 Twister wire nuts, $108.36 - 21.7 cents each - and his customer was billed
 * $135.00 for the box. Billed meant the whole box; not billed meant he ate a cost the job really
 * did incur. So there is a third state now, and the card asks for it the way he says it out loud:
 * how many are in the box, and how many did you use. It never answers either question itself.
 */
export function ReceiptBillingCard({ receipts }: { receipts: ReceiptForBilling[] }) {
  const router = useRouter();
  const toast = useToast();
  const [, start] = useTransition();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<{ receipt: ReceiptForBilling; line: ReceiptBillingLine } | null>(null);

  // Optimistic flips, so the totals move under his thumb instead of after a round trip. The
  // signature is every line's SERVER value: when the refresh lands and the server agrees, the
  // overrides are dropped in the same render, so the card never flickers back and never shows a
  // number the database would disagree with. It carries the split and the shelf flag too — a
  // signature that watched only the boolean would hold a stale dollar figure on screen after the
  // server had already moved it, which is the screen-disagrees-with-the-database bug this whole
  // card exists to end.
  const signature = useMemo(
    () =>
      receipts
        .map((r) => r.lines.map((l) => `${l.id}:${l.billable ? 1 : 0}:${l.billedAmount ?? ""}:${l.isStock ? 1 : 0}`).join(","))
        .join("|"),
    [receipts],
  );
  const [overrides, setOverrides] = useState<Record<string, LineOverride>>({});
  useEffect(() => {
    setOverrides((o) => (Object.keys(o).length ? {} : o));
  }, [signature]);

  function flip(lineId: string, next: boolean) {
    setOverrides((o) => ({ ...o, [lineId]: { ...o[lineId], billable: next } }));
    start(async () => {
      const res = await setReceiptLineBillable(lineId, next);
      if (!res?.ok) {
        setOverrides((o) => {
          const n = { ...o };
          delete n[lineId];
          return n;
        });
        toast(res?.error ?? "Couldn't change that line. Try again.", "error");
        return;
      }
      toast(next ? "Back on the customer's bill" : "Off the customer's bill", "success", {
        label: "Undo",
        onClick: () => flip(lineId, !next),
      });
      router.refresh();
    });
  }

  /**
   * Save what this job used, or put the whole line back on the bill (`billedAmount` null).
   *
   * The shelf can fail while the money succeeds - stockFromReceiptLine refuses a line it has
   * already counted, so a second save moves the dollars and adds nothing to the van. That refusal
   * comes back as a `note` and it is SAID, not swallowed: the money moved, and he is told exactly
   * what did not.
   */
  function saveUsage(
    line: ReceiptBillingLine,
    next: { billedAmount: number | null; containerCount: number | null; usedQuantity: number | null },
  ) {
    setOverrides((o) => ({
      ...o,
      [line.id]: { ...o[line.id], billedAmount: next.billedAmount, isStock: next.billedAmount != null || line.isStock },
    }));
    setEditing(null);
    start(async () => {
      const res = await setReceiptLineUsage({ lineId: line.id, ...next });
      if (!res?.ok) {
        setOverrides((o) => {
          const n = { ...o };
          delete n[line.id];
          return n;
        });
        toast(res?.error ?? "Couldn't change that line. Try again.", "error");
        return;
      }
      if (res.note) toast(res.note, "info");
      else if (next.billedAmount == null) toast("Back to billing the whole line", "success");
      else toast(`This job is billed ${formatCurrency(next.billedAmount)} of that line`, "success");
      router.refresh();
    });
  }

  return (
    <Card className="mb-6 p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">What Your Customers Get Billed</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Every line off a scanned receipt, and whether it lands on the customer&apos;s invoice. Snacks and
          drinks start out on you. Everything else, tools included, starts out billed. A box or a spool you
          bought whole can bill just what this job used, and the rest goes in your stock.
        </p>
      </div>

      {receipts.length === 0 ? (
        <p className="py-3 text-sm text-slate-400">
          Nothing to decide yet. Scan a receipt onto a job in Organize My and its lines show up here.
        </p>
      ) : (
        /* The shoebox has no ceiling, and neither does this list — it scrolls rather than
           truncating, because a receipt Erik cannot reach is a receipt he stops trusting. */
        <ul className="max-h-[30rem] divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {receipts.map((r) => {
            const lines = r.lines.map((l) => ({ ...l, ...overrides[l.id] }));
            const split = splitReceiptBilling(r.amount, lines);
            const isOpen = !!open[r.id];
            // A receipt on a SENT invoice is settled: the importer skips it forever after, so
            // neither the switch nor the split could move a dollar. A control that can only refuse
            // does not render at all — the paragraph below says what to do instead.
            const locked = !!r.billedOn && r.billedOn.status !== "draft";
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}
                  aria-expanded={isOpen}
                  className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50"
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">{r.supplier}</span>
                    <span className="block truncate text-xs text-slate-400">
                      {r.bill_date ? `${formatDate(r.bill_date)} · ` : ""}
                      {r.job_name ?? "No job"}
                    </span>
                    {/* THE ONE FACT THAT CANNOT BE TRUNCATED. This is the whole reason the card
                        exists: Erik must be able to see, without opening anything and without a
                        phone cutting it off mid-word, that something on this receipt is not going
                        on the customer's bill. It gets its own line for that.

                        "Not billed" and "billed in part" are two different facts and they get two
                        different sentences — a box he split is not a snack he switched off, and
                        one count covering both would tell him neither. */}
                    {split.notBilledCount > 0 && (
                      <span className="block text-xs font-medium text-amber-700">
                        {split.notBilledCount} {split.notBilledCount === 1 ? "line" : "lines"} not billed to the
                        customer
                      </span>
                    )}
                    {split.partBilledCount > 0 && (
                      <span className="block text-xs font-medium text-sky-700">
                        {split.partBilledCount} {split.partBilledCount === 1 ? "line bills" : "lines bill"} only what
                        this job used
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-medium tabular-nums text-slate-900">
                      {formatCurrency(split.billed)}
                    </span>
                    <span className="block text-xs tabular-nums text-slate-400">
                      of {formatCurrency(split.cost)} you paid
                    </span>
                  </span>
                </button>

                {isOpen && (
                  <div className="px-3 pb-3">
                    {r.billedOn && r.billedOn.status === "draft" ? (
                      /* A DRAFT CLAIMANT IS NOT A WALL. Its lines are still editable, so the
                         honest sentence points at the trash can on that invoice rather than at a
                         credit the situation does not call for. The switch stays live: it governs
                         what the NEXT import takes, which is a real effect and his to set. */
                      <p className="mb-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
                        This receipt is on {r.billedOn.label}, which is still a draft. Switching a line here
                        changes what future invoices take, not the lines already on that draft. To take
                        something off it now, remove the line on the invoice itself.
                      </p>
                    ) : r.billedOn ? (
                      /* NO DEAD ENDS. The importer skips a bill a live invoice already claims, so a
                         switch here could not move a dollar. Say what happened and what he CAN do
                         instead — the same substitution the invoice page makes on a sent bill. And
                         name a door that EXISTS: this sentence used to offer "a credit or an
                         adjustment", and there is no adjustment in this app, which is the exact
                         phantom the same wave deleted from the invoice page. */
                      <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        This receipt is already on {r.billedOn.label}, which has gone to the customer, so its
                        lines are locked. To take something off that bill, use Credit / Refund in the Actions
                        menu on the invoice.
                      </p>
                    ) : (
                      <p className="mb-2 text-xs text-slate-400">
                        {formatCurrency(split.notBilled)} of this receipt stays on you. The rest goes onto the
                        customer&apos;s next invoice, with your markup on top.
                      </p>
                    )}

                    <ul className="ml-1 space-y-0.5 border-l-2 border-slate-100 pl-3">
                      {lines.map((l) => {
                        const part = billedPortion(l.amount, l.billedAmount);
                        const hint = containerHint(l.description, l.quantity);
                        // The nudge is only ever a nudge, and it stands down the moment there is a
                        // decision on the row: a suggestion that keeps arguing after he has
                        // answered it is noise, and noise is what gets a real warning ignored.
                        const showHint = !locked && l.billable && part == null && !l.isStock && hint.looksLikeContainer;
                        const hintUnit = hint.count ? perUnitLabel(perUnitCost(l.amount, hint.count)) : "";
                        return (
                          <li key={l.id} className="py-0.5">
                            <div className="flex items-center gap-2">
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm text-slate-700">
                                  {l.quantity && l.quantity !== 1 ? `${l.quantity}× ` : ""}
                                  {l.description}
                                </span>
                                <span className="block truncate text-xs text-slate-400">
                                  {formatCurrency(l.amount)}
                                  {l.category ? ` · ${l.category}` : ""} ·{" "}
                                  {!l.billable ? (
                                    <span className="font-medium text-amber-700">Not billed to the customer</span>
                                  ) : part == null ? (
                                    <span className="text-slate-400">Billed to the customer</span>
                                  ) : part === 0 ? (
                                    <span className="font-medium text-sky-700">In your stock, none billed here</span>
                                  ) : (
                                    <span className="font-medium text-sky-700">
                                      {formatCurrency(part)} of it billed to this job
                                    </span>
                                  )}
                                </span>
                              </span>
                              {locked ? (
                                <span className="shrink-0 text-xs text-slate-400">On {r.billedOn?.label}</span>
                              ) : (
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={l.billable}
                                  aria-label={`Bill ${l.description} to the customer`}
                                  onClick={() => flip(l.id, !l.billable)}
                                  className="flex h-11 shrink-0 items-center justify-center rounded-lg px-2 hover:bg-slate-100"
                                >
                                  <span
                                    className={`relative block h-6 w-11 rounded-full transition-colors ${
                                      l.billable ? "bg-brand" : "bg-slate-300"
                                    }`}
                                  >
                                    <span
                                      className={`absolute top-0.5 block h-5 w-5 rounded-full bg-white shadow transition-all ${
                                        l.billable ? "left-[22px]" : "left-0.5"
                                      }`}
                                    />
                                  </span>
                                </button>
                              )}
                            </div>

                            {/* THE THIRD STATE IS REACHABLE FROM EVERY LINE, not only the flagged
                                ones. The nudge below catches a box that says "500" on it; the jar
                                of anti-oxidant that started this says "8 oz" and nothing about a
                                container, and it is exactly as splittable. A suggestion that was
                                also the only door would quietly decide which lines he is allowed
                                to split. */}
                            {!locked && l.billable && (
                              <div className="flex flex-wrap items-center gap-x-2">
                                <button
                                  type="button"
                                  onClick={() => setEditing({ receipt: r, line: l })}
                                  className="-ml-1 flex min-h-11 items-center rounded-lg px-1 text-xs font-medium text-brand hover:underline"
                                >
                                  {part == null ? "Bill Only What This Job Used" : "Change What This Job Used"}
                                </button>
                                {showHint && (
                                  <span className="text-xs text-slate-400">
                                    {hint.why}
                                    {hintUnit ? ` That is ${hintUnit}.` : ""}
                                  </span>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>

                    {r.job_id && (
                      <div className="mt-2">
                        <Link href={`/jobs/${r.job_id}`} className="text-xs font-medium text-brand hover:underline">
                          Open The Job
                        </Link>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <UsedOnThisJob
          line={editing.line}
          jobName={editing.receipt.job_name}
          onClose={() => setEditing(null)}
          onSave={(next) => saveUsage(editing.line, next)}
        />
      )}
    </Card>
  );
}

/**
 * HOW MANY ARE IN THE BOX, AND HOW MANY DID YOU USE.
 *
 * Erik did this arithmetic in his head in one sentence - "500 for $108.36 is 21.7 cents each" -
 * and then had nowhere to put the answer. So the form asks his two questions in his order and
 * shows the per-unit price the moment the first one is answered, because that division is the
 * thing that makes a box obviously a box.
 *
 * BOTH DIRECTIONS, BECAUSE HE THINKS IN BOTH. Sixty nuts is a count; a dab out of an eight ounce
 * jar is a dollar figure. Either way what gets stored is DOLLARS, once, rounded once, shown to him
 * before he saves it. Nothing here is prefilled: the count suggestion is a button he presses, not
 * a number that is already in the field, because a figure he taps past is a figure the app chose
 * and this one divides his customer's bill.
 */
function UsedOnThisJob({
  line,
  jobName,
  onClose,
  onSave,
}: {
  line: ReceiptBillingLine;
  jobName: string | null;
  onClose: () => void;
  onSave: (next: { billedAmount: number | null; containerCount: number | null; usedQuantity: number | null }) => void;
}) {
  const hint = containerHint(line.description, line.quantity);
  const [count, setCount] = useState(0);
  const [mode, setMode] = useState<"count" | "dollars">("count");
  const [used, setUsed] = useState(0);
  const [dollars, setDollars] = useState(line.billedAmount ?? 0);

  const cost = round2(line.amount);
  const unit = perUnitCost(cost, count);
  const unitWords = perUnitLabel(unit);
  const amount = mode === "count" ? usedCost(used, unit) : round2(dollars);
  const roughCount = mode === "dollars" ? usedCountFromCost(amount, unit) : null;
  const overCost = amount > cost;
  // By count, the container count is what the money is divided by, so it is required. By dollars
  // it only powers the per-unit line, and a figure he types straight in needs no divisor at all.
  const canSave = !overCost && (mode === "count" ? count > 0 : amount >= 0);

  return (
    <Modal
      open
      onClose={onClose}
      title="What This Job Used"
      size="md"
      // Dirty means HE typed something, not that the field has a value in it: the dollars box
      // opens holding the split already stored, and treating that as unsaved work would make a
      // backdrop tap ask him to confirm discarding a number he never touched.
      dirty={count > 0 || used > 0 || dollars !== (line.billedAmount ?? 0)}
      footer={
        <ModalActions
          onCancel={onClose}
          onSave={() =>
            onSave({
              billedAmount: amount,
              containerCount: count > 0 ? count : null,
              usedQuantity: mode === "count" && used > 0 ? used : null,
            })
          }
          saveLabel="Save"
          disabled={!canSave}
          extra={
            line.billedAmount != null ? (
              /* THE WAY BACK. Hiding the third state without offering the road out of it is the
                 same dead end as a button that refuses: he must always be able to put the whole
                 line back on the customer's bill, in one press, from the place he split it. */
              <button
                type="button"
                onClick={() => onSave({ billedAmount: null, containerCount: null, usedQuantity: null })}
                className="flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Bill The Whole Line
              </button>
            ) : undefined
          }
        />
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <p className="text-sm font-medium text-slate-900">{line.description}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {formatCurrency(cost)} on this receipt
            {jobName ? ` · ${jobName}` : ""}
          </p>
        </div>

        <div>
          <label htmlFor="container-count" className="block text-sm font-medium text-slate-700">
            How many are in the container?
          </label>
          <p className="mt-0.5 text-xs text-slate-500">
            Nobody but you knows this. The receipt says what the box cost, not what is in it.
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <NumberInput
              id="container-count"
              value={count}
              onValueChange={setCount}
              placeholder="500"
              className="h-11 w-32"
            />
            {hint.count != null && count !== hint.count && (
              <button
                type="button"
                onClick={() => setCount(hint.count as number)}
                className="flex min-h-11 items-center rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Use {hint.count}
              </button>
            )}
          </div>
          {unitWords && (
            <p className="mt-1.5 text-xs font-medium text-slate-600">
              {formatCurrency(cost)} ÷ {count} is {unitWords}.
            </p>
          )}
        </div>

        <div>
          <SegmentedControl
            items={[
              { id: "count", label: "By Count" },
              { id: "dollars", label: "By Dollars" },
            ]}
            activeId={mode}
            onSelect={(id) => setMode(id === "dollars" ? "dollars" : "count")}
            stretch
          />
          {mode === "count" ? (
            <div className="mt-3">
              <label htmlFor="used-count" className="block text-sm font-medium text-slate-700">
                How many did this job use?
              </label>
              <NumberInput
                id="used-count"
                value={used}
                onValueChange={setUsed}
                placeholder="60"
                className="mt-1.5 h-11 w-32"
              />
            </div>
          ) : (
            <div className="mt-3">
              <label htmlFor="used-dollars" className="block text-sm font-medium text-slate-700">
                How much of it did this job use, in dollars?
              </label>
              <NumberInput
                id="used-dollars"
                value={dollars}
                onValueChange={setDollars}
                placeholder="13.00"
                className="mt-1.5 h-11 w-32"
              />
              {roughCount != null && unitWords && (
                <p className="mt-1.5 text-xs text-slate-500">
                  {/* Hedged on purpose: $13.00 divided by 21.672 cents is 59.99, not 60. The
                      invoice bills the dollars he typed, and no rounded count is printed where a
                      customer can read it. */}
                  That is about {roughCount} of them.
                </p>
              )}
            </div>
          )}
        </div>

        {overCost ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            That is more than the line cost, {formatCurrency(cost)}. Lower it, or keep billing the whole line.
          </p>
        ) : (
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
            This job is billed {formatCurrency(amount)} of {formatCurrency(cost)}, with your markup on top. The other{" "}
            {formatCurrency(round2(cost - amount))}{" "}
            {/* COPY MUST NOT PROMISE A BUTTON THAT DOES NOT EXIST — or a shelf that does not get
                stocked. Stock is counted in units, so with no container count there is nothing to
                put on it and this sentence must not say otherwise. It says what happens instead,
                and how to get the other thing, which is the difference between a limit and a dead
                end. */}
            {count > 0 ? "goes in your stock." : "stays on you. Say how many are in the container and it goes in your stock instead."}
          </p>
        )}

        {line.isStock && (
          /* Said once, where the second save happens. The shelf count is only added the first
             time - there is no stock movement ledger yet, so a later change moves the money and
             leaves the count where a person put it. Telling him it also fixed his stock would be
             the promise this app does not make. */
          <p className="text-xs text-slate-500">
            This container is already counted in your stock. Changing the split here moves what the customer
            is billed; the count on the shelf stays as it is.
          </p>
        )}
      </div>
    </Modal>
  );
}
