"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, statusTone } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { setBillStatus, deleteBill } from "@/app/(app)/jobs/actions";
import { shortSupplierName } from "@/lib/supplier-name";
import { billSettledLabel, boughtAtRegister, flipBoughtHow } from "@/lib/supplier-owed";

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
  bill: {
    id: string;
    supplier: string;
    status: string;
    job_id?: string | null;
    /**
     * THE SUPPLIER'S OWN BOOKS CALL IT SETTLED (8a982483). The SAME bill read "On Account" on a
     * job's Costs tab and "Settled · <supplier> Says" on /bills, because only /bills was told. The
     * badge says it wherever the row is drawn now, and the control still says how it was BOUGHT -
     * those are two different facts and both belong on the row.
     */
    settledBySupplier?: boolean | null;
    settledBySupplierName?: string | null;
  };
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
    const next = flipBoughtHow(bill);
    start(async () => {
      const res = await setBillStatus(bill.id, next, job);
      if (!res?.ok) {
        toast(res?.error ?? "Couldn't update the bill — try again.", "error");
        return;
      }
      // WHAT THE TAP ACTUALLY DID, AND NOTHING MORE (8a982483).
      //
      // It used to promise the tap moved the supplier balance, and where a supplier sends its own
      // papers that is FALSE: the balance is their open documents, and flipping bills.status moves
      // it not one cent. A sentence the app says out loud after a write, that the next screen
      // contradicts, is the onboarding-truth law broken at the worst possible moment - just after
      // he pressed something.
      //
      // bills.status says HOW it was bought. That is what the toast says now.
      toast(
        next === "paid"
          ? "Marked settled at the register - it is no longer on account"
          : "Marked on account - it is money you still owe them",
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
        <Badge tone={statusTone(bill.status)}>{billSettledLabel(bill, shortSupplierName)}</Badge>
        {/* THE DEED, NOT "SWITCH" (ea2b7172): on a job page a bare "Switch" beside the badge read
            as "switch the job". The face says what the tap does to THIS bill. */}
        <span>{boughtAtRegister(bill) ? "Mark On Account" : "Mark Settled"}</span>
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
