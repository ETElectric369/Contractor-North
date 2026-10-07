"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { formatCurrency } from "@/lib/utils";
import { setBillStatus } from "@/app/(app)/jobs/actions";
import { RECONCILE_KINDS } from "@/lib/reconcile-kinds";
import type { TheyCallItPaidRow } from "./reconcile-read";

/**
 * THEY CALL IT PAID, YOUR BILL IS OPEN (0383). Two records about one bill that disagree: the
 * supplier's own paper covering it is closed, and the bill still carries money open. Reconcile
 * names it and offers the two doors that settle it, both of which write the bill's own number:
 *   · Mark Paid - his word that the purchase is paid in full (bills.amount_paid := amount);
 *   · Record The Payment - the Suppliers card's sheet with this account, where the bill's box is.
 * "Settled · CED Says" used to be a badge that silently left this bill out of every figure; now it
 * is a row he answers.
 */
export function TheyCallItPaid({ rows }: { rows: TheyCallItPaidRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + r.open, 0);

  function markPaid(row: TheyCallItPaidRow) {
    start(async () => {
      const res = await setBillStatus(row.billId, "paid", row.jobId ?? "");
      if (!res?.ok) {
        toast(res?.error ?? "Couldn't mark that bill paid. Try again.", "error");
        return;
      }
      toast(`Marked ${row.label} paid in full.`, "success");
      router.refresh();
    });
  }

  return (
    <Card className="mb-6 p-4">
      <h2 className="text-base font-semibold text-slate-900">
        {RECONCILE_KINDS["they-call-it-paid"].heading} ({rows.length})
        <span className="font-normal text-slate-500"> · {formatCurrency(total)} Open Here</span>
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        {RECONCILE_KINDS["they-call-it-paid"].theirs}; {RECONCILE_KINDS["they-call-it-paid"].ours.toLowerCase()}. If you paid it, record the
        payment and check its box; if it was paid some other way, mark it paid.
      </p>
      <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
        {rows.map((r) => (
          <li key={r.billId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="min-w-0">
              <Link href={`/bills#bill-${r.billId}`} className="font-medium text-slate-900 underline-offset-2 hover:underline">
                {r.label}
              </Link>
              <span className="block text-xs text-slate-500">
                {formatCurrency(r.open)} open here · {r.accountName} says paid
                {r.jobLabel ? ` · ${r.jobLabel}` : ""}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Button variant="outline" disabled={pending} onClick={() => markPaid(r)}>
                Mark Paid
              </Button>
              {r.accountId && (
                <Link href={`/bills?pay=${r.accountId}`} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-white">
                  Record The Payment
                </Link>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
