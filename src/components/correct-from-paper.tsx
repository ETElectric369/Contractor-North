"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { CorrectBillModal, type CorrectableBill } from "@/components/correct-bill-modal";
import { correctableBill } from "@/app/(app)/jobs/actions";

/** The supplier's paper, as the door needs it: its number and total pre-fill the box, its id ties it. */
export type PaperOnCard = { invoiceId: string; invoiceNumber: string; total: number; date: string | null };

/**
 * CORRECT THIS BILL, FROM THE SUPPLIER'S OWN PAPER (task 2, 2026-10-07). The card said "maybe the
 * same purchase at another price" and named the bill; this door reads that bill (correctableBill:
 * its lines and what is already under it) and opens the one Correct This Bill box the bill rows
 * use, with the paper's number and total already in it. The server re-checks that the paper is
 * offered this bill and ties the correction to the document.
 */
export function CorrectFromPaperButton({
  billId,
  paper,
  disabled,
  className,
  onAttached,
}: {
  billId: string;
  paper: PaperOnCard;
  disabled?: boolean;
  className?: string;
  onAttached?: (sentence: string) => void;
}) {
  const [pending, start] = useTransition();
  const [bill, setBill] = useState<CorrectableBill | null>(null);
  const [error, setError] = useState<string | null>(null);

  function open() {
    setError(null);
    start(async () => {
      try {
        const res = await correctableBill(billId);
        if (!res.ok) return setError(res.error);
        setBill(res.bill);
      } catch {
        setError("The connection dropped before the bill came back. Try again.");
      }
    });
  }

  return (
    <>
      <Button type="button" variant="outline" className={className} disabled={disabled || pending} onClick={open}>
        {pending ? "Opening…" : "Correct This Bill"}
      </Button>
      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
      {bill && (
        <CorrectBillModal
          key={bill.id}
          bill={bill}
          paper={{ paperNumber: paper.invoiceNumber, paperTotal: paper.total, paperDate: paper.date, supplierInvoiceId: paper.invoiceId }}
          onClose={() => setBill(null)}
          onAttached={onAttached}
        />
      )}
    </>
  );
}
