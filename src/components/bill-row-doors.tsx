"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { setBillStatus, deleteBill } from "@/app/(app)/jobs/actions";
import { formatCurrency } from "@/lib/utils";
import { billSettledLabel, billSettledTone, boughtHowFace, flipBoughtHow } from "@/lib/supplier-owed";
import { CorrectBillModal, type CorrectableBill } from "@/components/correct-bill-modal";

/**
 * A BILL ROW'S THREE DOORS, ONE COPY FOR EVERY SCREEN (audit v1018, class 13): how it was bought,
 * Edit, Delete. /bills (All Bills) and the job's Costs tab both draw a bill row, and the Costs tab
 * had kept the old ones: 16px icons, a one-tap hard delete with no question, and a badge reading
 * "paid", the word /bills retired because
 *
 *   Owed = bills not marked paid, minus payments recorded against the account,
 *
 * so ticking a bill a cheque already covered took the same dollar off twice. Since 0383 a bill
 * carries ONE NUMBER (amount_paid): the tap is his word that the whole purchase is paid in full, a
 * recorded payment pays bills by name, and the badge reads what is open. Every door is 44px at
 * 375px, and Delete asks first: there is no Undo behind it.
 *
 * CORRECT THIS BILL (0381) is the fourth door, on a bill that is not itself a correction and not set
 * aside, where the page could read the column (`correct`). A CORRECTION's row has no toggle: it is
 * settled with the bill it corrects (one purchase, one state, kept by the database), so its badge
 * says how it stands and names that bill (`follows`) instead of offering a tap the database refuses.
 */
export function BillRowDoors({
  bill,
  jobId,
  onEdit,
  disabled = false,
  correct = null,
  follows = null,
}: {
  bill: {
    id: string;
    supplier: string;
    status: string;
    job_id?: string | null;
    /** ONE NUMBER PER BILL (0383): the badge reads what is open, so a part-paid bill says its figures. */
    amount?: unknown;
    amount_paid?: number | null;
    superseded?: boolean | null;
  };
  /** The job the row is drawn on, for the server's revalidation; the bill's own job otherwise. */
  jobId?: string | null;
  onEdit: () => void;
  disabled?: boolean;
  /** Correct This Bill's bill, when this row may be corrected (lib/bill-correction canCorrect). */
  correct?: CorrectableBill | null;
  /** This row IS a correction: the number of the bill it is settled with. */
  follows?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [correcting, setCorrecting] = useState(false);
  const busy = pending || disabled;
  const job = jobId ?? bill.job_id ?? "";
  const paper = { status: bill.status, amount: bill.amount, amountPaid: bill.amount_paid ?? null, superseded: bill.superseded ?? null };

  function toggleStatus() {
    const next = flipBoughtHow(bill);
    start(async () => {
      const res = await setBillStatus(bill.id, next, job);
      if (!res?.ok) {
        toast(res?.error ?? "Couldn't update the bill — try again.", "error");
        return;
      }
      // WHAT THE TAP ACTUALLY DID (0383): Mark Paid is his word that the whole purchase is paid in
      // full, and the database writes the number from it; Mark On Account puts it back, keeping
      // whatever a recorded payment paid. A payment that paid it is undone on the payment, and the
      // server says so in the trigger's words when this tap is refused.
      toast(next === "paid" ? "Marked paid in full - it is no longer on account" : "Marked on account - it is money you still owe them", "success");
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
      {follows ? (
        <span className="flex min-h-11 items-center gap-2 px-2 text-xs font-medium text-slate-600">
          <Badge tone={billSettledTone(paper)}>{billSettledLabel(paper, formatCurrency)}</Badge>
          <span>Follows {follows}</span>
        </span>
      ) : (
        <button
          type="button"
          onClick={toggleStatus}
          disabled={busy}
          aria-label="Whether this bill is paid: tap to switch between Paid and On Account"
          className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-white"
        >
          {/* THE WORDS AND THE COLOUR FROM THE SAME NUMBER (0383): what is open on the bill. */}
          <Badge tone={billSettledTone(paper)}>{billSettledLabel(paper, formatCurrency)}</Badge>
          {/* THE DEED, NOT "SWITCH" (ea2b7172): on a job page a bare "Switch" beside the badge read
              as "switch the job". The face says what the tap does to THIS bill. */}
          <span>{boughtHowFace(bill)}</span>
        </button>
      )}
      <Button variant="outline" onClick={onEdit} disabled={busy}>
        <Pencil /> Edit
      </Button>
      {correct && (
        <Button variant="outline" onClick={() => setCorrecting(true)} disabled={busy}>
          <FilePlus2 /> Correct This Bill
        </Button>
      )}
      <Button variant="outline" className="text-red-700" onClick={removeBill} disabled={busy}>
        <Trash2 /> Delete
      </Button>
      {correct && correcting && <CorrectBillModal key={correct.id} bill={correct} onClose={() => setCorrecting(false)} />}
    </>
  );
}
