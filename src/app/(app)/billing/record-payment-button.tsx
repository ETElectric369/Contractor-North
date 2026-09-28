"use client";

import { useState } from "react";
import { BadgeDollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { GetPaidButton } from "@/components/settle-up-button";
import { formatCurrency } from "@/lib/utils";

/** An invoice that can take a payment: sent (never a draft), not void, with money still owed. */
export type OpenToPay = {
  id: string;
  invoice_number: string | null;
  customer: string | null;
  balance: number;
  /** A bank transfer on its way for this bill (lib/bank-transfer's sentence), said in the sheet. */
  transferPending?: string | null;
};

/**
 * GET PAID… (W1-29; it was /payments' Record Payment, with a sheet of its own). A check that arrives
 * without its bill: it asks WHICH INVOICE, then opens THE Get Paid sheet for it (settle-up-button's
 * GetPaidButton, the one the invoice's own page opens: card first, then every other way, with Date
 * Paid and Note), so a payment is recorded the one way, with every guard recordPayment has.
 *
 * The picker stays open under the sheet it opened, so that sheet is never unmounted mid-edit; closing
 * the Get Paid sheet reads the page again, and a bill paid in full leaves the list.
 */
export function GetPaidPickButton({
  invoices,
  cardEnabled = false,
  methods,
  venmoConfigured,
  textReady,
}: {
  invoices: OpenToPay[];
  cardEnabled?: boolean;
  methods?: string[];
  venmoConfigured?: boolean;
  /** smsReadiness(org).ready: the card receipt's Text door reads it. */
  textReady?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <BadgeDollarSign /> Get Paid…
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Which Invoice?" size="sm">
        {invoices.length === 0 ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            No sent invoice has money owed on it right now. A draft takes a payment from its own page (Getting Paid Now?).
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-500">Pick the bill the money is for. Its Get Paid opens next.</p>
            <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
              {invoices.map((i) => (
                <GetPaidButton
                  key={i.id}
                  source="invoice"
                  invoiceId={i.id}
                  balance={i.balance}
                  cardEnabled={cardEnabled}
                  methods={methods}
                  venmoConfigured={venmoConfigured}
                  textReady={textReady}
                  transferPending={i.transferPending ?? null}
                  trigger="menuItem"
                  label={`${i.invoice_number ?? "Invoice"} · ${i.customer ?? "No customer"} · ${formatCurrency(i.balance)} Due`}
                />
              ))}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
