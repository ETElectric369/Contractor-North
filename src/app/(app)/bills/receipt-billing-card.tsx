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
  splitContradictsReceipt,
  splitReceiptBilling,
  statedUnitPrice,
  usedCost,
  usedCountFromCost,
  type ContainerHint,
} from "./receipt-billing";
import { putRestOnShelf, setReceiptLineBillable, setReceiptLineUsage, takeRollOffShelf } from "./receipt-billing-actions";
import {
  ShelfCountRow,
  initialShelfCount,
  shelfAnswerOf,
  shelfPieces,
  useShelfItems,
  type ShelfCountLine,
  type ShelfCountValue,
} from "@/components/shelf-count";

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
  /**
   * THE ROLL ON THE SHELF FROM THIS LINE (Shop Stock, 0303), when there is one: what went on it,
   * what it cost off this ticket, and what is left of it now. Null = nothing from it is on the shelf.
   */
  shelf?: {
    lotId: string;
    itemName: string;
    pieces: number;
    unit: string;
    cost: number;
    piecesLeft: number;
    costLeft: number;
    /** Takes and counts on it. With any, it stays on the shelf as it is (0304). */
    liveMoves: number;
    stale: boolean;
  } | null;
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
  // The nudge travels WITH the line into the sheet instead of being computed a second time inside
  // it. The row already worked out whether the suggestion had any business showing - not locked,
  // still billable, not already split, not already on the shelf - and the sheet used to throw all
  // of that away and re-ask containerHint, so a "Use 24" button turned up on rows where the card
  // had deliberately stood the hint down. One reading, carried, not two readings that can differ.
  const [editing, setEditing] = useState<{
    receipt: ReceiptForBilling;
    line: ReceiptBillingLine;
    hint: ContainerHint | null;
  } | null>(null);

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
  /** The line whose rest is being put on the shelf (Shop Stock, Phase 2). */
  const [shelving, setShelving] = useState<{ receipt: ReceiptForBilling; line: ReceiptBillingLine } | null>(null);
  const [shelfBusy, setShelfBusy] = useState<string | null>(null);

  function takeOff(line: ReceiptBillingLine) {
    if (!line.shelf) return;
    setShelfBusy(line.id);
    start(async () => {
      const res = await takeRollOffShelf(line.shelf!.lotId);
      setShelfBusy(null);
      if (!res?.ok) {
        toast(res?.error ?? "That roll didn't come off the shelf. Try again.", "error");
        return;
      }
      toast(
        `${line.shelf!.pieces} ${line.shelf!.unit} is off the shelf, and its ${formatCurrency(line.shelf!.cost)} is back on the job. What the customer is billed didn't change.`,
        "success",
      );
      router.refresh();
    });
  }

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
      // What it did to a roll on the shelf from this ticket, if anything. Said, never swallowed.
      if (res.note) toast(res.note, "info");
      router.refresh();
    });
  }

  /**
   * Save what this job used, or put the whole line back on the bill (`billedAmount` null). This
   * moves the MONEY only (0303): the shelf is its own door now, and a `note` from the server, if
   * one ever comes back, is SAID, not swallowed.
   */
  function saveUsage(
    line: ReceiptBillingLine,
    next: {
      billedAmount: number | null;
      containerCount: number | null;
      boughtQuantity: number | null;
      usedQuantity: number | null;
    },
  ) {
    setOverrides((o) => ({
      ...o,
      [line.id]: { ...o[line.id], billedAmount: next.billedAmount },
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
    <Card id="receipt-billing" className="mb-6 scroll-mt-20 p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">What Your Customers Get Billed</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Every line off a scanned receipt, and whether it lands on the customer&apos;s invoice. Snacks and
          drinks start out on you. Everything else, tools included, starts out billed. A box or a spool you
          bought whole can bill just what this job used, and the rest is not billed to this customer.
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
                                    <span className="font-medium text-sky-700">{l.isStock ? "On the shelf, none billed here" : "None of it billed here"}</span>
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
                                  onClick={() => setEditing({ receipt: r, line: l, hint: showHint ? hint : null })}
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

                            {/* THE SHELF (Shop Stock, Phase 2). A roll from this line is on the
                                shelf: say what went there, what it cost off this ticket and what
                                is left of it. Otherwise any line that shipped something can put
                                its rest there, on a receipt no customer is holding yet. */}
                            {l.shelf ? (
                              <div className="mt-0.5 rounded-md bg-sky-50 px-2 py-1.5 text-xs text-sky-900">
                                <p className="font-medium">
                                  {r.job_name ? `${formatCurrency(l.billedAmount ?? 0)} billed to ${r.job_name}` : "None billed to a job"} ·{" "}
                                  {l.shelf.pieces} {l.shelf.unit} on the shelf ({formatCurrency(l.shelf.cost)})
                                </p>
                                <p className="text-sky-800">
                                  {l.shelf.itemName}: {l.shelf.piecesLeft} {l.shelf.unit} left, {formatCurrency(l.shelf.costLeft)}
                                  {l.shelf.stale ? " · its receipt changed, so its cost is being worked out again" : ""}
                                </p>
                                {!locked && l.shelf.liveMoves === 0 && (
                                  <button
                                    type="button"
                                    disabled={shelfBusy === l.id}
                                    onClick={() => takeOff(l)}
                                    className="-ml-1 flex min-h-11 items-center rounded-lg px-1 text-xs font-medium text-brand hover:underline disabled:opacity-50"
                                  >
                                    {shelfBusy === l.id ? "Taking It Off…" : "Take It Off The Shelf"}
                                  </button>
                                )}
                                {l.shelf.liveMoves > 0 && (
                                  <p className="text-sky-800">Pieces of it are on jobs, so it stays on the shelf as it is.</p>
                                )}
                              </div>
                            ) : (
                              !locked &&
                              l.amount > 0 &&
                              !/tax/i.test(String(l.category ?? "")) && (
                                <button
                                  type="button"
                                  onClick={() => setShelving({ receipt: r, line: l })}
                                  className="-ml-1 flex min-h-11 items-center rounded-lg px-1 text-xs font-medium text-brand hover:underline"
                                >
                                  Put The Rest On The Shelf
                                </button>
                              )
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
          hint={editing.hint}
          jobName={editing.receipt.job_name}
          onClose={() => setEditing(null)}
          onSave={(next) => saveUsage(editing.line, next)}
        />
      )}

      {shelving && (
        <PutTheRestOnTheShelf
          line={shelving.line}
          jobName={shelving.receipt.job_name}
          onClose={() => setShelving(null)}
          onDone={(message) => {
            setShelving(null);
            toast(message, "success");
            router.refresh();
          }}
        />
      )}
    </Card>
  );
}

/**
 * PUT THE REST ON THE SHELF (Shop Stock, Phase 2): "used on this job N, the rest to the shelf".
 *
 * Opens on the ticket's own count ("250 ft") and how much of it this job was already billed (none,
 * when the line was split to $0), so on Herringbone's 8/19 coil it is one tap: 0 used, 250 ft to
 * the shelf, $180.17 off Herringbone. Before the save it says exactly what will happen to the
 * customer's bill and to the job's cost, from the same arithmetic the server writes with.
 */
function PutTheRestOnTheShelf({
  line,
  jobName,
  onClose,
  onDone,
}: {
  line: ReceiptBillingLine;
  jobName: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { items, loaded, error: itemsError } = useShelfItems(true);
  const countLine = useMemo<ShelfCountLine>(
    () => ({ key: line.id, description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, amount: line.amount, category: line.category }),
    [line],
  );
  const [value, setValue] = useState<ShelfCountValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded || value) return;
    const first = initialShelfCount(countLine, items);
    // What the job was already billed, as a count, when the line was split before: 0 used on a
    // line split to $0. A line billed in full starts at 0 used too, and the sentence below says
    // plainly that saving takes it off the customer's bill.
    const unit = perUnitCost(line.amount, shelfPieces(first));
    const usedFromBilled = line.billedAmount != null && unit ? usedCountFromCost(line.billedAmount, unit) ?? 0 : 0;
    setValue({ ...first, used: usedFromBilled });
  }, [loaded, value, countLine, items, line.amount, line.billedAmount]);

  const pieces = value ? shelfPieces(value) : 0;
  const used = value ? Number(value.used) || 0 : 0;
  const per = perUnitCost(line.amount, pieces);
  const billed = used > 0 ? usedCost(used, per) : 0;
  const rest = Math.round((pieces - used) * 1000) / 1000;

  function save() {
    if (!value) return;
    setSaving(true);
    setError(null);
    putRestOnShelf({ lineId: line.id, ...shelfAnswerOf(countLine, value) })
      .then((res) => {
        setSaving(false);
        if (!res?.ok) {
          setError(res?.error ?? "Nothing went on the shelf. Try again.");
          return;
        }
        onDone(res.message ?? "On the shelf.");
      })
      .catch(() => {
        setSaving(false);
        setError("Nothing went on the shelf: the connection dropped. Try again.");
      });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Put The Rest On The Shelf"
      size="md"
      dirty={!!value?.confirmed}
      footer={
        <ModalActions
          onCancel={onClose}
          onSave={save}
          saving={saving}
          saveLabel="Put It On The Shelf"
          disabled={!value || !(pieces > 0) || !(rest > 0) || saving}
        />
      }
    >
      <div className="space-y-3">
        {!value ? (
          <p className="text-sm text-slate-500">Reading the shelf…</p>
        ) : (
          <>
            <ShelfCountRow line={countLine} value={value} onChange={setValue} items={items} showUsed allowNotStock={false} startOpen />
            {itemsError && <p className="text-xs text-amber-800">{itemsError}</p>}
            {pieces > 0 && rest > 0 && (
              <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
                {used > 0
                  ? `${jobName ?? "This job"} is billed ${formatCurrency(billed)} for the ${used} ${value.unit} it used. `
                  : `${jobName ?? "This job"} is billed nothing for it${line.billedAmount == null ? " (it was billing the whole line)" : ""}. `}
                The other {rest} {value.unit} go on the shelf, and their share of this ticket, tax included, comes off the job&apos;s cost.
              </p>
            )}
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          </>
        )}
      </div>
    </Modal>
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
  hint,
  jobName,
  onClose,
  onSave,
}: {
  line: ReceiptBillingLine;
  /** The nudge the ROW computed, or null when the row stood it down. Never recomputed here. */
  hint: ContainerHint | null;
  jobName: string | null;
  onClose: () => void;
  onSave: (next: {
    billedAmount: number | null;
    containerCount: number | null;
    boughtQuantity: number | null;
    usedQuantity: number | null;
  }) => void;
}) {
  /**
   * THE FACTOR THAT WAS MISSING, AND WHAT IT COST (audit of cn-v966).
   *
   * One question used to divide the money - how many are in the container - and the answer was
   * divided into the line's WHOLE extension. That is only right when the line bought exactly one
   * full container, which nothing on the sheet ever said out loud and nothing ever checked. On his
   * CED ticket of 2026-07-22, "NMB 6/3 W/GND (1000 ft REEL)" is fifty-five feet at $4.32; typing
   * 1000 into the old sheet billed the customer $13.07 for $237.66 of wire and put 945 feet of
   * cable that does not exist on his shelf.
   *
   * So there are two factors now and their product is what divides: how many units the line bought
   * (1 by default, which is exactly today's arithmetic and leaves the Twister box untouched) times
   * how many pieces are in one. Two boxes of 500 is $216.72 / 1000, exact instead of half price.
   */
  const [bought, setBought] = useState(1);
  const [count, setCount] = useState(0);
  const [mode, setMode] = useState<"count" | "dollars">("count");
  const [used, setUsed] = useState(0);
  const [dollars, setDollars] = useState(line.billedAmount ?? 0);

  const cost = round2(line.amount);
  const pieces = round2(bought * count);
  const unit = perUnitCost(cost, pieces);
  const unitWords = perUnitLabel(unit);
  const amount = mode === "count" ? usedCost(used, unit) : round2(dollars);
  const roughCount = mode === "dollars" ? usedCountFromCost(amount, unit) : null;
  const overCost = amount > cost;
  /** What the receipt itself says one purchased unit cost, when its own arithmetic closes. Null on
   *  the Twister row, where quantity came out of the product name, so nothing below fires there. */
  const stated = statedUnitPrice(line.quantity, line.unitPrice, cost);
  /** The refusal the split never had. Same sentence the server refuses with, from one function. */
  const objection = splitContradictsReceipt({
    cost,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    boughtQuantity: bought,
    pieces,
  });
  // By count, the piece count is what the money is divided by, so it is required. By dollars it
  // only powers the per-unit line, and a figure he types straight in needs no divisor at all.
  const canSave = !overCost && !objection && (mode === "count" ? pieces > 0 : amount >= 0);
  // "$216.72 ÷ (2 × 500)" when both factors are real, and plain "$108.36 ÷ 500" when one is 1, so
  // the one-box case reads exactly as it always has.
  const divisorWords = bought > 1 && count > 1 ? `(${round2(bought)} × ${round2(count)})` : String(pieces);

  return (
    <Modal
      open
      onClose={onClose}
      title="What This Job Used"
      size="md"
      // Dirty means HE typed something, not that the field has a value in it: the dollars box
      // opens holding the split already stored, and treating that as unsaved work would make a
      // backdrop tap ask him to confirm discarding a number he never touched.
      dirty={bought !== 1 || count > 0 || used > 0 || dollars !== (line.billedAmount ?? 0)}
      footer={
        <ModalActions
          onCancel={onClose}
          onSave={() =>
            onSave({
              billedAmount: amount,
              // PIECES, not the container count. The shelf gets `quantity_on_hand` and
              // `unit_cost` straight off this figure, so passing one box's count for a two box
              // line was the same halving landing in inventory as on the invoice.
              containerCount: pieces > 0 ? pieces : null,
              boughtQuantity: bought > 0 ? bought : null,
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
                onClick={() =>
                  onSave({ billedAmount: null, containerCount: null, boughtQuantity: null, usedQuantity: null })
                }
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

        {/* THE QUESTION THE SHEET NEVER ASKED. Answered 1 by default, which is what the old
            arithmetic silently assumed on every line it ever divided. When the receipt's own
            columns close it says so and offers its figure, because on a cut length of wire the
            receipt knows this and he should not have to work it out from the extension. */}
        <div>
          <label htmlFor="bought-count" className="block text-sm font-medium text-slate-700">
            How many of them did this line buy?
          </label>
          <p className="mt-0.5 text-xs text-slate-500">
            One box, one reel, one jar is 1.
            {stated != null
              ? ` This receipt charged ${formatCurrency(stated)} each for ${round2(line.quantity)} of them.`
              : " The receipt does not say plainly, so this starts at one."}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <NumberInput
              id="bought-count"
              value={bought}
              onValueChange={setBought}
              placeholder="1"
              className="h-11 w-32"
            />
            {stated != null && line.quantity > 0 && bought !== round2(line.quantity) && (
              <button
                type="button"
                onClick={() => setBought(round2(line.quantity))}
                className="flex min-h-11 items-center rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Use {round2(line.quantity)}
              </button>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="container-count" className="block text-sm font-medium text-slate-700">
            How many are in one of them?
          </label>
          {/* THE COMPOUND MISTAKE THIS SENTENCE HEADS OFF. On "NMB 12/2 W/GND (250 ft Coil)" the
              receipt already answers the question above with 250, and the instinct is to type 250
              here as well, which divides one coil into sixty-two thousand pieces. Nothing in the
              app can know how many pieces are in a foot, so it says what the receipt DID price and
              leaves the reading to him. */}
          <p className="mt-0.5 text-xs text-slate-500">
            Nobody but you knows this. The receipt says what the box cost, not what is in it.
            {stated != null
              ? ` It priced one of them at ${formatCurrency(stated)}, so if that is already the piece you use, this is 1.`
              : ""}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <NumberInput
              id="container-count"
              value={count}
              onValueChange={setCount}
              placeholder="500"
              className="h-11 w-32"
            />
            {/* Gated on the hint the ROW decided to show. Recomputing it here put a "Use 24" on
                lines the card had already stood the suggestion down on. */}
            {hint?.count != null && count !== hint.count && (
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
              {formatCurrency(cost)} ÷ {divisorWords} is {unitWords}.
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

        {objection ? (
          /* THE REFUSAL THAT GOES THE OTHER WAY. The only check this sheet ever had was "more
             than the line cost", and the reel failure comes in UNDER it: $13.07 billed against
             $237.66 passes that gate with room to spare while $224.59 walks off the invoice. This
             one compares against the price the receipt itself prints, which is the only figure in
             the building that can tell the app its one-container assumption is wrong. */
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{objection}</p>
        ) : overCost ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            That is more than the line cost, {formatCurrency(cost)}. Lower it, or keep billing the whole line.
          </p>
        ) : (
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
            This job is billed {formatCurrency(amount)} of {formatCurrency(cost)}, with your markup on top. The other{" "}
            {formatCurrency(round2(cost - amount))}{" "}
            {/* COPY MUST NOT PROMISE A SHELF THAT DOES NOT GET STOCKED (0303). This door moves the
                money only; putting the rest on the shelf, with its pieces and its cost, is its own
                door. So the sentence says what this save does, and nothing it does not. */}
            is not billed to this customer.
          </p>
        )}

        {line.isStock && (
          /* A roll from this line is on the shelf (0303: is_stock is true only while one is). The
             split moves what the customer is billed; once pieces of the roll are on a job, the
             database refuses a change here and says which takes to undo first. */
          <p className="text-xs text-slate-500">
            Part of this line is on the shelf. Changing the split here moves what the customer is billed.
          </p>
        )}
      </div>
    </Modal>
  );
}
