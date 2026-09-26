"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, statusTone } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { setBillStatus, deleteBill } from "@/app/(app)/jobs/actions";

/**
 * A BILL ROW'S THREE DOORS, ONE COPY FOR EVERY SCREEN (audit v1018, class 13): how it was bought,
 * Edit, Delete. /bills (All Bills) and the job's Costs tab both draw a bill row, and the Costs tab
 * had kept the old ones: 16px icons, a one-tap hard delete with no question, and a badge reading
 * "paid", the word /bills retired because
 *
 *   Owed = bills not marked paid, minus payments recorded against the account,
 *
 * so ticking a bill a cheque already covered takes the same dollar off twice. The control stays (a
 * counter receipt settled at the till is what it is for) and its face says how the bill was bought,
 * never "paid". Every door is 44px at 375px, and Delete asks first: there is no Undo behind it.
 */
export function BillRowDoors({
  bill,
  jobId,
  onEdit,
  disabled = false,
}: {
  bill: { id: string; supplier: string; status: string; job_id?: string | null };
  /** The job the row is drawn on, for the server's revalidation; the bill's own job otherwise. */
  jobId?: string | null;
  onEdit: () => void;
  disabled?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const busy = pending || disabled;
  const job = jobId ?? bill.job_id ?? "";

  function toggleStatus() {
    const next = bill.status === "paid" ? "unpaid" : "paid";
    start(async () => {
      const res = await setBillStatus(bill.id, next, job);
      if (!res?.ok) {
        toast(res?.error ?? "Couldn't update the bill — try again.", "error");
        return;
      }
      toast(
        next === "paid"
          ? "Marked settled - it comes out of the supplier balance"
          : "Marked on account - it goes back into the supplier balance",
        "success",
      );
      router.refresh();
    });
  }

  function removeBill() {
    if (!confirm(`Delete bill from "${bill.supplier}"?`)) return;
    start(async () => {
      const res = await deleteBill(bill.id, job);
      if (!res?.ok) {
        toast(res?.error ?? "Couldn't delete the bill — try again.", "error");
        return;
      }
      toast(res.warning ?? "Bill deleted", "success");
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={toggleStatus}
        disabled={busy}
        aria-label="How this bill was bought: tap to switch between Settled and On Account"
        className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-white"
      >
        <Badge tone={statusTone(bill.status)}>{bill.status === "paid" ? "Settled" : "On Account"}</Badge>
        <span>Switch</span>
      </button>
      <Button variant="outline" onClick={onEdit} disabled={busy}>
        <Pencil /> Edit
      </Button>
      <Button variant="outline" className="text-red-700" onClick={removeBill} disabled={busy}>
        <Trash2 /> Delete
      </Button>
    </>
  );
}
