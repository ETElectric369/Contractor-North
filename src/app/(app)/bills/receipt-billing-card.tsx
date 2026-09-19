"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import { splitReceiptBilling } from "./receipt-billing";
import { setReceiptLineBillable } from "./receipt-billing-actions";

export interface ReceiptBillingLine {
  id: string;
  description: string;
  quantity: number;
  amount: number;
  category: string | null;
  billable: boolean;
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
 */
export function ReceiptBillingCard({ receipts }: { receipts: ReceiptForBilling[] }) {
  const router = useRouter();
  const toast = useToast();
  const [, start] = useTransition();
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // Optimistic flips, so the totals move under his thumb instead of after a round trip. The
  // signature is every line's SERVER value: when the refresh lands and the server agrees, the
  // overrides are dropped in the same render, so the card never flickers back and never shows a
  // number the database would disagree with.
  const signature = useMemo(
    () => receipts.map((r) => r.lines.map((l) => `${l.id}:${l.billable ? 1 : 0}`).join(",")).join("|"),
    [receipts],
  );
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOverrides((o) => (Object.keys(o).length ? {} : o));
  }, [signature]);

  function flip(lineId: string, next: boolean) {
    setOverrides((o) => ({ ...o, [lineId]: next }));
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

  return (
    <Card className="mb-6 p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">What Your Customers Get Billed</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Every line off a scanned receipt, and whether it lands on the customer&apos;s invoice. Snacks and
          drinks start out on you. Everything else, tools included, starts out billed.
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
            const lines = r.lines.map((l) => ({ ...l, billable: overrides[l.id] ?? l.billable }));
            const split = splitReceiptBilling(r.amount, lines);
            const isOpen = !!open[r.id];
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
                        on the customer's bill. It gets its own line for that. */}
                    {split.notBilledCount > 0 && (
                      <span className="block text-xs font-medium text-amber-700">
                        {split.notBilledCount} {split.notBilledCount === 1 ? "line" : "lines"} not billed to the
                        customer
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
                      {lines.map((l) => (
                        <li key={l.id} className="flex items-center gap-2 py-0.5">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-slate-700">
                              {l.quantity && l.quantity !== 1 ? `${l.quantity}× ` : ""}
                              {l.description}
                            </span>
                            <span className="block truncate text-xs text-slate-400">
                              {formatCurrency(l.amount)}
                              {l.category ? ` · ${l.category}` : ""} ·{" "}
                              <span className={l.billable ? "text-slate-400" : "font-medium text-amber-700"}>
                                {l.billable ? "Billed to the customer" : "Not billed to the customer"}
                              </span>
                            </span>
                          </span>
                          {r.billedOn && r.billedOn.status !== "draft" ? (
                            <span className="shrink-0 text-xs text-slate-400">On {r.billedOn.label}</span>
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
                        </li>
                      ))}
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
    </Card>
  );
}
